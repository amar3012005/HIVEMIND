/**
 * Phase 6e — hm-control `/hermes/*` route handler (tenant-scoped Hermes agents).
 *
 * Mounted in control-plane-server.js (NEVER server.js) as a single delegating call
 * just before the 404 fallthrough. Self-contained so the server diff stays one line.
 *
 * EVERY request is:
 *   1. flag-gated  — HERMES_MANAGER_ENABLED !== 'true' → 404 (prod behavior unchanged).
 *   2. session-auth — via injected requireSession.
 *   3. org-scoped   — list/create scoped to session.orgId; every :id route asserts
 *                     the agent row's org_id === session.orgId else 403 (no cross-org).
 *
 * Persistence: hivemind.hermes_agents (roster/config) + hivemind.hermes_jobs (append-only
 * audit) via raw SQL (same approach as hermes_runtimes — no schema.prisma drift).
 * Dispatch/lifecycle delegate to profile-manager (ensureProfile/runTask/destroyProfile).
 *
 * tenant == org: a tenant's profile id is its org_id (1 profile = 1 org).
 *
 * @module hermes/control-routes
 */
import crypto from 'node:crypto';
// profile-manager (→ runtime-spec → ajv) is lazy-imported only on dispatch so the
// default-OFF path (and server boot) never loads it. See run branch below.
// library is a static module with no heavy deps — imported at top level.
import { LIBRARY, findTemplate } from './library.js';
// profile-orchestrator: writeProfileFile + restartGateway + cron + env-merge ops (Phase 6h transport).
import { writeProfileFile, restartGateway, stopGateway, startGateway, listCron, addCron, deleteCron, mergeProfileEnv, buildConfigYaml, PROVIDER_BASE_URLS } from './profile-orchestrator.js';

/**
 * Whitelabelled browser connector (served at GET /hermes/wb/connector.mjs).
 * Runs on the USER's machine: long-polls the relay for commands and proxies them
 * to the local Kimi WebBridge daemon (127.0.0.1:10086), returning results. Dials
 * OUT only (no inbound ports). Usage: RELAY=<url> WB_TOKEN=<token> node connector.mjs
 */
const WEBBRIDGE_CONNECTOR_JS = `#!/usr/bin/env node
// HiveMind Web-bridge automation connector. Proxies relay <-> local Kimi daemon.
const RELAY = (process.env.RELAY || '').replace(/\\/+$/, '');
const TOKEN = process.env.WB_TOKEN || '';
const DAEMON = process.env.WB_DAEMON || 'http://127.0.0.1:10086';
if (!RELAY || !TOKEN) { console.error('Set RELAY and WB_TOKEN'); process.exit(1); }
const H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
async function runOne(cmd) {
  try {
    const r = await fetch(DAEMON + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: cmd.action, args: cmd.args || {}, session: (cmd.args && cmd.args.session) || 'hivemind' }) });
    const data = await r.json().catch(() => ({ ok: false, error: 'daemon non-json' }));
    return data;
  } catch (e) { return { ok: false, error: 'daemon unreachable: ' + e.message }; }
}
async function loop() {
  console.log('[webbridge-connector] connected to', RELAY, '— browser tasks enabled. Ctrl+C to stop.');
  for (;;) {
    try {
      const r = await fetch(RELAY + '/hermes/wb/poll', { headers: H });
      if (r.status === 401) { console.error('pairing token rejected — re-pair from the app'); process.exit(1); }
      const { commands = [] } = await r.json().catch(() => ({ commands: [] }));
      for (const cmd of commands) {
        const result = await runOne(cmd);
        await fetch(RELAY + '/hermes/wb/result', { method: 'POST', headers: H, body: JSON.stringify({ commandId: cmd.id, result }) }).catch(() => {});
      }
    } catch (e) { await new Promise((s) => setTimeout(s, 2000)); }
  }
}
loop();
`;

const DEFAULT_MODEL = { provider: 'openrouter', model: process.env.HERMES_MODEL || 'google/gemini-2.5-flash' };
const ALLOWED_PROVIDERS = ['groq', 'openrouter'];

/**
 * Fetch the selectable model list from a provider (server-side).
 *
 * - groq: uses the Groq platform key; returns all available models.
 * - openrouter: filters to TOOL-CAPABLE models only — entries whose
 *   `supported_parameters` array includes 'tools'. This excludes base models
 *   that would 404 at the /v1/chat/completions?route=tool-call endpoint and
 *   NousResearch/hermes models that have no tool endpoint on OpenRouter.
 *
 * Returns [{id, name}].
 */
async function fetchProviderModels(provider) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    if (provider === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY || ''}` }, signal: ctrl.signal,
      });
      const d = await r.json().catch(() => ({}));
      return (d.data || []).map((m) => ({ id: m.id, name: m.id }));
    }
    if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/models', { signal: ctrl.signal });
      const d = await r.json().catch(() => ({}));
      // Filter to models that explicitly declare 'tools' support so the gateway
      // can use tool-calling. Models without this parameter silently drop tool
      // schemas or 404 at the tool-call endpoint.
      return (d.data || [])
        .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'))
        .map((m) => ({ id: m.id, name: m.name || m.id }));
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const ROUTE_PREFIX = '/hermes/';

/**
 * Browser-automation MCP tools (P2). Exposed to the Hermes gateway as a JSON-RPC
 * MCP server at POST /hermes/mcp/browser (same hand-rolled transport as the
 * hivemind MCP). Each tool name maps 1:1 to a Kimi WebBridge action; tools/call
 * forwards to webbridge-relay.dispatch(tenant,…) → the user's connector → browser.
 */
const BROWSER_TOOLS = [
  { name: 'navigate', description: 'Open a URL in the user’s browser (use newTab:true on first call).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, newTab: { type: 'boolean' }, group_title: { type: 'string' } }, required: ['url'] } },
  { name: 'find_tab', description: 'Reuse an already-open tab by URL/domain (active:true = the tab the user is viewing).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' } }, required: ['url'] } },
  { name: 'snapshot', description: 'Read the current page as an accessibility tree (text) with @e element refs.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'click', description: 'Click an element by @e ref or CSS selector.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'fill', description: 'Fill an input/textarea/contenteditable (clear-and-insert).',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } },
  { name: 'evaluate', description: 'Run JS in the page (supports async). Return compact JSON.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'list_tabs', description: 'List open tabs in the session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'save_as_pdf', description: 'Render the current page to PDF (saved on the user machine).',
    inputSchema: { type: 'object', properties: { paper_format: { type: 'string' }, landscape: { type: 'boolean' }, file_name: { type: 'string' } } } },
  { name: 'close_session', description: 'Close all tabs in the session (call at task end).', inputSchema: { type: 'object', properties: {} } },
];

/**
 * Supported messaging channel types and the env var(s) each requires.
 * Telegram is the simplest (one token). Slack requires two tokens (xoxb- + xapp-).
 * Discord: no dedicated platform adapter file was confirmed during recon — we gate
 * it as 'unsupported' and return 400 so the FE can show a clear error rather than
 * silently misconfiguring the profile env.
 *
 * Structure: { envVars: string[], label: string, supported: boolean }
 */
const CHANNEL_SPECS = {
  telegram: {
    label: 'Telegram',
    supported: true,
    envVars: ['TELEGRAM_BOT_TOKEN'],
    tokenFields: ['token'], // body field names that map 1:1 to envVars
  },
  slack: {
    label: 'Slack',
    supported: true,
    envVars: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    tokenFields: ['bot_token', 'app_token'],
  },
  discord: {
    label: 'Discord',
    supported: false, // no dedicated platform adapter confirmed in recon
    envVars: [],
    tokenFields: [],
  },
};

/** Extract channels status from hermes_agents.config.channels (defaults to all false). */
function channelsFromConfig(storedCfg) {
  const stored = (storedCfg && typeof storedCfg.channels === 'object' && storedCfg.channels !== null)
    ? storedCfg.channels
    : {};
  return {
    telegram: !!stored.telegram,
    slack: !!stored.slack,
    discord: !!stored.discord,
  };
}

/**
 * Canonical skill catalog — 6 toggleable capabilities.
 * `enabled` is the DEFAULT state for a new agent (all on except browser for safety).
 */
const DEFAULT_SKILLS = [
  { id: 'web_search',    label: 'Web Search',    description: 'Search the web for up-to-date information.', enabled: true },
  { id: 'slack_post',    label: 'Slack Post',    description: 'Post messages to Slack channels.',           enabled: true },
  { id: 'memory_read',   label: 'Memory Read',   description: 'Read from HiveMind long-term memory.',       enabled: true },
  { id: 'memory_write',  label: 'Memory Write',  description: 'Write to HiveMind long-term memory.',        enabled: true },
  { id: 'browser',       label: 'Browser',       description: 'Headless browser for web automation.',       enabled: false },
  { id: 'files',         label: 'Files',         description: 'Read/write files in the profile workspace.', enabled: true },
];

/**
 * Build a minimal skills.yaml fragment that Hermes can merge as an extra config.
 * Writes enabled skill ids into a `capabilities` list — the gateway picks these
 * up on restart. Structure matches profile-manager's buildProfileConfigYaml shape.
 * @param {string[]} enabledIds
 * @returns {string}
 */
function buildSkillsConfigYaml(enabledIds) {
  const lines = ['# Auto-generated by HiveMind Hermes skill toggles', 'capabilities:'];
  for (const id of enabledIds) lines.push(`  - ${id}`);
  lines.push('');
  return lines.join('\n');
}

function isEnabled() {
  return process.env.HERMES_MANAGER_ENABLED === 'true';
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Load one agent row scoped to org. Returns null if absent OR not owned by org. */
async function loadOwnedAgent(prisma, orgId, agentId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, org_id, tenant_id, name, config, status
       FROM hivemind.hermes_agents
      WHERE id = $1 AND deleted_at IS NULL`,
    agentId,
  ).catch(() => []);
  const row = rows && rows[0];
  if (!row) return { row: null, forbidden: false };
  if (row.org_id !== orgId) return { row: null, forbidden: true };
  return { row, forbidden: false };
}

async function auditJob(prisma, { orgId, tenantId, agentId, action, status, payload, result, createdBy }) {
  const id = newId('hjob');
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.hermes_jobs
       (id, org_id, tenant_id, agent_id, action, status, payload, result, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    id, orgId, tenantId, agentId, action, status,
    JSON.stringify(payload || null), JSON.stringify(result || null), createdBy || null,
  ).catch(() => {});
  return id;
}

// ─── HTML response rendering (zero-dep, XSS-safe by construction) ────────────
// Agent output is UNTRUSTED. We escape ALL html first, then regex-upgrade a safe
// markdown subset around the already-escaped text — so the only tags that ever
// reach the page are ours. No markdown/sanitizer dependency needed.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mdToSafeHtml(md) {
  const src = String(md == null ? '' : md);
  // 1. Pull out fenced code blocks first (so their contents are not md-parsed).
  const blocks = [];
  let work = src.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre class="code"><code>${escapeHtml(code.replace(/^\n/, ''))}</code></pre>`);
    return ` BLOCK${blocks.length - 1} `;
  });
  // 2. Escape everything else.
  work = escapeHtml(work);
  // 3. Inline upgrades on the escaped text.
  work = work
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // links [text](http(s)://...) — scheme-restricted, no javascript:/data:
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) =>
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  // 4. Block-level: headings + lists + paragraphs, line by line.
  const lines = work.split(/\r?\n/);
  const out = [];
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const raw of lines) {
    const line = raw;
    if (/^ BLOCK\d+ $/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    let m;
    if ((m = line.match(/^\s*(#{1,4})\s+(.*)$/))) { closeList(); const n = m[1].length; out.push(`<h${n}>${m[2]}</h${n}>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${m[1]}</li>`); continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${m[1]}</li>`); continue; }
    if (line.trim() === '') { closeList(); out.push(''); continue; }
    closeList(); out.push(`<p>${line}</p>`);
  }
  closeList();
  let html = out.join('\n');
  // 5. Restore code blocks.
  html = html.replace(/ BLOCK(\d+) /g, (_, i) => blocks[Number(i)] || '');
  return html;
}

// Full standalone HTML document with a strict CSP — no remote anything, inline
// styles only, no scripts. Safe to serve to an unauthenticated viewer.
function renderResultPage({ title, bodyHtml, meta }) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title || 'Hermes result')}</title>
<style>
:root{--bg:#faf9f4;--card:#fff;--ink:#0a0a0a;--mut:#737373;--line:#e3e0db;--accent:#117dff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 'Space Grotesk',-apple-system,system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:40px 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 36px}
.meta{color:var(--mut);font-size:12px;margin:0 0 20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;background:#f0eee7;font-size:11px}
h1,h2,h3,h4{font-weight:600;line-height:1.3;margin:1.4em 0 .5em}h1{font-size:24px}h2{font-size:19px}h3{font-size:16px}
p{margin:.7em 0}ul,ol{margin:.6em 0;padding-left:1.4em}li{margin:.25em 0}
code{background:#f0eee7;padding:1px 5px;border-radius:4px;font:13px ui-monospace,Menlo,monospace}
pre.code{background:#0a0a0a;color:#e8e8e8;padding:16px;border-radius:10px;overflow:auto}
pre.code code{background:none;color:inherit;padding:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.foot{color:var(--mut);font-size:11px;text-align:center;margin-top:24px}
</style></head>
<body><div class="wrap"><div class="card">
<div class="meta"><span class="badge">Hermes</span>${meta ? escapeHtml(meta) : ''}</div>
${bodyHtml}
</div><div class="foot">Generated by HIVEMIND Hermes · read-only</div></div></body></html>`;
}

// Extract the agent's text completion from a stored hermes_jobs.result jsonb.
// runOnce stores { ok, status, result:<string>, usage, issues }.
function resultToText(stored) {
  if (stored == null) return '';
  if (typeof stored === 'string') return stored;
  if (typeof stored.result === 'string') return stored.result;
  if (stored.result && typeof stored.result === 'object') return JSON.stringify(stored.result, null, 2);
  return JSON.stringify(stored, null, 2);
}

// Lazily create the share-link table (raw-SQL convention — no prisma schema).
// Memoized so the DDL runs at most once per process.
let _shareTableReady = null;
function ensureShareTable(prisma) {
  if (!_shareTableReady) {
    _shareTableReady = prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS hivemind.hermes_share_links (
        token_hash  text PRIMARY KEY,
        job_id      text NOT NULL,
        org_id      uuid NOT NULL,
        created_by  uuid,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL,
        revoked_at  timestamptz
      )`).catch((e) => { _shareTableReady = null; throw e; });
  }
  return _shareTableReady;
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Build the public base for share URLs from proxy headers (Caddy sets them),
// falling back to env. Never trust an internal docker host.
function publicBaseFromReq(req) {
  const env = process.env.HERMES_PUBLIC_BASE || process.env.CONTROL_PLANE_PUBLIC_URL;
  if (env) return env.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'hivemind.davinciai.eu').split(',')[0].trim();
  return `${proto}://${host}`;
}

/**
 * Handle a `/hermes/*` request. Returns true if it owned the response, false to fall through.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ pathname:string, method:string, prisma:object,
 *           jsonResponse:Function, parseBody:Function, requireSession:Function }} ctx
 * @returns {Promise<boolean>}
 */
export async function handleHermesRoutes(req, res, ctx) {
  const { pathname, method, prisma, jsonResponse, parseBody, requireSession } = ctx;
  if (!pathname.startsWith(ROUTE_PREFIX)) return false;

  // (1) Flag gate — default OFF → indistinguishable from a non-existent route.
  if (!isEnabled()) {
    jsonResponse(res, { error: 'Not found' }, 404);
    return true;
  }
  if (!prisma) {
    jsonResponse(res, { error: 'Database unavailable' }, 503);
    return true;
  }

  // (1a) Public connector bootstrap script (no auth) — the whitelabelled installer.
  if (pathname === '/hermes/wb/connector.mjs' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(WEBBRIDGE_CONNECTOR_JS);
    return true;
  }

  // (1b) Web-bridge CONNECTOR routes — authenticated by PAIRING TOKEN (not a
  // session): the connector runs on the user's machine, no cookie. Handle these
  // before session auth. Token → tenant via hermes_browser_pairings(token_hash).
  if (pathname === '/hermes/wb/poll' || pathname === '/hermes/wb/result' || pathname === '/hermes/wb/dispatch' || pathname === '/hermes/mcp/browser') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) { jsonResponse(res, { error: 'pairing token required' }, 401); return true; }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM hivemind.hermes_browser_pairings WHERE token_hash=$1 AND revoked_at IS NULL LIMIT 1`,
      tokenHash,
    ).catch(() => []);
    const wbTenant = rows && rows[0] && rows[0].tenant_id;
    if (!wbTenant) { jsonResponse(res, { error: 'invalid pairing token' }, 401); return true; }
    const relay = await import('./webbridge-relay.js');

    // Browser MCP server (JSON-RPC over POST) — the Hermes gateway connects here
    // as an MCP server (same hand-rolled transport as hivemind MCP). tools/call
    // forwards to the relay → this tenant's connector → the user's browser.
    if (pathname === '/hermes/mcp/browser' && method === 'POST') {
      const rpc = (await parseBody(req)) || {};
      const reply = (result) => jsonResponse(res, { jsonrpc: '2.0', id: rpc.id ?? null, result });
      if (rpc.method === 'initialize') {
        return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hivemind-web-automation', version: '1.0.0' } }), true;
      }
      if (rpc.method === 'notifications/initialized' || rpc.method === 'ping') { jsonResponse(res, { jsonrpc: '2.0', id: rpc.id ?? null, result: {} }); return true; }
      if (rpc.method === 'tools/list') { return reply({ tools: BROWSER_TOOLS }), true; }
      if (rpc.method === 'tools/call') {
        const name = rpc.params && rpc.params.name;
        const args = (rpc.params && rpc.params.arguments) || {};
        if (!BROWSER_TOOLS.some((t) => t.name === name)) {
          jsonResponse(res, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: `unknown tool ${name}` } });
          return true;
        }
        const out = await relay.dispatch(wbTenant, name, args);
        const isErr = out && out.ok === false;
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }], isError: !!isErr }), true;
      }
      jsonResponse(res, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: `method ${rpc.method} not found` } });
      return true;
    }

    // Agent/MCP side: dispatch a browser action to this tenant's connector. The
    // browser-MCP forwards the gateway's per-tenant token here (same token the
    // connector uses), so token → tenant resolution is identical.
    if (pathname === '/hermes/wb/dispatch' && method === 'POST') {
      const body = (await parseBody(req)) || {};
      if (!body.action) { jsonResponse(res, { error: 'action required' }, 400); return true; }
      const result = await relay.dispatch(wbTenant, String(body.action), body.args || {});
      jsonResponse(res, { result });
      return true;
    }
    if (pathname === '/hermes/wb/poll' && method === 'GET') {
      const cmds = await relay.poll(wbTenant);
      await prisma.$executeRawUnsafe(`UPDATE hivemind.hermes_browser_pairings SET last_seen_at=now() WHERE tenant_id=$1`, wbTenant).catch(() => {});
      jsonResponse(res, { commands: cmds });
      return true;
    }
    if (pathname === '/hermes/wb/result' && method === 'POST') {
      const body = (await parseBody(req)) || {};
      const ok = relay.submitResult(wbTenant, body.commandId, body.result);
      jsonResponse(res, { ok });
      return true;
    }
    jsonResponse(res, { error: 'method not allowed' }, 405);
    return true;
  }

  // (1c) PUBLIC share-view (no auth) — temporary, unguessable link to ONE job's
  // result rendered as HTML. Token is hashed at rest; checked against expiry +
  // revocation. Read-only, single job, CSP-locked. Anyone with the link views it.
  const shareView = pathname.match(/^\/hermes\/share\/([A-Za-z0-9_-]{16,})$/);
  if (shareView && method === 'GET') {
    try {
      await ensureShareTable(prisma);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT job_id, org_id, expires_at, revoked_at FROM hivemind.hermes_share_links WHERE token_hash=$1 LIMIT 1`,
        sha256(shareView[1]),
      );
      const link = rows && rows[0];
      const expired = link && new Date(link.expires_at).getTime() < Date.now();
      if (!link || link.revoked_at || expired) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderResultPage({ title: 'Link unavailable', bodyHtml: '<h2>This link is no longer available</h2><p>It may have expired or been revoked.</p>' }));
        return true;
      }
      const jrows = await prisma.$queryRawUnsafe(
        `SELECT result, action, created_at FROM hivemind.hermes_jobs WHERE id=$1 AND org_id=$2 LIMIT 1`,
        link.job_id, link.org_id,
      );
      const job = jrows && jrows[0];
      const text = resultToText(job && job.result);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderResultPage({
        title: 'Hermes result',
        meta: job && job.created_at ? new Date(job.created_at).toISOString().slice(0, 10) : '',
        bodyHtml: mdToSafeHtml(text) || '<p>No result recorded.</p>',
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderResultPage({ title: 'Error', bodyHtml: '<h2>Could not render this result</h2>' }));
    }
    return true;
  }

  // (2) Session auth.
  const current = await requireSession(req, res);
  if (!current) return true;
  const userId = current.session.userId;
  const orgId = current.session.orgId;
  if (!orgId) {
    jsonResponse(res, { error: 'No active organization' }, 400);
    return true;
  }
  const tenantId = orgId; // tenant == org

  try {
    // ── Collection: GET /hermes/agents ──────────────────────────────
    if (pathname === '/hermes/agents' && method === 'GET') {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status, created_at, updated_at
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL
          ORDER BY created_at ASC`,
        orgId,
      );
      jsonResponse(res, { agents: rows });
      return true;
    }

    // ── Collection: POST /hermes/agents ─────────────────────────────
    if (pathname === '/hermes/agents' && method === 'POST') {
      const body = (await parseBody(req)) || {};
      const name = String(body.name || '').trim();
      if (!name) { jsonResponse(res, { error: 'name required' }, 400); return true; }
      const id = newId('hagent');
      const config = body.config && typeof body.config === 'object' ? body.config : {};
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
        id, orgId, tenantId, name, JSON.stringify(config), userId,
      );
      jsonResponse(res, { id, org_id: orgId, tenant_id: tenantId, name, config, status: 'active' }, 201);
      return true;
    }

    // ── :id routes ──────────────────────────────────────────────────
    // /hermes/agents/:id
    const detail = pathname.match(/^\/hermes\/agents\/([^/]+)$/);
    if (detail && method === 'PATCH') {
      const agentId = detail[1];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const body = (await parseBody(req)) || {};
      const nextName = body.name != null ? String(body.name) : row.name;
      const nextConfig = body.config && typeof body.config === 'object' ? body.config : row.config;
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_agents
            SET name=$2, config=$3::jsonb, updated_at=now()
          WHERE id=$1`,
        agentId, nextName, JSON.stringify(nextConfig),
      );
      jsonResponse(res, { id: agentId, name: nextName, config: nextConfig, status: row.status });
      return true;
    }

    // POST /hermes/agents/:id/run | /pause | /resume
    const action = pathname.match(/^\/hermes\/agents\/([^/]+)\/(run|pause|resume)$/);
    if (action && method === 'POST') {
      const agentId = action[1];
      const verb = action[2];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }

      if (verb === 'pause' || verb === 'resume') {
        const status = verb === 'pause' ? 'paused' : 'active';
        await prisma.$executeRawUnsafe(
          `UPDATE hivemind.hermes_agents SET status=$2, updated_at=now() WHERE id=$1`,
          agentId, status,
        );
        await auditJob(prisma, { orgId, tenantId, agentId, action: verb, status: 'succeeded', createdBy: userId });
        jsonResponse(res, { id: agentId, status });
        return true;
      }

      // run
      if (row.status === 'paused') { jsonResponse(res, { error: 'Agent is paused' }, 409); return true; }
      const body = (await parseBody(req)) || {};
      const payload = { task: String(body.task || ''), context: body.context || '' };
      if (!payload.task) { jsonResponse(res, { error: 'task required' }, 400); return true; }
      const jobId = await auditJob(prisma, { orgId, tenantId, agentId, action: 'run', status: 'running', payload, createdBy: userId });
      // Build a normalized HermesAgentConfig so the strict AJV validator passes even
      // when the stored row.config is empty (agents created with minimal config).
      // agent_id MUST be a real UUID (the hagent_ row.id is NOT a UUID format).
      // hermes_profile convention: "org-<tenantId>" (matches profile-orchestrator.profileName).
      const storedCfg = (row.config && typeof row.config === 'object') ? row.config : {};
      const agentConfig = {
        // Defaults first — stored fields override below via spread.
        agent_id: crypto.randomUUID(),
        name: row.name,
        tenant_id: tenantId,
        hermes_profile: `org-${tenantId}`,
        memory_mode: 'hivemind_mcp',
        capabilities: Array.isArray(storedCfg.capabilities) ? storedCfg.capabilities : [],
        schedule: storedCfg.schedule && typeof storedCfg.schedule === 'object'
          ? storedCfg.schedule
          : { type: 'manual' },
        output_routes: Array.isArray(storedCfg.output_routes) && storedCfg.output_routes.length > 0
          ? storedCfg.output_routes
          : [{ type: 'hivemind_memory', tenant_id: tenantId }],
        safety_policy: storedCfg.safety_policy && typeof storedCfg.safety_policy === 'object'
          ? storedCfg.safety_policy
          : { max_tokens_per_run: 100000, max_runtime_seconds: 600 },
        status: row.status || 'active',
        // Spread stored config last so any explicitly-set fields override the defaults.
        ...storedCfg,
        // Re-assert non-negotiables that must not be overridden by empty stored values.
        tenant_id: tenantId,
        memory_mode: 'hivemind_mcp',
      };
      const { runTask } = await import('./profile-manager.js'); // lazy: pulls ajv only on dispatch
      const out = await runTask(prisma, tenantId, agentConfig, payload, { createdBy: userId });
      const status = out && out.ok ? 'succeeded' : 'failed';
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_jobs SET status=$2, result=$3::jsonb, updated_at=now() WHERE id=$1`,
        jobId, status, JSON.stringify(out || null),
      ).catch(() => {});
      jsonResponse(res, { job_id: jobId, status, result: out }, status === 'succeeded' ? 200 : 502);
      return true;
    }

    // GET /hermes/agents/:id/runs | /logs
    const listJobs = pathname.match(/^\/hermes\/agents\/([^/]+)\/(runs|logs)$/);
    if (listJobs && method === 'GET') {
      const agentId = listJobs[1];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, action, status, payload, result, created_at, updated_at
           FROM hivemind.hermes_jobs
          WHERE agent_id = $1 AND org_id = $2
          ORDER BY created_at DESC
          LIMIT 100`,
        agentId, orgId,
      );
      jsonResponse(res, { runs: rows });
      return true;
    }

    // ── GET /hermes/agents/:id/runs/:jobId/html — one-click HTML view (authed) ──
    const jobHtml = pathname.match(/^\/hermes\/agents\/([^/]+)\/runs\/([^/]+)\/html$/);
    if (jobHtml && method === 'GET') {
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, jobHtml[1]);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const jrows = await prisma.$queryRawUnsafe(
        `SELECT result, created_at FROM hivemind.hermes_jobs WHERE id=$1 AND agent_id=$2 AND org_id=$3 LIMIT 1`,
        jobHtml[2], jobHtml[1], orgId,
      );
      const job = jrows && jrows[0];
      if (!job) { jsonResponse(res, { error: 'Run not found' }, 404); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderResultPage({
        title: 'Hermes result',
        meta: job.created_at ? new Date(job.created_at).toISOString().slice(0, 10) : '',
        bodyHtml: mdToSafeHtml(resultToText(job.result)) || '<p>No result recorded.</p>',
      }));
      return true;
    }

    // ── POST /hermes/agents/:id/runs/:jobId/share — mint temp public link ──────
    const jobShare = pathname.match(/^\/hermes\/agents\/([^/]+)\/runs\/([^/]+)\/share$/);
    if (jobShare && method === 'POST') {
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, jobShare[1]);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const jrows = await prisma.$queryRawUnsafe(
        `SELECT id FROM hivemind.hermes_jobs WHERE id=$1 AND agent_id=$2 AND org_id=$3 LIMIT 1`,
        jobShare[2], jobShare[1], orgId,
      );
      if (!jrows || !jrows[0]) { jsonResponse(res, { error: 'Run not found' }, 404); return true; }
      await ensureShareTable(prisma);
      const ttlDays = 7;
      const token = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000);
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.hermes_share_links (token_hash, job_id, org_id, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        sha256(token), jobShare[2], orgId, userId, expiresAt,
      );
      jsonResponse(res, { url: `${publicBaseFromReq(req)}/hermes/share/${token}`, expires_at: expiresAt.toISOString(), ttl_days: ttlDays });
      return true;
    }

    // ── POST /hermes/agents/:id/runs/:jobId/unshare — revoke all links for a run ─
    const jobUnshare = pathname.match(/^\/hermes\/agents\/([^/]+)\/runs\/([^/]+)\/unshare$/);
    if (jobUnshare && method === 'POST') {
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, jobUnshare[1]);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      await ensureShareTable(prisma);
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_share_links SET revoked_at=now() WHERE job_id=$1 AND org_id=$2 AND revoked_at IS NULL`,
        jobUnshare[2], orgId,
      ).catch(() => {});
      jsonResponse(res, { ok: true });
      return true;
    }

    // GET /hermes/agents/:id/approvals
    const approvalsList = pathname.match(/^\/hermes\/agents\/([^/]+)\/approvals$/);
    if (approvalsList && method === 'GET') {
      const agentId = approvalsList[1];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, action, status, payload, created_at
           FROM hivemind.hermes_jobs
          WHERE agent_id = $1 AND org_id = $2 AND status = 'awaiting_approval'
          ORDER BY created_at DESC`,
        agentId, orgId,
      );
      jsonResponse(res, { approvals: rows });
      return true;
    }

    // POST /hermes/agents/:id/approvals/:aid  { decision: 'approve'|'reject' }
    const approvalAct = pathname.match(/^\/hermes\/agents\/([^/]+)\/approvals\/([^/]+)$/);
    if (approvalAct && method === 'POST') {
      const agentId = approvalAct[1];
      const approvalId = approvalAct[2];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const body = (await parseBody(req)) || {};
      const decision = body.decision === 'approve' ? 'approved' : 'rejected';
      // Org-scoped + agent-scoped update — cannot touch another org's approval row.
      const n = await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_jobs
            SET status=$4, updated_at=now()
          WHERE id=$1 AND agent_id=$2 AND org_id=$3 AND status='awaiting_approval'`,
        approvalId, agentId, orgId, decision,
      ).catch(() => 0);
      if (!n) { jsonResponse(res, { error: 'Approval not found' }, 404); return true; }
      jsonResponse(res, { id: approvalId, status: decision });
      return true;
    }

    // ── GET /hermes/agent — singleton canonical agent for the org ───────
    // Resolve-or-create: if an active hermes_agents row exists for this org,
    // return it; otherwise create one (name 'Hermes Agent') and return it.
    if (pathname === '/hermes/agent' && method === 'GET') {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status, created_at, updated_at
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC
          LIMIT 1`,
        orgId,
      );
      if (existing && existing.length > 0) {
        jsonResponse(res, { agent: existing[0] });
        return true;
      }
      // No active agent — create the canonical singleton.
      const id = newId('hagent');
      const name = 'Hermes Agent';
      const config = {};
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
        id, orgId, tenantId, name, JSON.stringify(config), userId,
      );
      jsonResponse(res, { agent: { id, org_id: orgId, tenant_id: tenantId, name, config, status: 'active' } }, 201);
      return true;
    }

    // ── GET /hermes/library — curated dispatch templates ────────────────
    if (pathname === '/hermes/library' && method === 'GET') {
      const items = LIBRARY.map(({ id, name, blurb, persona, suggestedTask, skills }) => ({
        id, name, blurb, persona, suggestedTask, skills,
      }));
      jsonResponse(res, { templates: items });
      return true;
    }

    // ── POST /hermes/library/:id/run — ephemeral template dispatch ───────
    const libraryRun = pathname.match(/^\/hermes\/library\/([^/]+)\/run$/);
    if (libraryRun && method === 'POST') {
      const templateId = libraryRun[1];
      const template = findTemplate(templateId);
      if (!template) { jsonResponse(res, { error: 'Template not found' }, 404); return true; }

      const body = (await parseBody(req)) || {};
      const task = String(body.task || template.suggestedTask || '').trim();
      const context = body.context || '';

      // Build a full, schema-valid HermesAgentConfig for this ephemeral run.
      const templateCfg = template.agentConfig;
      const ephemeralConfig = {
        agent_id: crypto.randomUUID(),
        name: template.name,
        tenant_id: tenantId,
        hermes_profile: `org-${tenantId}`,
        memory_mode: 'hivemind_mcp',
        capabilities: Array.isArray(templateCfg.capabilities) ? templateCfg.capabilities : [],
        schedule: templateCfg.schedule || { type: 'manual' },
        output_routes: Array.isArray(templateCfg.output_routes) && templateCfg.output_routes.length > 0
          ? templateCfg.output_routes
          : [{ type: 'hivemind_memory', tenant_id: tenantId }],
        safety_policy: templateCfg.safety_policy || { max_tokens_per_run: 100000, max_runtime_seconds: 600 },
        status: 'active',
        ...templateCfg,
        // Re-assert non-negotiables.
        agent_id: crypto.randomUUID(),
        tenant_id: tenantId,
        memory_mode: 'hivemind_mcp',
        // Ensure output_routes always has the tenant-scoped hivemind_memory route.
        output_routes: Array.isArray(templateCfg.output_routes) && templateCfg.output_routes.length > 0
          ? templateCfg.output_routes
          : [{ type: 'hivemind_memory', tenant_id: tenantId }],
      };

      const jobId = await auditJob(prisma, {
        orgId, tenantId, agentId: `lib:${templateId}`, action: 'library_run',
        status: 'running', payload: { templateId, task, context }, createdBy: userId,
      });
      const { runTask } = await import('./profile-manager.js');
      const out = await runTask(prisma, tenantId, ephemeralConfig, { task, context }, { createdBy: userId });
      const status = out && out.ok ? 'succeeded' : 'failed';
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_jobs SET status=$2, result=$3::jsonb, updated_at=now() WHERE id=$1`,
        jobId, status, JSON.stringify(out || null),
      ).catch(() => {});
      jsonResponse(res, { job_id: jobId, status, result: out }, status === 'succeeded' ? 200 : 502);
      return true;
    }

    // ── Singleton-agent helper: resolve or create without returning HTTP yet ──
    // Shared by all /hermes/agent/* sub-routes below.

    // ── PUT /hermes/agent/persona ────────────────────────────────────────────
    // Accepts { name?, role?, behavior? }. Composes a SOUL.md, writes it to the
    // tenant's profile (via profile-orchestrator → mgmt-server), restarts the
    // gateway to pick it up, and persists the fields into hermes_agents.config.
    if (pathname === '/hermes/agent/persona' && method === 'PUT') {
      // Resolve singleton agent.
      const agentRows = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC LIMIT 1`,
        orgId,
      );
      let agent = agentRows && agentRows[0];
      if (!agent) {
        const id = newId('hagent');
        const cfg = {};
        await prisma.$executeRawUnsafe(
          `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
           VALUES ($1,$2,$3,'Hermes Agent',$4::jsonb,'active',$5)`,
          id, orgId, tenantId, JSON.stringify(cfg), userId,
        );
        agent = { id, org_id: orgId, tenant_id: tenantId, name: 'Hermes Agent', config: cfg, status: 'active' };
      }

      const body = (await parseBody(req)) || {};
      const storedCfg = (agent.config && typeof agent.config === 'object') ? agent.config : {};
      const personaName = body.name != null ? String(body.name).trim() : (storedCfg.persona?.name || agent.name);
      const role = body.role != null ? String(body.role).trim() : (storedCfg.persona?.role || '');
      const behavior = body.behavior != null ? String(body.behavior).trim() : (storedCfg.persona?.behavior || '');

      // Compose SOUL.md from the plain fields.
      const soulLines = [`# ${personaName || 'Hermes Agent'}`];
      if (role) soulLines.push('', `## Role`, '', role);
      if (behavior) soulLines.push('', `## Behavior`, '', behavior);
      soulLines.push('', '---', '_Managed by HiveMind Hermes._', '');
      const soul = soulLines.join('\n');

      const writeOk = await writeProfileFile(tenantId, 'SOUL.md', soul);
      const restartResult = writeOk ? await restartGateway(tenantId) : { ok: false, issues: ['writeProfileFile failed'] };

      // Persist persona fields into config regardless of restart outcome (idempotent).
      const nextConfig = { ...storedCfg, persona: { name: personaName, role, behavior } };
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_agents SET config=$2::jsonb, updated_at=now() WHERE id=$1`,
        agent.id, JSON.stringify(nextConfig),
      );

      jsonResponse(res, {
        id: agent.id,
        persona: { name: personaName, role, behavior },
        soul_written: writeOk,
        gateway_restarted: restartResult.ok,
        issues: restartResult.issues || [],
      });
      return true;
    }

    // ── GET /hermes/agent/skills ─────────────────────────────────────────────
    // Returns skill toggles from hermes_agents.config.skills, falling back to
    // the default catalog of 6 skills (all enabled by default).
    if (pathname === '/hermes/agent/skills' && method === 'GET') {
      const agentRows = await prisma.$queryRawUnsafe(
        `SELECT id, config FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC LIMIT 1`,
        orgId,
      );
      const agent = agentRows && agentRows[0];
      const storedCfg = (agent && agent.config && typeof agent.config === 'object') ? agent.config : {};
      const skills = storedCfg.skills != null ? storedCfg.skills : DEFAULT_SKILLS.map((s) => ({ ...s }));
      jsonResponse(res, { skills });
      return true;
    }

    // ── PUT /hermes/agent/skills ─────────────────────────────────────────────
    // Accepts { skills: [{ id, enabled }] }. Merges with default catalog,
    // persists into config, and writes an updated config.yaml + restarts gateway.
    if (pathname === '/hermes/agent/skills' && method === 'PUT') {
      const agentRows = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC LIMIT 1`,
        orgId,
      );
      let agent = agentRows && agentRows[0];
      if (!agent) {
        const id = newId('hagent');
        await prisma.$executeRawUnsafe(
          `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
           VALUES ($1,$2,$3,'Hermes Agent','{}','active',$4)`,
          id, orgId, tenantId, userId,
        );
        agent = { id, org_id: orgId, tenant_id: tenantId, name: 'Hermes Agent', config: {}, status: 'active' };
      }

      const body = (await parseBody(req)) || {};
      if (!Array.isArray(body.skills)) {
        jsonResponse(res, { error: 'skills must be an array' }, 400); return true;
      }
      const storedCfg = (agent.config && typeof agent.config === 'object') ? agent.config : {};

      // Merge incoming toggles with the full default catalog.
      const toggleMap = new Map(body.skills.map((s) => [String(s.id), !!s.enabled]));
      const skills = DEFAULT_SKILLS.map((def) => ({
        ...def,
        enabled: toggleMap.has(def.id) ? toggleMap.get(def.id) : (storedCfg.skills?.find?.((x) => x.id === def.id)?.enabled ?? def.enabled),
      }));

      const nextConfig = { ...storedCfg, skills };
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_agents SET config=$2::jsonb, updated_at=now() WHERE id=$1`,
        agent.id, JSON.stringify(nextConfig),
      );

      // Write updated capabilities into config.yaml (skills → capabilities list) + restart.
      const enabledSkillIds = skills.filter((s) => s.enabled).map((s) => s.id);
      const configYamlPatch = buildSkillsConfigYaml(enabledSkillIds);
      const writeOk = await writeProfileFile(tenantId, 'skills.yaml', configYamlPatch);
      const restartResult = await restartGateway(tenantId);

      jsonResponse(res, {
        skills,
        skills_written: writeOk,
        gateway_restarted: restartResult.ok,
        issues: restartResult.issues || [],
      });
      return true;
    }

    // ── GET /hermes/agent/schedules ──────────────────────────────────────────
    // List cron jobs for the org's singleton agent profile (live via CLI).
    if (pathname === '/hermes/agent/schedules' && method === 'GET') {
      const result = await listCron(tenantId);
      if (!result.ok) {
        jsonResponse(res, { schedules: [], issues: result.issues });
        return true;
      }
      jsonResponse(res, { schedules: result.jobs });
      return true;
    }

    // ── POST /hermes/agent/schedules ─────────────────────────────────────────
    // Add a cron job. Body: { cron, prompt?, name?, deliver? }
    if (pathname === '/hermes/agent/schedules' && method === 'POST') {
      const body = (await parseBody(req)) || {};
      const cronExpr = String(body.cron || '').trim();
      if (!cronExpr) { jsonResponse(res, { error: 'cron (expression or interval) required' }, 400); return true; }
      const result = await addCron(tenantId, {
        cron: cronExpr,
        prompt: String(body.prompt || '').trim(),
        name: String(body.name || '').trim(),
        deliver: String(body.deliver || 'origin').trim(),
      });
      if (!result.ok) {
        jsonResponse(res, { error: 'Failed to create schedule', issues: result.issues }, 502);
        return true;
      }
      jsonResponse(res, { jobId: result.jobId, issues: [] }, 201);
      return true;
    }

    // ── DELETE /hermes/agent/schedules/:jobId ────────────────────────────────
    const deleteSchedule = pathname.match(/^\/hermes\/agent\/schedules\/([^/]+)$/);
    if (deleteSchedule && method === 'DELETE') {
      const jobId = deleteSchedule[1];
      const result = await deleteCron(tenantId, jobId);
      if (!result.ok) {
        jsonResponse(res, { error: 'Failed to remove schedule', issues: result.issues }, 502);
        return true;
      }
      jsonResponse(res, { ok: true });
      return true;
    }

    // ── GET /hermes/agent/channels ──────────────────────────────────────────
    // Returns the connection status for each messaging channel (slack, telegram,
    // discord) read from hermes_agents.config.channels (booleans). Does NOT
    // reveal any tokens — purely a status endpoint.
    if (pathname === '/hermes/agent/channels' && method === 'GET') {
      const agentRows = await prisma.$queryRawUnsafe(
        `SELECT id, config FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC LIMIT 1`,
        orgId,
      );
      const agent = agentRows && agentRows[0];
      const storedCfg = (agent && agent.config && typeof agent.config === 'object') ? agent.config : {};
      const channels = channelsFromConfig(storedCfg);
      jsonResponse(res, {
        channels: [
          { type: 'telegram', label: 'Telegram', connected: channels.telegram, supported: true },
          { type: 'slack',    label: 'Slack',    connected: channels.slack,    supported: true },
          { type: 'discord',  label: 'Discord',  connected: channels.discord,  supported: false },
        ],
      });
      return true;
    }

    // ── POST /hermes/agent/channels/:type/connect ──────────────────────────
    // Connect a messaging channel by writing its bot token(s) into the profile
    // .env (via mergeProfileEnv → mgmt-server /mgmt/profile/env-merge) and
    // restarting the gateway so the Hermes gateway picks them up.
    //
    // Body for telegram: { token: "..." }
    // Body for slack:    { bot_token: "xoxb-...", app_token: "xapp-..." }
    //
    // SECURITY: tokens are NEVER logged or returned in the response.
    const channelConnect = pathname.match(/^\/hermes\/agent\/channels\/([^/]+)\/connect$/);
    if (channelConnect && method === 'POST') {
      const channelType = channelConnect[1];
      const spec = CHANNEL_SPECS[channelType];
      if (!spec) {
        jsonResponse(res, { error: `Unknown channel type: ${channelType}` }, 400);
        return true;
      }
      if (!spec.supported) {
        jsonResponse(res, {
          error: `Channel type '${channelType}' is not supported in this release`,
          supported_channels: ['telegram', 'slack'],
        }, 400);
        return true;
      }

      const body = (await parseBody(req)) || {};

      // Build the env map from body fields → env var names.
      /** @type {Record<string,string>} */
      const envMap = {};
      for (let i = 0; i < spec.tokenFields.length; i++) {
        const fieldName = spec.tokenFields[i];
        const envKey = spec.envVars[i];
        const val = body[fieldName];
        if (!val || typeof val !== 'string' || !val.trim()) {
          jsonResponse(res, { error: `${fieldName} is required for ${channelType}` }, 400);
          return true;
        }
        envMap[envKey] = val.trim();
      }

      // Resolve (or auto-create) the singleton agent so we can persist config.
      const agentRows = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC LIMIT 1`,
        orgId,
      );
      let agent = agentRows && agentRows[0];
      if (!agent) {
        const id = newId('hagent');
        await prisma.$executeRawUnsafe(
          `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
           VALUES ($1,$2,$3,'Hermes Agent','{}','active',$4)`,
          id, orgId, tenantId, userId,
        );
        agent = { id, org_id: orgId, tenant_id: tenantId, name: 'Hermes Agent', config: {}, status: 'active' };
      }

      // Merge tokens into the profile .env (no-log, no-return of the values).
      const mergeResult = await mergeProfileEnv(tenantId, envMap);
      if (!mergeResult.ok) {
        jsonResponse(res, { error: 'Failed to write channel credentials', issues: mergeResult.issues }, 502);
        return true;
      }

      // Restart gateway to pick up the new env vars.
      const restartResult = await restartGateway(tenantId);

      // Persist channels[type]=true into config.channels (independent of restart outcome).
      const storedCfg = (agent.config && typeof agent.config === 'object') ? agent.config : {};
      const nextChannels = { ...channelsFromConfig(storedCfg), [channelType]: true };
      const nextConfig = { ...storedCfg, channels: nextChannels };
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_agents SET config=$2::jsonb, updated_at=now() WHERE id=$1`,
        agent.id, JSON.stringify(nextConfig),
      );

      jsonResponse(res, {
        channel: channelType,
        connected: true,
        gateway_restarted: restartResult.ok,
        issues: restartResult.issues || [],
      });
      return true;
    }

    // ── GET /hermes/agent/memory ────────────────────────────────────────────
    // Returns the 20 most-recent memory records scoped to this org (read-only).
    // Content is truncated to 300 chars to avoid bloating the API response.
    // No writes — purely observational for the Hermes UI "memory" tab.
    if (pathname === '/hermes/agent/memory' && method === 'GET') {
      const SNIPPET_LEN = 300;
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, title, content, tags, created_at
           FROM hivemind.memories
          WHERE org_id = $1::uuid
            AND deleted_at IS NULL
            AND is_latest = true
          ORDER BY created_at DESC
          LIMIT 20`,
        orgId,
      ).catch(() => []);
      const memories = (rows || []).map((r) => ({
        id: r.id,
        title: r.title || null,
        content_snippet: typeof r.content === 'string' && r.content.length > SNIPPET_LEN
          ? r.content.slice(0, SNIPPET_LEN) + '…'
          : (r.content || ''),
        tags: Array.isArray(r.tags) ? r.tags : [],
        created_at: r.created_at,
      }));
      jsonResponse(res, { memories });
      return true;
    }

    // ── GET /hermes/agent/model — current provider + model ──────────────────
    if (pathname === '/hermes/agent/model' && method === 'GET') {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT config FROM hivemind.hermes_agents WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
        orgId,
      ).catch(() => []);
      const saved = rows && rows[0] && rows[0].config && rows[0].config.model;
      jsonResponse(res, { model: (saved && saved.provider && saved.model) ? saved : DEFAULT_MODEL });
      return true;
    }

    // ── GET /hermes/providers/:provider/models — selectable model list ──────
    const provModels = pathname.match(/^\/hermes\/providers\/([^/]+)\/models$/);
    if (provModels && method === 'GET') {
      const provider = provModels[1];
      if (!ALLOWED_PROVIDERS.includes(provider)) { jsonResponse(res, { error: 'unsupported provider' }, 400); return true; }
      const models = await fetchProviderModels(provider);
      jsonResponse(res, { provider, models });
      return true;
    }

    // ── PUT /hermes/agent/model { provider, model } ──────────────────────────
    // Switches the tenant agent's model. Keys are server-side env vars — the
    // caller NEVER sends an API key. Rewrites config.yaml and does a full gateway
    // STOP then START (restart alone does not reload the provider on some Hermes
    // versions). provider 'groq' is normalised to 'custom:groq' in buildConfigYaml.
    if (pathname === '/hermes/agent/model' && method === 'PUT') {
      const body = (await parseBody(req)) || {};
      const rawProvider = String(body.provider || '').trim();
      const model = String(body.model || '').trim();
      if (!ALLOWED_PROVIDERS.includes(rawProvider)) {
        jsonResponse(res, { error: 'provider must be groq or openrouter' }, 400); return true;
      }
      if (!model) { jsonResponse(res, { error: 'model required' }, 400); return true; }

      // Map 'groq' → 'custom:groq' for buildConfigYaml; store the canonical name.
      const provider = rawProvider === 'groq' ? 'custom:groq' : rawProvider;

      const { ensureProfile } = await import('./profile-manager.js');
      const ens = await ensureProfile(prisma, tenantId, { orgId, mcpUserId: userId });
      if (!ens.ok) { jsonResponse(res, { error: 'profile unavailable: ' + (ens.issues || []).join(';') }, 502); return true; }

      const mcpUrl = process.env.HIVEMIND_API_URL ? `${process.env.HIVEMIND_API_URL}/api/mcp` : 'https://core.hivemind.davinciai.eu:8050/api/mcp';
      const browserMcpUrl = process.env.HERMES_BROWSER_MCP_URL || 'http://hivemind-control-plane:3000/hermes/mcp/browser';
      const webMcpUrl = process.env.HERMES_PLAYWRIGHT_MCP_URL || 'http://hm-playwright:8931/mcp';

      const wrote = await writeProfileFile(tenantId, 'config.yaml', buildConfigYaml({ provider, model, mcpUrl, browserMcpUrl, webMcpUrl }));
      if (!wrote) { jsonResponse(res, { error: 'failed to write model config' }, 502); return true; }

      // Full stop → start (NOT restartGateway) so Hermes reinitialises the
      // provider from scratch; restart keeps the old provider in-process.
      await stopGateway(tenantId);
      await startGateway(tenantId);

      // Persist {provider, model} (NOT any key) to the agent config.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, config FROM hivemind.hermes_agents WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, orgId,
      ).catch(() => []);
      if (rows && rows[0]) {
        const cfg = { ...(rows[0].config || {}), model: { provider, model } };
        await prisma.$executeRawUnsafe(
          `UPDATE hivemind.hermes_agents SET config=$2::jsonb, updated_at=now() WHERE id=$1`,
          rows[0].id, JSON.stringify(cfg),
        ).catch(() => {});
      }
      jsonResponse(res, { model: { provider, model } });
      return true;
    }

    // ── GET /hermes/agent/browser — pairing + connector status ──────────────
    if (pathname === '/hermes/agent/browser' && method === 'GET') {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT created_at, last_seen_at FROM hivemind.hermes_browser_pairings WHERE tenant_id=$1 AND revoked_at IS NULL LIMIT 1`,
        tenantId,
      ).catch(() => []);
      const paired = !!(rows && rows[0]);
      const { isOnline } = await import('./webbridge-relay.js');
      jsonResponse(res, { paired, online: paired ? isOnline(tenantId) : false, paired_at: paired ? rows[0].created_at : null });
      return true;
    }

    // ── POST /hermes/agent/browser/pair — mint a connector pairing token ────
    if (pathname === '/hermes/agent/browser/pair' && method === 'POST') {
      const token = `wbk_${crypto.randomBytes(24).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.hermes_browser_pairings (tenant_id, org_id, token_hash, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id) DO UPDATE SET token_hash=$3, created_by=$4, created_at=now(), revoked_at=NULL, last_seen_at=NULL`,
        tenantId, orgId, tokenHash, userId,
      );
      // Activate the browser MCP on this tenant's profile: ensure it exists, put
      // the pairing token in the profile .env (the browser MCP header resolves
      // Bearer ${WB_MCP_TOKEN}), and restart so the gateway loads the tools.
      try {
        const { ensureProfile } = await import('./profile-manager.js');
        await ensureProfile(prisma, tenantId, { orgId, mcpUserId: userId });
        await mergeProfileEnv(tenantId, { WB_MCP_TOKEN: token });
        await restartGateway(tenantId);
      } catch { /* best-effort; tools activate on next profile (re)start */ }
      const base = process.env.HIVEMIND_CONTROL_PLANE_PUBLIC_URL || 'https://api.hivemind.davinciai.eu:8040';
      // One-liner the user runs AFTER installing Kimi WebBridge (cdn.kimi.com).
      const connectCommand = `curl -fsSL ${base}/hermes/wb/connector.mjs -o /tmp/hm-webbridge.mjs && RELAY=${base} WB_TOKEN=${token} node /tmp/hm-webbridge.mjs`;
      jsonResponse(res, { token, connect_command: connectCommand, relay: base }, 201);
      return true;
    }

    // ── DELETE /hermes/agent/browser — unpair (revoke) ──────────────────────
    if (pathname === '/hermes/agent/browser' && method === 'DELETE') {
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_browser_pairings SET revoked_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL`, tenantId,
      ).catch(() => {});
      jsonResponse(res, { ok: true });
      return true;
    }

    // ── POST /hermes/agent/browser/dispatch — run one browser action (test/MCP) ──
    if (pathname === '/hermes/agent/browser/dispatch' && method === 'POST') {
      const body = (await parseBody(req)) || {};
      const action = String(body.action || '').trim();
      if (!action) { jsonResponse(res, { error: 'action required' }, 400); return true; }
      const { dispatch } = await import('./webbridge-relay.js');
      const result = await dispatch(tenantId, action, body.args || {});
      jsonResponse(res, { result });
      return true;
    }

    // Unknown /hermes/* path.
    jsonResponse(res, { error: 'Not found' }, 404);
    return true;
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
    return true;
  }
}
