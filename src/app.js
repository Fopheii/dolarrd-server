const express = require('express');
const ratesRouter   = require('./routes/rates');
const alertsRouter  = require('./routes/alerts');
const devicesRouter = require('./routes/devices');
const syncRouter    = require('./routes/sync');
const downloadRouter = require('./routes/download');
const { getLastSyncTimestamp } = require('./services/sync');

const app = express();

app.use(express.json());

app.use('/rates',   ratesRouter);
app.use('/alerts',  alertsRouter);
app.use('/devices', devicesRouter);
app.use('/sync',    syncRouter);
app.use('/download', downloadRouter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    last_sync: getLastSyncTimestamp(),
    timestamp: new Date().toISOString(),
  });
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
