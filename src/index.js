const fs = require('fs');
const path = require('path');

// Ensure data/ directory exists before DB initializes
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const cron = require('node-cron');
const app = require('./app');
const { runSync } = require('./services/sync');

const PORT = process.env.PORT || 3000;
// Sync every 20 minutes. Adjust via SYNC_CRON env var.
const SYNC_CRON = process.env.SYNC_CRON || '*/20 * * * *';

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

  console.log(`[server] Cron scheduled: ${SYNC_CRON}`);
});
