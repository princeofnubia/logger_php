import crypto from 'node:crypto';
import express from 'express';
import { requireIngestToken } from '../auth.js';
import { config } from '../config.js';
import { db, transaction } from '../db.js';
import { sendAlert, dashboardLink } from '../alerts.js';

export const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
const MAX_BATCH = 1000;

const str = (value, max = 1000) => (value == null || value === '' ? null : String(value).slice(0, max));
const num = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const toTs = (value) => {
  if (value == null) return Date.now();
  // Accept ISO strings, epoch milliseconds, or epoch seconds.
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? Math.round(ms) : Date.now();
};
const json = (value, max = 65536) => {
  if (value == null || (typeof value === 'object' && !Object.keys(value).length)) return null;
  let out = JSON.stringify(value);
  if (out.length > max) out = JSON.stringify({ _truncated: out.slice(0, max) });
  return out;
};

function fingerprint(log) {
  // Group by exception origin when we have one; otherwise by message with numbers masked
  // so "Order 123 failed" and "Order 456 failed" land in the same issue.
  const basis = log.exception_class
    ? `${log.exception_class}|${log.exception_location}`
    : (log.message || '').replace(/\d+/g, '#').slice(0, 300);
  return crypto.createHash('sha1').update(`${log.app}|${log.level}|${basis}`).digest('hex').slice(0, 16);
}

function normalizeLog(raw) {
  const level = String(raw.level || 'info').toLowerCase();
  const ex = raw.exception && typeof raw.exception === 'object' ? raw.exception : null;
  const log = {
    ts: toTs(raw.ts ?? raw.datetime),
    app: str(raw.app, 100),
    level: LEVELS.includes(level) ? level : 'info',
    message: str(raw.message, 10000) ?? '',
    channel: str(raw.channel, 100),
    context: json(raw.context),
    exception_class: str(ex?.class, 300),
    exception_location: ex?.file ? str(`${ex.file}:${ex.line ?? ''}`, 500) : null,
    trace: ex ? str([ex.message, ex.trace].filter(Boolean).join('\n\n'), 30000) : null,
    url: str(raw.url, 2000),
    method: str(raw.method, 10),
    ip: str(raw.ip, 64),
    user_id: str(raw.user_id, 100),
  };
  log.fingerprint = fingerprint(log);
  return log;
}

function normalizeRequest(raw) {
  return {
    ts: toTs(raw.ts),
    app: str(raw.app, 100),
    method: str(raw.method, 10),
    path: str(raw.path, 2000),
    route: str(raw.route, 500),
    status: num(raw.status),
    duration_ms: num(raw.duration_ms),
    ip: str(raw.ip, 64),
    user_id: str(raw.user_id, 100),
    user_agent: str(raw.user_agent, 500),
    memory_mb: num(raw.memory_mb),
  };
}

function normalizeMetric(raw) {
  return {
    ts: toTs(raw.ts),
    host: str(raw.host, 200) ?? 'unknown',
    cpu: num(raw.cpu),
    mem_used: num(raw.mem_used),
    mem_total: num(raw.mem_total),
    disk_used: num(raw.disk_used),
    disk_total: num(raw.disk_total),
    load1: num(raw.load1),
  };
}

const insertLog = db.prepare(`
  INSERT INTO logs (ts, app, level, message, channel, context, exception_class, exception_location, trace, url, method, ip, user_id, fingerprint)
  VALUES (:ts, :app, :level, :message, :channel, :context, :exception_class, :exception_location, :trace, :url, :method, :ip, :user_id, :fingerprint)
`);
const insertRequest = db.prepare(`
  INSERT INTO requests (ts, app, method, path, route, status, duration_ms, ip, user_id, user_agent, memory_mb)
  VALUES (:ts, :app, :method, :path, :route, :status, :duration_ms, :ip, :user_id, :user_agent, :memory_mb)
`);
const insertMetric = db.prepare(`
  INSERT INTO metrics (ts, host, cpu, mem_used, mem_total, disk_used, disk_total, load1)
  VALUES (:ts, :host, :cpu, :mem_used, :mem_total, :disk_used, :disk_total, :load1)
`);
const countFingerprintLastHour = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE fingerprint = ? AND ts >= ?');
const recentHostAverages = db.prepare(`
  SELECT AVG(cpu) AS cpu, AVG(mem_used * 100.0 / mem_total) AS mem, AVG(disk_used * 100.0 / disk_total) AS disk
  FROM metrics WHERE host = ? AND ts >= ?
`);

function alertOnErrors(logs) {
  const seen = new Set();
  for (const log of logs) {
    if (!config.alerts.levels.includes(log.level) || seen.has(log.fingerprint)) continue;
    seen.add(log.fingerprint);
    const lastHour = countFingerprintLastHour.get(log.fingerprint, Date.now() - 3_600_000).n;
    const lines = [
      `${log.level.toUpperCase()} in ${log.app || 'app'}`,
      '',
      log.message,
      log.exception_class && `\nException: ${log.exception_class}\nAt: ${log.exception_location}`,
      log.url && `\nURL: ${log.method || ''} ${log.url}`,
      log.user_id && `User: ${log.user_id}`,
      `\nOccurrences in the last hour: ${lastHour}`,
      log.trace && `\nTrace:\n${log.trace.split('\n').slice(0, 25).join('\n')}`,
    ];
    sendAlert({
      key: `error:${log.fingerprint}`,
      subject: `${log.level.toUpperCase()}: ${log.message.slice(0, 120)}`,
      text: lines.filter(Boolean).join('\n') + dashboardLink(`#logs?fingerprint=${log.fingerprint}`),
    });
  }
}

function alertOnMetrics(metrics) {
  const { cpuPct, memPct, diskPct } = config.alerts;
  for (const host of new Set(metrics.map((m) => m.host))) {
    // Use a 5-minute average so a single busy minute doesn't page anyone.
    const avg = recentHostAverages.get(host, Date.now() - 5 * 60_000);
    const checks = [
      ['cpu', 'CPU', avg.cpu, cpuPct],
      ['memory', 'Memory', avg.mem, memPct],
      ['disk', 'Disk', avg.disk, diskPct],
    ];
    for (const [key, label, value, limit] of checks) {
      if (value == null || value < limit) continue;
      sendAlert({
        key: `${key}:${host}`,
        subject: `${label} at ${value.toFixed(0)}% on ${host}`,
        text: `${label} usage on ${host} has averaged ${value.toFixed(1)}% over the last 5 minutes (threshold ${limit}%).` + dashboardLink('#server'),
      });
    }
  }
}

export const ingestRouter = express.Router();

ingestRouter.post('/', requireIngestToken, express.json({ limit: '5mb' }), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []).filter((x) => x && typeof x === 'object');

  const logs = asArray(body.logs).slice(0, MAX_BATCH).map(normalizeLog);
  const requests = asArray(body.requests).slice(0, MAX_BATCH).map(normalizeRequest);
  const metrics = asArray(body.metrics).slice(0, MAX_BATCH).map(normalizeMetric);

  transaction(() => {
    for (const log of logs) insertLog.run(log);
    for (const request of requests) insertRequest.run(request);
    for (const metric of metrics) insertMetric.run(metric);
  });

  res.json({ ok: true, accepted: { logs: logs.length, requests: requests.length, metrics: metrics.length } });

  try {
    if (logs.length) alertOnErrors(logs);
    if (metrics.length) alertOnMetrics(metrics);
  } catch (err) {
    console.error('[ingest] alert check failed:', err);
  }
});
