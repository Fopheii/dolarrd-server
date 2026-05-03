const express = require('express');
const db = require('../db');
const { getLastSyncTimestamp } = require('../services/sync');

const router = express.Router();

/**
 * GET /health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    last_sync: getLastSyncTimestamp(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /sync/logs
 * Optional query params: ?limit=50&source=banreservas
 */
router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const { source } = req.query;

  let query = 'SELECT * FROM sync_logs';
  const params = [];

  if (source) {
    query += ' WHERE source = ?';
    params.push(source);
  }

  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params);
  res.json({ count: rows.length, data: rows });
});

module.exports = router;
