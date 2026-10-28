#!/usr/bin/env bash
# Sends CPU, memory, disk and load average to the logger service.
# Run it every minute from cron on each droplet you want to watch:
#   * * * * * /usr/local/bin/metrics-agent.sh >/dev/null 2>&1
#
# Configuration is read from /etc/logger-agent.env:
#   LOGGER_URL=https://logs.example.com
#   LOGGER_TOKEN=<same value as INGEST_TOKEN on the logger>
#   DISK_PATH=/            (optional)
set -euo pipefail

[ -f /etc/logger-agent.env ] && . /etc/logger-agent.env
: "${LOGGER_URL:?LOGGER_URL is not set}"
: "${LOGGER_TOKEN:?LOGGER_TOKEN is not set}"
DISK_PATH="${DISK_PATH:-/}"

cpu_sample() {
  # user nice system idle iowait irq softirq steal
  awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat
}
read -r total1 idle1 < <(cpu_sample)
sleep 1
read -r total2 idle2 < <(cpu_sample)
cpu=$(awk -v t="$((total2 - total1))" -v i="$((idle2 - idle1))" 'BEGIN { printf "%.1f", (t > 0 ? (1 - i / t) * 100 : 0) }')

mem_total=$(awk '/^MemTotal:/{print $2 * 1024}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/{print $2 * 1024}' /proc/meminfo)
mem_used=$((mem_total - mem_available))

read -r disk_used disk_total < <(df -B1 --output=used,size "$DISK_PATH" | tail -n 1)
load1=$(cut -d ' ' -f 1 /proc/loadavg)
host=$(hostname)

payload=$(printf '{"metrics":[{"host":"%s","cpu":%s,"mem_used":%s,"mem_total":%s,"disk_used":%s,"disk_total":%s,"load1":%s}]}' \
  "$host" "$cpu" "$mem_used" "$mem_total" "$disk_used" "$disk_total" "$load1")

curl -fsS -m 10 -X POST \
  -H "Authorization: Bearer ${LOGGER_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "$payload" \
  "${LOGGER_URL%/}/api/ingest" >/dev/null
