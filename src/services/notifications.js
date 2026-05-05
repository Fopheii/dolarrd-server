/**
 * Smart notification service.
 *
 * Rules:
 *  1. Best-institution notification  — fired when a new #1 takes the lead
 *  2. Market movement notification   — fired when best rate shifts ±0.30+
 *  3. User alert notifications       — fired when user-defined threshold is crossed
 *
 * Frequency guard: rules 1 & 2 fire at most once per 8 hours (system-level).
 * User alerts fire every time their condition is satisfied (deduplicated by alert id).
 */

const db = require('../db');

const EXPO_PUSH_URL   = 'https://exp.host/--/api/v2/push/send';
const MOVE_THRESHOLD  = 0.30;   // minimum rate change to trigger market alert
const SYSTEM_COOLDOWN = 8 * 60 * 60 * 1000; // 8 hours in ms

// ── Persist state between sync cycles ─────────────────────────────────────────
// These survive process restarts via the notifications_state table (see ensureTable).
let _lastLeader    = null;   // name of the last #1 institution
let _lastBestRate  = null;   // best buy rate at last system notification
let _lastSystemTs  = 0;      // ms timestamp of last system (rule 1/2) notification

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notified_alerts (
      alert_id    INTEGER PRIMARY KEY,
      notified_at TEXT NOT NULL
    );
  `);

  const get = (k) => db.prepare('SELECT value FROM notification_state WHERE key = ?').get(k)?.value;
  _lastLeader   = get('last_leader')   ?? null;
  _lastBestRate = parseFloat(get('last_best_rate') ?? '0') || null;
  _lastSystemTs = parseInt(get('last_system_ts') ?? '0', 10) || 0;
}

function saveState(key, value) {
  db.prepare(`
    INSERT INTO notification_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ── Expo push sender ──────────────────────────────────────────────────────────
async function sendPush(tokens, title, body) {
  if (!tokens || tokens.length === 0) return;

  const messages = tokens.map((to) => ({ to, title, body, sound: 'default' }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(messages),
    });
    const json = await res.json();
    console.log(`[notify] Sent ${messages.length} push(es):`, json?.data?.map(d => d.status));
  } catch (err) {
    console.error('[notify] Push failed:', err.message);
  }
}

// Collect all unique push tokens from the alerts table
function getAllTokens() {
  return db.prepare('SELECT DISTINCT push_token FROM alerts').all().map(r => r.push_token);
}

// ── Rule 1 + 2: system notifications ─────────────────────────────────────────
async function checkSystemNotifications(rates) {
  if (!rates || rates.length === 0) return;

  const now = Date.now();
  if (now - _lastSystemTs < SYSTEM_COOLDOWN) return; // cooldown active

  // Find #1 by buy_rate
  const live = rates.filter(r => r.buy_rate != null && r.status !== 'stub');
  if (!live.length) return;
  live.sort((a, b) => b.buy_rate - a.buy_rate);
  const leader = live[0];

  const tokens = getAllTokens();
  if (!tokens.length) return;

  // Rule 1: leader changed
  if (_lastLeader && _lastLeader !== leader.name) {
    await sendPush(
      tokens,
      '🔄 Nueva mejor opción',
      `Ahora ${leader.name} da la mejor tasa: RD$ ${leader.buy_rate.toFixed(2)}`
    );
    _lastLeader   = leader.name;
    _lastBestRate = leader.buy_rate;
    _lastSystemTs = now;
    saveState('last_leader',    leader.name);
    saveState('last_best_rate', leader.buy_rate);
    saveState('last_system_ts', now);
    return; // only one system notification per cycle
  }

  // Rule 2: significant market movement (even if same leader)
  if (_lastBestRate != null) {
    const delta = leader.buy_rate - _lastBestRate;
    if (Math.abs(delta) >= MOVE_THRESHOLD) {
      const direction = delta > 0 ? '📈 sube' : '📉 baja';
      await sendPush(
        tokens,
        `El dólar ${direction}`,
        `${delta > 0 ? '+' : ''}${delta.toFixed(2)} hoy — mejor tasa: ${leader.name} (RD$ ${leader.buy_rate.toFixed(2)})`
      );
      _lastBestRate = leader.buy_rate;
      _lastSystemTs = now;
      saveState('last_best_rate', leader.buy_rate);
      saveState('last_system_ts', now);
      return;
    }
  }

  // Initialise state silently on first run
  if (!_lastLeader) {
    _lastLeader   = leader.name;
    _lastBestRate = leader.buy_rate;
    saveState('last_leader',    leader.name);
    saveState('last_best_rate', leader.buy_rate);
    console.log(`[notify] Initialised leader: ${leader.name} @ ${leader.buy_rate}`);
  }
}

// ── Rule 3: user alert notifications ─────────────────────────────────────────
async function checkUserAlerts(rates) {
  if (!rates || rates.length === 0) return;

  const alerts = db.prepare('SELECT * FROM alerts').all();
  if (!alerts.length) return;

  const alreadyNotified = new Set(
    db.prepare('SELECT alert_id FROM notified_alerts').all().map(r => r.alert_id)
  );

  const markNotified = db.prepare(`
    INSERT OR IGNORE INTO notified_alerts (alert_id, notified_at) VALUES (?, ?)
  `);

  for (const alert of alerts) {
    if (alreadyNotified.has(alert.id)) continue;

    // Match by entity_name (case-insensitive)
    const inst = rates.find(r =>
      r.name.toLowerCase() === alert.entity_name.toLowerCase()
    );
    if (!inst) continue;

    const currentRate = alert.direction === 'buy' ? inst.buy_rate : inst.sell_rate;
    if (currentRate == null) continue;

    const triggered =
      (alert.direction === 'buy'  && currentRate >= alert.threshold_rate) ||
      (alert.direction === 'sell' && currentRate <= alert.threshold_rate);

    if (!triggered) continue;

    await sendPush(
      [alert.push_token],
      '🚨 Alerta de tasa',
      `${inst.name} llegó a RD$ ${currentRate.toFixed(2)} como pediste`
    );

    markNotified.run(alert.id, new Date().toISOString());
    console.log(`[notify] User alert ${alert.id} fired for ${inst.name} @ ${currentRate}`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function runNotifications(rates) {
  try {
    ensureTable();
    await checkSystemNotifications(rates);
    await checkUserAlerts(rates);
  } catch (err) {
    console.error('[notify] Error:', err.message);
  }
}

module.exports = { runNotifications };
