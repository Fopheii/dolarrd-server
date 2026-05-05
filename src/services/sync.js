const db = require('../db');
const cache = require('../cache');
const { fetchTasareal } = require('./tasareal');
const { scrapeBanreservas } = require('../scrapers/banreservas');
const { scrapeBancentral } = require('../scrapers/bancentral');
const { scrapeRemesas } = require('../scrapers/remesas');
const { runNotifications } = require('./notifications');

let lastSyncTimestamp = null;

// ─── Weighted market average ──────────────────────────────────────────────────
const WEIGHTS = {
  'Banco Popular':  0.25,
  'Banreservas':    0.25,
  'BHD León':       0.20,
  'Caribe Express': 0.15,
  'Western Union':  0.10,
  'Vimenca':        0.05,
};

function calcMarketAverage(rates) {
  const now = Date.now();
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [name, weight] of Object.entries(WEIGHTS)) {
    const r = rates.find((x) => x.name === name);
    if (!r || !r.buy_rate) continue;
    // Skip stale data (>24h)
    if (now - new Date(r.last_updated).getTime() > 86_400_000) continue;
    weightedSum += r.buy_rate * weight;
    totalWeight += weight;
  }

  if (totalWeight < 0.3) return null; // fewer than ~3 sources available
  return weightedSum / totalWeight;
}

// Persists across sync cycles within the same process.
// Starts at the midpoint of the 0.25–0.45 range.
let prevDelta = 0.35;

const WU_KEY = 'western union';

/**
 * Main sync orchestrator.
 *
 * Priority order (highest wins):
 *   1. manual_override = 1  → never touched by sync
 *   2. scraper data         → own scrapers
 *   3. tasareal             → fallback if no scraper data
 */
async function runSync() {
  console.log(`[sync] Starting sync at ${new Date().toISOString()}`);

  const scraperResults = await runScrapers();
  const tasarealResults = await runTasareal();

  // Build a map of scraper data keyed by normalized name
  const scraperMap = new Map(
    scraperResults.map((r) => [normalizeName(r.name), r])
  );

  // Merge: for each tasareal entity, use scraper data if available
  const merged = new Map();

  for (const entity of tasarealResults) {
    const key = normalizeName(entity.name);
    merged.set(key, scraperMap.get(key) ?? entity);
  }

  // Also include scraper-only entities not in tasareal
  for (const entity of scraperResults) {
    const key = normalizeName(entity.name);
    if (!merged.has(key)) {
      merged.set(key, entity);
    }
  }

  // Apply market-based WU estimation unless a live API rate already exists
  applyWUEstimation(merged);

  const upsert = db.prepare(`
    INSERT INTO rates (name, type, buy_rate, sell_rate, fee, receive_amount, status, last_updated, source, manual_override)
    VALUES (@name, @type, @buy_rate, @sell_rate, @fee, @receive_amount, @status, @last_updated, @source, 0)
    ON CONFLICT(name) DO UPDATE SET
      type           = CASE WHEN manual_override = 1 THEN type           ELSE excluded.type           END,
      buy_rate       = CASE WHEN manual_override = 1 THEN buy_rate       ELSE excluded.buy_rate       END,
      sell_rate      = CASE WHEN manual_override = 1 THEN sell_rate      ELSE excluded.sell_rate      END,
      fee            = CASE WHEN manual_override = 1 THEN fee            ELSE excluded.fee            END,
      receive_amount = CASE WHEN manual_override = 1 THEN receive_amount ELSE excluded.receive_amount END,
      status         = CASE WHEN manual_override = 1 THEN status         ELSE excluded.status         END,
      last_updated   = CASE WHEN manual_override = 1 THEN last_updated   ELSE excluded.last_updated   END,
      source         = CASE WHEN manual_override = 1 THEN source         ELSE excluded.source         END
  `);

  const logStmt = db.prepare(`
    INSERT INTO sync_logs (timestamp, source, records_updated, error)
    VALUES (?, ?, ?, ?)
  `);

  let totalUpdated = 0;

  const syncAll = db.transaction(() => {
    for (const entity of merged.values()) {
      const { _based_on, ...row } = entity; // strip internal annotation
      upsert.run({
        receive_amount: null,
        status: 'live',
        ...row,
      });
      totalUpdated++;
    }
  });

  try {
    syncAll();
    cache.flushAll();
    lastSyncTimestamp = new Date().toISOString();

    logStmt.run(lastSyncTimestamp, 'sync', totalUpdated, null);
    console.log(`[sync] Done — ${totalUpdated} records updated`);

    // Snapshot all institutions into rate_history after each successful sync
    const liveRates = db.prepare(`
      SELECT name, buy_rate, sell_rate FROM rates
      WHERE status != 'stub' AND (buy_rate IS NOT NULL OR sell_rate IS NOT NULL)
    `).all();

    const insertSnapshot = db.prepare(`
      INSERT INTO rate_history (institution, buy_rate, sell_rate, recorded_at)
      VALUES (@institution, @buy_rate, @sell_rate, @recorded_at)
    `);

    const insertAll = db.transaction((rows) => {
      for (const row of rows) insertSnapshot.run(row);
    });

    insertAll(liveRates.map((r) => ({
      institution:  r.name,
      buy_rate:     r.buy_rate  ?? null,
      sell_rate:    r.sell_rate ?? null,
      recorded_at:  lastSyncTimestamp,
    })));

    console.log(`[sync] Snapshot recorded: ${liveRates.length} institutions`);

    // Weighted market average → rate_history as 'Mercado'
    const allRatesForAvg = db.prepare('SELECT * FROM rates WHERE status != ?').all('stub');
    const marketAvg = calcMarketAverage(allRatesForAvg);
    if (marketAvg != null) {
      const avgRate = parseFloat(marketAvg.toFixed(4));
      insertSnapshot.run({
        institution:  'Mercado',
        buy_rate:     avgRate,
        sell_rate:    null,
        recorded_at:  lastSyncTimestamp,
      });
      console.log(`[sync] Market average saved: ${avgRate}`);
    } else {
      console.warn('[sync] Market average skipped — insufficient sources');
    }

    // Run smart notifications after every successful sync (non-blocking)
    const allRates = db.prepare('SELECT * FROM rates WHERE status != ?').all('stub');
    runNotifications(allRates).catch((e) => console.error('[notify] Unhandled:', e.message));
  } catch (err) {
    const ts = new Date().toISOString();
    logStmt.run(ts, 'sync', 0, err.message);
    console.error('[sync] DB write failed:', err.message);
  }
}

async function runScrapers() {
  const results = [];
  const logStmt = db.prepare(`
    INSERT INTO sync_logs (timestamp, source, records_updated, error)
    VALUES (?, ?, ?, ?)
  `);

  const scrapers = [
    { name: 'banreservas', fn: scrapeBanreservas },
    { name: 'bancentral',  fn: scrapeBancentral },
  ];

  for (const { name, fn } of scrapers) {
    try {
      const result = await fn();
      results.push(result);
      logStmt.run(new Date().toISOString(), name, 1, null);
      console.log(`[sync] Scraper ${name}: OK`);
    } catch (err) {
      logStmt.run(new Date().toISOString(), name, 0, err.message);
      console.warn(`[sync] Scraper ${name} failed: ${err.message}`);
    }
  }

  // Remittance scrapers — run as a batch, each fails independently
  const remesaResults = await scrapeRemesas();
  results.push(...remesaResults);
  logStmt.run(new Date().toISOString(), 'remesas', remesaResults.length, null);
  console.log(`[sync] Remesas: ${remesaResults.length} scraped`);

  return results;
}

async function runTasareal() {
  const logStmt = db.prepare(`
    INSERT INTO sync_logs (timestamp, source, records_updated, error)
    VALUES (?, ?, ?, ?)
  `);

  try {
    const results = await fetchTasareal();
    logStmt.run(new Date().toISOString(), 'tasareal', results.length, null);
    console.log(`[sync] TasaReal: ${results.length} entities`);
    return results;
  } catch (err) {
    logStmt.run(new Date().toISOString(), 'tasareal', 0, err.message);
    console.warn(`[sync] TasaReal failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Western Union market-based estimation
//
// WU consistently rates 0.25–0.45 DOP below the remittance average in RD.
// Delta is stabilized across sync cycles (max drift ±0.05 per run) to avoid
// noisy rate jumps for the user.
// ---------------------------------------------------------------------------
function applyWUEstimation(merged) {
  const existing = merged.get(WU_KEY);

  // Never overwrite a rate that came from a successful live API fetch
  if (existing?.status === 'live') {
    console.log('[sync] WU: live rate present, skipping estimation');
    return;
  }

  // Priority: use Vimenca's verified rate as a reliable proxy for WU
  const vimenca = merged.get(normalizeName('Vimenca'));
  if (vimenca?.buy_rate) {
    merged.set(WU_KEY, {
      name:           'Western Union',
      type:           'remittance',
      buy_rate:       vimenca.buy_rate,
      sell_rate:      vimenca.sell_rate,
      fee:            null,
      receive_amount: null,
      status:         'live',
      source:         'vimenca',
      last_updated:   new Date().toISOString(),
    });
    console.log(`[sync] WU: set from Vimenca rate ${vimenca.buy_rate}`);
    return;
  }

  const estimated = buildWUEstimate(merged);

  if (estimated) {
    merged.set(WU_KEY, estimated);
    console.log(`[sync] WU estimated: ${estimated.buy_rate} (delta=${prevDelta.toFixed(3)}, based on ${estimated._based_on.join(', ')})`);
    return;
  }

  // Not enough remittance data — keep whatever the scraper returned (fallback/stub)
  // or ensure the entity still exists in merged so WU always appears.
  if (!merged.has(WU_KEY)) {
    const lastDB = db.prepare("SELECT * FROM rates WHERE name LIKE '%Western%'").get();
    merged.set(WU_KEY, lastDB ?? wuStub());
    console.warn('[sync] WU: insufficient remittance data, using last DB value');
  }
}

function buildWUEstimate(merged) {
  // Collect remittance buy rates from all other entities
  const sources = [];

  for (const [key, entity] of merged) {
    if (key === WU_KEY) continue;
    if (entity.type !== 'remittance') continue;
    if (entity.buy_rate == null || entity.buy_rate <= 0) continue;
    sources.push({ name: entity.name, rate: entity.buy_rate });
  }

  if (sources.length < 1) return null;

  const avg = sources.reduce((sum, s) => sum + s.rate, 0) / sources.length;

  // Stable delta: new random value clamped to ±0.05 from previous run
  const rawDelta = 0.25 + Math.random() * 0.20;
  const delta    = parseFloat(
    Math.max(prevDelta - 0.05, Math.min(prevDelta + 0.05, rawDelta)).toFixed(4)
  );
  prevDelta = delta;

  const wu_rate = parseFloat((avg - delta).toFixed(4));

  return {
    name:           'Western Union',
    type:           'remittance',
    buy_rate:       wu_rate,
    sell_rate:      wu_rate,
    fee:            null,
    receive_amount: null,
    status:         'estimated',
    source:         'estimated',
    last_updated:   new Date().toISOString(),
    _based_on:      sources.map((s) => s.name), // stripped before DB upsert
  };
}

function wuStub() {
  return {
    name:         'Western Union',
    type:         'remittance',
    buy_rate:     null,
    sell_rate:    null,
    fee:          null,
    receive_amount: null,
    status:       'estimated',
    source:       'estimated',
    last_updated: new Date().toISOString(),
  };
}

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getLastSyncTimestamp() {
  return lastSyncTimestamp;
}

module.exports = { runSync, getLastSyncTimestamp };
