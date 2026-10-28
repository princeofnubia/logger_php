import crypto from 'node:crypto';
import { config } from './config.js';

// Compare digests so the comparison is constant-time regardless of input length.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function requireIngestToken(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token && safeEqual(token, config.ingestToken)) return next();
  res.status(401).json({ error: 'Invalid ingest token' });
}

export function requireDashboardLogin(req, res, next) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    // Evaluate both so timing doesn't reveal which one was wrong.
    const userOk = safeEqual(user, config.dashboard.user);
    const passOk = safeEqual(pass, config.dashboard.password);
    if (sep > 0 && userOk && passOk) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Logger", charset="UTF-8"');
  res.status(401).send('Authentication required');
}
