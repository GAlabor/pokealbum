import fs from 'fs/promises';

const token = process.env.CARDTRADER_TOKEN;
const API_BASE = 'https://api.cardtrader.com/api/v2';

const INCLUDE_PRICES = process.env.INCLUDE_PRICES !== '0';
const PRICE_CONCURRENCY = Math.max(1, Number(process.env.PRICE_CONCURRENCY || 4));
const PRICE_DELAY_MS = Math.max(0, Number(process.env.PRICE_DELAY_MS || 120));
const PRICE_CACHE_PATH = process.env.PRICE_CACHE_PATH || './data/pokemon-price-cache.json';

if (!token) {
  throw new Error('CARDTRADER_TOKEN mancante');
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise(resolve => setTimeout(resolve, ms));
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

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function buildSearchText(...values) {
  return values
    .map(value => normalizeSearchText(value))
    .filter(Boolean)
    .join(' ');
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

function getProductLanguage(product) {
  return product?.properties_hash?.language
    || product?.properties_hash?.pokemon_language
    || product?.properties_hash?.pkm_language
    || product?.properties_hash?.mtg_language
    || product?.language
    || '';
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

function formatEuroFromCents(cents) {
  if (!Number.isFinite(cents)) return '-';
  return `€ ${(cents / 100).toFixed(2)}`;
}

function isCardTraderZero(product) {
  return product?.user?.can_sell_via_hub === true
    || product?.seller?.can_sell_via_hub === true
    || product?.can_sell_via_hub === true;
}

const CONDITION_ORDER = ['NM', 'SP', 'MP', 'PL', 'PO'];
const CONDITION_LABELS = {
  NM: 'Near Mint',
  SP: 'Slightly Played',
  MP: 'Moderately Played',
  PL: 'Played',
  PO: 'Poor'
};

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

function getConditionLabelFromCode(code) {
  const key = String(code || '').toUpperCase();
  return CONDITION_LABELS[key] || key || '-';
}

function conditionRank(code) {
  const idx = CONDITION_ORDER.indexOf(String(code || '').toUpperCase());
  return idx >= 0 ? idx : 999;
}

const MARKET_LANGUAGE_LABEL_MAP = {
  it: 'Italiano', ita: 'Italiano', italiano: 'Italiano', italian: 'Italiano',
  en: 'Inglese', eng: 'Inglese', english: 'Inglese', inglese: 'Inglese', us: 'Inglese', gb: 'Inglese', uk: 'Inglese',
  fr: 'Francese', fra: 'Francese', fre: 'Francese', french: 'Francese', francese: 'Francese',
  es: 'Spagnolo', esp: 'Spagnolo', spa: 'Spagnolo', spanish: 'Spagnolo', spagnolo: 'Spagnolo',
  de: 'Tedesco', deu: 'Tedesco', ger: 'Tedesco', german: 'Tedesco', tedesco: 'Tedesco',
  nl: 'Olandese', nld: 'Olandese', dut: 'Olandese', nederlands: 'Olandese', dutch: 'Olandese', olandese: 'Olandese',
  pt: 'Portoghese', por: 'Portoghese', portuguese: 'Portoghese', portoghese: 'Portoghese',
  jp: 'Giapponese', ja: 'Giapponese', jpn: 'Giapponese', japanese: 'Giapponese', giapponese: 'Giapponese',
  cn: 'Cinese Semplificato', zh: 'Cinese Semplificato', zhcn: 'Cinese Semplificato', zhhans: 'Cinese Semplificato',
  ko: 'Coreano', kor: 'Coreano', korean: 'Coreano', coreano: 'Coreano'
};

function getLanguageKeyFromValue(value) {
  const key = normalizeLang(value);
  return key || '';
}

function getLanguageDisplayLabel(value) {
  const key = getLanguageKeyFromValue(value);
  return MARKET_LANGUAGE_LABEL_MAP[key] || String(value || '').trim() || '-';
}

function buildMarketRows(products) {
  return (Array.isArray(products) ? products : [])
    .map(product => {
      const priceCents = getProductPriceCents(product);
      if (!Number.isFinite(priceCents)) return null;

      const rawLanguage = getProductLanguage(product);
      const langLabel = getLanguageDisplayLabel(rawLanguage);
      const langKey = getLanguageKeyFromValue(rawLanguage);
      const condKey = getConditionCode(product?.properties_hash?.condition || '');

      if (!langKey || !condKey) return null;

      return {
        product,
        priceCents,
        langKey,
        langLabel,
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
    { kind: 'lowest_absolute', rows, mode: 'price' }
  ];

  for (const step of prioritySteps) {
    const row = step.mode === 'price' ? getLowestRow(step.rows) : getBestByConditionThenPrice(step.rows);
    if (row) {
      return {
        kind: step.kind,
        product: row.product,
        priceCents: row.priceCents,
        row
      };
    }
  }

  return null;
}

function compactPriceSummary(products) {
  const rows = buildMarketRows(products);
  const selected = pickBestMarketplaceOffer(products);

  if (!selected) {
    return {
      updatedAt: new Date().toISOString(),
      source: 'cardtrader_marketplace_products',
      hasPrice: false,
      priceCents: null,
      priceLabel: '-',
      priorityKind: '',
      offersCount: Array.isArray(products) ? products.length : 0,
      pricedOffersCount: rows.length,
      note: rows.length ? 'Offerte presenti, ma nessuna compatibile con la scaletta prezzo.' : 'Nessuna offerta con prezzo leggibile.'
    };
  }

  const row = selected.row;
  const product = selected.product;

  return {
    updatedAt: new Date().toISOString(),
    source: 'cardtrader_marketplace_products',
    hasPrice: true,
    priceCents: selected.priceCents,
    priceValue: Number((selected.priceCents / 100).toFixed(2)),
    priceLabel: formatEuroFromCents(selected.priceCents),
    currency: 'EUR',
    priorityKind: selected.kind,
    language: row.langLabel,
    languageKey: row.langKey,
    condition: row.condKey,
    conditionLabel: getConditionLabelFromCode(row.condKey),
    ctZero: Boolean(row.ctZero),
    productId: product?.id ?? null,
    sellerId: product?.user_id ?? product?.seller_id ?? product?.user?.id ?? product?.seller?.id ?? null,
    offersCount: Array.isArray(products) ? products.length : 0,
    pricedOffersCount: rows.length,
    note: 'Prezzo scelto con la stessa scaletta usata nell’HTML: IT/NM/CTZero, poi fallback ordinati.'
  };
}

async function readPriceCache() {
  try {
    const raw = await fs.readFile(PRICE_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writePriceCache(cache) {
  await fs.mkdir('./data', { recursive: true });
  await fs.writeFile(PRICE_CACHE_PATH, JSON.stringify(cache));
}

async function fetchPriceSummaryForCard(card, cache) {
  const key = String(card.id);

  try {
    await sleep(PRICE_DELAY_MS);
    const data = await api(`/marketplace/products?blueprint_id=${encodeURIComponent(card.id)}`);
    const products = extractArray(data, ['products']);
    const summary = compactPriceSummary(products);

    cache[key] = summary;
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (cache[key]) {
      return {
        ...cache[key],
        stale: true,
        staleReason: message,
        note: 'Prezzo recuperato dalla cache locale perché CardTrader non ha risposto durante la build.'
      };
    }

    return {
      updatedAt: new Date().toISOString(),
      source: 'cardtrader_marketplace_products',
      hasPrice: false,
      priceCents: null,
      priceLabel: '-',
      priorityKind: '',
      offersCount: 0,
      pricedOffersCount: 0,
      error: message,
      note: 'Prezzo non disponibile durante la build.'
    };
  }
}

async function attachPrices(cards) {
  if (!INCLUDE_PRICES) {
    console.log('Prezzi saltati: INCLUDE_PRICES=0');
    return {
      pricedCards: 0,
      cardsWithPrice: 0,
      cardsWithoutPrice: cards.length,
      cardsWithStalePrice: 0,
      priceErrors: 0
    };
  }

  console.log(`Avvio download prezzi marketplace: ${cards.length} carte, concorrenza ${PRICE_CONCURRENCY}, pausa ${PRICE_DELAY_MS}ms.`);

  const cache = await readPriceCache();

  let index = 0;
  let completed = 0;
  let cardsWithPrice = 0;
  let cardsWithStalePrice = 0;
  let priceErrors = 0;

  async function worker(workerId) {
    while (index < cards.length) {
      const cardIndex = index++;
      const card = cards[cardIndex];

      const summary = await fetchPriceSummaryForCard(card, cache);
      card.price = summary;

      if (summary?.hasPrice) cardsWithPrice++;
      if (summary?.stale) cardsWithStalePrice++;
      if (summary?.error) priceErrors++;

      completed++;

      if (completed % 100 === 0 || completed === cards.length) {
        console.log(`Prezzi: ${completed}/${cards.length} completati - con prezzo ${cardsWithPrice} - stale ${cardsWithStalePrice} - errori ${priceErrors}`);
        await writePriceCache(cache);
      }
    }
  }

  await Promise.all(
    Array.from({ length: PRICE_CONCURRENCY }, (_, i) => worker(i + 1))
  );

  await writePriceCache(cache);

  return {
    pricedCards: completed,
    cardsWithPrice,
    cardsWithoutPrice: cards.length - cardsWithPrice,
    cardsWithStalePrice,
    priceErrors
  };
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
        image_url: bp.image_url || ''
      };

      const card = {
        ...baseCard,
        q: buildSearchText(
          baseCard.name,
          baseCard.collector_number,
          baseCard.rarity,
          baseCard.version,
          baseCard.set_name,
          baseCard.set_code
        )
      };

      allCards.push(card);
    }
  }

  const priceMeta = await attachPrices(allCards);

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
    pricesIncluded: INCLUDE_PRICES,
    priceMeta,
    indexVersion: 4
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
  console.log(`Prezzi: ${priceMeta.cardsWithPrice}/${allCards.length} carte con prezzo.`);

  if (skippedExpansions.length) {
    console.warn(`Espansioni saltate perché non pronte: ${skippedExpansions.length}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
