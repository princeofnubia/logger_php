import express from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { LEVELS } from './ingest.js';

const HOUR = 3_600_000;
const RANGES = {
  '1h': { span: HOUR, bucket: 60_000 },
  '6h': { span: 6 * HOUR, bucket: 5 * 60_000 },
  '24h': { span: 24 * HOUR, bucket: 15 * 60_000 },
  '7d': { span: 7 * 24 * HOUR, bucket: 2 * HOUR },
  '30d': { span: 30 * 24 * HOUR, bucket: 6 * HOUR },
};

const ERROR_LEVELS_SQL = config.alerts.levels
  .filter((l) => LEVELS.includes(l))
  .map((l) => `'${l}'`)
  .join(',') || `'error'`;

function getRange(req) {
  const { span, bucket } = RANGES[req.query.range] || RANGES['24h'];
  const to = Date.now();
  // Align to the bucket size so SQL group keys line up with the filled timeline.
  const from = Math.floor((to - span) / bucket) * bucket;
  return { from, to, bucket };
}

function fillBuckets(rows, { from, to, bucket }, empty) {
  const byTime = new Map(rows.map((r) => [r.t, r]));
  const out = [];
  for (let t = from; t <= to; t += bucket) out.push(byTime.get(t) ?? { t, ...empty });
  return out;
}

function likeParam(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function percentile(table, column, where, params, count, p) {
  if (!count) return null;
  const offset = Math.min(count - 1, Math.floor(count * p));
  const row = db
    .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${where} ORDER BY ${column} LIMIT 1 OFFSET ${offset}`)
    .get(params);
  return row?.v ?? null;
}

export const apiRouter = express.Router();

apiRouter.get('/overview', (req, res) => {
  const range = getRange(req);
  const { from, bucket } = range;

  const req_ = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(status >= 500), 0) AS s5xx,
           COALESCE(SUM(status >= 400 AND status < 500), 0) AS s4xx, AVG(duration_ms) AS avg
    FROM requests WHERE ts >= :from
  `).get({ from });
  const p95 = percentile('requests', 'duration_ms', 'ts >= :from AND duration_ms IS NOT NULL', { from }, req_.total, 0.95);

  const errorLogs = db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE ts >= :from AND level IN (${ERROR_LEVELS_SQL})`).get({ from }).n;
  const uptime = db.prepare('SELECT AVG(ok) * 100 AS pct, COUNT(*) AS n FROM uptime_checks WHERE ts >= :from').get({ from });

  const requestSeries = fillBuckets(
    db.prepare(`
      SELECT (ts / :bucket) * :bucket AS t, COUNT(*) AS count, SUM(status >= 500) AS s5xx, AVG(duration_ms) AS avg
      FROM requests WHERE ts >= :from GROUP BY t ORDER BY t
    `).all({ from, bucket }),
    range,
    { count: 0, s5xx: 0, avg: null },
  );
  const errorSeries = fillBuckets(
    db.prepare(`
      SELECT (ts / :bucket) * :bucket AS t, COUNT(*) AS count
      FROM logs WHERE ts >= :from AND level IN (${ERROR_LEVELS_SQL}) GROUP BY t ORDER BY t
    `).all({ from, bucket }),
    range,
    { count: 0 },
  );

  const servers = db.prepare(`
    SELECT m.host, m.ts, m.cpu, m.load1,
           m.mem_used * 100.0 / m.mem_total AS mem_pct, m.disk_used * 100.0 / m.disk_total AS disk_pct
    FROM metrics m
    JOIN (SELECT host, MAX(ts) AS ts FROM metrics WHERE ts >= :since GROUP BY host) latest
      ON latest.host = m.host AND latest.ts = m.ts
    ORDER BY m.host
  `).all({ since: Date.now() - 24 * HOUR });

  const topRoutes = db.prepare(`
    SELECT COALESCE(route, path) AS name, COUNT(*) AS count, AVG(duration_ms) AS avg,
           MAX(duration_ms) AS max, COALESCE(SUM(status >= 500), 0) AS errors
    FROM requests WHERE ts >= :from GROUP BY name ORDER BY count DESC LIMIT 10
  `).all({ from });

  const recentAlerts = db.prepare('SELECT ts, subject FROM alert_history ORDER BY ts DESC LIMIT 8').all();

  res.json({
    range,
    totals: {
      requests: req_.total,
      s5xx: req_.s5xx,
      s4xx: req_.s4xx,
      avgMs: req_.avg,
      p95Ms: p95,
      errorLogs,
      uptimePct: uptime.n ? uptime.pct : null,
    },
    series: requestSeries.map((r, i) => ({ ...r, errorLogs: errorSeries[i].count })),
    servers,
    topRoutes,
    recentAlerts,
  });
});

apiRouter.get('/issues', (req, res) => {
  const { from } = getRange(req);
  const rows = db.prepare(`
    SELECT fingerprint, COUNT(*) AS count, MIN(ts) AS first_seen, MAX(ts) AS last_seen,
           level, app, message, exception_class, exception_location, url
    FROM logs WHERE ts >= :from AND level IN ('warning', ${ERROR_LEVELS_SQL})
    GROUP BY fingerprint ORDER BY last_seen DESC LIMIT 200
  `).all({ from });
  res.json({ issues: rows });
});

apiRouter.get('/logs', (req, res) => {
  const { from } = getRange(req);
  const where = ['ts >= :from'];
  const params = { from };
  const { level, q, fingerprint, before } = req.query;

  const minLevel = LEVELS.indexOf(level);
  if (minLevel > 0) where.push(`level IN (${LEVELS.slice(minLevel).map((l) => `'${l}'`).join(',')})`);
  if (q) {
    where.push(`(message LIKE :q ESCAPE '\\' OR exception_class LIKE :q ESCAPE '\\' OR url LIKE :q ESCAPE '\\')`);
    params.q = likeParam(q);
  }
  if (fingerprint) {
    where.push('fingerprint = :fingerprint');
    params.fingerprint = String(fingerprint);
  }
  if (Number(before)) {
    where.push('id < :before');
    params.before = Number(before);
  }

  const rows = db.prepare(`
    SELECT id, ts, app, level, message, channel, exception_class, url, method, user_id, fingerprint
    FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100
  `).all(params);
  res.json({ logs: rows });
});

apiRouter.get('/logs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM logs WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ log: row });
});

apiRouter.get('/requests', (req, res) => {
  const { from } = getRange(req);
  const where = ['ts >= :from'];
  const params = { from };
  const { status, q, method, min_ms: minMs, before } = req.query;

  const statusClass = /^([1-5])xx$/.exec(status || '');
  if (statusClass) {
    where.push('status >= :statusFrom AND status < :statusTo');
    params.statusFrom = Number(statusClass[1]) * 100;
    params.statusTo = params.statusFrom + 100;
  }
  if (q) {
    where.push(`(path LIKE :q ESCAPE '\\' OR route LIKE :q ESCAPE '\\' OR ip LIKE :q ESCAPE '\\' OR user_id = :qExact)`);
    params.q = likeParam(q);
    params.qExact = String(q);
  }
  if (method) {
    where.push('method = :method');
    params.method = String(method).toUpperCase();
  }
  if (Number(minMs)) {
    where.push('duration_ms >= :minMs');
    params.minMs = Number(minMs);
  }
  if (Number(before)) {
    where.push('id < :before');
    params.before = Number(before);
  }

  const rows = db.prepare(`
    SELECT id, ts, app, method, path, route, status, duration_ms, ip, user_id, user_agent, memory_mb
    FROM requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100
  `).all(params);
  res.json({ requests: rows });
});

apiRouter.get('/uptime', (req, res) => {
  const range = getRange(req);
  const { from, bucket } = range;
  const known = db.prepare('SELECT DISTINCT url FROM uptime_checks WHERE ts >= :from').all({ from }).map((r) => r.url);
  const urls = [...new Set([...config.uptime.urls, ...known])];

  const monitors = urls.map((url) => {
    const stats = db.prepare(`
      SELECT COUNT(*) AS n, AVG(ok) * 100 AS pct, AVG(CASE WHEN ok = 1 THEN duration_ms END) AS avg
      FROM uptime_checks WHERE url = :url AND ts >= :from
    `).get({ url, from });
    const p95 = percentile('uptime_checks', 'duration_ms', 'url = :url AND ts >= :from AND ok = 1', { url, from }, stats.n, 0.95);
    const last = db.prepare('SELECT ts, ok, status, duration_ms, error FROM uptime_checks WHERE url = ? ORDER BY ts DESC LIMIT 1').get(url);
    const series = fillBuckets(
      db.prepare(`
        SELECT (ts / :bucket) * :bucket AS t, AVG(CASE WHEN ok = 1 THEN duration_ms END) AS avg, SUM(ok = 0) AS failures
        FROM uptime_checks WHERE url = :url AND ts >= :from GROUP BY t ORDER BY t
      `).all({ url, from, bucket }),
      range,
      { avg: null, failures: 0 },
    );
    const incidents = db.prepare(`
      SELECT ts, status, duration_ms, error FROM uptime_checks
      WHERE url = :url AND ts >= :from AND ok = 0 ORDER BY ts DESC LIMIT 20
    `).all({ url, from });
    return {
      url,
      monitored: config.uptime.urls.includes(url),
      checks: stats.n,
      uptimePct: stats.n ? stats.pct : null,
      avgMs: stats.avg,
      p95Ms: p95,
      last,
      series,
      incidents,
    };
  });

  res.json({ range, monitors });
});

apiRouter.get('/server', (req, res) => {
  const range = getRange(req);
  const { from, bucket } = range;
  const hosts = db.prepare('SELECT DISTINCT host FROM metrics WHERE ts >= :from ORDER BY host').all({ from }).map((r) => r.host);

  const servers = hosts.map((host) => {
    const latest = db.prepare(`
      SELECT ts, cpu, load1, mem_used, mem_total, disk_used, disk_total,
             mem_used * 100.0 / mem_total AS mem_pct, disk_used * 100.0 / disk_total AS disk_pct
      FROM metrics WHERE host = ? ORDER BY ts DESC LIMIT 1
    `).get(host);
    const series = fillBuckets(
      db.prepare(`
        SELECT (ts / :bucket) * :bucket AS t, AVG(cpu) AS cpu,
               AVG(mem_used * 100.0 / mem_total) AS mem, AVG(disk_used * 100.0 / disk_total) AS disk, AVG(load1) AS load1
        FROM metrics WHERE host = :host AND ts >= :from GROUP BY t ORDER BY t
      `).all({ host, from, bucket }),
      range,
      { cpu: null, mem: null, disk: null, load1: null },
    );
    return { host, latest, series };
  });

  res.json({ range, servers });
});
