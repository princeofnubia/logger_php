import nodemailer from 'nodemailer';
import { config } from './config.js';
import { db } from './db.js';

const { alerts } = config;

const transport = alerts.smtp.host
  ? nodemailer.createTransport({
      host: alerts.smtp.host,
      port: alerts.smtp.port,
      secure: alerts.smtp.secure,
      auth: alerts.smtp.user ? { user: alerts.smtp.user, pass: alerts.smtp.pass } : undefined,
    })
  : null;

if (!transport || !alerts.to.length) {
  console.warn('[alerts] SMTP_HOST or ALERT_EMAIL_TO not set: alerts will only be logged to the console and dashboard.');
}

const getState = db.prepare('SELECT last_sent, state FROM alert_state WHERE key = ?');
const setSent = db.prepare(`
  INSERT INTO alert_state (key, last_sent) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET last_sent = excluded.last_sent
`);
const setStateValue = db.prepare(`
  INSERT INTO alert_state (key, state) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET state = excluded.state
`);
const addHistory = db.prepare('INSERT INTO alert_history (ts, subject, body) VALUES (?, ?, ?)');

export function getAlertState(key) {
  return getState.get(key)?.state ?? null;
}

export function setAlertState(key, state) {
  setStateValue.run(key, state);
}

export function dashboardLink(hash = '') {
  return config.dashboardUrl ? `\n\nOpen dashboard: ${config.dashboardUrl}/${hash}` : '';
}

/**
 * Send an alert email. With `cooldown`, alerts sharing a `key` are sent at most
 * once per ALERT_COOLDOWN_MINUTES so a recurring error doesn't flood the inbox.
 */
export async function sendAlert({ key, subject, text, cooldown = true }) {
  const now = Date.now();
  if (cooldown && key) {
    const row = getState.get(key);
    if (row?.last_sent && now - row.last_sent < alerts.cooldownMin * 60_000) return false;
  }
  if (key) setSent.run(key, now);
  addHistory.run(now, subject, text);

  if (!transport || !alerts.to.length) {
    console.log(`[alert] ${subject}`);
    return true;
  }
  try {
    await transport.sendMail({
      from: alerts.from,
      to: alerts.to.join(', '),
      subject: `${alerts.subjectPrefix} ${subject}`,
      text,
    });
  } catch (err) {
    console.error(`[alerts] Failed to send "${subject}": ${err.message}`);
  }
  return true;
}
