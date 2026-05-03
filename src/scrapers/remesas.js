const axios = require('axios');
const cheerio = require('cheerio');
const cache = require('../cache');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'es-DO,es;q=0.9,en;q=0.8',
};

const db = require('../db');

const WU_CACHE_KEY = 'scraper:western_union';
const WU_CACHE_TTL = 60 * 60 * 3; // 3 hours — minimum refresh interval

// ---------------------------------------------------------------------------
// Caribe Express
// The homepage has .plan blocks with <h3> labels and a .value span (compra).
// Only the buy rate (compra) is published; sell_rate is not shown.
// ---------------------------------------------------------------------------
async function scrapeCaribe() {
  const { data: html } = await axios.get('https://www.caribeexpress.com.do', {
    headers: HEADERS,
    timeout: 15000,
  });

  const $ = cheerio.load(html);
  let buy_rate = null;

  $('.plan').each((_, el) => {
    const label = $(el).find('h3').text().trim().toUpperCase();
    if (label.includes('DOLAR')) {
      const raw = $(el).find('.value').text().replace(/[^\d.]/g, '').trim();
      const parsed = parseFloat(raw);
      if (!isNaN(parsed)) buy_rate = parsed;
      return false; // break
    }
  });

  if (buy_rate === null) throw new Error('Caribe Express: USD buy rate not found');

  return result('Caribe Express', buy_rate, null);
}

// ---------------------------------------------------------------------------
// Western Union RD
// Resilient strategy: always returns a valid object — never null.
//   1. Check 3-hour cache → return immediately if warm
//   2. Try each endpoint in order; on first JSON success extract rate
//   3. If all endpoints fail or return no extractable rate:
//      → return last DB row with status "fallback"
//   4. If DB is also empty (first ever run):
//      → return a stub with null rates so WU still appears in results
// ---------------------------------------------------------------------------
async function scrapeWesternUnion() {
  const cached = cache.get(WU_CACHE_KEY);
  if (cached) {
    console.log('[remesas] western_union: serving from 3h cache');
    return cached;
  }

  const amounts = [100, 200, 300, 500];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    'Accept': 'application/json',
    'Accept-Language': 'es-DO,es;q=0.9,en;q=0.8',
    'Referer': 'https://www.westernunion.com/do/es/home.html',
  };

  const urls = [
    `https://www.westernunion.com/us/en/send-money/app/price-estimation?D_A=DO&D_C=DOP&O_A=US&O_C=USD&transferType=PP&amount=${amount}`,
    `https://www.westernunion.com/content/dam/wu/legacy-bootstrap/price-estimation?origination_country=US&destination_country=DO&origination_currency=USD&destination_currency=DOP&amount=${amount}`,
    `https://www.westernunion.com/wuconnect/rest/priceEstimation?fromCountry=US&toCountry=DO&amount=${amount}&currency=USD`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers });

      if (!res.ok) {
        console.warn(`[remesas] WU ${url.split('?')[0]} → HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();

      const rate =
        data?.pricingInfo?.exchangeRate ||
        data?.pricingInfo?.fxRate       ||
        data?.fxRate                    ||
        data?.exchange_rate             ||
        null;

      if (!rate) {
        console.warn('[remesas] WU responded but no rate found:', JSON.stringify(data).substring(0, 200));
        continue;
      }

      const entry = {
        name:           'Western Union',
        type:           'remittance',
        buy_rate:       parseFloat(rate),
        sell_rate:      parseFloat(rate),
        fee:            data?.pricingInfo?.fee              ?? null,
        receive_amount: data?.pricingInfo?.destinationAmount ?? null,
        status:         'live',
        source:         'wu_api',
        last_updated:   new Date().toISOString(),
      };

      cache.set(WU_CACHE_KEY, entry, WU_CACHE_TTL);
      console.log(`[remesas] WU live rate: ${rate} (amount=${amount})`);
      return entry;
    } catch (e) {
      console.warn(`[remesas] WU ${url.split('?')[0]} → ${e.message}`);
    }
  }

  return wuFallback();
}

// Returns the last saved WU row from the DB with status "fallback".
// If the DB has no WU row yet (very first run, all endpoints failed),
// returns a stub so WU still appears in the API response.
function wuFallback() {
  const row = db.prepare('SELECT * FROM rates WHERE name = ?').get('Western Union');

  if (row) {
    console.log(`[remesas] WU fallback: using DB row from ${row.last_updated}`);
    return { ...row, status: 'fallback' };
  }

  console.warn('[remesas] WU fallback: no DB row yet, returning stub');
  return {
    name:           'Western Union',
    type:           'remittance',
    buy_rate:       null,
    sell_rate:      null,
    fee:            null,
    receive_amount: null,
    status:         'fallback',
    source:         'wu_api',
    last_updated:   new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Unitransfer
// Their server consistently times out to automated requests.
// ---------------------------------------------------------------------------
async function scrapeUnitransfer() {
  throw new Error('Unitransfer: server does not respond to automated requests');
}

// ---------------------------------------------------------------------------
// Viamericas
// Homepage loads via React/SPA — rates not present in static HTML.
// ---------------------------------------------------------------------------
async function scrapeViamericas() {
  throw new Error('Viamericas: page is JavaScript-rendered, not scrapeable statically');
}

// ---------------------------------------------------------------------------
// Small World
// Returns 403 Forbidden for all bot-like requests.
// ---------------------------------------------------------------------------
async function scrapeSmallWorld() {
  throw new Error('Small World: returns 403, bot-blocking in place');
}

// ---------------------------------------------------------------------------
// Run all scrapers — each failure is logged and skipped gracefully.
// ---------------------------------------------------------------------------
const SCRAPERS = [
  { key: 'caribe_express',  fn: scrapeCaribe },
  { key: 'western_union',   fn: scrapeWesternUnion },
  { key: 'unitransfer',     fn: scrapeUnitransfer },
  { key: 'viamericas',      fn: scrapeViamericas },
  { key: 'small_world',     fn: scrapeSmallWorld },
];

async function scrapeRemesas() {
  const results = [];

  for (const { key, fn } of SCRAPERS) {
    try {
      const data = await fn();
      if (data) results.push(data);
    } catch (err) {
      console.warn(`[remesas] ${key} skipped: ${err.message}`);
    }
  }

  return results;
}

function result(name, buy_rate, sell_rate) {
  return {
    name,
    type: 'remittance',
    buy_rate,
    sell_rate,
    fee: null,
    source: 'scraper',
    last_updated: new Date().toISOString(),
  };
}

module.exports = { scrapeRemesas, scrapeWesternUnion, scrapeCaribe };
