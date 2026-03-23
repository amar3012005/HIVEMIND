function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAdminLogsPage({ controlPlaneBaseUrl, coreBaseUrl }) {
  const defaultControlPlaneBase = escapeHtml(controlPlaneBaseUrl);
  const defaultCoreBase = escapeHtml(coreBaseUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HIVEMIND Admin Logs</title>
    <style>
      :root {
        --bg: #07111a;
        --bg-soft: #0c1822;
        --panel: rgba(10, 19, 28, 0.92);
        --panel-strong: rgba(13, 24, 36, 0.98);
        --border: rgba(157, 181, 201, 0.14);
        --text: #eff6ff;
        --muted: #94a3b8;
        --lime: #bdf213;
        --blue: #38bdf8;
        --red: #fb7185;
        --amber: #fbbf24;
        --green: #34d399;
        --shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(56, 189, 248, 0.16), transparent 30%),
          radial-gradient(circle at top right, rgba(189, 242, 19, 0.12), transparent 26%),
          linear-gradient(180deg, #04080c 0%, #07111a 45%, #08121b 100%);
        min-height: 100vh;
      }
      .shell {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(320px, 0.8fr);
        gap: 20px;
        margin-bottom: 24px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 22px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .hero-main {
        padding: 28px;
      }
      .hero h1 {
        margin: 0 0 10px;
        font-size: clamp(28px, 4vw, 42px);
        line-height: 1;
        letter-spacing: -0.04em;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
        max-width: 64ch;
        line-height: 1.55;
      }
      .hero-side {
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      label {
        display: block;
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      input, button {
        font: inherit;
      }
      input[type="password"], input[type="text"] {
        width: 100%;
        background: rgba(255,255,255,0.04);
        color: var(--text);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        padding: 12px 14px;
        outline: none;
      }
      input:focus {
        border-color: rgba(189, 242, 19, 0.45);
        box-shadow: 0 0 0 3px rgba(189, 242, 19, 0.12);
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .btn {
        border: 1px solid transparent;
        border-radius: 14px;
        padding: 11px 16px;
        cursor: pointer;
        transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease;
      }
      .btn:hover { transform: translateY(-1px); }
      .btn-primary {
        background: linear-gradient(135deg, var(--lime), #d9ff5c);
        color: #091018;
        font-weight: 700;
      }
      .btn-secondary {
        background: rgba(255,255,255,0.04);
        color: var(--text);
        border-color: rgba(255,255,255,0.08);
      }
      .meta {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .pill, .tag {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        color: var(--muted);
        font-size: 12px;
      }
      .tag {
        cursor: pointer;
      }
      .tag.active {
        border-color: rgba(189, 242, 19, 0.36);
        background: rgba(189, 242, 19, 0.12);
        color: var(--text);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 18px;
      }
      .span-4 { grid-column: span 4; }
      .span-6 { grid-column: span 6; }
      .span-8 { grid-column: span 8; }
      .span-12 { grid-column: span 12; }
      .panel {
        padding: 20px;
      }
      .panel h2 {
        margin: 0 0 16px;
        font-size: 15px;
        letter-spacing: 0.02em;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .stat {
        padding: 16px;
        border-radius: 16px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
      }
      .stat .label {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        margin-bottom: 8px;
      }
      .stat .value {
        font-size: 28px;
        font-family: "JetBrains Mono", monospace;
      }
      .service-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .service-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        display: inline-block;
      }
      .ok { background: var(--green); }
      .warn { background: var(--amber); }
      .err { background: var(--red); }
      .muted { background: rgba(255,255,255,0.18); }
      .kv {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .kv-item {
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 16px;
        padding: 14px;
        background: rgba(255,255,255,0.025);
      }
      .kv-item .k {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        margin-bottom: 6px;
      }
      .kv-item .v {
        font-family: "JetBrains Mono", monospace;
        font-size: 13px;
        word-break: break-word;
      }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .toolbar-left, .toolbar-right {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 12px 10px;
        vertical-align: top;
      }
      th {
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      td {
        font-size: 13px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .log-message {
        font-family: "JetBrains Mono", monospace;
        color: #dbeafe;
        line-height: 1.45;
      }
      .mono {
        font-family: "JetBrains Mono", monospace;
      }
      .context {
        margin-top: 8px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.05);
        color: var(--muted);
        font-size: 12px;
        white-space: pre-wrap;
      }
      .empty {
        padding: 36px 18px;
        text-align: center;
        color: var(--muted);
      }
      .banner {
        margin-top: 16px;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(251, 113, 133, 0.25);
        background: rgba(127, 29, 29, 0.2);
        color: #fecdd3;
        display: none;
      }
      .banner.show {
        display: block;
      }
      @media (max-width: 1100px) {
        .hero, .stats, .kv {
          grid-template-columns: 1fr;
        }
        .span-4, .span-6, .span-8 {
          grid-column: span 12;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="hero-main card">
          <h1>Admin Log Console</h1>
          <p>
            Unified observability for the HIVE-MIND core and control plane. This panel gives you live health, recent errors,
            runtime signals, and a tagged stream of logs so you can diagnose issues without hopping between containers.
          </p>
          <div class="meta">
            <span class="pill">Core: ${defaultCoreBase}</span>
            <span class="pill">Control plane: ${defaultControlPlaneBase}</span>
            <span class="pill" id="lastUpdated">Waiting for first refresh</span>
          </div>
        </div>
        <div class="hero-side card">
          <div>
            <label for="adminSecret">Admin Secret</label>
            <input id="adminSecret" type="password" placeholder="Enter HIVEMIND admin secret" />
          </div>
          <div class="actions">
            <button id="connectBtn" class="btn btn-primary">Connect Dashboard</button>
            <button id="refreshBtn" class="btn btn-secondary">Refresh Now</button>
          </div>
          <div class="actions">
            <button id="autoRefreshBtn" class="btn btn-secondary">Auto Refresh: On</button>
            <input id="searchInput" type="text" placeholder="Search logs, errors, services" />
          </div>
          <div id="errorBanner" class="banner"></div>
        </div>
      </section>

      <section class="card panel" style="margin-bottom:18px;">
        <div class="toolbar">
          <div class="toolbar-left" id="serviceTags"></div>
          <div class="toolbar-right" id="levelTags"></div>
        </div>
        <div class="stats" id="statsGrid"></div>
      </section>

      <section class="grid">
        <div class="span-6 card panel">
          <div class="service-header">
            <div class="service-title">
              <span class="dot muted" id="coreDot"></span>
              <div>
                <h2 style="margin:0;">Core Service</h2>
                <div class="mono" id="coreHealthLine" style="color:var(--muted);font-size:12px;"></div>
              </div>
            </div>
          </div>
          <div class="kv" id="coreDetails"></div>
        </div>

        <div class="span-6 card panel">
          <div class="service-header">
            <div class="service-title">
              <span class="dot muted" id="controlDot"></span>
              <div>
                <h2 style="margin:0;">Control Plane</h2>
                <div class="mono" id="controlHealthLine" style="color:var(--muted);font-size:12px;"></div>
              </div>
            </div>
          </div>
          <div class="kv" id="controlDetails"></div>
        </div>

        <div class="span-12 card panel">
          <div class="toolbar">
            <div class="toolbar-left">
              <h2 style="margin:0;">Live Event Stream</h2>
            </div>
            <div class="toolbar-right">
              <span class="pill" id="logCountPill">0 events</span>
            </div>
          </div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th style="width:170px;">Time</th>
                  <th style="width:130px;">Service</th>
                  <th style="width:110px;">Level</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody id="logsTable"></tbody>
            </table>
          </div>
        </div>
      </section>
    </div>

    <script>
      const secretInput = document.getElementById('adminSecret');
      const searchInput = document.getElementById('searchInput');
      const connectBtn = document.getElementById('connectBtn');
      const refreshBtn = document.getElementById('refreshBtn');
      const autoRefreshBtn = document.getElementById('autoRefreshBtn');
      const lastUpdated = document.getElementById('lastUpdated');
      const errorBanner = document.getElementById('errorBanner');
      const statsGrid = document.getElementById('statsGrid');
      const logsTable = document.getElementById('logsTable');
      const logCountPill = document.getElementById('logCountPill');
      const serviceTags = document.getElementById('serviceTags');
      const levelTags = document.getElementById('levelTags');
      const coreDot = document.getElementById('coreDot');
      const controlDot = document.getElementById('controlDot');
      const coreHealthLine = document.getElementById('coreHealthLine');
      const controlHealthLine = document.getElementById('controlHealthLine');
      const coreDetails = document.getElementById('coreDetails');
      const controlDetails = document.getElementById('controlDetails');

      const state = {
        secret: sessionStorage.getItem('hivemind_admin_secret') || '',
        search: '',
        serviceFilter: 'all',
        levelFilter: 'all',
        autoRefresh: true,
        timer: null,
        data: null,
      };

      secretInput.value = state.secret;

      function setError(message) {
        if (!message) {
          errorBanner.classList.remove('show');
          errorBanner.textContent = '';
          return;
        }
        errorBanner.textContent = message;
        errorBanner.classList.add('show');
      }

      function formatTime(value) {
        if (!value) return 'n/a';
        try {
          return new Date(value).toLocaleString();
        } catch {
          return value;
        }
      }

      function formatDuration(seconds) {
        if (!Number.isFinite(seconds)) return 'n/a';
        if (seconds < 60) return Math.round(seconds) + 's';
        if (seconds < 3600) return Math.round(seconds / 60) + 'm';
        return (seconds / 3600).toFixed(1) + 'h';
      }

      function dotClass(ok, summary) {
        if (!ok) return 'dot err';
        if ((summary?.errors || 0) > 0) return 'dot warn';
        return 'dot ok';
      }

      function renderDetailGrid(target, snapshot) {
        const items = [
          ['Status', snapshot.health?.ok ? 'healthy' : 'degraded'],
          ['Service', snapshot.health?.service || snapshot.service],
          ['Uptime', formatDuration(snapshot.runtime?.uptime_seconds)],
          ['Memory', snapshot.runtime?.rss_mb ? snapshot.runtime.rss_mb + ' MB RSS' : 'n/a'],
          ['Errors', String(snapshot.summary?.errors || 0)],
          ['Warnings', String(snapshot.summary?.warnings || 0)],
          ['Last Error', formatTime(snapshot.summary?.lastErrorAt)],
          ['Updated', formatTime(snapshot.observed_at)],
        ];
        target.innerHTML = items.map(([k, v]) => \`
          <div class="kv-item">
            <div class="k">\${k}</div>
            <div class="v">\${v}</div>
          </div>
        \`).join('');
      }

      function renderStats(data) {
        const merged = data.logs || [];
        const errors = merged.filter((entry) => entry.level === 'error').length;
        const warnings = merged.filter((entry) => entry.level === 'warn').length;
        const coreOk = data.core?.health?.ok;
        const controlOk = data.control_plane?.health?.ok;
        const stats = [
          ['Total Events', merged.length, 'All merged core and control-plane log events'],
          ['Errors', errors, 'Recent high-priority failures and thrown exceptions'],
          ['Warnings', warnings, 'Signals worth checking before they escalate'],
          ['Services Healthy', [coreOk, controlOk].filter(Boolean).length + '/2', 'Live service health checks'],
        ];
        statsGrid.innerHTML = stats.map(([label, value, note]) => \`
          <div class="stat">
            <div class="label">\${label}</div>
            <div class="value">\${value}</div>
            <div style="margin-top:8px;color:var(--muted);font-size:12px;line-height:1.45;">\${note}</div>
          </div>
        \`).join('');
      }

      function renderTags(logs) {
        const serviceCounts = logs.reduce((acc, log) => {
          acc[log.service] = (acc[log.service] || 0) + 1;
          return acc;
        }, {});
        const levelCounts = logs.reduce((acc, log) => {
          acc[log.level] = (acc[log.level] || 0) + 1;
          return acc;
        }, {});

        const serviceOptions = [['all', 'All services', logs.length], ['core', 'Core', serviceCounts.core || 0], ['control-plane', 'Control plane', serviceCounts['control-plane'] || 0]];
        const levelOptions = [['all', 'All levels', logs.length], ['error', 'Errors', levelCounts.error || 0], ['warn', 'Warnings', levelCounts.warn || 0], ['info', 'Info', levelCounts.info || 0], ['log', 'Logs', levelCounts.log || 0]];

        serviceTags.innerHTML = serviceOptions.map(([value, label, count]) => \`
          <button class="tag \${state.serviceFilter === value ? 'active' : ''}" data-service="\${value}">
            <span>\${label}</span>
            <span class="mono">\${count}</span>
          </button>
        \`).join('');
        levelTags.innerHTML = levelOptions.map(([value, label, count]) => \`
          <button class="tag \${state.levelFilter === value ? 'active' : ''}" data-level="\${value}">
            <span>\${label}</span>
            <span class="mono">\${count}</span>
          </button>
        \`).join('');
      }

      function renderLogs(data) {
        const filtered = (data.logs || []).filter((entry) => {
          if (state.serviceFilter !== 'all' && entry.service !== state.serviceFilter) return false;
          if (state.levelFilter !== 'all' && entry.level !== state.levelFilter) return false;
          if (state.search && !entry.message.toLowerCase().includes(state.search.toLowerCase())) return false;
          return true;
        });

        logCountPill.textContent = filtered.length + ' events';

        if (!filtered.length) {
          logsTable.innerHTML = '<tr><td colspan="4" class="empty">No events match the current filters.</td></tr>';
          return;
        }

        logsTable.innerHTML = filtered.map((entry) => {
          const context = entry.context && entry.context.length
            ? '<div class="context">' + JSON.stringify(entry.context, null, 2) + '</div>'
            : '';
          const levelClass = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : 'ok';
          return \`
            <tr>
              <td class="mono">\${formatTime(entry.timestamp)}</td>
              <td><span class="pill">\${entry.service}</span></td>
              <td><span class="pill"><span class="dot \${levelClass}"></span>\${entry.level}</span></td>
              <td>
                <div class="log-message">\${entry.message}</div>
                \${context}
              </td>
            </tr>
          \`;
        }).join('');
      }

      function render(data) {
        state.data = data;
        setError(data.control_plane?.error || '');
        lastUpdated.textContent = 'Updated ' + formatTime(data.observed_at);

        coreDot.className = dotClass(data.core?.health?.ok, data.core?.summary);
        controlDot.className = dotClass(data.control_plane?.health?.ok, data.control_plane?.summary);
        coreHealthLine.textContent = (data.core?.health?.service || 'core') + ' • ' + (data.core?.health?.ok ? 'healthy' : 'degraded');
        controlHealthLine.textContent = (data.control_plane?.health?.service || 'control-plane') + ' • ' + (data.control_plane?.health?.ok ? 'healthy' : 'degraded');

        renderDetailGrid(coreDetails, data.core);
        renderDetailGrid(controlDetails, data.control_plane);
        renderStats(data);
        renderTags(data.logs || []);
        renderLogs(data);
      }

      async function refresh() {
        if (!state.secret) {
          setError('Enter the admin secret to load live observability.');
          return;
        }
        sessionStorage.setItem('hivemind_admin_secret', state.secret);
        try {
          const response = await fetch('/admin/api/observability', {
            headers: { 'X-Admin-Secret': state.secret },
            credentials: 'same-origin',
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || 'Failed to load observability');
          }
          render(payload);
        } catch (error) {
          setError(error.message);
        }
      }

      function scheduleRefresh() {
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        if (state.autoRefresh) {
          state.timer = setInterval(refresh, 5000);
        }
        autoRefreshBtn.textContent = 'Auto Refresh: ' + (state.autoRefresh ? 'On' : 'Off');
      }

      connectBtn.addEventListener('click', () => {
        state.secret = secretInput.value.trim();
        refresh();
      });
      refreshBtn.addEventListener('click', () => {
        state.secret = secretInput.value.trim();
        refresh();
      });
      autoRefreshBtn.addEventListener('click', () => {
        state.autoRefresh = !state.autoRefresh;
        scheduleRefresh();
      });
      searchInput.addEventListener('input', (event) => {
        state.search = event.target.value;
        if (state.data) renderLogs(state.data);
      });
      document.addEventListener('click', (event) => {
        const serviceValue = event.target.closest('[data-service]')?.getAttribute('data-service');
        const levelValue = event.target.closest('[data-level]')?.getAttribute('data-level');
        if (serviceValue) {
          state.serviceFilter = serviceValue;
          if (state.data) {
            renderTags(state.data.logs || []);
            renderLogs(state.data);
          }
        }
        if (levelValue) {
          state.levelFilter = levelValue;
          if (state.data) {
            renderTags(state.data.logs || []);
            renderLogs(state.data);
          }
        }
      });

      scheduleRefresh();
      if (state.secret) {
        refresh();
      }
    </script>
  </body>
</html>`;
}
