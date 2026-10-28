import { config } from './config.js';
import { db } from './db.js';

const DAY = 86_400_000;

const tables = [
  ['logs', config.retentionDays.logs],
  ['requests', config.retentionDays.requests],
  ['metrics', config.retentionDays.metrics],
  ['uptime_checks', config.retentionDays.uptime],
  ['alert_history', config.retentionDays.logs],
];

function prune() {
  const now = Date.now();
  for (const [table, days] of tables) {
    const { changes } = db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(now - days * DAY);
    if (changes) console.log(`[retention] Removed ${changes} rows from ${table}`);
  }
  db.exec('PRAGMA optimize');
}

export function startRetention() {
  prune();
  setInterval(prune, 3_600_000);
}
