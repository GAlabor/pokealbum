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

function getGroupedProducts(payload) {
  if (!payload || typeof payload !== 'object') return {};

  if (!Array.isArray(payload) && !payload.length) {
    return payload;
  }

  return {};
}

function normalizeProduct(product) {
  const blueprintId =
    product.blueprint_id ??
    product.blueprintId ??
    product.blueprint?.id ??
    product.card_id ??
    product.cardId ??
    null;

  if (blueprintId == null) return null;

  return {
    id: product.id ?? null,
    blueprint_id: Number(blueprintId),
    price_cents: product.price_cents ?? product.priceCents ?? product.price?.cents ?? null,
    price: product.price ?? product.price_eur ?? product.priceEUR ?? null,
    currency: product.currency ?? product.price_currency ?? product.price?.currency ?? 'EUR',
    quantity: product.quantity ?? product.available_quantity ?? product.count ?? null,
    condition: product.condition ?? product.properties?.condition ?? product.properties_hash?.condition ?? '',
    language: product.language ?? product.properties?.language ?? product.properties_hash?.language ?? '',
    expansion_id: product.expansion_id ?? product.expansionId ?? product.expansion?.id ?? null,
    user_id: product.user_id ?? product.userId ?? product.seller?.id ?? null,
    user_name: product.user?.username ?? product.user?.name ?? product.seller?.username ?? product.seller?.name ?? '',
    ct_zero: Boolean(
      product.ct_zero ??
      product.ctZero ??
      product.is_ct_zero ??
      product.properties?.ct_zero ??
      product.properties_hash?.ct_zero ??
      false
    ),
    raw: product
  };
}

function addProduct(pricesByBlueprint, product) {
  const normalized = normalizeProduct(product);
  if (!normalized) return false;

  const key = String(normalized.blueprint_id);

  if (!pricesByBlueprint[key]) {
    pricesByBlueprint[key] = [];
  }

  pricesByBlueprint[key].push(normalized);
  return true;
}

function addProductsFromPayload(pricesByBlueprint, payload) {
  let added = 0;

  if (Array.isArray(payload)) {
    for (const product of payload) {
      if (addProduct(pricesByBlueprint, product)) added++;
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
        if (addProduct(pricesByBlueprint, product)) added++;
      }
    }

    return added;
  }

  // CardTrader marketplace/products con expansion_id può restituire un oggetto raggruppato per blueprint_id.
  for (const [blueprintId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const product of value) {
        const merged = {
          ...product,
          blueprint_id: product.blueprint_id ?? blueprintId
        };

        if (addProduct(pricesByBlueprint, merged)) added++;
      }

      continue;
    }

    if (value && typeof value === 'object') {
      const merged = {
        ...value,
        blueprint_id: value.blueprint_id ?? blueprintId
      };

      if (addProduct(pricesByBlueprint, merged)) added++;
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
  console.log('Avvio costruzione database PREZZI Pokémon completo...');

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
      const added = addProductsFromPayload(pricesByBlueprint, productsPayload);

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
    indexVersion: 1
  };

  await fs.mkdir('./data', { recursive: true });

  await fs.writeFile(
    './data/pokemon-prices.json',
    JSON.stringify(pricesByBlueprint)
  );

  await fs.writeFile(
    './data/pokemon-prices-meta.json',
    JSON.stringify(meta)
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
