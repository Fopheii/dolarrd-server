const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * POST /alerts
 * Saves a price alert for later push notification delivery.
 *
 * Body: { entity_name, direction, threshold_rate, push_token }
 */
router.post('/', (req, res) => {
  const { entity_name, direction, threshold_rate, push_token } = req.body;

  if (!entity_name || typeof entity_name !== 'string') {
    return res.status(400).json({ error: 'entity_name is required' });
  }
  if (!['buy', 'sell'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "buy" or "sell"' });
  }
  const rate = parseFloat(threshold_rate);
  if (isNaN(rate) || rate <= 0) {
    return res.status(400).json({ error: 'threshold_rate must be a positive number' });
  }
  if (!push_token || typeof push_token !== 'string') {
    return res.status(400).json({ error: 'push_token is required' });
  }

  const stmt = db.prepare(`
    INSERT INTO alerts (entity_name, direction, threshold_rate, push_token, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const { lastInsertRowid } = stmt.run(
    entity_name.trim(),
    direction,
    rate,
    push_token.trim(),
    new Date().toISOString()
  );

  res.status(201).json({ id: lastInsertRowid, message: 'Alert saved' });
});

module.exports = router;
