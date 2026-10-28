# Site Monitor: a logger for a Laravel site on DigitalOcean

A small self-hosted monitoring service for your Laravel site. It records:

| What | How it gets here |
|---|---|
| **Errors & log entries** (with exception, stack trace, URL, user) | A `remote` log channel in Laravel |
| **Every HTTP request** (route, status, duration, memory, IP, user) | The `LogRequests` middleware in Laravel |
| **Uptime** (status, response time) | The logger checks your URLs every minute |
| **Server metrics** (CPU, memory, disk, load) | `agent/metrics-agent.sh` run from cron on the droplet |

It also emails you about new errors, downtime and recovery, high CPU/memory/disk, and when a droplet stops reporting.

```
 Laravel droplet                                Logger (Node.js)
 ┌──────────────────────────┐   POST /api/ingest   ┌──────────────────────────┐
 │ remote log channel ──────┼─────────────────────►│ SQLite (data/logger.db)  │
 │ LogRequests middleware ──┼─────────────────────►│ Dashboard (password)     │──► email alerts
 │ metrics-agent.sh (cron) ─┼─────────────────────►│ Uptime checker ──────────┼──► GET your site
 └──────────────────────────┘                      └──────────────────────────┘
```

Requirements: **Node.js 22.13+** for the logger (it uses the built-in `node:sqlite`, so there's nothing to compile), and **Laravel 10 or newer** (Monolog 3).

---

## 1. Try it locally

```bash
npm install
cp .env.example .env      # set INGEST_TOKEN and DASHBOARD_PASSWORD at minimum
npm start                 # http://127.0.0.1:4000
npm run demo              # in a second terminal: loads 24h of fake data
```

Generate a token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## 2. Deploy the logger on DigitalOcean

**Where to run it:** put it on a **separate small droplet** ($4–6/mo) if you can. If it runs on the same droplet as your site, a crash of that droplet also takes down the monitor, and you won't get a "site is down" email. Same-droplet still works for errors, requests and metrics.

On the logger droplet (Ubuntu):

```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# App
sudo useradd --system --home /opt/logger logger
sudo mkdir -p /opt/logger && sudo chown $USER /opt/logger
# copy this folder to /opt/logger (git clone, scp or rsync), then:
cd /opt/logger && npm ci --omit=dev
cp .env.example .env && nano .env
mkdir -p data && sudo chown -R logger:logger /opt/logger

# Service
sudo cp deploy/logger.service /etc/systemd/system/logger.service
sudo systemctl daemon-reload && sudo systemctl enable --now logger
sudo journalctl -u logger -f        # check it started

# HTTPS (point a DNS A record such as logs.yourdomain.com at the droplet first)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/logger
sudo sed -i 's/logs.example.com/logs.yourdomain.com/' /etc/nginx/sites-available/logger
sudo ln -s /etc/nginx/sites-available/logger /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo snap install --classic certbot && sudo certbot --nginx -d logs.yourdomain.com
```

Open `https://logs.yourdomain.com` and log in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.

> **Email on DigitalOcean:** DO blocks outbound SMTP on ports 25, 465 and 587 for many accounts. Use a mail provider that accepts port **2525** (SendGrid, Mailgun, Brevo, Postmark), e.g. `SMTP_HOST=smtp.sendgrid.net`, `SMTP_PORT=2525`, `SMTP_USER=apikey`. Or ask DO support to unblock SMTP. If SMTP isn't configured, alerts still show on the dashboard's Overview and in `journalctl`.

## 3. Connect your Laravel app

**a) Copy the files** from `laravel/` into your Laravel project, keeping the paths:

```
app/Logging/RemoteLogger.php
app/Logging/RemoteLogHandler.php
app/Logging/CreateRemoteLogger.php
app/Http/Middleware/LogRequests.php
```

**b) `config/services.php`**: add:

```php
'remote_logger' => [
    'url' => env('LOGGER_URL'),
    'token' => env('LOGGER_TOKEN'),
    'app' => env('LOGGER_APP', env('APP_NAME', 'laravel')),
    // Paths not to record as requests (Laravel's $request->is() patterns).
    'ignore' => array_filter(explode(',', env('LOGGER_IGNORE_PATHS', 'up'))),
],
```

**c) `config/logging.php`**: add a channel under `'channels'`:

```php
'remote' => [
    'driver' => 'custom',
    'via' => App\Logging\CreateRemoteLogger::class,
    'level' => env('LOGGER_LEVEL', 'warning'),
],
```

and add `remote` to your stack. On Laravel 11+ that's just the env var `LOG_STACK=daily,remote` (with `LOG_CHANNEL=stack`). On Laravel 10, edit the `stack` channel: `'channels' => ['daily', 'remote']`.

**d) Register the middleware globally.**

Laravel 11+ (`bootstrap/app.php`):

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->append(\App\Http\Middleware\LogRequests::class);
})
```

Laravel 10 (`app/Http/Kernel.php`): add `\App\Http\Middleware\LogRequests::class` to `$middleware`.

**e) `.env`** on the Laravel droplet:

```dotenv
LOG_CHANNEL=stack
LOG_STACK=daily,remote
LOGGER_URL=https://logs.yourdomain.com
LOGGER_TOKEN=<same value as INGEST_TOKEN>
LOGGER_APP=my-site
LOGGER_LEVEL=warning
```

Then `php artisan config:cache`. Test with `php artisan tinker` and run `Log::error('Hello from Laravel');`. It should show up under **Logs** within a second.

**How it behaves:**
- Log entries and the request record are buffered and sent in **one** HTTP call per request, from the middleware's `terminate()`. Under PHP-FPM that runs after the response is sent, so visitors aren't slowed down.
- In queue workers and artisan commands, entries are sent immediately.
- If the logger is unreachable, sending gives up after 3 seconds and writes a line to PHP's error log. Your site keeps working, and the logger can't cause logging loops.

## 4. Install the metrics agent on each droplet

```bash
sudo cp agent/metrics-agent.sh /usr/local/bin/metrics-agent.sh
sudo chmod +x /usr/local/bin/metrics-agent.sh
sudo tee /etc/logger-agent.env >/dev/null <<'EOF'
LOGGER_URL=https://logs.yourdomain.com
LOGGER_TOKEN=<same value as INGEST_TOKEN>
EOF
sudo chmod 600 /etc/logger-agent.env
sudo /usr/local/bin/metrics-agent.sh && echo ok     # test once
echo '* * * * * root /usr/local/bin/metrics-agent.sh >/dev/null 2>&1' | sudo tee /etc/cron.d/logger-agent
```

## Dashboard

- **Overview**: request volume, 5xx rate, p95 latency, error count, uptime, server summary, busiest routes, recent alerts.
- **Issues**: warnings and errors grouped by exception origin (or by message with numbers masked). Click one to see every occurrence.
- **Logs**: filter by minimum level, full-text search; click a row for trace, context, URL and user.
- **Requests**: filter by status class, method, slowness, path/IP/user.
- **Uptime**: per-URL uptime %, response time and failed checks.
- **Server**: CPU / memory / disk % and load per droplet.

Use the time range buttons (1h to 30d) at the top. Overview, Issues, Uptime and Server refresh every 30 seconds.

## Alerts

| Alert | When | Repeat |
|---|---|---|
| Error | A log entry at a level in `ALERT_LEVELS` | Once per issue per `ALERT_COOLDOWN_MINUTES` |
| DOWN / RECOVERED | `UPTIME_FAILURES_BEFORE_ALERT` failed checks in a row / first success after | Once per incident |
| CPU / Memory / Disk | 5-minute average above `ALERT_*_PERCENT` | Per cooldown |
| Agent silent | No metrics from a droplet for `ALERT_METRICS_SILENCE_MINUTES` | Per cooldown |

## Data & retention

Everything lives in `data/logger.db` (SQLite). Old rows are deleted every hour according to the `RETENTION_*_DAYS` settings. To back it up, copy the file, or use `sqlite3 data/logger.db ".backup backup.db"` while it's running.

## Ingest API

`POST /api/ingest` with `Authorization: Bearer <INGEST_TOKEN>` and a JSON body that contains any of `logs`, `requests` or `metrics` (arrays, up to 1000 items each). See `src/routes/ingest.js` for the fields. You can send data from other apps or scripts the same way.
