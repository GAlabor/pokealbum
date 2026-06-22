import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const token = process.env.CARDTRADER_TOKEN;
const dbDir = process.env.POKEMON_DB_DIR || '/opt/pokealbum-db';
const minCardsCount = Number(process.env.MIN_CARDS_COUNT || 1000);
const fetchTimeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const requestDelayMs = Number(process.env.REQUEST_DELAY_MS || 120);

const API_BASE = 'https://api.cardtrader.com/api/v2';

if (!token) {
  throw new Error('CARDTRADER_TOKEN mancante');
}

async function api(apiPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await fetch(`${API_BASE}${apiPath}`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Errore API ${response.status}: ${text || response.statusText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
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

  const direct = categories.find(c =>
    (/single/i.test(String(c.name || '')) && /card/i.test(String(c.name || ''))) ||
    /pokemon singles/i.test(String(c.name || '')) ||
    /singles/i.test(String(c.name || ''))
  );

  return direct || categories[0] || null;
}

async function main() {
  console.log('Avvio aggiornamento database Pokémon...');

  const info = await api('/info');
  const pokemonGame = await detectPokemonGame();
  const category = await detectSingleCardCategory(pokemonGame.id);

  console.log(`Game trovato: ${pokemonGame.name || pokemonGame.display_name || pokemonGame.id}`);
  console.log(`Categoria: ${category?.name || category?.id || 'non trovata'}`);

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
    console.log(`${i + 1}/${pokemonExpansions.length} - ${exp.name}`);

    let blueprintsPayload;

    try {
      blueprintsPayload = await api(`/blueprints/export?expansion_id=${encodeURIComponent(exp.id)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.warn(`SKIP espansione ${exp.id} - ${exp.name}: ${message}`);

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

  if (allCards.length < minCardsCount) {
    throw new Error(`Database troppo piccolo: ${allCards.length} carte. Minimo richiesto: ${minCardsCount}`);
  }

  const meta = {
    updatedAt: new Date().toISOString(),
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
    indexVersion: 4,
    imageSchema: {
      version: 1,
      fields: [
        'images.preview',
        'images.show',
        'images.full'
      ]
    }
  };

  await fs.mkdir(dbDir, { recursive: true });

  await fs.writeFile(
    path.join(dbDir, 'pokemon-index.json'),
    JSON.stringify(allCards)
  );

  await fs.writeFile(
    path.join(dbDir, 'pokemon-index-meta.json'),
    JSON.stringify(meta)
  );

  console.log(`Database aggiornato: ${allCards.length} carte, ${pokemonExpansions.length} espansioni.`);
  console.log(`File scritti in: ${dbDir}`);

  if (skippedExpansions.length) {
    console.warn(`Espansioni saltate: ${skippedExpansions.length}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
