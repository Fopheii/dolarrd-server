const express = require('express');
const ratesRouter = require('./routes/rates');
const alertsRouter = require('./routes/alerts');
const syncRouter = require('./routes/sync');
const { getLastSyncTimestamp } = require('./services/sync');

const app = express();

app.use(express.json());

app.use('/rates', ratesRouter);
app.use('/alerts', alertsRouter);
app.use('/sync', syncRouter);

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
