const express = require('express');
const db      = require('../db');

const router = express.Router();

/**
 * POST /devices/register
 * Upsert an Expo push token so the server can send push notifications
 * even when the app is closed.
 *
 * Body: { token: "ExponentPushToken[...]" }
 */
router.post('/register', (req, res) => {
  const { token } = req.body;

  if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken')) {
    return res.status(400).json({ error: 'token must be a valid ExponentPushToken' });
  }

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO device_tokens (token, registered_at, last_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET last_seen = excluded.last_seen
  `).run(token.trim(), now, now);

  res.status(201).json({ ok: true });
});

/**
 * POST /devices/unregister
 * Remove a token — called when user disables notifications or on Expo InvalidCredentials receipt.
 *
 * Body: { token: "ExponentPushToken[...]" }
 */
router.post('/unregister', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  db.prepare('DELETE FROM device_tokens WHERE token = ?').run(token.trim());
  res.json({ ok: true });
});

module.exports = router;
