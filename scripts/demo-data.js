// Fills a locally running logger with 24 hours of fake data so you can try the dashboard.
// Usage: npm start (in one terminal), then npm run demo.
// Don't point this at production: error entries trigger alert emails like real ones.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const base = `http://127.0.0.1:${process.env.PORT || 4000}`;
const token = process.env.INGEST_TOKEN;

const routes = [
  ['GET', '/', '/', 120],
  ['GET', '/products', 'products', 180],
  ['GET', '/products/42', 'products/{product}', 160],
  ['POST', '/cart', 'cart', 220],
  ['POST', '/checkout', 'checkout', 650],
  ['GET', '/api/search?q=shoes', 'api/search', 300],
  ['GET', '/login', 'login', 90],
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const now = Date.now();
const start = now - 24 * 3_600_000;

const requests = [];
const logs = [];
const metrics = [];

for (let t = start; t < now; t += 60_000) {
  const hour = new Date(t).getHours();
  const traffic = Math.round(4 + 10 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2)) + Math.random() * 4);
  for (let i = 0; i < traffic; i++) {
    const [method, p, route, typicalMs] = pick(routes);
    const r = Math.random();
    const status = r < 0.01 ? 500 : r < 0.05 ? 404 : r < 0.08 ? 302 : 200;
    requests.push({
      ts: t + Math.floor(Math.random() * 60_000),
      app: 'shop',
      method,
      path: p,
      route,
      status,
      duration_ms: Math.round(typicalMs * (0.5 + Math.random()) * (status === 500 ? 3 : 1)),
      ip: `203.0.113.${Math.floor(Math.random() * 255)}`,
      user_id: Math.random() < 0.3 ? String(Math.floor(Math.random() * 50) + 1) : null,
      user_agent: 'Mozilla/5.0 (demo)',
      memory_mb: 18 + Math.round(Math.random() * 10),
    });
  }
  if (Math.random() < 0.03) {
    logs.push({
      ts: t,
      app: 'shop',
      level: 'error',
      message: `SQLSTATE[40001]: Deadlock found when trying to get lock (order ${Math.floor(Math.random() * 9000)})`,
      channel: 'production',
      url: 'https://shop.example.com/checkout',
      method: 'POST',
      exception: {
        class: 'Illuminate\\Database\\QueryException',
        message: 'Deadlock found when trying to get lock',
        file: '/var/www/app/app/Services/CheckoutService.php',
        line: 88,
        trace: '#0 /var/www/app/app/Http/Controllers/CheckoutController.php(31): App\\Services\\CheckoutService->place()\n#1 {main}',
      },
      context: { cart_id: 991, total: 54.2 },
    });
  }
  if (Math.random() < 0.05) {
    logs.push({ ts: t, app: 'shop', level: 'warning', message: 'Payment gateway responded slowly', channel: 'production', context: { ms: 4200 } });
  }
  if (Math.random() < 0.1) {
    logs.push({ ts: t, app: 'shop', level: 'info', message: 'User registered', channel: 'production', context: { user_id: 7 } });
  }
  const cpu = 15 + 30 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2)) + Math.random() * 8;
  metrics.push({
    ts: t,
    host: 'web-01',
    cpu: +cpu.toFixed(1),
    mem_used: Math.round((1.1 + Math.random() * 0.3) * 2 ** 30),
    mem_total: 2 * 2 ** 30,
    disk_used: Math.round(21.4 * 2 ** 30 + ((t - start) / 86_400_000) * 0.2 * 2 ** 30),
    disk_total: 50 * 2 ** 30,
    load1: +(cpu / 50).toFixed(2),
  });
}

async function post(body) {
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
for (const c of chunks(requests, 1000)) await post({ requests: c });
for (const c of chunks(metrics, 1000)) await post({ metrics: c });
for (const c of chunks(logs, 1000)) await post({ logs: c });

console.log(`Sent ${requests.length} requests, ${logs.length} log entries and ${metrics.length} metric samples to ${base}.`);
