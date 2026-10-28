import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const str = (key, fallback = '') => process.env[key] ?? fallback;
const int = (key, fallback) => {
  const value = parseInt(process.env[key], 10);
  return Number.isFinite(value) ? value : fallback;
};
const list = (key, fallback = []) => {
  const items = (process.env[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
};

export const config = {
  port: int('PORT', 4000),
  host: str('HOST', '127.0.0.1'),
  dbPath: path.resolve(ROOT, str('DB_PATH', 'data/logger.db')),
  dashboardUrl: str('DASHBOARD_URL', '').replace(/\/$/, ''),
  ingestToken: str('INGEST_TOKEN'),
  dashboard: {
    user: str('DASHBOARD_USER', 'admin'),
    password: str('DASHBOARD_PASSWORD'),
  },
  retentionDays: {
    logs: int('RETENTION_LOGS_DAYS', 30),
    requests: int('RETENTION_REQUESTS_DAYS', 14),
    metrics: int('RETENTION_METRICS_DAYS', 14),
    uptime: int('RETENTION_UPTIME_DAYS', 30),
  },
  uptime: {
    urls: list('UPTIME_URLS'),
    intervalSec: int('UPTIME_INTERVAL_SECONDS', 60),
    timeoutMs: int('UPTIME_TIMEOUT_MS', 10000),
    failuresBeforeAlert: int('UPTIME_FAILURES_BEFORE_ALERT', 2),
  },
  alerts: {
    to: list('ALERT_EMAIL_TO'),
    from: str('ALERT_EMAIL_FROM', 'logger@localhost'),
    subjectPrefix: str('ALERT_SUBJECT_PREFIX', '[Logger]'),
    cooldownMin: int('ALERT_COOLDOWN_MINUTES', 30),
    levels: list('ALERT_LEVELS', ['error', 'critical', 'alert', 'emergency']),
    cpuPct: int('ALERT_CPU_PERCENT', 90),
    memPct: int('ALERT_MEMORY_PERCENT', 90),
    diskPct: int('ALERT_DISK_PERCENT', 90),
    metricsSilenceMin: int('ALERT_METRICS_SILENCE_MINUTES', 5),
    smtp: {
      host: str('SMTP_HOST'),
      port: int('SMTP_PORT', 587),
      secure: str('SMTP_SECURE', 'false') === 'true',
      user: str('SMTP_USER'),
      pass: str('SMTP_PASS'),
    },
  },
};

const problems = [];
if (config.ingestToken.length < 24) problems.push('INGEST_TOKEN must be set (at least 24 characters).');
if (config.dashboard.password.length < 8) problems.push('DASHBOARD_PASSWORD must be set (at least 8 characters).');
if (problems.length) {
  console.error(`Configuration error:\n  ${problems.join('\n  ')}\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}
