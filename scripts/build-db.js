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
  number_norm: getNumberNorm(bp.fixed_properties?.collector_number),
  rarity: bp.fixed_properties?.pokemon_rarity || '',
  version: bp.version || '',
  expansion_id: bp.expansion_id,
  set_name: exp.name || '',
  set_code: exp.code || '',
  image_url: bp.image_url || ''
};

// Database alleggerito: niente searchText/searchTokens/searchNumericGroups.
// La normalizzazione e gli indici temporanei vengono costruiti nell'HTML al momento della ricerca.
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
    JSON.stringify(allCards)
  );

  await fs.writeFile(
    './data/pokemon-index-meta.json',
    JSON.stringify(meta)
  );

  console.log(`Database creato: ${allCards.length} carte, ${pokemonExpansions.length} espansioni.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
