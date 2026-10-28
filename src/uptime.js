import { config } from './config.js';
import { db } from './db.js';
import { sendAlert, getAlertState, setAlertState, dashboardLink } from './alerts.js';

const { uptime, alerts } = config;

const insertCheck = db.prepare(`
  INSERT INTO uptime_checks (ts, url, ok, status, duration_ms, error)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const latestPerHost = db.prepare(`
  SELECT host, MAX(ts) AS last FROM metrics WHERE ts >= ? GROUP BY host
`);

const failures = new Map();

async function check(url) {
  const started = performance.now();
  let status = null;
  let error = null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(uptime.timeoutMs),
      headers: { 'User-Agent': 'laravel-logger-uptime/1.0' },
    });
    status = res.status;
    await res.body?.cancel();
  } catch (err) {
    error = err.name === 'TimeoutError' ? `Timed out after ${uptime.timeoutMs} ms` : err.cause?.code || err.message;
  }
  const duration = Math.round(performance.now() - started);
  const ok = status !== null && status < 400;
  if (!ok && !error) error = `HTTP ${status}`;
  insertCheck.run(Date.now(), url, ok ? 1 : 0, status, duration, error);

  // Down/up state lives in the database so a restart doesn't lose an open incident.
  const key = `uptime:${url}`;
  const wasDown = getAlertState(key) === 'down';
  const count = ok ? 0 : (failures.get(url) || 0) + 1;
  failures.set(url, count);

  if (!ok && !wasDown && count >= uptime.failuresBeforeAlert) {
    setAlertState(key, 'down');
    await sendAlert({
      key: `${key}:down`,
      cooldown: false,
      subject: `DOWN: ${url}`,
      text: `${url} failed ${count} checks in a row.\nLast error: ${error}\nResponse time: ${duration} ms` + dashboardLink('#uptime'),
    });
  } else if (ok && wasDown) {
    setAlertState(key, 'up');
    await sendAlert({
      key: `${key}:up`,
      cooldown: false,
      subject: `RECOVERED: ${url}`,
      text: `${url} is responding again (HTTP ${status}, ${duration} ms).` + dashboardLink('#uptime'),
    });
  }
}

// The droplet agent posts every minute; silence means the agent or the server is gone.
async function checkMetricsSilence() {
  const now = Date.now();
  for (const { host, last } of latestPerHost.all(now - 24 * 3_600_000)) {
    const silentMin = (now - last) / 60_000;
    if (silentMin < alerts.metricsSilenceMin) continue;
    await sendAlert({
      key: `silent:${host}`,
      subject: `No server metrics from ${host} for ${Math.round(silentMin)} min`,
      text: `The metrics agent on ${host} last reported at ${new Date(last).toISOString()}.\nThe server may be down, or the cron job stopped running.` + dashboardLink('#server'),
    });
  }
}

export function startUptimeMonitor() {
  const tick = () => {
    for (const url of uptime.urls) check(url).catch((err) => console.error(`[uptime] ${url}:`, err));
    checkMetricsSilence().catch((err) => console.error('[uptime] metrics silence check:', err));
  };
  if (uptime.urls.length) console.log(`[uptime] Checking ${uptime.urls.join(', ')} every ${uptime.intervalSec}s`);
  tick();
  setInterval(tick, uptime.intervalSec * 1000);
}
