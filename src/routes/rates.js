const express = require('express');
const db = require('../db');
const cache = require('../cache');

const router = express.Router();

const VALID_TYPES = new Set(['bank', 'remittance', 'exchange']);

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

  if (sort === 'sell') {
    query += ' AND sell_rate IS NOT NULL ORDER BY sell_rate ASC';
  } else {
    // Default: best buy rate first (highest), then best sell rate (lowest)
    query += ' AND buy_rate IS NOT NULL ORDER BY buy_rate DESC, sell_rate ASC';
  }

  const rows = db.prepare(query).all(...params);
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

module.exports = router;
