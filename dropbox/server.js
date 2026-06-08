import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8001);
const DATA_DIR = path.resolve('data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const DROPBOX_DATA_FILE = '/pokealbum-data.json';

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REDIRECT_URI =
  process.env.DROPBOX_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/dropbox/callback`;

if (!APP_KEY || !APP_SECRET) {
  console.warn('\n[ATTENZIONE] Mancano DROPBOX_APP_KEY o DROPBOX_APP_SECRET nel file .env\n');
}

app.use(express.json({ limit: '50mb' }));
const PROJECT_ROOT = path.resolve('..');

app.use(express.static(PROJECT_ROOT));

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(TOKENS_FILE);
  } catch {
    await fs.writeFile(TOKENS_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

async function readTokens() {
  await ensureDataFile();
  return JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
}

async function writeTokens(data) {
  await ensureDataFile();
  await fs.writeFile(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function makeState() {
  return crypto.randomBytes(24).toString('hex');
}

// Demo locale: state in memoria.
// In produzione vera: sessione/cookie firmato/database.
const pendingStates = new Set();

app.get('/auth/dropbox/start', (req, res) => {
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).send('Config Dropbox mancante: controlla il file .env');
  }

  const state = makeState();
  pendingStates.add(state);

  const params = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    token_access_type: 'offline',
    state
  });

  res.redirect(`https://www.dropbox.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/dropbox/cancel', (req, res) => {
  res.redirect('/index.html?dropbox=cancelled');
});

app.get('/auth/dropbox/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      if (state) pendingStates.delete(String(state));

      const normalizedError = String(error);
      const target = normalizedError === 'access_denied'
        ? '/index.html?dropbox=cancelled'
        : `/index.html?dropbox=error&reason=${encodeURIComponent(normalizedError)}`;

      return res.redirect(target);
    }

    if (!code || !state) {
      return res.redirect('/index.html?dropbox=error&reason=missing_code_or_state');
    }

    if (!pendingStates.has(String(state))) {
      return res.redirect('/index.html?dropbox=error&reason=invalid_state');
    }

    pendingStates.delete(String(state));

    const basic = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');

    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error('[DROPBOX TOKEN ERROR]', tokenJson);
      return res.status(500).json(tokenJson);
    }

    const accountRes = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'Content-Type': 'application/json'
      },
      body: 'null'
    });

    const accountJson = await accountRes.json();

    if (!accountRes.ok) {
      console.error('[DROPBOX ACCOUNT ERROR]', accountJson);
      return res.status(500).json(accountJson);
    }

    const tokens = await readTokens();

    tokens.users[accountJson.account_id] = {
      account_id: accountJson.account_id,
      name: accountJson.name?.display_name || 'Utente Dropbox',
      email: accountJson.email || '',
      refresh_token: tokenJson.refresh_token,
      linked_at: new Date().toISOString()
    };

    await writeTokens(tokens);

    res.redirect(`/index.html?dropbox=connected&account_id=${encodeURIComponent(accountJson.account_id)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Errore callback Dropbox. Vedi finestra server.');
  }
});

async function getFirstAccountId() {
  const tokens = await readTokens();
  const users = Object.values(tokens.users);

  if (users.length === 0) {
    throw new Error('Nessun utente Dropbox collegato');
  }

  return users[0].account_id;
}

async function getAccessToken(accountId) {
  const tokens = await readTokens();
  const user = tokens.users[accountId];

  if (!user?.refresh_token) {
    throw new Error('Refresh token mancante');
  }

  const basic = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');

  const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token
    })
  });

  const tokenJson = await tokenRes.json();

  if (!tokenRes.ok) {
    throw new Error(JSON.stringify(tokenJson));
  }

  return tokenJson.access_token;
}

app.get('/api/status', async (req, res) => {
  try {
    const tokens = await readTokens();
    const users = Object.values(tokens.users).map(({ refresh_token, ...safeUser }) => safeUser);

    res.json({
      ok: true,
      connected: users.length > 0,
      users
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

app.get('/api/load-data', async (req, res) => {
  try {
    const accountId = await getFirstAccountId();
    const accessToken = await getAccessToken(accountId);

    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          path: DROPBOX_DATA_FILE
        })
      }
    });

    const text = await response.text();

    if (response.status === 409) {
      return res.json({
        ok: true,
        exists: false,
        data: {}
      });
    }

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        status: response.status,
        error: text
      });
    }

    res.json({
      ok: true,
      exists: true,
      data: JSON.parse(text)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

app.post('/api/save-data', async (req, res) => {
  try {
    const accountId = await getFirstAccountId();
    const accessToken = await getAccessToken(accountId);
    const content = JSON.stringify(req.body || {}, null, 2);

    const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          path: DROPBOX_DATA_FILE,
          mode: 'overwrite',
          autorename: false,
          mute: false,
          strict_conflict: false
        }),
        'Content-Type': 'application/octet-stream'
      },
      body: content
    });

    const uploadText = await uploadRes.text();

    let uploadJson;
    try {
      uploadJson = JSON.parse(uploadText);
    } catch {
      uploadJson = { raw: uploadText };
    }

    if (!uploadRes.ok) {
      return res.status(500).json({
        ok: false,
        status: uploadRes.status,
        error: uploadJson
      });
    }

    res.json({
      ok: true,
      message: 'pokealbum-data.json salvato su Dropbox',
      file: DROPBOX_DATA_FILE,
      dropbox: uploadJson
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});


app.post('/api/disconnect', async (req, res) => {
  try {
    await writeTokens({ users: {} });

    res.json({
      ok: true,
      connected: false,
      message: 'Dropbox disconnesso localmente'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server avviato: http://localhost:${PORT}`);
  console.log(`Cartella servita: ${PROJECT_ROOT}`);
  console.log(`Redirect URI Dropbox: ${REDIRECT_URI}`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n[ERRORE] La porta ${PORT} è già occupata.`);
    console.error('Chiudi la vecchia finestra del server oppure cambia PORT nel file .env.\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
