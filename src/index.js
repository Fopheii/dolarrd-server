const fs = require('fs');
const path = require('path');

// Ensure data/ directory exists before DB initializes
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const cron = require('node-cron');
const app = require('./app');
const { runSync } = require('./services/sync');
const { sendDailyDigest } = require('./services/notifications');

const PORT = process.env.PORT || 3000;
// Sync every 5 minutes. Adjust via SYNC_CRON env var.
const SYNC_CRON = process.env.SYNC_CRON || '*/5 * * * *';

app.listen(PORT, async () => {
  console.log(`[server] Listening on port ${PORT}`);

  // Run an initial sync on startup so the DB is populated immediately
  try {
    await runSync();
  } catch (err) {
    console.error('[server] Initial sync error:', err.message);
  }

  cron.schedule(SYNC_CRON, async () => {
    try {
      await runSync();
    } catch (err) {
      console.error('[cron] Sync error:', err.message);
    }
  });

  // Daily digest at 9:00 AM (server local time — Contabo is UTC, RD is UTC-4)
  // '0 13 * * *' UTC = 9:00 AM Santo Domingo time
  cron.schedule('0 13 * * *', async () => {
    try {
      await sendDailyDigest();
    } catch (err) {
      console.error('[cron] Daily digest error:', err.message);
    }
  });

  console.log(`[server] Cron scheduled: ${SYNC_CRON} | Daily digest: 9:00 AM RD`);
});
