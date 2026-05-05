/**
 * One-time seed: inserts 30 days of realistic USD/DOP data into rate_history.
 *
 * Frankfurter and other free public APIs don't carry DOP (Dominican Peso).
 * This script generates plausible day-by-day rates using a seeded random walk
 * anchored to the known USD/DOP range (≈ 58.5–60.5 in Apr–May 2026).
 *
 * Run once with: node scripts/seed-history.js
 */

const path = require('path');
const db   = require(path.join(__dirname, '../src/db'));

const INSTITUTION = 'Mercado';
const START_DATE  = '2026-04-01';
const END_DATE    = '2026-05-04';
const START_RATE  = 58.50;   // anchor for April 1

// Deterministic seeded PRNG (mulberry32) so re-runs produce the same values
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRates(startDate, endDate, startRate) {
  const rand   = mulberry32(0xDEADBEEF);
  const rows   = [];
  let   rate   = startRate;
  let   cursor = new Date(startDate + 'T00:00:00Z');
  const end    = new Date(endDate   + 'T00:00:00Z');

  while (cursor <= end) {
    // Daily drift: slight upward bias (peso has depreciated slowly) + noise
    const drift = 0.01;
    const noise = (rand() - 0.46) * 0.35;   // ±0.17 max, skewed slightly up
    rate = Math.max(57.50, Math.min(61.50, rate + drift + noise));

    rows.push({
      institution: INSTITUTION,
      buy_rate:    parseFloat(rate.toFixed(2)),
      sell_rate:   parseFloat((rate + 2.0).toFixed(2)),  // typical 2 DOP spread
      recorded_at: cursor.toISOString().replace('T00', 'T12'), // noon UTC
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return rows;
}

function main() {
  // Check for existing Mercado rows to avoid duplicates
  const existing = new Set(
    db.prepare(`SELECT recorded_at FROM rate_history WHERE institution = ?`)
      .all(INSTITUTION)
      .map(r => r.recorded_at.slice(0, 10))
  );

  const allRows = generateRates(START_DATE, END_DATE, START_RATE);
  const newRows = allRows.filter(r => !existing.has(r.recorded_at.slice(0, 10)));

  if (!newRows.length) {
    console.log('[seed] Nothing to insert — all dates already present.');
    return;
  }

  const insert = db.prepare(`
    INSERT INTO rate_history (institution, buy_rate, sell_rate, recorded_at)
    VALUES (@institution, @buy_rate, @sell_rate, @recorded_at)
  `);

  db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  })(newRows);

  console.log(`[seed] Inserted ${newRows.length} rows for "${INSTITUTION}" (${START_DATE} → ${END_DATE}).`);
  console.log(`[seed] Rate range: ${Math.min(...newRows.map(r=>r.buy_rate)).toFixed(2)} – ${Math.max(...newRows.map(r=>r.buy_rate)).toFixed(2)} DOP`);
}

main();
