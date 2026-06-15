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

const FRONTEND_URL = (process.env.FRONTEND_URL || `http://localhost:${PORT}/`).replace(/\/?$/, '/');
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);

class HttpError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function frontendRedirect(params = {}) {
  const url = new URL(FRONTEND_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (!APP_KEY || !APP_SECRET) {
  console.warn('\n[ATTENZIONE] Mancano DROPBOX_APP_KEY o DROPBOX_APP_SECRET nel file .env\n');
}

if (USE_SUPABASE) {
  console.log('[SUPABASE] Token Dropbox salvati su Supabase');
} else {
  console.log('[LOCAL] Token Dropbox salvati su file locale data/tokens.json');
}

app.use(express.json({ limit: '50mb' }));

// CORS minimo per usare il backend Render da GitHub Pages.
// Non è Fort Knox, ma almeno il browser non fa il vigile urbano.
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const PROJECT_ROOT = path.resolve('..');
app.use(express.static(PROJECT_ROOT));

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(TOKENS_FILE);
  } catch {
    await fs.writeFile(TOKENS_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

async function readLocalTokens() {
  await ensureDataFile();
  return JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
}

async function writeLocalTokens(data) {
  await ensureDataFile();
  await fs.writeFile(TOKENS_FILE, JSON.stringify(data, null, 2));
}

async function readSupabaseTokens() {
  const url = `${SUPABASE_URL}/rest/v1/dropbox_tokens?select=account_id,name,email,refresh_token,linked_at`;

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: supabaseHeaders()
  });

  const json = await response.json();

  if (!response.ok) {
    console.error('[SUPABASE READ ERROR]', json);
    throw new Error(`Errore lettura Supabase: ${JSON.stringify(json)}`);
  }

  const users = {};

  for (const row of json) {
    users[row.account_id] = {
      account_id: row.account_id,
      name: row.name || 'Utente Dropbox',
      email: row.email || '',
      refresh_token: row.refresh_token,
      linked_at: row.linked_at
    };
  }

  return { users };
}

async function upsertSupabaseToken(user) {
  const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/dropbox_tokens`, {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    }),
    body: JSON.stringify({
      account_id: user.account_id,
      name: user.name || 'Utente Dropbox',
      email: user.email || '',
      refresh_token: user.refresh_token,
      linked_at: user.linked_at || new Date().toISOString()
    })
  });

  const text = await response.text();

  if (!response.ok) {
    let error;
    try {
      error = JSON.parse(text);
    } catch {
      error = { raw: text };
    }

    console.error('[SUPABASE UPSERT ERROR]', error);
    throw new Error(`Errore salvataggio Supabase: ${JSON.stringify(error)}`);
  }
}

async function clearSupabaseTokens() {
  const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/dropbox_tokens?account_id=not.is.null`, {
    method: 'DELETE',
    headers: supabaseHeaders()
  });

  const text = await response.text();

  if (!response.ok) {
    let error;
    try {
      error = JSON.parse(text);
    } catch {
      error = { raw: text };
    }

    console.error('[SUPABASE DELETE ERROR]', error);
    throw new Error(`Errore cancellazione Supabase: ${JSON.stringify(error)}`);
  }
}

async function readTokens() {
  if (USE_SUPABASE) {
    return readSupabaseTokens();
  }

  return readLocalTokens();
}

async function saveDropboxUser(user) {
  if (USE_SUPABASE) {
    await upsertSupabaseToken(user);
    return;
  }

  const tokens = await readLocalTokens();
  tokens.users[user.account_id] = user;
  await writeLocalTokens(tokens);
}

async function clearTokens() {
  if (USE_SUPABASE) {
    await clearSupabaseTokens();
    return;
  }

  await writeLocalTokens({ users: {} });
}

async function revokeDropboxTokenForUser(user) {
  if (!user?.refresh_token || !APP_KEY || !APP_SECRET) return false;

  try {
    const accessToken = await getAccessToken(user.account_id);
    const response = await fetchWithTimeout('https://api.dropboxapi.com/2/auth/token/revoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: 'null'
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn('[DROPBOX REVOKE WARNING]', user.account_id, response.status, text);
      return false;
    }

    return true;
  } catch (error) {
    console.warn('[DROPBOX REVOKE WARNING]', user.account_id, error?.message || error);
    return false;
  }
}

async function revokeDropboxTokens() {
  const tokens = await readTokens();
  const users = Object.values(tokens.users || {});

  const results = [];
  for (const user of users) {
    results.push({
      account_id: user.account_id,
      revoked: await revokeDropboxTokenForUser(user)
    });
  }

  return results;
}

function makeSignedState() {
  const payload = JSON.stringify({
    nonce: crypto.randomBytes(16).toString('hex'),
    ts: Date.now()
  });
  const data = Buffer.from(payload).toString('base64url');
  const signature = crypto
    .createHmac('sha256', APP_SECRET || 'pokealbum-local-state')
    .update(data)
    .digest('base64url');

  return `${data}.${signature}`;
}

function verifySignedState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return false;

  const [data, signature] = state.split('.');
  const expected = crypto
    .createHmac('sha256', APP_SECRET || 'pokealbum-local-state')
    .update(data)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature || '');
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return false;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    const ts = Number(payload.ts || 0);
    return Number.isFinite(ts) && Date.now() - ts <= STATE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

app.get('/auth/dropbox/start', (req, res) => {
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).send('Config Dropbox mancante: controlla variabili ambiente o file .env');
  }

  const state = makeSignedState();

  const params = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    token_access_type: 'offline',
    state
  });

  const forceReapprove = String(req.query.force_reapprove || req.query.forceReapprove || '').toLowerCase();
  if (forceReapprove === '1' || forceReapprove === 'true' || forceReapprove === 'yes') {
    params.set('force_reapprove', 'true');
  }

  res.redirect(`https://www.dropbox.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/dropbox/cancel', (req, res) => {
  res.redirect(frontendRedirect({ dropbox: 'cancelled' }));
});

app.get('/auth/dropbox/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      const normalizedError = String(error);
      const target = normalizedError === 'access_denied'
        ? frontendRedirect({ dropbox: 'cancelled' })
        : frontendRedirect({ dropbox: 'error', reason: normalizedError });

      return res.redirect(target);
    }

    if (!code || !state) {
      return res.redirect(frontendRedirect({ dropbox: 'error', reason: 'missing_code_or_state' }));
    }

    if (!verifySignedState(String(state))) {
      return res.redirect(frontendRedirect({ dropbox: 'error', reason: 'invalid_state' }));
    }

    const basic = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');

    const tokenRes = await fetchWithTimeout('https://api.dropboxapi.com/oauth2/token', {
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

    const accountRes = await fetchWithTimeout('https://api.dropboxapi.com/2/users/get_current_account', {
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

    await saveDropboxUser({
      account_id: accountJson.account_id,
      name: accountJson.name?.display_name || 'Utente Dropbox',
      email: accountJson.email || '',
      refresh_token: tokenJson.refresh_token,
      linked_at: new Date().toISOString()
    });

    res.redirect(frontendRedirect({ dropbox: 'connected', account_id: accountJson.account_id }));
  } catch (err) {
    console.error(err);
    res.status(500).send('Errore callback Dropbox. Vedi log server.');
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

  const tokenRes = await fetchWithTimeout('https://api.dropboxapi.com/oauth2/token', {
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

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'pokealbum-dropbox-backend',
    storage: USE_SUPABASE ? 'supabase' : 'local',
    now: new Date().toISOString()
  });
});

app.get('/api/status', async (req, res) => {
  try {
    const tokens = await readTokens();
    const users = Object.values(tokens.users).map(({ refresh_token, ...safeUser }) => safeUser);

    res.json({
      ok: true,
      storage: USE_SUPABASE ? 'supabase' : 'local',
      connected: users.length > 0,
      users
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      storage: USE_SUPABASE ? 'supabase' : 'local',
      error: String(err.message || err)
    });
  }
});

app.get('/api/load-data', async (req, res) => {
  try {
    const accountId = await getFirstAccountId();
    const accessToken = await getAccessToken(accountId);

    const response = await fetchWithTimeout('https://content.dropboxapi.com/2/files/download', {
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

    let parsedData;
    try {
      parsedData = JSON.parse(text);
    } catch {
      return res.status(500).json({
        ok: false,
        error: 'Il file pokealbum-data.json su Dropbox non contiene JSON valido'
      });
    }

    res.json({
      ok: true,
      exists: true,
      data: parsedData
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

    const uploadRes = await fetchWithTimeout('https://content.dropboxapi.com/2/files/upload', {
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
    const revoked = await revokeDropboxTokens();
    await clearTokens();

    res.json({
      ok: true,
      connected: false,
      storage: USE_SUPABASE ? 'supabase' : 'local',
      revoked,
      message: USE_SUPABASE
        ? 'Dropbox disconnesso da Supabase e token revocato'
        : 'Dropbox disconnesso localmente e token revocato'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server avviato: http://localhost:${PORT}`);
  console.log(`Cartella servita: ${PROJECT_ROOT}`);
  console.log(`Redirect URI Dropbox: ${REDIRECT_URI}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`Token storage: ${USE_SUPABASE ? 'Supabase' : 'file locale'}`);
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
