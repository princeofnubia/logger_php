import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    app TEXT,
    level TEXT NOT NULL,
    message TEXT,
    channel TEXT,
    context TEXT,
    exception_class TEXT,
    exception_location TEXT,
    trace TEXT,
    url TEXT,
    method TEXT,
    ip TEXT,
    user_id TEXT,
    fingerprint TEXT
  );
  CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
  CREATE INDEX IF NOT EXISTS logs_fingerprint ON logs (fingerprint, ts);

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    app TEXT,
    method TEXT,
    path TEXT,
    route TEXT,
    status INTEGER,
    duration_ms REAL,
    ip TEXT,
    user_id TEXT,
    user_agent TEXT,
    memory_mb REAL
  );
  CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    host TEXT NOT NULL,
    cpu REAL,
    mem_used INTEGER,
    mem_total INTEGER,
    disk_used INTEGER,
    disk_total INTEGER,
    load1 REAL
  );
  CREATE INDEX IF NOT EXISTS metrics_host_ts ON metrics (host, ts);
  CREATE INDEX IF NOT EXISTS metrics_ts ON metrics (ts);

  CREATE TABLE IF NOT EXISTS uptime_checks (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    url TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    duration_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS uptime_url_ts ON uptime_checks (url, ts);
  CREATE INDEX IF NOT EXISTS uptime_ts ON uptime_checks (ts);

  CREATE TABLE IF NOT EXISTS alert_state (
    key TEXT PRIMARY KEY,
    last_sent INTEGER,
    state TEXT
  );

  CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT
  );
`);

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
