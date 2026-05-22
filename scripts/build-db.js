import fs from 'fs/promises';

const token = process.env.CARDTRADER_TOKEN;
const API_BASE = 'https://api.cardtrader.com/api/v2';

const PAUSE_MS = Number(process.env.PAUSE_MS || 120);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const RETRIES = Number(process.env.RETRIES || 3);

if (!token) {
  throw new Error('CARDTRADER_TOKEN mancante');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (attempt < RETRIES) {
      const wait = 800 * attempt;
      console.warn(`Retry ${attempt}/${RETRIES - 1} per ${path}: ${message}. Attesa ${wait}ms`);
      await sleep(wait);
      return api(path, attempt + 1);
    }

    throw error;
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

function getField(product, keys, fallback = '') {
  for (const key of keys) {
    const value = key.split('.').reduce((obj, part) => obj?.[part], product);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeProduct(product, forcedBlueprintId = null, forcedExpansionId = null) {
  const blueprintId =
    forcedBlueprintId ??
    product.blueprint_id ??
    product.blueprintId ??
    product.blueprint?.id ??
    product.card_id ??
    product.cardId ??
    null;

  if (blueprintId == null) return null;

  const priceCents =
    product.price_cents ??
    product.priceCents ??
    product.price?.cents ??
    product.price_currency_cents ??
    null;

  const price =
    product.price_eur ??
    product.priceEUR ??
    product.price_float ??
    product.price_value ??
    null;

  return {
    id: product.id ?? null,
    b: Number(blueprintId),
    e: Number(product.expansion_id ?? product.expansionId ?? product.expansion?.id ?? forcedExpansionId ?? 0) || null,
    pc: priceCents == null ? null : Number(priceCents),
    p: price == null || typeof price === 'object' ? null : Number(price),
    c: String(product.currency ?? product.price_currency ?? product.price?.currency ?? 'EUR'),
    q: product.quantity ?? product.available_quantity ?? product.count ?? null,
    cond: String(getField(product, [
      'condition',
      'properties.condition',
      'properties_hash.condition',
      'properties_hash.Condition'
    ], '')),
    lang: String(getField(product, [
      'language',
      'properties.language',
      'properties_hash.language',
      'properties_hash.Language'
    ], '')),
    ct0: Boolean(
      product.ct_zero ??
      product.ctZero ??
      product.is_ct_zero ??
      product.properties?.ct_zero ??
      product.properties_hash?.ct_zero ??
      false
    )
  };
}

function addProduct(pricesByBlueprint, product, forcedBlueprintId = null, forcedExpansionId = null) {
  const normalized = normalizeProduct(product, forcedBlueprintId, forcedExpansionId);
  if (!normalized) return false;

  const key = String(normalized.b);

  if (!pricesByBlueprint[key]) {
    pricesByBlueprint[key] = [];
  }

  pricesByBlueprint[key].push(normalized);
  return true;
}

function addProductsFromPayload(pricesByBlueprint, payload, expansionId) {
  let added = 0;

  if (Array.isArray(payload)) {
    for (const product of payload) {
      if (addProduct(pricesByBlueprint, product, null, expansionId)) added++;
    }

    return added;
  }

  if (!payload || typeof payload !== 'object') {
    return added;
  }

  const possibleArrays = [
    payload.products,
    payload.marketplace_products,
    payload.data,
    payload.results,
    payload.items
  ].filter(Array.isArray);

  if (possibleArrays.length) {
    for (const arr of possibleArrays) {
      for (const product of arr) {
        if (addProduct(pricesByBlueprint, product, null, expansionId)) added++;
      }
    }

    return added;
  }

  // CardTrader marketplace/products con expansion_id può restituire oggetto raggruppato per blueprint_id.
  for (const [blueprintId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const product of value) {
        if (addProduct(pricesByBlueprint, product, blueprintId, expansionId)) added++;
      }

      continue;
    }

    if (value && typeof value === 'object') {
      if (addProduct(pricesByBlueprint, value, blueprintId, expansionId)) added++;
    }
  }

  return added;
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

async function main() {
  console.log('Avvio costruzione database PREZZI Pokémon completo, versione leggera...');

  const info = await api('/info');
  const pokemonGame = await detectPokemonGame();

  console.log(`Game trovato: ${pokemonGame.name || pokemonGame.display_name || pokemonGame.id}`);

  const expansionsPayload = await api('/expansions');
  const expansions = extractArray(expansionsPayload, ['expansions']);

  const pokemonExpansions = expansions.filter(x =>
    Number(x?.game_id) === Number(pokemonGame.id)
  );

  if (!pokemonExpansions.length) {
    throw new Error('Nessuna espansione Pokémon trovata');
  }

  console.log(`Espansioni Pokémon trovate: ${pokemonExpansions.length}`);
  console.log(`Download prezzi marketplace per TUTTE le espansioni. Pausa ${PAUSE_MS}ms, timeout ${REQUEST_TIMEOUT_MS}ms, retry ${RETRIES}.`);

  const pricesByBlueprint = {};
  const skippedExpansions = [];
  let totalOffers = 0;
  let expansionsWithOffers = 0;

  for (let i = 0; i < pokemonExpansions.length; i++) {
    const exp = pokemonExpansions[i];

    console.log(`${i + 1}/${pokemonExpansions.length} - ${exp.name}`);

    try {
      const productsPayload = await api(`/marketplace/products?expansion_id=${encodeURIComponent(exp.id)}`);
      const added = addProductsFromPayload(pricesByBlueprint, productsPayload, exp.id);

      totalOffers += added;

      if (added > 0) {
        expansionsWithOffers++;
      }

      console.log(`  offerte aggiunte: ${added} - blueprint con offerte: ${Object.keys(pricesByBlueprint).length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.warn(`SKIP prezzi espansione ${exp.id} - ${exp.name}: ${message}`);

      skippedExpansions.push({
        id: exp.id,
        name: exp.name || '',
        code: exp.code || '',
        error: message
      });
    }

    if (PAUSE_MS > 0) {
      await sleep(PAUSE_MS);
    }
  }

  const meta = {
    updatedAt: new Date().toISOString(),
    appName: info.name || '',
    appId: info.id || null,
    gameId: pokemonGame.id,
    gameName: pokemonGame.name || pokemonGame.display_name || 'Pokemon',
    expansionsCount: pokemonExpansions.length,
    expansionsWithOffers,
    skippedExpansionsCount: skippedExpansions.length,
    skippedExpansions,
    blueprintWithOffersCount: Object.keys(pricesByBlueprint).length,
    offersCount: totalOffers,
    source: 'cardtrader-marketplace-products-by-expansion',
    shape: {
      b: 'blueprint_id',
      e: 'expansion_id',
      pc: 'price_cents',
      p: 'price',
      c: 'currency',
      q: 'quantity',
      cond: 'condition',
      lang: 'language',
      ct0: 'ct_zero'
    },
    indexVersion: 2
  };

  await fs.mkdir('./data', { recursive: true });

  await fs.writeFile(
    './data/pokemon-prices.json',
    JSON.stringify(pricesByBlueprint)
  );

  await fs.writeFile(
    './data/pokemon-prices-meta.json',
    JSON.stringify(meta, null, 2)
  );

  console.log(`Database prezzi creato.`);
  console.log(`Blueprint con offerte: ${meta.blueprintWithOffersCount}`);
  console.log(`Offerte totali salvate: ${meta.offersCount}`);
  console.log(`Espansioni con offerte: ${meta.expansionsWithOffers}/${meta.expansionsCount}`);

  if (skippedExpansions.length) {
    console.warn(`Espansioni saltate: ${skippedExpansions.length}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
