const express = require('express');
const db = require('../db');
const cache = require('../cache');

const router = express.Router();

const VALID_TYPES = new Set(['bank', 'remittance', 'exchange']);

const HIDDEN = new Set([
  'Cambio Extranjero', 'SCT', 'Taveras', 'Moneycorps',
  'Banco Central', 'DGII', 'Panora Exchange', 'Gamelin', 'Quezada', 'RM',
]);

/**
 * GET /rates
 * GET /rates?type=bank
 * GET /rates?type=remittance
 *
 * Sorting:
 *   Default (no direction) → sorted by best buy_rate DESC, then sell_rate ASC
 *   ?sort=buy  → highest buy_rate first  (who pays you most)
 *   ?sort=sell → lowest sell_rate first  (who charges you least)
 */
router.get('/', (req, res) => {
  const { type, sort } = req.query;

  if (type && !VALID_TYPES.has(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${[...VALID_TYPES].join(', ')}` });
  }

  const cacheKey = `rates:${type ?? 'all'}:${sort ?? 'default'}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  let query = 'SELECT * FROM rates WHERE 1=1';
  const params = [];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  // Rows with null rates (e.g. WU fallback stub) sort to the bottom via NULLS LAST
  if (sort === 'sell') {
    query += ' ORDER BY sell_rate ASC NULLS LAST';
  } else {
    query += ' ORDER BY buy_rate DESC NULLS LAST, sell_rate ASC NULLS LAST';
  }

  const rows = db.prepare(query).all(...params).filter((r) => !HIDDEN.has(r.name));
  const result = { count: rows.length, data: rows };

  cache.set(cacheKey, result);
  res.json(result);
});

/**
 * GET /rates/best
 * Returns the single best buy rate and the single best sell rate.
 * Used by home screen widgets.
 */
router.get('/best', (req, res) => {
  const cached = cache.get('rates:best');
  if (cached) return res.json(cached);

  const bestBuy = db
    .prepare('SELECT * FROM rates WHERE buy_rate IS NOT NULL ORDER BY buy_rate DESC LIMIT 1')
    .get();

  const bestSell = db
    .prepare('SELECT * FROM rates WHERE sell_rate IS NOT NULL ORDER BY sell_rate ASC LIMIT 1')
    .get();

  const result = {
    best_buy: bestBuy ?? null,
    best_sell: bestSell ?? null,
  };

  cache.set('rates:best', result);
  res.json(result);
});

/**
 * POST /rates/update-wu
 * Manually push a live Western Union rate (called from mobile app or admin).
 * Flushes cache so the next GET /rates reflects the new value immediately.
 */
router.post('/update-wu', (req, res) => {
  const { rate, fee, receive_amount } = req.body;

  if (!rate || isNaN(rate)) {
    return res.status(400).json({ error: 'Invalid rate' });
  }

  const now = new Date().toISOString();

  db.prepare(`
    UPDATE rates
    SET buy_rate = ?, sell_rate = ?, fee = ?, receive_amount = ?,
        status = 'live', source = 'wu_api', last_updated = ?
    WHERE name LIKE '%Western%'
  `).run(parseFloat(rate), parseFloat(rate), fee ?? null, receive_amount ?? null, now);

  cache.flushAll();

  res.json({ success: true, rate: parseFloat(rate), updated_at: now });
});

/**
 * GET /rates/history?days=7
 * Returns flat rows ordered by time ascending.
 */
router.get('/history', (req, res) => {
  const days  = parseInt(req.query.days) || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT recorded_at, institution, buy_rate, sell_rate
    FROM   rate_history
    WHERE  recorded_at >= ?
    ORDER  BY recorded_at ASC
  `).all(since);

  res.json({ count: rows.length, data: rows });
});

module.exports = router;
