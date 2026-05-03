const db = require('../db');
const cache = require('../cache');
const { fetchTasareal } = require('./tasareal');
const { scrapeBanreservas } = require('../scrapers/banreservas');
const { scrapeBancentral } = require('../scrapers/bancentral');
const { scrapeRemesas } = require('../scrapers/remesas');

let lastSyncTimestamp = null;

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
      upsert.run({
        receive_amount: null,
        status: 'live',
        ...entity,
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

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getLastSyncTimestamp() {
  return lastSyncTimestamp;
}

module.exports = { runSync, getLastSyncTimestamp };
