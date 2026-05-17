/**
 * Push notification service — server-side delivery via Expo Push API.
 *
 * Notification types (all in Spanish):
 *  1. Market movement  — fires when market average shifts ≥ 0.50 DOP
 *  2. Best-rate leader — fires when a new institution takes the top spot
 *  3. Daily digest     — best rate of the day, sent at 9 AM (triggered by cron)
 *  4. User alerts      — custom threshold alerts registered via POST /alerts
 *
 * Frequency guards:
 *  - Rules 1 & 2 share an 8-hour cooldown (one system alert per 8 h max)
 *  - Rule 4 fires once per alert (stored in notified_alerts) — auto-resets daily
 *
 * Invalid tokens returned by Expo are automatically purged from device_tokens.
 */

const db = require('../db');

const EXPO_PUSH_URL   = 'https://exp.host/--/api/v2/push/send';
const MOVE_THRESHOLD  = 0.50;                  // RD$ — triggers market movement alert
const SYSTEM_COOLDOWN = 8 * 60 * 60 * 1000;   // 8 hours in ms

// ── In-process state (also persisted in notification_state) ───────────────────
let _lastLeader   = null;
let _lastBestRate = null;
let _lastSystemTs = 0;

// ── Schema bootstrap ──────────────────────────────────────────────────────────
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
  _lastSystemTs = parseInt(get('last_system_ts')   ?? '0', 10) || 0;
}

function saveState(key, value) {
  db.prepare(`
    INSERT INTO notification_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ── Token helpers ─────────────────────────────────────────────────────────────
function getAllDeviceTokens() {
  return db.prepare('SELECT token FROM device_tokens').all().map((r) => r.token);
}

/**
 * Purge tokens that Expo says are no longer valid.
 * Called after every batch push.
 */
function purgeInvalidTokens(tokens, expoData) {
  if (!Array.isArray(expoData)) return;
  expoData.forEach((receipt, i) => {
    if (
      receipt.status === 'error' &&
      (receipt.details?.error === 'DeviceNotRegistered' ||
       receipt.details?.error === 'InvalidCredentials')
    ) {
      const bad = tokens[i];
      if (bad) {
        db.prepare('DELETE FROM device_tokens WHERE token = ?').run(bad);
        db.prepare('DELETE FROM alerts WHERE push_token = ?').run(bad);
        console.log(`[notify] Purged invalid token: ${bad.slice(0, 30)}…`);
      }
    }
  });
}

// ── Expo push sender ──────────────────────────────────────────────────────────
/**
 * Send a batch of push notifications via Expo's Push API.
 * Automatically removes invalid tokens from the DB.
 */
async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    title,
    body,
    sound: 'default',
    data,
  }));

  try {
    const res  = await fetch(EXPO_PUSH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify(messages),
    });
    const json = await res.json();
    const statuses = (json?.data ?? []).map((d) => d.status);
    console.log(`[notify] Sent ${messages.length} push(es):`, statuses);
    purgeInvalidTokens(tokens, json?.data);
  } catch (err) {
    console.error('[notify] Push failed:', err.message);
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
/**
 * Format a DOP rate delta into natural Spanish.
 * 0.60  →  "60 centavos"
 * 1.20  →  "1 peso con 20 centavos"
 * 2.00  →  "2 pesos"
 */
function formatDelta(delta) {
  const abs       = Math.abs(delta);
  const pesos     = Math.floor(abs);
  const centavos  = Math.round((abs - pesos) * 100);

  if (pesos === 0) {
    return `${centavos} centavo${centavos !== 1 ? 's' : ''}`;
  }
  if (centavos === 0) {
    return `${pesos} peso${pesos !== 1 ? 's' : ''}`;
  }
  return `${pesos} peso${pesos !== 1 ? 's' : ''} con ${centavos} centavos`;
}

// ── Rule 1 + 2: system notifications (market movement / leader change) ────────
async function checkSystemNotifications(rates) {
  if (!rates || rates.length === 0) return;

  const now = Date.now();
  if (now - _lastSystemTs < SYSTEM_COOLDOWN) return; // cooldown active

  const live = rates.filter((r) => r.buy_rate != null && r.status !== 'stub');
  if (!live.length) return;
  live.sort((a, b) => b.buy_rate - a.buy_rate);
  const leader = live[0];

  const tokens = getAllDeviceTokens();
  if (!tokens.length) return;

  // Rule 1: leader changed → announce new best institution
  if (_lastLeader && _lastLeader !== leader.name) {
    await sendPush(
      tokens,
      `⭐ Nueva mejor tasa disponible`,
      `${leader.name} ofrece RD$${leader.buy_rate.toFixed(2)} — la mejor opción ahora mismo.`,
      { screen: 'Inicio' }
    );
    _lastLeader   = leader.name;
    _lastBestRate = leader.buy_rate;
    _lastSystemTs = now;
    saveState('last_leader',    leader.name);
    saveState('last_best_rate', leader.buy_rate);
    saveState('last_system_ts', now);
    return;
  }

  // Rule 2: significant market movement
  if (_lastBestRate != null) {
    const delta = leader.buy_rate - _lastBestRate;
    if (Math.abs(delta) >= MOVE_THRESHOLD) {
      const subio = delta > 0;
      const emoji = subio ? '📈' : '📉';
      const verb  = subio ? 'subió' : 'bajó';
      const amount = formatDelta(delta);

      await sendPush(
        tokens,
        `${emoji} El dólar ${verb} ${amount}`,
        `La mejor tasa ahora es RD$${leader.buy_rate.toFixed(2)} en ${leader.name}.`,
        { screen: 'Inicio' }
      );
      _lastBestRate = leader.buy_rate;
      _lastSystemTs = now;
      saveState('last_best_rate', leader.buy_rate);
      saveState('last_system_ts', now);
      return;
    }
  }

  // First run — initialise state silently, no push
  if (!_lastLeader) {
    _lastLeader   = leader.name;
    _lastBestRate = leader.buy_rate;
    saveState('last_leader',    leader.name);
    saveState('last_best_rate', leader.buy_rate);
    console.log(`[notify] Initialised: ${leader.name} @ ${leader.buy_rate}`);
  }
}

// ── Rule 3: daily digest (called by 9 AM cron in index.js) ───────────────────
async function sendDailyDigest() {
  ensureTable();

  const tokens = getAllDeviceTokens();
  if (!tokens.length) {
    console.log('[notify] Daily digest: no registered devices.');
    return;
  }

  const live = db
    .prepare(`SELECT * FROM rates WHERE status != 'stub' AND buy_rate IS NOT NULL ORDER BY buy_rate DESC LIMIT 1`)
    .get();

  if (!live) {
    console.log('[notify] Daily digest: no live rate data.');
    return;
  }

  await sendPush(
    tokens,
    `⭐ La mejor tasa hoy es RD$${live.buy_rate.toFixed(2)}`,
    `${live.name} ofrece la tasa más alta del mercado ahora mismo. ¡Abre la app para ver todos los cambios!`,
    { screen: 'Inicio' }
  );

  console.log(`[notify] Daily digest sent to ${tokens.length} device(s): ${live.name} @ ${live.buy_rate}`);
}

// ── Rule 4: user custom alert notifications ───────────────────────────────────
async function checkUserAlerts(rates) {
  if (!rates || rates.length === 0) return;

  const alerts = db.prepare('SELECT * FROM alerts').all();
  if (!alerts.length) return;

  const alreadyNotified = new Set(
    db.prepare('SELECT alert_id FROM notified_alerts').all().map((r) => r.alert_id)
  );

  // Reset triggered alerts daily (so they can fire again the next day)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM notified_alerts WHERE notified_at < ?').run(cutoff);

  const markNotified = db.prepare(`
    INSERT OR IGNORE INTO notified_alerts (alert_id, notified_at) VALUES (?, ?)
  `);

  for (const alert of alerts) {
    if (alreadyNotified.has(alert.id)) continue;

    const inst = rates.find(
      (r) => r.name.toLowerCase() === alert.entity_name.toLowerCase()
    );
    if (!inst) continue;

    const currentRate = alert.direction === 'buy' ? inst.buy_rate : inst.sell_rate;
    if (currentRate == null) continue;

    // buy alerts fire when rate reaches or exceeds threshold
    // sell alerts fire when rate drops to or below threshold
    const triggered =
      (alert.direction === 'buy'  && currentRate >= alert.threshold_rate) ||
      (alert.direction === 'sell' && currentRate <= alert.threshold_rate);

    if (!triggered) continue;

    const symbol = alert.direction === 'buy' ? '📈' : '📉';
    const label  = alert.direction === 'buy' ? 'compra' : 'venta';

    await sendPush(
      [alert.push_token],
      `🔔 Tu alerta se activó`,
      `${inst.name} llegó a RD$${currentRate.toFixed(2)} de ${label}. ¡Es tu momento!`,
      { screen: 'Inicio', alertId: alert.id }
    );

    markNotified.run(alert.id, new Date().toISOString());
    console.log(`[notify] User alert ${alert.id} fired: ${inst.name} @ ${currentRate}`);
  }
}

// ── Rule 5: smart historical alerts (30-day high / low) ──────────────────────
//
// Fires at most ONCE PER DAY. Compares the current best market rate against
// the 30-day min/max from rate_history (Mercado weighted average).
// Threshold: rate must be within the bottom or top 10% of the 30-day range.
//
// Messages (Spanish only):
//   Low  → "📉 El dólar está en su punto más bajo en 30 días. RD$X — buen momento para comprar."
//   High → "📈 El dólar está en su punto más alto en 30 días. RD$X"

// Institutions excluded from "best market rate" calculation (same as routes/rates.js HIDDEN)
const SMART_HIDDEN = new Set([
  'Cambio Extranjero', 'SCT', 'Taveras', 'Moneycorps',
  'Banco Central', 'DGII', 'Panora Exchange', 'Gamelin', 'Quezada', 'RM',
]);

async function checkSmartAlerts(rates) {
  if (!rates || rates.length === 0) return;

  // Once-per-day guard — store today's ISO date string in notification_state
  const today    = new Date().toISOString().slice(0, 10); // "2026-05-17"
  const lastDate = db.prepare(
    'SELECT value FROM notification_state WHERE key = ?'
  ).get('smart_alert_date')?.value;
  if (lastDate === today) return;

  // Current best visible buy rate
  const visible = rates
    .filter((r) => r.buy_rate != null && r.status !== 'stub' && !SMART_HIDDEN.has(r.name))
    .sort((a, b) => b.buy_rate - a.buy_rate);
  if (!visible.length) return;

  const currentRate = visible[0].buy_rate;

  // Last 30 days of Mercado weighted-average history
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const history = db.prepare(`
    SELECT buy_rate FROM rate_history
    WHERE  institution = 'Mercado'
      AND  recorded_at >= ?
      AND  buy_rate    IS NOT NULL
    ORDER  BY recorded_at ASC
  `).all(since);

  // Need at least 7 data points to be meaningful
  if (history.length < 7) return;

  const histRates = history.map((r) => r.buy_rate);
  const min30     = Math.min(...histRates);
  const max30     = Math.max(...histRates);
  const range     = max30 - min30;

  // Skip if market was essentially flat (< 0.10 DOP range over 30 days)
  if (range < 0.10) return;

  const tokens = getAllDeviceTokens();
  if (!tokens.length) return;

  // Bottom 10% of 30-day range → historic low alert
  const lowThreshold  = min30 + range * 0.10;
  // Top 10% of 30-day range → historic high alert
  const highThreshold = max30 - range * 0.10;

  let title, body;

  if (currentRate <= lowThreshold) {
    title = `📉 El dólar en su punto más bajo en 30 días`;
    body  = `RD$${currentRate.toFixed(2)} — buen momento para comprar dólares ahora.`;
  } else if (currentRate >= highThreshold) {
    title = `📈 El dólar en su punto más alto en 30 días`;
    body  = `RD$${currentRate.toFixed(2)} — considera esperar si puedes.`;
  } else {
    return; // rate is in the middle range — no alert
  }

  await sendPush(tokens, title, body, { screen: 'Inicio' });
  saveState('smart_alert_date', today);
  console.log(`[notify] Smart alert sent (${currentRate.toFixed(2)} vs 30d range ${min30.toFixed(2)}–${max30.toFixed(2)}): ${title}`);
}

// ── Main entry point (called after every rate sync) ───────────────────────────
async function runNotifications(rates) {
  try {
    ensureTable();
    await checkSystemNotifications(rates);
    await checkSmartAlerts(rates);
    await checkUserAlerts(rates);
  } catch (err) {
    console.error('[notify] Error:', err.message);
  }
}

module.exports = { runNotifications, sendDailyDigest };
