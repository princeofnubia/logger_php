import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import { requireDashboardLogin } from './auth.js';
import { ingestRouter } from './routes/ingest.js';
import { apiRouter } from './routes/api.js';
import { startUptimeMonitor } from './uptime.js';
import { startRetention } from './retention.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api/ingest', ingestRouter);

// Everything below requires the dashboard login.
app.use(requireDashboardLogin);
app.use('/api', apiRouter);
app.use(express.static(path.join(ROOT, 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(config.port, config.host, () => {
  console.log(`Logger listening on http://${config.host}:${config.port}`);
  startRetention();
  startUptimeMonitor();
});
