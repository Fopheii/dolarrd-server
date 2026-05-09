/**
 * One-time import: fetches 365 days of TasaReal history per institution and
 * inserts a daily weighted market average for 'Mercado' into rate_history.
 *
 * Weights (normalised automatically if an institution is unavailable):
 *   Banco Popular   25%
 *   Banreservas     25%
 *   BHD León        20%
 *   Caribe Express  15%
 *   Western Union   10%  (skipped — not in API; weight redistributed)
 *   Vimenca          5%
 *
 * Existing dates are skipped — safe to re-run.
 *
 * Usage: node scripts/import-history.js
 */

const path  = require('path');
const axios = require('axios');
const db    = require(path.join(__dirname, '../src/db'));

const BASE_URL = 'https://tasareal.com/api/v1';
const API_KEY  = 'tcrd_7UHk7ktrWzse205CIeGX3v2c64XY15gVbtonXAO9w5BjRFcs';

// Institution IDs from TasaReal + weights. Weight normalised automatically.
const INSTITUTIONS = [
  { id: 'popular',  weight: 0.25 },
  { id: 'reservas', weight: 0.25 },
  { id: 'bhd',      weight: 0.20 },
  { id: 'caribe',   weight: 0.15 },
  { id: 'vimenca',  weight: 0.05 },
];

const DAYS = 365;

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchInstitutionHistory(id, from, to) {
  const { data } = await axios.get(`${BASE_URL}/rates/history`, {
    params:  { institution: id, currency: 'USD', from, to },
    headers: { Authorization: `Bearer ${API_KEY}` },
    timeout: 30000,
  });
  // Response shape: { data: [ { date, buy, sell, verified }, ... ] }
  const rows = data.data ?? data.history ?? data.rates ?? [];
  return rows;
}

async function main() {
  // Existing Mercado dates → skip
  const existing = new Set(
    db.prepare(`SELECT recorded_at FROM rate_history WHERE institution = 'Mercado'`)
      .all()
      .map(r => r.recorded_at.slice(0, 10))
  );
  console.log(`[import] ${existing.size} date(s) already in DB — will skip.`);

  const to   = toISO(new Date());
  const from = toISO(new Date(Date.now() - DAYS * 86400000));
  console.log(`[import] Fetching history from ${from} to ${to} for ${INSTITUTIONS.length} institutions…`);

  // byDate: Map<dateStr, Array<{ weight, buy, sell }>>
  const byDate = new Map();

  for (const inst of INSTITUTIONS) {
    let rows;
    try {
      rows = await fetchInstitutionHistory(inst.id, from, to);
      console.log(`  [${inst.id}] ${rows.length} row(s)`);
    } catch (err) {
      console.warn(`  [${inst.id}] Fetch failed: ${err.response?.status ?? err.message} — skipping`);
      continue;
    }

    for (const row of rows) {
      const date = (row.date ?? '').slice(0, 10);
      if (!date) continue;

      const buy  = parseFloat(row.buy  ?? row.buy_rate  ?? 0) || null;
      const sell = parseFloat(row.sell ?? row.sell_rate ?? 0) || null;
      if (buy == null) continue;

      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ weight: inst.weight, buy, sell });
    }
  }

  console.log(`[import] Aggregated ${byDate.size} date(s).`);

  const insert = db.prepare(`
    INSERT INTO rate_history (institution, buy_rate, sell_rate, recorded_at)
    VALUES (@institution, @buy_rate, @sell_rate, @recorded_at)
  `);

  const toInsert = [];
  let skipped    = 0;

  for (const [date, records] of [...byDate.entries()].sort()) {
    if (existing.has(date)) { skipped++; continue; }

    let totalWeight = 0;
    let weightedBuy  = 0;
    let weightedSell = 0;

    for (const r of records) {
      weightedBuy  += r.buy  * r.weight;
      weightedSell += (r.sell ?? r.buy + 2) * r.weight;
      totalWeight  += r.weight;
    }

    if (totalWeight === 0) {
      console.warn(`[import] No data for ${date} — skipping.`);
      continue;
    }

    // Normalise (handles missing institutions)
    const avgBuy  = parseFloat((weightedBuy  / totalWeight).toFixed(2));
    const avgSell = parseFloat((weightedSell / totalWeight).toFixed(2));

    toInsert.push({
      institution: 'Mercado',
      buy_rate:    avgBuy,
      sell_rate:   avgSell,
      recorded_at: `${date}T12:00:00.000Z`,
    });
  }

  if (!toInsert.length) {
    console.log('[import] Nothing new to insert.');
    return;
  }

  db.transaction(rows => {
    for (const row of rows) insert.run(row);
  })(toInsert);

  console.log(`[import] ✓ Inserted ${toInsert.length} rows  |  Skipped ${skipped} existing.`);
  console.log(`[import] Buy-rate range: ${Math.min(...toInsert.map(r=>r.buy_rate)).toFixed(2)} – ${Math.max(...toInsert.map(r=>r.buy_rate)).toFixed(2)} DOP`);
}

main().catch(err => {
  console.error('[import] Fatal:', err.message);
  process.exit(1);
});
