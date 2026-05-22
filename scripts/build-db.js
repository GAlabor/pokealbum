import fs from 'fs/promises';

const token = process.env.CARDTRADER_TOKEN;
const API_BASE = 'https://api.cardtrader.com/api/v2';

const OUT_DIR = process.env.OUT_DIR || './data';
const PRICES_FILE = `${OUT_DIR}/pokemon-prices.json`;
const META_FILE = `${OUT_DIR}/pokemon-prices-meta.json`;

// Limiti regolabili da GitHub Actions / terminale.
// Per provare solo poche espansioni: MAX_EXPANSIONS=20 node build-prices.js
const PAUSE_MS = Number(process.env.PRICE_PAUSE_MS || 250);
const MAX_EXPANSIONS = Number(process.env.MAX_EXPANSIONS || 0); // 0 = tutte
const START_FROM = Number(process.env.START_FROM || 0); // indice espansione, 0-based
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 180000);
const RETRIES = Number(process.env.PRICE_RETRIES || 2);

if (!token) {
  throw new Error('CARDTRADER_TOKEN mancante');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const { timeoutMs = API_TIMEOUT_MS, retries = RETRIES } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Errore API ${response.status}: ${text || response.statusText}`);
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      const message = error instanceof Error ? error.message : String(error);
      const wait = Math.min(15000, 1200 * (attempt + 1));

      if (attempt < retries) {
        console.warn(`Retry ${attempt + 1}/${retries} per ${path}: ${message}. Pausa ${wait}ms.`);
        await sleep(wait);
        continue;
      }
    }
  }

  throw lastError;
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

function extractObject(payload, preferredKeys = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  for (const key of preferredKeys) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  return payload;
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

function getBlueprintId(product, fallbackId = null) {
  const candidates = [
    product?.blueprint_id,
    product?.blueprintId,
    product?.blueprint?.id,
    product?.card_id,
    product?.cardId,
    product?.properties?.blueprint_id,
    fallbackId
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return String(n);
  }

  return null;
}

function normalizeProduct(product, fallbackBlueprintId = null) {
  const blueprintId = getBlueprintId(product, fallbackBlueprintId);

  // Manteniamo tutto il prodotto originale, ma aggiungiamo campi normalizzati comodi
  // per l'HTML. Sì, un minimo di civiltà in mezzo al JSON selvaggio.
  return {
    blueprint_id: blueprintId ? Number(blueprintId) : null,
    id: product?.id ?? null,
    price_cents: product?.price_cents ?? product?.priceCents ?? product?.price?.cents ?? null,
    price: product?.price ?? product?.price_float ?? product?.priceFloat ?? null,
    currency: product?.currency ?? product?.price_currency ?? product?.price?.currency ?? null,
    language: product?.language ?? product?.properties?.language ?? product?.properties?.pokemon_language ?? null,
    condition: product?.condition ?? product?.properties?.condition ?? product?.properties?.pokemon_condition ?? null,
    ct_zero: product?.ct_zero ?? product?.ctZero ?? product?.properties?.ct_zero ?? product?.properties?.ctZero ?? null,
    raw: product
  };
}

function addProductsToPrices(pricesByBlueprint, payload) {
  let added = 0;

  // Caso 1: CardTrader spesso restituisce oggetto raggruppato per blueprint_id:
  // { "123": [prodotti...], "456": [prodotti...] }
  const objectPayload = extractObject(payload, ['products']);

  if (objectPayload && !Array.isArray(objectPayload)) {
    for (const [key, value] of Object.entries(objectPayload)) {
      if (Array.isArray(value)) {
        for (const product of value) {
          const normalized = normalizeProduct(product, key);
          const blueprintId = getBlueprintId(normalized, key);
          if (!blueprintId) continue;

          if (!pricesByBlueprint[blueprintId]) pricesByBlueprint[blueprintId] = [];
          pricesByBlueprint[blueprintId].push(normalized);
          added++;
        }
      } else if (value && typeof value === 'object') {
        const normalized = normalizeProduct(value, key);
        const blueprintId = getBlueprintId(normalized, key);
        if (!blueprintId) continue;

        if (!pricesByBlueprint[blueprintId]) pricesByBlueprint[blueprintId] = [];
        pricesByBlueprint[blueprintId].push(normalized);
        added++;
      }
    }

    if (added > 0) return added;
  }

  // Caso 2: risposta piatta: [prodotti...]
  const products = extractArray(payload, ['products', 'marketplace_products', 'data']);

  for (const product of products) {
    const normalized = normalizeProduct(product);
    const blueprintId = getBlueprintId(normalized);
    if (!blueprintId) continue;

    if (!pricesByBlueprint[blueprintId]) pricesByBlueprint[blueprintId] = [];
    pricesByBlueprint[blueprintId].push(normalized);
    added++;
  }

  return added;
}

async function main() {
  console.log('Avvio creazione DB SOLO PREZZI CardTrader per Pokémon...');

  const pokemonGame = await detectPokemonGame();
  console.log(`Game trovato: ${pokemonGame.name || pokemonGame.display_name || pokemonGame.id}`);

  const expansionsPayload = await api('/expansions');
  const expansions = extractArray(expansionsPayload, ['expansions']);

  const pokemonExpansions = expansions.filter(x => Number(x?.game_id) === Number(pokemonGame.id));

  if (!pokemonExpansions.length) {
    throw new Error('Nessuna espansione Pokémon trovata');
  }

  const selectedExpansions = pokemonExpansions.slice(
    START_FROM,
    MAX_EXPANSIONS > 0 ? START_FROM + MAX_EXPANSIONS : undefined
  );

  console.log(`Espansioni Pokémon totali: ${pokemonExpansions.length}`);
  console.log(`Espansioni da processare ora: ${selectedExpansions.length}`);
  console.log(`Pausa tra richieste: ${PAUSE_MS}ms`);

  const pricesByBlueprint = {};
  const skippedExpansions = [];
  let totalProducts = 0;
  let expansionsWithProducts = 0;

  await fs.mkdir(OUT_DIR, { recursive: true });

  for (let i = 0; i < selectedExpansions.length; i++) {
    const globalIndex = START_FROM + i;
    const exp = selectedExpansions[i];
    console.log(`${globalIndex + 1}/${pokemonExpansions.length} - ${exp.code || exp.id}: ${exp.name}`);

    try {
      const payload = await api(`/marketplace/products?expansion_id=${encodeURIComponent(exp.id)}`);
      const added = addProductsToPrices(pricesByBlueprint, payload);
      totalProducts += added;

      if (added > 0) expansionsWithProducts++;

      console.log(`  offerte aggiunte: ${added} - carte con offerte finora: ${Object.keys(pricesByBlueprint).length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  SKIP prezzi espansione ${exp.id} - ${exp.name}: ${message}`);

      skippedExpansions.push({
        id: exp.id,
        name: exp.name || '',
        code: exp.code || '',
        error: message
      });
    }

    // Salvataggio progressivo ogni 25 espansioni, così se cade non perdi tutto.
    if ((i + 1) % 25 === 0) {
      await fs.writeFile(PRICES_FILE, JSON.stringify(pricesByBlueprint));
      console.log(`  salvataggio progressivo: ${Object.keys(pricesByBlueprint).length} carte con offerte`);
    }

    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  const meta = {
    updatedAt: new Date().toISOString(),
    gameId: pokemonGame.id,
    gameName: pokemonGame.name || pokemonGame.display_name || 'Pokemon',
    source: 'CardTrader /marketplace/products?expansion_id=',
    expansionsTotal: pokemonExpansions.length,
    startFrom: START_FROM,
    maxExpansions: MAX_EXPANSIONS,
    expansionsProcessed: selectedExpansions.length,
    expansionsWithProducts,
    blueprintWithOffersCount: Object.keys(pricesByBlueprint).length,
    productsCount: totalProducts,
    skippedExpansionsCount: skippedExpansions.length,
    skippedExpansions,
    indexVersion: 1
  };

  await fs.writeFile(PRICES_FILE, JSON.stringify(pricesByBlueprint));
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2));

  console.log('DB prezzi creato.');
  console.log(`Carte con offerte: ${meta.blueprintWithOffersCount}`);
  console.log(`Offerte totali salvate: ${meta.productsCount}`);
  console.log(`Espansioni saltate: ${meta.skippedExpansionsCount}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
