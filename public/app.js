'use strict';

const view = document.getElementById('view');
const state = {
  range: safeGet('range') || '24h',
  tab: 'overview',
  params: new URLSearchParams(),
};
const charts = [];
let refreshTimer = null;

// ---------- helpers ----------

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, params = {}) {
  const url = new URL(`api/${path}`, location.href);
  url.searchParams.set('range', state.range);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const fmt = {
  int: (n) => (n == null ? '–' : Math.round(n).toLocaleString()),
  ms: (n) => (n == null ? '–' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`),
  pct: (n, d = 1) => (n == null ? '–' : `${n.toFixed(d)}%`),
  bytes: (n) => {
    if (n == null) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  },
  time: (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  ago: (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
};

function tile(label, value, sub = '') {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}

function statusBadge(status) {
  if (status == null) return '<span class="badge">–</span>';
  return `<span class="badge st-${String(status)[0]}">${esc(status)}</span>`;
}

function levelBadge(level) {
  return `<span class="badge lvl-${esc(level)}">${esc(level)}</span>`;
}

// ---------- line chart (SVG, hover crosshair + tooltip) ----------

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * exp;
}

function timeLabel(ts, spanMs) {
  const d = new Date(ts);
  if (spanMs <= 36 * 3600e3) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * series: [{ name, color: 'var(--series-1)', values: [number|null] }], all sharing `times`.
 */
function chartHtml(id, title, series, extra = '') {
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span style="--c:${s.color}">${esc(s.name)}</span>`).join('')}</div>`
    : '';
  return `<div class="card"><div class="card-head"><h3>${esc(title)}</h3>${legend}${extra}</div><div class="chart" id="${id}"></div></div>`;
}

function drawLineChart(el, { times, series, yFormat = fmt.int, yMax, height = 200 }) {
  if (!el) return;
  const W = Math.max(280, el.clientWidth);
  const H = height;
  const m = { t: 10, r: 12, b: 24, l: 52 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const from = times[0];
  const to = times[times.length - 1];
  const span = Math.max(1, to - from);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const max = yMax ?? niceMax(Math.max(0, ...all));
  const x = (t) => m.l + ((t - from) / span) * iw;
  const y = (v) => m.t + (1 - v / max) * ih;

  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">`;
  svg += '<g class="axis">';
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(yFormat(v))}</text>`;
  }
  const ticks = Math.min(6, Math.floor(iw / 90));
  for (let i = 0; i <= ticks; i++) {
    const t = from + (span * i) / ticks;
    const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
    svg += `<text x="${x(t)}" y="${H - 6}" text-anchor="${anchor}">${esc(timeLabel(t, span))}</text>`;
  }
  svg += '</g>';

  for (const s of series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  svg += `<line class="crosshair" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
  svg += `<g class="dots" visibility="hidden">${series.map((s) => `<circle r="4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="2"/>`).join('')}</g>`;
  svg += `<rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>`;
  svg += '</svg>';
  el.innerHTML = `${svg}<div class="tooltip" hidden></div>`;

  const root = el.querySelector('svg');
  const cross = root.querySelector('.crosshair');
  const dots = root.querySelector('.dots');
  const tip = el.querySelector('.tooltip');
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.setAttribute('visibility', 'hidden'); tip.hidden = true; };

  root.addEventListener('pointermove', (e) => {
    const rect = root.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = from + ((px - m.l) / iw) * span;
    const i = Math.max(0, Math.min(times.length - 1, Math.round(((t - from) / span) * (times.length - 1))));
    const cx = x(times[i]);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    dots.setAttribute('visibility', 'visible');
    [...dots.children].forEach((c, k) => {
      const v = series[k].values[i];
      c.setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { c.setAttribute('cx', cx); c.setAttribute('cy', y(v)); }
    });
    tip.innerHTML = `<div class="t-time">${esc(fmt.time(times[i]))}</div>` +
      series.map((s) => `<div class="t-row" style="--c:${s.color}"><i></i>${esc(s.name)}<b>${esc(s.values[i] == null ? '–' : yFormat(s.values[i]))}</b></div>`).join('');
    tip.hidden = false;
    const scale = rect.width / W;
    const left = cx * scale + 12;
    tip.style.left = `${left + tip.offsetWidth > rect.width ? cx * scale - tip.offsetWidth - 12 : left}px`;
    tip.style.top = `${m.t}px`;
  });
  root.addEventListener('pointerleave', hide);
}

function registerChart(id, opts) {
  charts.push(() => drawLineChart(document.getElementById(id), opts));
}

function drawCharts() {
  for (const draw of charts) draw();
}

// ---------- views ----------

const views = {
  async overview() {
    const data = await api('overview');
    const { totals: t, series, servers, topRoutes, recentAlerts } = data;
    const times = series.map((p) => p.t);
    const errRate = t.requests ? (t.s5xx / t.requests) * 100 : null;

    let html = '<div class="tiles">';
    html += tile('Requests', fmt.int(t.requests), t.requests ? `${fmt.int(t.s4xx)} client errors (4xx)` : 'No requests received yet');
    html += tile('Server error rate', fmt.pct(errRate, 2), `${fmt.int(t.s5xx)} responses with 5xx`);
    html += tile('p95 response time', fmt.ms(t.p95Ms), `avg ${fmt.ms(t.avgMs)}`);
    html += tile('Error logs', fmt.int(t.errorLogs), 'error level and above');
    html += tile('Uptime', fmt.pct(t.uptimePct, 2), t.uptimePct == null ? 'No checks configured' : 'of uptime checks passed');
    for (const s of servers) {
      html += tile(`Server · ${s.host}`, `CPU ${fmt.pct(s.cpu, 0)}`, `Mem ${fmt.pct(s.mem_pct, 0)} · Disk ${fmt.pct(s.disk_pct, 0)} · ${fmt.ago(s.ts)}`);
    }
    html += '</div>';

    html += '<div class="section grid-2">';
    html += chartHtml('c-requests', 'Requests', [{ name: 'Requests' }]);
    html += chartHtml('c-errors', 'Errors', [
      { name: '5xx responses', color: 'var(--series-1)' },
      { name: 'Error logs', color: 'var(--series-2)' },
    ]);
    html += chartHtml('c-latency', 'Average response time', [{ name: 'Avg' }]);
    html += `<div class="card"><div class="card-head"><h3>Recent alerts</h3></div>${
      recentAlerts.length
        ? `<ul class="alert-list">${recentAlerts.map((a) => `<li><time>${esc(fmt.time(a.ts))}</time><span>${esc(a.subject)}</span></li>`).join('')}</ul>`
        : '<p class="muted">No alerts sent.</p>'
    }</div>`;
    html += '</div>';

    html += '<div class="section"><h2>Busiest routes</h2>';
    html += topRoutes.length
      ? `<div class="table-wrap"><table><thead><tr><th>Route</th><th class="num">Requests</th><th class="num">Avg</th><th class="num">Max</th><th class="num">5xx</th></tr></thead><tbody>${
        topRoutes.map((r) => `<tr><td class="mono truncate" title="${esc(r.name)}">${esc(r.name)}</td><td class="num">${fmt.int(r.count)}</td><td class="num">${fmt.ms(r.avg)}</td><td class="num">${fmt.ms(r.max)}</td><td class="num">${fmt.int(r.errors)}</td></tr>`).join('')
      }</tbody></table></div>`
      : emptyState('No requests yet. Add the <code>LogRequests</code> middleware to your Laravel app (see README).');
    html += '</div>';

    view.innerHTML = html;
    registerChart('c-requests', { times, series: [{ name: 'Requests', color: 'var(--series-1)', values: series.map((p) => p.count) }] });
    registerChart('c-errors', {
      times,
      series: [
        { name: '5xx responses', color: 'var(--series-1)', values: series.map((p) => p.s5xx) },
        { name: 'Error logs', color: 'var(--series-2)', values: series.map((p) => p.errorLogs) },
      ],
    });
    registerChart('c-latency', { times, yFormat: fmt.ms, series: [{ name: 'Avg response', color: 'var(--series-1)', values: series.map((p) => p.avg) }] });
  },

  async issues() {
    const { issues } = await api('issues');
    if (!issues.length) {
      view.innerHTML = emptyState('No warnings or errors in this time range.');
      return;
    }
    view.innerHTML = `<h2>Issues <span class="muted">· grouped warnings and errors</span></h2>
      <div class="table-wrap"><table><thead><tr><th>Level</th><th>Issue</th><th class="num">Events</th><th>Last seen</th><th>First seen</th></tr></thead><tbody>${
      issues.map((i) => `<tr class="clickable" data-fp="${esc(i.fingerprint)}">
        <td>${levelBadge(i.level)}</td>
        <td><div class="truncate" title="${esc(i.message)}">${esc(i.exception_class ? `${i.exception_class}: ${i.message}` : i.message)}</div>
            <div class="muted mono truncate">${esc(i.exception_location || i.url || i.app || '')}</div></td>
        <td class="num">${fmt.int(i.count)}</td>
        <td class="nowrap">${esc(fmt.ago(i.last_seen))}</td>
        <td class="nowrap muted">${esc(fmt.time(i.first_seen))}</td></tr>`).join('')
    }</tbody></table></div>`;
    view.querySelectorAll('tr[data-fp]').forEach((tr) => {
      tr.addEventListener('click', () => { location.hash = `logs?fingerprint=${tr.dataset.fp}`; });
    });
  },

  async logs() {
    const filters = {
      level: state.params.get('level') || '',
      q: state.params.get('q') || '',
      fingerprint: state.params.get('fingerprint') || '',
    };
    view.innerHTML = `
      <form class="filters" id="log-filters">
        <select name="level" aria-label="Minimum level">
          <option value="">All levels</option>
          ${['info', 'notice', 'warning', 'error', 'critical'].map((l) => `<option value="${l}" ${filters.level === l ? 'selected' : ''}>${l}+</option>`).join('')}
        </select>
        <input type="search" name="q" placeholder="Search message, exception, URL…" value="${esc(filters.q)}">
        ${filters.fingerprint ? `<span class="chip">Issue ${esc(filters.fingerprint)} <button type="button" id="clear-fp" aria-label="Clear issue filter">×</button></span>` : ''}
        <button class="btn" type="submit">Apply</button>
      </form>
      <div id="log-table"></div>`;
    bindFilterForm('log-filters', 'logs', filters);
    document.getElementById('clear-fp')?.addEventListener('click', () => {
      state.params.delete('fingerprint');
      location.hash = `logs?${state.params}`;
    });
    await pagedTable({
      el: document.getElementById('log-table'),
      fetch: (before) => api('logs', { ...filters, before }).then((d) => d.logs),
      head: '<th>Time</th><th>Level</th><th>Message</th><th>URL</th>',
      cols: 4,
      row: (l) => `<td class="nowrap mono">${esc(fmt.time(l.ts))}</td><td>${levelBadge(l.level)}</td>
        <td><div class="truncate" title="${esc(l.message)}">${esc(l.message)}</div>${l.exception_class ? `<div class="muted mono">${esc(l.exception_class)}</div>` : ''}</td>
        <td class="mono truncate muted">${esc(l.url ? `${l.method || ''} ${l.url}` : l.channel || '')}</td>`,
      detail: async (l) => {
        const { log } = await api(`logs/${l.id}`);
        let context = log.context;
        try { context = JSON.stringify(JSON.parse(log.context), null, 2); } catch { /* keep raw */ }
        return `<dl>
            <dt>Time</dt><dd>${esc(new Date(log.ts).toISOString())}</dd>
            ${log.app ? `<dt>App</dt><dd>${esc(log.app)}</dd>` : ''}
            ${log.channel ? `<dt>Channel</dt><dd>${esc(log.channel)}</dd>` : ''}
            ${log.url ? `<dt>Request</dt><dd class="mono">${esc(`${log.method || ''} ${log.url}`)}</dd>` : ''}
            ${log.ip ? `<dt>IP</dt><dd>${esc(log.ip)}</dd>` : ''}
            ${log.user_id ? `<dt>User</dt><dd>${esc(log.user_id)}</dd>` : ''}
            ${log.exception_class ? `<dt>Exception</dt><dd class="mono">${esc(log.exception_class)} at ${esc(log.exception_location)}</dd>` : ''}
            <dt>Issue</dt><dd><a href="#logs?fingerprint=${esc(log.fingerprint)}">${esc(log.fingerprint)}</a></dd>
          </dl>
          <strong>Message</strong><pre>${esc(log.message)}</pre>
          ${log.trace ? `<strong>Trace</strong><pre>${esc(log.trace)}</pre>` : ''}
          ${context ? `<strong>Context</strong><pre>${esc(context)}</pre>` : ''}`;
      },
      empty: 'No log entries match. Make sure the <code>remote</code> log channel is enabled in Laravel (see README).',
    });
  },

  async requests() {
    const filters = {
      status: state.params.get('status') || '',
      method: state.params.get('method') || '',
      q: state.params.get('q') || '',
      min_ms: state.params.get('min_ms') || '',
    };
    const opt = (value, label, current) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
    view.innerHTML = `
      <form class="filters" id="req-filters">
        <select name="status" aria-label="Status">
          ${opt('', 'All statuses', filters.status)}${['2xx', '3xx', '4xx', '5xx'].map((s) => opt(s, s, filters.status)).join('')}
        </select>
        <select name="method" aria-label="Method">
          ${opt('', 'All methods', filters.method)}${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((s) => opt(s, s, filters.method)).join('')}
        </select>
        <select name="min_ms" aria-label="Minimum duration">
          ${opt('', 'Any duration', filters.min_ms)}${['500', '1000', '3000'].map((s) => opt(s, `Slower than ${fmt.ms(+s)}`, filters.min_ms)).join('')}
        </select>
        <input type="search" name="q" placeholder="Path, route, IP or user ID…" value="${esc(filters.q)}">
        <button class="btn" type="submit">Apply</button>
      </form>
      <div id="req-table"></div>`;
    bindFilterForm('req-filters', 'requests', filters);
    await pagedTable({
      el: document.getElementById('req-table'),
      fetch: (before) => api('requests', { ...filters, before }).then((d) => d.requests),
      head: '<th>Time</th><th>Method</th><th>Path</th><th>Status</th><th class="num">Duration</th><th class="num">Memory</th><th>IP</th><th>User</th>',
      cols: 8,
      row: (r) => `<td class="nowrap mono">${esc(fmt.time(r.ts))}</td><td class="mono">${esc(r.method)}</td>
        <td class="mono truncate" title="${esc(r.route || '')}">${esc(r.path)}</td><td>${statusBadge(r.status)}</td>
        <td class="num">${fmt.ms(r.duration_ms)}</td><td class="num">${r.memory_mb == null ? '–' : `${r.memory_mb.toFixed(0)} MB`}</td>
        <td class="mono">${esc(r.ip || '')}</td><td>${esc(r.user_id || '')}</td>`,
      detail: async (r) => `<dl>
          <dt>Time</dt><dd>${esc(new Date(r.ts).toISOString())}</dd>
          ${r.app ? `<dt>App</dt><dd>${esc(r.app)}</dd>` : ''}
          <dt>Route</dt><dd class="mono">${esc(r.route || '–')}</dd>
          <dt>Path</dt><dd class="mono">${esc(r.path)}</dd>
          <dt>User agent</dt><dd>${esc(r.user_agent || '–')}</dd>
        </dl>`,
      empty: 'No requests match. Add the <code>LogRequests</code> middleware to your Laravel app (see README).',
    });
  },

  async uptime() {
    const { monitors } = await api('uptime');
    if (!monitors.length) {
      view.innerHTML = emptyState('No uptime checks yet. Set <code>UPTIME_URLS</code> in the logger’s <code>.env</code> and restart it.');
      return;
    }
    let html = '';
    monitors.forEach((mon, i) => {
      const up = mon.last?.ok === 1;
      const pill = mon.last
        ? `<span class="status-pill ${up ? 'up' : 'down'}">${up ? '● Up' : '▲ Down'}</span>`
        : '<span class="muted">No checks yet</span>';
      html += `<div class="section"><div class="card-head"><h2 class="mono">${esc(mon.url)}</h2>${pill}</div>
        <div class="tiles">
          ${tile('Uptime', fmt.pct(mon.uptimePct, 2), `${fmt.int(mon.checks)} checks`)}
          ${tile('Avg response', fmt.ms(mon.avgMs), `p95 ${fmt.ms(mon.p95Ms)}`)}
          ${tile('Last check', mon.last ? fmt.ago(mon.last.ts) : '–', mon.last ? (mon.last.error || `HTTP ${mon.last.status} · ${fmt.ms(mon.last.duration_ms)}`) : '')}
          ${tile('Failed checks', fmt.int(mon.series.reduce((a, p) => a + (p.failures || 0), 0)), 'in this range')}
        </div>
        <div class="section grid-2">
          ${chartHtml(`c-up-${i}`, 'Response time', [{ name: 'Response' }])}
          ${chartHtml(`c-fail-${i}`, 'Failed checks', [{ name: 'Failures' }])}
        </div>
        ${mon.incidents.length ? `<div class="section"><h2>Recent failures</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Status</th><th class="num">Duration</th><th>Error</th></tr></thead><tbody>${
          mon.incidents.map((f) => `<tr><td class="nowrap mono">${esc(fmt.time(f.ts))}</td><td>${statusBadge(f.status)}</td><td class="num">${fmt.ms(f.duration_ms)}</td><td>${esc(f.error || '')}</td></tr>`).join('')
        }</tbody></table></div></div>` : ''}
      </div>`;
    });
    view.innerHTML = html;
    monitors.forEach((mon, i) => {
      const times = mon.series.map((p) => p.t);
      registerChart(`c-up-${i}`, { times, yFormat: fmt.ms, series: [{ name: 'Avg response', color: 'var(--series-1)', values: mon.series.map((p) => p.avg) }] });
      registerChart(`c-fail-${i}`, { times, series: [{ name: 'Failed checks', color: 'var(--series-1)', values: mon.series.map((p) => p.failures) }] });
    });
  },

  async server() {
    const { servers } = await api('server');
    if (!servers.length) {
      view.innerHTML = emptyState('No server metrics yet. Install <code>agent/metrics-agent.sh</code> on your droplet (see README).');
      return;
    }
    let html = '';
    servers.forEach((s, i) => {
      const l = s.latest;
      html += `<div class="section"><h2>${esc(s.host)} <span class="muted">· last report ${esc(fmt.ago(l.ts))}</span></h2>
        <div class="tiles">
          ${tile('CPU', fmt.pct(l.cpu, 0), `load ${l.load1 ?? '–'}`)}
          ${tile('Memory', fmt.pct(l.mem_pct, 0), `${fmt.bytes(l.mem_used)} of ${fmt.bytes(l.mem_total)}`)}
          ${tile('Disk', fmt.pct(l.disk_pct, 0), `${fmt.bytes(l.disk_used)} of ${fmt.bytes(l.disk_total)}`)}
        </div>
        <div class="section grid-2">
          ${chartHtml(`c-res-${i}`, 'Resource usage', [
            { name: 'CPU', color: 'var(--series-1)' },
            { name: 'Memory', color: 'var(--series-2)' },
            { name: 'Disk', color: 'var(--series-3)' },
          ])}
          ${chartHtml(`c-load-${i}`, 'Load average (1 min)', [{ name: 'Load' }])}
        </div></div>`;
    });
    view.innerHTML = html;
    servers.forEach((s, i) => {
      const times = s.series.map((p) => p.t);
      registerChart(`c-res-${i}`, {
        times,
        yMax: 100,
        yFormat: (v) => `${Math.round(v)}%`,
        series: [
          { name: 'CPU', color: 'var(--series-1)', values: s.series.map((p) => p.cpu) },
          { name: 'Memory', color: 'var(--series-2)', values: s.series.map((p) => p.mem) },
          { name: 'Disk', color: 'var(--series-3)', values: s.series.map((p) => p.disk) },
        ],
      });
      registerChart(`c-load-${i}`, {
        times,
        yFormat: (v) => v.toFixed(1),
        series: [{ name: 'Load', color: 'var(--series-1)', values: s.series.map((p) => p.load1) }],
      });
    });
  },
};

function emptyState(html) {
  return `<div class="empty">${html}</div>`;
}

function bindFilterForm(id, tab, current) {
  document.getElementById(id).addEventListener('submit', (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(e.target)) if (v) params.set(k, v);
    if (current.fingerprint) params.set('fingerprint', current.fingerprint);
    location.hash = `${tab}${params.size ? `?${params}` : ''}`;
  });
}

async function pagedTable({ el, fetch, head, row, cols, detail, empty }) {
  const rows = await fetch();
  if (!rows.length) {
    el.innerHTML = emptyState(empty);
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody></tbody></table></div>
    <button class="btn load-more" type="button">Load more</button>`;
  const tbody = el.querySelector('tbody');
  const more = el.querySelector('.load-more');
  let lastId = null;

  const append = (items) => {
    for (const item of items) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.innerHTML = row(item);
      tr.addEventListener('click', async () => {
        const next = tr.nextElementSibling;
        if (next?.classList.contains('detail')) { next.remove(); return; }
        const d = document.createElement('tr');
        d.className = 'detail';
        d.innerHTML = `<td colspan="${cols}">Loading…</td>`;
        tr.after(d);
        try { d.firstElementChild.innerHTML = await detail(item); } catch (err) { d.firstElementChild.textContent = `Failed to load: ${err.message}`; }
      });
      tbody.append(tr);
      lastId = item.id;
    }
    more.hidden = items.length < 100;
  };
  append(rows);
  more.addEventListener('click', async () => {
    more.disabled = true;
    append(await fetch(lastId));
    more.disabled = false;
  });
}

// ---------- routing ----------

async function render() {
  const [tab, query] = location.hash.slice(1).split('?');
  state.tab = views[tab] ? tab : 'overview';
  state.params = new URLSearchParams(query || '');
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === state.tab));
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));

  charts.length = 0;
  try {
    await views[state.tab]();
    drawCharts();
  } catch (err) {
    view.innerHTML = `<div class="error-banner">Could not load data: ${esc(err.message)}</div>`;
  }

  // Live views refresh themselves; tables don't, so expanded rows aren't yanked away.
  clearInterval(refreshTimer);
  if (['overview', 'uptime', 'server', 'issues'].includes(state.tab)) refreshTimer = setInterval(render, 30_000);
}

document.getElementById('range').addEventListener('click', (e) => {
  const range = e.target.dataset?.range;
  if (!range) return;
  state.range = range;
  safeSet('range', range);
  render();
});
document.getElementById('refresh').addEventListener('click', render);
window.addEventListener('hashchange', render);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 150);
});

render();
