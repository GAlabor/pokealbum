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

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeLang(value) {
  return normalize(value).replace(/[^a-z]/g, '');
}

function isItalianLanguage(value) {
  const lang = normalizeLang(value);
  return ['it', 'ita', 'italian', 'italiano'].includes(lang);
}

function normalizeCondition(value) {
  return normalize(value).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getProductLanguage(product) {
  return product?.properties_hash?.language
    || product?.properties_hash?.pokemon_language
    || product?.properties_hash?.pkm_language
    || product?.properties_hash?.mtg_language
    || product?.language
    || '';
}

function getProductPriceCents(product) {
  const direct = Number(product?.price_cents);
  if (Number.isFinite(direct)) return direct;

  const nested = Number(product?.price?.cents);
  if (Number.isFinite(nested)) return nested;

  const rawPrice = Number(product?.price);
  if (Number.isFinite(rawPrice)) {
    return rawPrice > 1000 ? rawPrice : Math.round(rawPrice * 100);
  }

  return null;
}

function isCardTraderZero(product) {
  return product?.user?.can_sell_via_hub === true
    || product?.seller?.can_sell_via_hub === true
    || product?.can_sell_via_hub === true;
}

const CONDITION_ORDER = ['NM', 'SP', 'MP', 'PL', 'PO'];

function getConditionCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (CONDITION_ORDER.includes(raw)) return raw;

  const cond = normalizeCondition(value);
  if (!cond) return '';

  if (cond === 'near mint' || cond === 'nm' || cond.startsWith('near mint ')) return 'NM';
  if (cond === 'slightly played' || cond === 'sp' || cond.startsWith('slightly played ')) return 'SP';
  if (cond === 'moderately played' || cond === 'mp' || cond.startsWith('moderately played ')) return 'MP';
  if (cond === 'played' || cond === 'pl') return 'PL';
  if (cond === 'poor' || cond === 'po') return 'PO';

  return raw || cond.toUpperCase();
}

function conditionRank(code) {
  const idx = CONDITION_ORDER.indexOf(String(code || '').toUpperCase());
  return idx >= 0 ? idx : 999;
}

function getLanguageKeyFromValue(value) {
  const lang = normalizeLang(value);

  if (['it', 'ita', 'italian', 'italiano'].includes(lang)) return 'it';
  if (['en', 'eng', 'english', 'inglese', 'us', 'gb', 'uk'].includes(lang)) return 'en';
  if (['fr', 'fra', 'fre', 'french', 'francese'].includes(lang)) return 'fr';
  if (['es', 'esp', 'spa', 'spanish', 'spagnolo'].includes(lang)) return 'es';
  if (['de', 'deu', 'ger', 'german', 'tedesco'].includes(lang)) return 'de';
  if (['jp', 'ja', 'jpn', 'japanese', 'giapponese'].includes(lang)) return 'jp';
  if (['cn', 'zh', 'zho', 'chi', 'chinese', 'cinese'].includes(lang)) return 'cn';

  return lang || '';
}

function buildMarketRows(products) {
  return (Array.isArray(products) ? products : [])
    .map(product => {
      const priceCents = getProductPriceCents(product);
      if (!Number.isFinite(priceCents)) return null;

      const rawLanguage = getProductLanguage(product);
      const langKey = getLanguageKeyFromValue(rawLanguage);
      const condKey = getConditionCode(product?.properties_hash?.condition || product?.condition || '');

      if (!langKey || !condKey) return null;

      return {
        product,
        priceCents,
        langKey,
        langLabel: rawLanguage,
        condKey,
        ctZero: isCardTraderZero(product)
      };
    })
    .filter(Boolean);
}

function getLowestRow(rows) {
  return (rows || []).slice().sort((a, b) => a.priceCents - b.priceCents)[0] || null;
}

function getBestByConditionThenPrice(rows) {
  return (rows || []).slice().sort((a, b) => {
    const rankDiff = conditionRank(a.condKey) - conditionRank(b.condKey);
    if (rankDiff) return rankDiff;
    return a.priceCents - b.priceCents;
  })[0] || null;
}

function pickBestMarketplaceOffer(products) {
  const rows = buildMarketRows(products);
  if (!rows.length) return null;

  const isItalianRow = row => isItalianLanguage(row.langLabel) || isItalianLanguage(row.langKey);
  const isNearMintRow = row => row.condKey === 'NM';
  const isOtherLanguageRow = row => !isItalianRow(row);

  const prioritySteps = [
    { kind: 'ita_near_mint_ctzero', rows: rows.filter(row => isItalianRow(row) && isNearMintRow(row) && row.ctZero), mode: 'price' },
    { kind: 'ita_near_mint_no_ctzero', rows: rows.filter(row => isItalianRow(row) && isNearMintRow(row) && !row.ctZero), mode: 'price' },
    { kind: 'ita_best_condition_ctzero', rows: rows.filter(row => isItalianRow(row) && row.ctZero), mode: 'condition' },
    { kind: 'ita_best_condition_no_ctzero', rows: rows.filter(row => isItalianRow(row) && !row.ctZero), mode: 'condition' },
    { kind: 'other_language_best_condition_ctzero', rows: rows.filter(row => isOtherLanguageRow(row) && row.ctZero), mode: 'condition' },
    { kind: 'other_language_best_condition_no_ctzero', rows: rows.filter(row => isOtherLanguageRow(row) && !row.ctZero), mode: 'condition' },
    { kind: 'lowest_absolute', rows, mode: 'price' },
  ];

  for (const step of prioritySteps) {
    const row = step.mode === 'price' ? getLowestRow(step.rows) : getBestByConditionThenPrice(step.rows);

    if (row) {
      return {
        kind: step.kind,
        product: row.product,
        priceCents: row.priceCents,
        language: row.langKey,
        condition: row.condKey,
        ctZero: row.ctZero
      };
    }
  }

  return null;
}

function addGroupedProduct(groups, product, forcedBlueprintId = null) {
  const blueprintId =
    forcedBlueprintId
    ?? product?.blueprint_id
    ?? product?.blueprintId
    ?? product?.blueprint?.id
    ?? product?.card_id
    ?? product?.cardId
    ?? null;

  if (blueprintId == null) return false;

  const key = String(Number(blueprintId));
  if (!key || key === 'NaN') return false;

  if (!groups[key]) groups[key] = [];
  groups[key].push(product);

  return true;
}

function getProductsGroupedByBlueprint(payload) {
  const groups = {};

  if (Array.isArray(payload)) {
    for (const product of payload) addGroupedProduct(groups, product);
    return groups;
  }

  if (!payload || typeof payload !== 'object') {
    return groups;
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
      for (const product of arr) addGroupedProduct(groups, product);
    }
    return groups;
  }

  // CardTrader può restituire direttamente un oggetto: { blueprint_id: [products...] }
  for (const [blueprintId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const product of value) addGroupedProduct(groups, product, blueprintId);
      continue;
    }

    if (value && typeof value === 'object') {
      addGroupedProduct(groups, value, blueprintId);
    }
  }

  return groups;
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
  console.log('Avvio costruzione database PREZZI Pokémon con logica HTML...');

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

  const prices = {};
  const skippedExpansions = [];
  let cardsCount = 0;
  let offersReadCount = 0;
  let pricesCount = 0;

  console.log(`Espansioni Pokémon trovate: ${pokemonExpansions.length}`);
  console.log(`Scarico marketplace per espansione e salvo solo il prezzo vincente per blueprint.`);

  for (let i = 0; i < pokemonExpansions.length; i++) {
    const exp = pokemonExpansions[i];
    console.log(`${i + 1}/${pokemonExpansions.length} - ${exp.name}`);

    try {
      // Conteggio carte totali, mantenendo la logica del vecchio build-db.
      // Serve solo per meta/debug; NON salva il DB carte.
      try {
        const blueprintsPayload = await api(`/blueprints/export?expansion_id=${encodeURIComponent(exp.id)}`);
        const blueprints = extractArray(blueprintsPayload, ['blueprints']);

        const cards = blueprints.filter(bp =>
          Number(bp?.game_id) === Number(pokemonGame.id) &&
          (!category || Number(bp?.category_id) === Number(category.id))
        );

        cardsCount += cards.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  conteggio carte non riuscito per ${exp.id}: ${message}`);
      }

      const productsPayload = await api(`/marketplace/products?expansion_id=${encodeURIComponent(exp.id)}`);
      const groupedProducts = getProductsGroupedByBlueprint(productsPayload);

      let expansionPrices = 0;
      let expansionOffers = 0;

      for (const [blueprintId, products] of Object.entries(groupedProducts)) {
        expansionOffers += products.length;

        const selected = pickBestMarketplaceOffer(products);
        if (!selected) continue;

        prices[blueprintId] = {
          pc: selected.priceCents,
          p: Number((selected.priceCents / 100).toFixed(2)),
          k: selected.kind,
          l: selected.language,
          c: selected.condition,
          z: selected.ctZero ? 1 : 0
        };

        expansionPrices++;
      }

      offersReadCount += expansionOffers;
      pricesCount += expansionPrices;

      console.log(`  offerte lette: ${expansionOffers} - prezzi scelti: ${expansionPrices} - totale prezzi: ${Object.keys(prices).length}`);
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
    categoryId: category?.id || null,
    categoryName: category?.name || '',
    expansionsCount: pokemonExpansions.length,
    cardsCount,
    pricesCount: Object.keys(prices).length,
    offersReadCount,
    skippedExpansionsCount: skippedExpansions.length,
    skippedExpansions,
    source: 'cardtrader-marketplace-products-by-expansion',
    priceLogic: [
      'ita_near_mint_ctzero',
      'ita_near_mint_no_ctzero',
      'ita_best_condition_ctzero',
      'ita_best_condition_no_ctzero',
      'other_language_best_condition_ctzero',
      'other_language_best_condition_no_ctzero',
      'lowest_absolute'
    ],
    shape: {
      pc: 'prezzo in centesimi',
      p: 'prezzo in euro',
      k: 'criterio vincente',
      l: 'lingua',
      c: 'condizione',
      z: 'ct_zero: 1 sì, 0 no'
    },
    indexVersion: 4
  };

  await fs.mkdir('./data', { recursive: true });

  await fs.rm('./data/prices', { recursive: true, force: true });
  await fs.rm('./data/pokemon_price-db.json', { force: true });

  await fs.writeFile(
    './data/pokemon_price-db.json',
    JSON.stringify(prices)
  );

  await fs.writeFile(
    './data/pokemon_price-db-meta.json',
    JSON.stringify(meta, null, 2)
  );

  const jsonBytes = Buffer.byteLength(JSON.stringify(prices), 'utf8');
  console.log(`Database prezzi creato.`);
  console.log(`Carte totali rilevate: ${cardsCount}`);
  console.log(`Offerte lette: ${offersReadCount}`);
  console.log(`Prezzi salvati: ${Object.keys(prices).length}`);
  console.log(`Dimensione pokemon_price-db.json: ${(jsonBytes / 1024 / 1024).toFixed(2)} MB`);

  if (skippedExpansions.length) {
    console.warn(`Espansioni saltate: ${skippedExpansions.length}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
