import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG = {
  apiBase: 'https://api.cardtrader.com/api/v2',
  token: process.env.CARDTRADER_TOKEN || '',
  dbDir: process.env.POKEMON_DB_DIR || '/opt/pokealbum-db',
  minCardsCount: Number(process.env.MIN_CARDS_COUNT || 1000),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 30000)
};

const PATHS = {
  indexesDir: path.join(CONFIG.dbDir, 'indexes'),
  tmpDir: path.join(CONFIG.dbDir, 'tmp'),
  logsDir: path.join(CONFIG.dbDir, 'logs'),
  activeManifest: path.join(CONFIG.dbDir, 'active-index.json'),
  logFile: path.join(CONFIG.dbDir, 'logs', 'update.log')
};

function nowIso() {
  return new Date().toISOString();
}

async function log(level, message) {
  const line = `[${nowIso()}] [${level}] ${message}`;
  console.log(line);

  try {
    await fs.mkdir(PATHS.logsDir, { recursive: true });
    await fs.appendFile(PATHS.logFile, `${line}\n`, 'utf8');
  } catch {
    // Il log non deve mai bloccare l'aggiornamento.
  }
}

async function step(label, fn) {
  const started = Date.now();
  await log('INFO', `${label}...`);

  try {
    const result = await fn();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    await log('SUCCESS', `${label} completato (${seconds}s)`);
    return result;
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    await log('ERROR', `${label} fallito (${seconds}s): ${error?.message || error}`);
    throw error;
  }
}

function assertConfig() {
  if (!CONFIG.token) {
    throw new Error('CARDTRADER_TOKEN mancante');
  }

  if (!Number.isFinite(CONFIG.minCardsCount) || CONFIG.minCardsCount < 1000) {
    throw new Error('MIN_CARDS_COUNT non valido');
  }

  if (!Number.isFinite(CONFIG.fetchTimeoutMs) || CONFIG.fetchTimeoutMs < 1000) {
    throw new Error('FETCH_TIMEOUT_MS non valido');
  }
}

async function ensureDirs() {
  await fs.mkdir(CONFIG.dbDir, { recursive: true });
  await fs.mkdir(PATHS.indexesDir, { recursive: true });
  await fs.mkdir(PATHS.tmpDir, { recursive: true });
  await fs.mkdir(PATHS.logsDir, { recursive: true });
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function api(apiPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);

  try {
    const response = await fetch(`${CONFIG.apiBase}${apiPath}`, {
      headers: {
        Authorization: `Bearer ${CONFIG.token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`CardTrader HTTP ${response.status}: ${text || response.statusText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractArray(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

function stripLeadingZeros(value) {
  const cleaned = String(value ?? '').replace(/^0+(\d)/, '$1');
  return cleaned === '' ? '0' : cleaned;
}

function getNumberNorm(value) {
  const text = String(value ?? '').trim();

  if (!/^\d+$/.test(text)) return null;

  const normalized = Number(stripLeadingZeros(text));
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchText(...values) {
  return values
    .map(value => normalizeSearchText(value))
    .filter(Boolean)
    .join(' ');
}

function cleanImageUrl(value) {
  return String(value ?? '').trim();
}

function replaceFileNamePrefix(url, newPrefix) {
  const cleaned = cleanImageUrl(url);
  if (!cleaned) return '';

  const slashIndex = cleaned.lastIndexOf('/');
  if (slashIndex === -1) return cleaned;

  const basePath = cleaned.slice(0, slashIndex + 1);
  const fileName = cleaned.slice(slashIndex + 1);
  const cleanFileName = fileName.replace(/^(preview_|show_)/i, '');

  return `${basePath}${newPrefix}${cleanFileName}`;
}

function buildImageUrls(imageUrl) {
  const cleaned = cleanImageUrl(imageUrl);

  if (!cleaned) {
    return {
      preview: '',
      show: '',
      full: ''
    };
  }

  return {
    preview: replaceFileNamePrefix(cleaned, 'preview_'),
    show: replaceFileNamePrefix(cleaned, 'show_'),
    full: replaceFileNamePrefix(cleaned, '')
  };
}

async function detectPokemonGame() {
  const payload = await api('/games');
  const games = extractArray(payload, ['games']);

  const pokemon = games.find(g =>
    /pokemon/i.test(String(g.name || '')) ||
    /pokémon/i.test(String(g.name || '')) ||
    /pokemon/i.test(String(g.display_name || '')) ||
    /pokémon/i.test(String(g.display_name || ''))
  );

  if (!pokemon) {
    throw new Error('Game Pokémon non trovato');
  }

  return pokemon;
}

async function detectSingleCardCategory(gameId) {
  const payload = await api(`/categories?game_id=${encodeURIComponent(gameId)}`);
  const categories = extractArray(payload, ['categories']);

  return categories.find(c =>
    (/single/i.test(String(c.name || '')) && /card/i.test(String(c.name || ''))) ||
    /pokemon singles/i.test(String(c.name || '')) ||
    /singles/i.test(String(c.name || ''))
  ) || categories[0] || null;
}

function validateDatabase(cards, meta) {
  if (!Array.isArray(cards)) {
    throw new Error('Database non valido: non è un array');
  }

  if (cards.length < CONFIG.minCardsCount) {
    throw new Error(`Database troppo piccolo: ${cards.length} carte, minimo ${CONFIG.minCardsCount}`);
  }

  if (!meta || typeof meta !== 'object') {
    throw new Error('Meta database mancante o non valido');
  }

  if (Number(meta.cardsCount) !== cards.length) {
    throw new Error(`Meta incoerente: cardsCount=${meta.cardsCount}, array=${cards.length}`);
  }

  const sample = cards.slice(0, 50);
  const broken = sample.find(card => !card.id || !card.name || !card.set_name);

  if (broken) {
    throw new Error(`Carta non valida nel campione: ${JSON.stringify(broken).slice(0, 300)}`);
  }
}

async function buildDatabase() {
  const info = await api('/info');
  const pokemonGame = await detectPokemonGame();
  const category = await detectSingleCardCategory(pokemonGame.id);

  await log('INFO', `Game trovato: ${pokemonGame.name || pokemonGame.display_name || pokemonGame.id}`);
  await log('INFO', `Categoria: ${category?.name || category?.id || 'non trovata'}`);

  const expansionsPayload = await api('/expansions');
  const expansions = extractArray(expansionsPayload, ['expansions']);

  const pokemonExpansions = expansions.filter(x =>
    Number(x?.game_id) === Number(pokemonGame.id)
  );

  if (!pokemonExpansions.length) {
    throw new Error('Nessuna espansione Pokémon trovata');
  }

  const allCards = [];
  const skippedExpansions = [];

  for (let i = 0; i < pokemonExpansions.length; i++) {
    const exp = pokemonExpansions[i];

    await log('INFO', `${i + 1}/${pokemonExpansions.length} - ${exp.name}`);

    let blueprintsPayload;

    try {
      blueprintsPayload = await api(`/blueprints/export?expansion_id=${encodeURIComponent(exp.id)}`);
    } catch (error) {
      const message = error?.message || String(error);

      await log('WARN', `SKIP espansione ${exp.id} - ${exp.name}: ${message}`);

      skippedExpansions.push({
        id: exp.id,
        name: exp.name || '',
        code: exp.code || '',
        error: message
      });

      continue;
    }

    const blueprints = extractArray(blueprintsPayload, ['blueprints']);

    const cards = blueprints.filter(bp =>
      Number(bp?.game_id) === Number(pokemonGame.id) &&
      (!category || Number(bp?.category_id) === Number(category.id))
    );

    for (const bp of cards) {
      const images = buildImageUrls(bp.image_url || '');

      const baseCard = {
        id: Number(bp.id),
        name: bp.name || '-',
        collector_number: bp.fixed_properties?.collector_number || '',
        number_norm: getNumberNorm(bp.fixed_properties?.collector_number),
        rarity: bp.fixed_properties?.pokemon_rarity || '',
        version: bp.version || '',
        expansion_id: bp.expansion_id,
        set_name: exp.name || '',
        set_code: exp.code || '',
        images
      };

      allCards.push({
        ...baseCard,
        q: buildSearchText(
          baseCard.name,
          baseCard.collector_number,
          baseCard.rarity,
          baseCard.version,
          baseCard.set_name,
          baseCard.set_code
        )
      });
    }
  }

  const meta = {
    updatedAt: nowIso(),
    appName: info.name || '',
    appId: info.id || null,
    gameId: pokemonGame.id,
    gameName: pokemonGame.name || pokemonGame.display_name || 'Pokemon',
    categoryId: category?.id || null,
    categoryName: category?.name || '',
    cardsCount: allCards.length,
    expansionsCount: pokemonExpansions.length,
    skippedExpansionsCount: skippedExpansions.length,
    skippedExpansions,
    indexVersion: 5,
    imageSchema: {
      version: 1,
      fields: [
        'images.preview',
        'images.show',
        'images.full'
      ]
    }
  };

  return {
    cards: allCards,
    meta
  };
}

function getNextVersion(activeManifest) {
  const current = Number(activeManifest?.version || 0);
  return current + 1;
}

async function publishDatabase(cards, meta) {
  const active = await readJsonIfExists(PATHS.activeManifest, null);
  const version = getNextVersion(active);

  const indexFileName = `pokemon-index-v${version}.json`;
  const metaFileName = `pokemon-index-v${version}-meta.json`;

  const tmpIndexPath = path.join(PATHS.tmpDir, indexFileName);
  const tmpMetaPath = path.join(PATHS.tmpDir, metaFileName);

  const finalIndexPath = path.join(PATHS.indexesDir, indexFileName);
  const finalMetaPath = path.join(PATHS.indexesDir, metaFileName);

  await writeJson(tmpIndexPath, cards);
  await writeJson(tmpMetaPath, meta);

  const tmpCards = await readJsonIfExists(tmpIndexPath, null);
  const tmpMeta = await readJsonIfExists(tmpMetaPath, null);

  validateDatabase(tmpCards, tmpMeta);

  await fs.rename(tmpIndexPath, finalIndexPath);
  await fs.rename(tmpMetaPath, finalMetaPath);

  const manifest = {
    version,
    createdAt: nowIso(),
    cards: cards.length,
    generator: 'pokealbum-pokemon-db 1.0',
    index: `indexes/${indexFileName}`,
    meta: `indexes/${metaFileName}`
  };

  const tmpManifest = path.join(PATHS.tmpDir, 'active-index.json');
  await writeJson(tmpManifest, manifest);

  const checkManifest = await readJsonIfExists(tmpManifest, null);

  if (!checkManifest?.index || !checkManifest?.meta || !checkManifest?.cards) {
    throw new Error('Manifest temporaneo non valido');
  }

  await fs.rename(tmpManifest, PATHS.activeManifest);

  return manifest;
}

async function main() {
  await ensureDirs();
  assertConfig();

  await log('INFO', '=== Avvio aggiornamento database Pokémon ===');

  const { cards, meta } = await step('Download e costruzione database', buildDatabase);

  await step('Validazione database', async () => {
    validateDatabase(cards, meta);
  });

  const manifest = await step('Pubblicazione atomica database', async () => {
    return publishDatabase(cards, meta);
  });

  await log(
    'SUCCESS',
    `Database attivo v${manifest.version}: ${manifest.cards} carte`
  );

  await log('INFO', '=== Fine aggiornamento database Pokémon ===');
}

main().catch(async error => {
  await log('ERROR', error?.stack || error?.message || String(error));
  process.exit(1);
});