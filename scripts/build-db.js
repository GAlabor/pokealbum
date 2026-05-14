import fs from 'fs/promises';

const token = process.env.CARDTRADER_TOKEN;
const API_BASE = 'https://api.cardtrader.com/api/v2';

if (!token) {
  throw new Error('CARDTRADER_TOKEN mancante');
}

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Errore API ${response.status}: ${text || response.statusText}`);
  }

  return response.json();
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

function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTokens(value) {
  return normalize(value).split(' ').filter(Boolean);
}

function expandNumberVariants(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const norm = normalize(raw);
  const out = new Set();
  out.add(norm);

  if (/^\d+$/.test(norm)) {
    out.add(stripLeadingZeros(norm));
  }

  return Array.from(out).filter(Boolean);
}

function expandVersionVariants(version) {
  const raw = String(version || '').trim();
  if (!raw) return [];

  const norm = normalize(raw);
  const out = new Set();
  out.add(norm);

  const match = norm.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return Array.from(out);

  const [, aRaw, bRaw] = match;
  const aVars = expandNumberVariants(aRaw);
  const bVars = expandNumberVariants(bRaw);

  for (const a of aVars) {
    for (const b of bVars) {
      out.add(`${a}/${b}`);
      out.add(`${a} ${b}`);
    }
  }

  aVars.forEach(v => out.add(v));
  bVars.forEach(v => out.add(v));

  return Array.from(out).filter(Boolean);
}

function extractNumericGroupsFromValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const matches = raw.match(/\d+/g) || [];
  return matches.map(group => ({
    raw: group,
    norm: stripLeadingZeros(group)
  }));
}

function createSearchIndex(card) {
  const tokenSet = new Set();
  const numericGroups = [];

  const baseFields = [
    card.name,
    card.collector_number,
    card.version,
    card.set_code,
    card.set_name,
  ];

  baseFields.forEach(value => {
    if (!value) return;

    splitTokens(value).forEach(t => tokenSet.add(t));
    tokenSet.add(normalize(value));

    const compact = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (compact) tokenSet.add(compact);
  });

  expandNumberVariants(card.collector_number).forEach(v => tokenSet.add(v));
  expandVersionVariants(card.version).forEach(v => tokenSet.add(v));
  extractNumericGroupsFromValue(card.collector_number).forEach(g => numericGroups.push(g));
  extractNumericGroupsFromValue(card.version).forEach(g => numericGroups.push(g));

  const textParts = [
    card.name,
    card.collector_number,
    ...expandNumberVariants(card.collector_number),
    card.version,
    ...expandVersionVariants(card.version),
    card.set_code,
    card.set_name,
  ];

  return {
    text: normalize(textParts.join(' | ')),
    tokens: Array.from(tokenSet).filter(Boolean),
    numericGroups,
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
  console.log('Avvio costruzione database Pokémon...');

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

  for (let i = 0; i < pokemonExpansions.length; i++) {
    const exp = pokemonExpansions[i];
    console.log(`${i + 1}/${pokemonExpansions.length} - ${exp.name}`);

    const blueprintsPayload = await api(`/blueprints/export?expansion_id=${encodeURIComponent(exp.id)}`);
    const blueprints = extractArray(blueprintsPayload, ['blueprints']);

    const cards = blueprints.filter(bp =>
      Number(bp?.game_id) === Number(pokemonGame.id) &&
      (!category || Number(bp?.category_id) === Number(category.id))
    );

    for (const bp of cards) {
const card = {
  id: Number(bp.id),
  name: bp.name || '-',
  collector_number: bp.fixed_properties?.collector_number || '',
  rarity: bp.fixed_properties?.pokemon_rarity || '',
  version: bp.version || '',
  expansion_id: bp.expansion_id,
  set_name: exp.name || '',
  set_code: exp.code || '',
  image_url: bp.image_url || ''
};

allCards.push(card);
    }
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
    indexVersion: 2
  };

  await fs.mkdir('./data', { recursive: true });

  await fs.writeFile(
    './data/pokemon-index.json',
    JSON.stringify(allCards, null, 2)
  );

  await fs.writeFile(
    './data/pokemon-index-meta.json',
    JSON.stringify(meta, null, 2)
  );

  console.log(`Database creato: ${allCards.length} carte, ${pokemonExpansions.length} espansioni.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
