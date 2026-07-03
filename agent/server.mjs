// hm-agent — HIVEMIND data-plane agent. Runs on the org's box (self-host) or in our cloud (managed).
// PHASE 1 build: pure Postgres + Qdrant (no .amr). The agent owns its OWN minimal schema (plain
// columns, NO Prisma enums) so it never drifts from the engine's schema — the engine PUSHES a finished
// memory envelope over this authenticated HTTP API and the agent maps it into its own tables. The
// engine NEVER connects to this Postgres directly. (Phase 12 swaps PG+Qdrant internals for .amr behind
// this same contract — the engine never changes.)
//
// Env:
//   ORG_ID        org this agent serves (must match the API key's org)   [required]
//   AGENT_TOKEN   bearer the engine presents                              [required]
//   DATABASE_URL  local Postgres (rows + lexical + hydrate)              [required]
//   QDRANT_URL    local Qdrant (vectors)                                 [required]
//   AGENT_PORT    listen port (default 8787)
//   MNEME_DIM     embedding dim (default 1024)
//   AGENT_STORE   memory storage engine: 'pg-qdrant' (default) | 'amr' — the operator's choice,
//                 asked by setup.sh and recorded in .env. See STORE below.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const ORG = process.env.ORG_ID || die('ORG_ID required');
// Storage engine for memories + relationships — the OPERATOR'S CHOICE, made at setup time:
//   pg-qdrant (default) — proven Phase-1 path: rows in Postgres, vectors in Qdrant.
//   amr                 — the .amr engine: one mmap'd shard per org (memories + vectors + graph
//                         in one file). Postgres+Qdrant still serve the KB layer (docs/segments).
// Switching pg-qdrant → amr later is safe: on first amr boot the shard auto-migrates all existing
// rows + their real Qdrant vectors (mneme/amr.mjs migrateFromPostgres, idempotent).
const STORE = (process.env.AGENT_STORE || 'pg-qdrant').toLowerCase() === 'amr' ? 'amr' : 'pg-qdrant';
const TOKEN = process.env.AGENT_TOKEN || die('AGENT_TOKEN required');
// Optional: pin the engine origin. The engine calls server-to-server (no Origin header), so ANY
// request bearing an Origin/Referer is a browser and is rejected outright (blocks CSRF/SSRF from a
// page the operator visits). If ALLOWED_ENGINE_ORIGIN is set, a present Origin must match it exactly.
const ALLOWED_ENGINE_ORIGIN = (process.env.ALLOWED_ENGINE_ORIGIN || '').replace(/\/+$/, '');
const TOKEN_BUF = Buffer.from(`Bearer ${TOKEN}`);
function tokenOk(header) {
  if (typeof header !== 'string') return false;
  const h = Buffer.from(header);
  return h.length === TOKEN_BUF.length && timingSafeEqual(h, TOKEN_BUF);
}
const PORT = Number(process.env.AGENT_PORT || 8787);
const DIM = Number(process.env.MNEME_DIM || 1024);
const SCHEMA_VERSION = 1; // bump when the agent's local schema changes
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const QCOLL = `org_${ORG}`.replace(/[^a-zA-Z0-9]/g, '_');

function die(m) { console.error(`[hm-agent] ${m}`); process.exit(1); }

// ── Postgres (rows + lexical) ───────────────────────────────────────────────────────────────────
const { default: Pg } = await import('pg');
// Pin the session to the agent's OWN schema `hm` so it never collides with leftover tables (e.g. a
// prior Prisma `hivemind.memories`) — fully self-contained on fresh and dirty boxes alike.
const pg = new Pg.Pool({ connectionString: process.env.DATABASE_URL || die('DATABASE_URL required'), max: 8, options: '-c search_path=hm,public' });

// The agent's OWN schema — minimal, plain types, no enums, no FKs to global tables. content_tsv is a
// generated column so lexical search is always in sync. Idempotent; created on boot in schema `hm`.
async function ensureSchema() {
  await pg.query(`
    CREATE SCHEMA IF NOT EXISTS hm;
    CREATE TABLE IF NOT EXISTS hm.memories (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      user_id uuid,
      content text,
      title text,
      tags text[] NOT NULL DEFAULT '{}',
      memory_type text,
      is_latest boolean NOT NULL DEFAULT true,
      layer text NOT NULL DEFAULT 'memory',
      cognitive_layer_role text,
      confidence real,
      created_at timestamptz NOT NULL DEFAULT now(),
      valid_from timestamptz,
      document_date timestamptz,
      project text,
      project_ids text[] NOT NULL DEFAULT '{}',
      scope text,
      primary_team_id uuid,
      -- Recall reinforcement (feeds recall SCORING: log-boost on recall_count +
      -- multiplicative strength). Bumped by /v1/bump-recall on every recall hit,
      -- mirroring central's prisma updateMany. Without these the reinforcement
      -- boost is permanently neutral on self-host.
      recall_count int NOT NULL DEFAULT 0,
      strength real NOT NULL DEFAULT 1.0,
      last_accessed_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}',
      deleted_at timestamptz,
      vector_synced boolean NOT NULL DEFAULT false,
      content_tsv tsvector GENERATED ALWAYS AS
        (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
    );
    -- Self-host parity (added after the table shipped): idempotent backfill for
    -- existing boxes so scope/team + recall-reinforcement round-trip like central.
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS primary_team_id uuid;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count int NOT NULL DEFAULT 0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS strength real NOT NULL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
    CREATE INDEX IF NOT EXISTS memories_org_idx     ON memories(org_id);
    CREATE INDEX IF NOT EXISTS memories_tags_idx    ON memories USING gin(tags);
    CREATE INDEX IF NOT EXISTS memories_tsv_idx     ON memories USING gin(content_tsv);
    CREATE INDEX IF NOT EXISTS memories_latest_idx  ON memories(org_id, is_latest) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS relationships (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      from_id uuid NOT NULL,
      to_id uuid NOT NULL,
      type text,
      confidence real NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS rel_from_idx ON relationships(from_id);
    CREATE INDEX IF NOT EXISTS rel_to_idx   ON relationships(to_id);
    -- KB layer (self-host): documents + evidence segments live here, never central. Segment vectors
    -- go in the same Qdrant collection tagged layer='segment' (recall filters on it).
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      user_id uuid,
      filename text,
      content_type text,
      status text DEFAULT 'ready',
      checksum text,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS kbdoc_org_idx ON knowledge_documents(org_id) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS knowledge_segments (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      user_id uuid,
      document_id uuid NOT NULL,
      content text,
      content_hash text,
      segment_type text,
      segment_index int NOT NULL DEFAULT 0,
      previous_segment_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}',
      vector_synced boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content,''))) STORED
    );
    CREATE INDEX IF NOT EXISTS kbseg_org_idx  ON knowledge_segments(org_id);
    CREATE INDEX IF NOT EXISTS kbseg_doc_idx  ON knowledge_segments(document_id);
    CREATE INDEX IF NOT EXISTS kbseg_tsv_idx  ON knowledge_segments USING gin(content_tsv);
    -- Meetings layer (self-host): full meeting rows live here, never central.
    CREATE TABLE IF NOT EXISTS meetings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      user_id uuid,
      project_id uuid,
      title text,
      summary text,
      transcript text,
      language text,
      duration_sec int,
      multi_speaker boolean NOT NULL DEFAULT false,
      speaker_count int,
      action_items jsonb NOT NULL DEFAULT '[]',
      decisions jsonb NOT NULL DEFAULT '[]',
      key_points jsonb NOT NULL DEFAULT '[]',
      questions jsonb NOT NULL DEFAULT '[]',
      segments jsonb,
      topics text[] NOT NULL DEFAULT '{}',
      sentiment text,
      source_memory_id uuid,
      notes text,
      insights jsonb NOT NULL DEFAULT '{}',
      participants jsonb NOT NULL DEFAULT '[]',
      scope text,
      intelligence jsonb,
      intelligence_status text,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS meetings_org_idx ON meetings(org_id) WHERE deleted_at IS NULL;
    -- TARA call ledger (self-host): call rows + turns live here, never central.
    CREATE TABLE IF NOT EXISTS tara_calls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      user_id uuid,
      session_id text UNIQUE NOT NULL,
      status text NOT NULL DEFAULT 'active',
      turn_count int NOT NULL DEFAULT 0,
      prompt_tokens bigint NOT NULL DEFAULT 0,
      completion_tokens bigint NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tara_calls_org_idx ON tara_calls(org_id);
    CREATE TABLE IF NOT EXISTS tara_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      call_id uuid NOT NULL,
      role text,
      content text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tara_turns_org_idx  ON tara_turns(org_id);
    CREATE INDEX IF NOT EXISTS tara_turns_call_idx ON tara_turns(call_id);
  `);
  console.log('[hm-agent] postgres schema ready');
}

// ── Qdrant (vectors) ────────────────────────────────────────────────────────────────────────────
const qFetch = (path, opts = {}, ms = 4000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  return fetch(`${QDRANT_URL}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, signal: ac.signal }).finally(() => clearTimeout(t));
};
async function ensureQdrant() {
  if (!QDRANT_URL) die('QDRANT_URL required');
  const r = await qFetch(`/collections/${QCOLL}`, { method: 'PUT', body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }) }).catch((e) => die(`qdrant unreachable: ${e.message}`));
  if (!r.ok && r.status !== 409) console.warn(`[hm-agent] qdrant ensure → ${r.status}`); // 409/200 both fine (already exists)
  console.log(`[hm-agent] qdrant collection ready: ${QCOLL} (dim ${DIM})`);
}
async function qdrantHealthy() {
  try { const r = await qFetch(`/collections/${QCOLL}`, {}, 1500); return r.ok; } catch { return false; }
}

// Build a Qdrant payload filter from the engine's filter spec. org_id is always forced.
function qdrantFilter(f = {}) {
  const must = [{ key: 'org_id', match: { value: ORG } }];
  if (f.is_latest !== undefined) must.push({ key: 'is_latest', match: { value: !!f.is_latest } });
  if (f.layer) must.push({ key: 'layer', match: { value: f.layer } });
  if (f.user_id) must.push({ key: 'user_id', match: { value: f.user_id } });
  if (f.project) must.push({ key: 'project', match: { value: f.project } });
  const must_not = [];
  if (f.must_not?.layer) must_not.push({ key: 'layer', match: { value: f.must_not.layer } });
  const filter = { must };
  if (must_not.length) filter.must_not = must_not;
  return filter;
}

// The Qdrant payload carries the recall-display fields so a hit needs no PG join (content rides in payload).
function payloadOf(rec) {
  return {
    memory_id: rec.id, org_id: ORG, user_id: rec.userId || null,
    content: rec.content || '', title: rec.title || null, tags: rec.tags || [],
    memory_type: rec.memoryType || null, layer: rec.layer || 'memory',
    cognitive_layer_role: rec.cognitiveLayerRole || null,
    is_latest: rec.isLatest ?? true, created_at: rec.createdAt || null,
  };
}

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sendHtml = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

// ── Dashboard — read-only status page for the box operator ─────────────────────────────────────
// GET-only, no bearer token (matches /health): the agent listens only on the private tailnet/LAN
// per TRANSPORT.md, and this exposes counts only, never memory content. Separate from the POST-only
// engine API below (which stays bearer-token + origin-locked).
const BOOT_AT = Date.now();
async function dashboardStats() {
  const pgOk = await pg.query('SELECT 1').then(() => true).catch(() => false);
  const qOk = await qdrantHealthy();
  let counts = { total: 0, by_layer: [], by_type: [], users: 0, oldest: null, newest: null };
  try {
    if (effectiveStore === 'amr' && amr) {
      // Counts straight from the .amr in-process index (the memory source of truth in this mode).
      const { memories } = amr.list({}, undefined, 100000, 0);
      const byLayer = new Map(); const byType = new Map(); const users = new Set();
      let oldest = null, newest = null;
      for (const m of memories) {
        const lk = m.layer || 'memory'; byLayer.set(lk, (byLayer.get(lk) || 0) + 1);
        const tk = m.memory_type || 'unspecified'; byType.set(tk, (byType.get(tk) || 0) + 1);
        if (m.user_id) users.add(m.user_id);
        if (!oldest || new Date(m.created_at) < new Date(oldest)) oldest = m.created_at;
        if (!newest || new Date(m.created_at) > new Date(newest)) newest = m.created_at;
      }
      counts = {
        total: memories.length,
        by_layer: [...byLayer].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n),
        by_type: [...byType].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 8),
        users: users.size, oldest, newest,
      };
    } else {
      const [tot, layer, type, users, span] = await Promise.all([
        pg.query(`SELECT count(*)::int AS n FROM hm.memories WHERE org_id=$1 AND deleted_at IS NULL`, [ORG]),
        pg.query(`SELECT coalesce(layer,'memory') AS k, count(*)::int AS n FROM hm.memories WHERE org_id=$1 AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`, [ORG]),
        pg.query(`SELECT coalesce(memory_type,'unspecified') AS k, count(*)::int AS n FROM hm.memories WHERE org_id=$1 AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [ORG]),
        pg.query(`SELECT count(DISTINCT user_id)::int AS n FROM hm.memories WHERE org_id=$1 AND deleted_at IS NULL`, [ORG]),
        pg.query(`SELECT min(created_at) AS oldest, max(created_at) AS newest FROM hm.memories WHERE org_id=$1 AND deleted_at IS NULL`, [ORG]),
      ]);
      counts = {
        total: tot.rows[0]?.n || 0,
        by_layer: layer.rows,
        by_type: type.rows,
        users: users.rows[0]?.n || 0,
        oldest: span.rows[0]?.oldest || null,
        newest: span.rows[0]?.newest || null,
      };
    }
  } catch (e) { console.warn('[hm-agent] dashboard stats query failed:', e.message); }
  return {
    ok: true, org: ORG, dim: DIM, schemaVersion: SCHEMA_VERSION,
    uptime_seconds: Math.floor((Date.now() - BOOT_AT) / 1000),
    connections: { postgres: pgOk, qdrant: qOk, ...(effectiveStore === 'amr' ? { amr: !!amr } : {}) },
    storage_backend: effectiveStore, // the operator's setup-time choice (AGENT_STORE)
    memories: counts,
  };
}

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HIVEMIND — Self-host Agent</title>
<style>
  :root{--paper:#faf9f4;--panel:#fff;--wash:#f3f1ec;--line:#e3e0db;--line-hover:#d4d0ca;--ink:#0a0a0a;--dim:#525252;--dim2:#a3a3a3;--accent:#117dff;--accent2:#0066e0;--good:#16a34a;--bad:#e0443e}
  *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Inter',sans-serif;-webkit-font-smoothing:antialiased}
  header{padding:26px 32px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;background:var(--panel)}
  header h1{font-size:16px;font-weight:700;margin:0;font-family:'Space Grotesk',sans-serif;letter-spacing:.01em}
  header h1 span{color:var(--accent)}
  .badge{font:11px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--wash);color:var(--dim)}
  .badge.live{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.3);color:var(--good)}
  .badge.bad{background:rgba(224,68,62,.08);border-color:rgba(224,68,62,.3);color:var(--bad)}
  main{max-width:1080px;margin:0 auto;padding:32px 32px 60px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:border-color .15s}
  .card:hover{border-color:var(--line-hover)}
  .card .label{font:10px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--dim2);margin-bottom:10px}
  .card .value{font:26px/1 'Space Grotesk',sans-serif;font-weight:700;color:var(--ink)}
  .card .sub{margin-top:6px;font-size:12px;color:var(--dim2)}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .dot.good{background:var(--good);box-shadow:0 0 6px rgba(22,163,74,.5)}
  .dot.bad{background:var(--bad)}
  .section-title{font:11px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--dim2);margin:28px 0 10px;display:flex;align-items:center;justify-content:space-between}
  .section-title small{font:10px/1 ui-monospace,monospace;color:var(--dim2);text-transform:none;letter-spacing:0}
  .row{padding:12px 0;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:none}
  .row .rhead{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px}
  .row .rname{font-size:13px;color:var(--ink);font-weight:500}
  .row .rmeta{font:12px/1 ui-monospace,monospace;color:var(--accent);display:flex;align-items:baseline;gap:6px}
  .row .rmeta b{font-size:13px;color:var(--ink);font-weight:700}
  .bar{height:7px;border-radius:4px;background:var(--wash);overflow:hidden;border:1px solid var(--line)}
  .bar i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .5s cubic-bezier(.4,0,.2,1);box-shadow:0 0 10px rgba(17,125,255,.25)}
  table{width:100%;border-collapse:collapse}
  td{padding:9px 0;border-bottom:1px solid var(--line);font-size:13px}
  td:last-child{text-align:right;font-family:ui-monospace,monospace;color:var(--accent);font-weight:600}
  tr:last-child td{border-bottom:none}
  .empty{color:var(--dim2);font-size:13px;padding:16px 0}
  .pill{display:inline-flex;align-items:center;gap:6px;font:11px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;padding:4px 10px;border-radius:999px;border:1px solid rgba(17,125,255,.2);background:rgba(17,125,255,.06);color:var(--accent2)}
  footer{color:var(--dim2);font-size:11px;text-align:center;padding:24px;font-family:ui-monospace,monospace}
  a{color:var(--accent);text-decoration:none}
</style></head>
<body>
  <header>
    <h1>HIVE<span>MIND</span> — self-host agent</h1>
    <span class="badge" id="live-badge">loading…</span>
  </header>
  <main>
    <div class="grid">
      <div class="card"><div class="label">Org</div><div class="value" id="org" style="font-size:13px;font-family:ui-monospace,monospace;word-break:break-all">—</div></div>
      <div class="card"><div class="label">Memories</div><div class="value" id="total">—</div><div class="sub" id="users-sub"></div></div>
      <div class="card"><div class="label">Postgres</div><div class="value" id="pg-status" style="font-size:16px">—</div></div>
      <div class="card"><div class="label">Qdrant</div><div class="value" id="q-status" style="font-size:16px">—</div></div>
      <div class="card"><div class="label">Agent uptime</div><div class="value" id="uptime" style="font-size:16px">—</div></div>
    </div>

    <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>
        <div class="label" style="margin-bottom:6px">Storage engine</div>
        <div style="font:15px 'Space Grotesk',sans-serif;font-weight:700" id="backend-name">—</div>
      </div>
      <span class="pill" id="backend-pill">checking…</span>
    </div>

    <div class="section-title">Memory by layer <small id="layer-total"></small></div>
    <div class="card" id="layer-rows"></div>

    <div class="section-title">Memory by type <small id="type-total"></small></div>
    <div class="card" id="type-rows"></div>

    <div class="section-title">Timeline</div>
    <div class="card">
      <table><tbody>
        <tr><td>Oldest memory</td><td id="oldest">—</td></tr>
        <tr><td>Newest memory</td><td id="newest">—</td></tr>
        <tr><td>Embedding dimension</td><td id="dim">—</td></tr>
        <tr><td>Schema version</td><td id="schema">—</td></tr>
      </tbody></table>
    </div>
  </main>
  <footer>Your data lives here — content + vectors never leave this box. Refreshes every 10s.</footer>
<script>
function fmtTime(s){ if(s==null) return '—'; const d=new Date(s); return d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function fmtUptime(s){ if(s<60) return s+'s'; const h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h>0 ? h+'h '+m+'m' : m+'m'; }
function barRows(items, total){
  if (!items.length) return '<div class="empty">No memories yet — the engine will push them here as it ingests.</div>';
  const max = Math.max(...items.map(r=>r.n), 1);
  return items.map(r => {
    const pct = total ? Math.round((r.n/total)*100) : 0;
    const w = Math.max(4, Math.round((r.n/max)*100));
    return '<div class="row"><div class="rhead"><span class="rname">'+r.k+'</span><span class="rmeta"><b>'+r.n+'</b> · '+pct+'%</span></div><div class="bar"><i style="width:'+w+'%"></i></div></div>';
  }).join('');
}
async function refresh(){
  const badge = document.getElementById('live-badge');
  try{
    const r = await fetch('/v1/dashboard/stats'); const d = await r.json();
    badge.textContent = d.ok ? 'live' : 'error';
    badge.className = 'badge ' + (d.ok ? 'live' : 'bad');
    document.getElementById('org').textContent = d.org;
    document.getElementById('total').textContent = d.memories.total.toLocaleString();
    document.getElementById('users-sub').textContent = d.memories.users + ' user' + (d.memories.users===1?'':'s');
    document.getElementById('pg-status').innerHTML = '<span class="dot '+(d.connections.postgres?'good':'bad')+'"></span>'+(d.connections.postgres?'Connected':'Down');
    document.getElementById('q-status').innerHTML = '<span class="dot '+(d.connections.qdrant?'good':'bad')+'"></span>'+(d.connections.qdrant?'Connected':'Down');
    document.getElementById('uptime').textContent = fmtUptime(d.uptime_seconds);
    document.getElementById('dim').textContent = d.dim;
    document.getElementById('schema').textContent = 'v'+d.schemaVersion;
    document.getElementById('oldest').textContent = fmtTime(d.memories.oldest);
    document.getElementById('newest').textContent = fmtTime(d.memories.newest);
    const isAmr = d.storage_backend === 'amr';
    document.getElementById('backend-name').textContent = isAmr ? '.amr — one mmap\\'d file, no server' : 'Postgres + Qdrant';
    const bp = document.getElementById('backend-pill');
    bp.textContent = isAmr ? '.amr active' : 'phase 1 · pg-qdrant';
    bp.style.color = isAmr ? '#16a34a' : '#0066e0';
    bp.style.background = isAmr ? 'rgba(22,163,74,.08)' : 'rgba(17,125,255,.06)';
    bp.style.borderColor = isAmr ? 'rgba(22,163,74,.3)' : 'rgba(17,125,255,.2)';
    document.getElementById('layer-total').textContent = d.memories.total ? d.memories.total + ' total' : '';
    document.getElementById('type-total').textContent = d.memories.total ? d.memories.total + ' total' : '';
    document.getElementById('layer-rows').innerHTML = barRows(d.memories.by_layer, d.memories.total);
    document.getElementById('type-rows').innerHTML = barRows(d.memories.by_type, d.memories.total);
  }catch(e){
    badge.textContent = 'unreachable'; badge.className = 'badge bad';
  }
}
refresh(); setInterval(refresh, 10000);
</script>
</body></html>`;

const routes = {
  // Upsert one finished memory: row (idempotent by id) + vector. Atomic-ish: insert row synced=false,
  // upsert vector (wait), then mark synced. If the vector fails the route returns non-ok so the caller retries.
  '/v1/write': async (b) => {
    const r = b.record || {};
    if (!r.id) return { ok: false, error: 'record.id required' };
    await pg.query(
      `INSERT INTO memories (id, org_id, user_id, content, title, tags, memory_type, is_latest, layer,
         cognitive_layer_role, confidence, created_at, valid_from, document_date, project, project_ids,
         metadata, scope, primary_team_id, recall_count, strength, vector_synced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::timestamptz,now()),$13,$14,$15,$16,$17::jsonb,$18,$19::uuid,coalesce($20::int,0),coalesce($21::real,1.0),false)
       ON CONFLICT (id) DO UPDATE SET
         content=EXCLUDED.content,
         -- title/tags/confidence: the 2-phase write (engine row, THEN vector
         -- re-upsert) carries null title / bare tags / null confidence on the
         -- 2nd write. Plain EXCLUDED CLOBBERED the title, the ts: date tag, and
         -- the importance score. COALESCE title+confidence (keep the scored
         -- value) and UNION tags (so ts:/entity:/filename: from BOTH writes
         -- survive) instead of overwriting.
         title=COALESCE(NULLIF(EXCLUDED.title,''), memories.title),
         tags=(SELECT ARRAY(SELECT DISTINCT x FROM unnest(memories.tags || EXCLUDED.tags) AS x)),
         confidence=COALESCE(EXCLUDED.confidence, memories.confidence),
         memory_type=COALESCE(EXCLUDED.memory_type, memories.memory_type),
         is_latest=EXCLUDED.is_latest, layer=EXCLUDED.layer, cognitive_layer_role=EXCLUDED.cognitive_layer_role,
         scope=COALESCE(EXCLUDED.scope, memories.scope),
         primary_team_id=COALESCE(EXCLUDED.primary_team_id, memories.primary_team_id),
         -- Provenance preservation: memory rows are written in two phases — the
         -- engine creates the row (with valid_from / document_date / metadata),
         -- then the vector store re-upserts the SAME id to attach the embedding
         -- (carrying null/empty for those fields). Plain EXCLUDED assignment let
         -- the second write CLOBBER provenance. COALESCE/merge keeps the existing
         -- value when the incoming one is null/empty, so the date + source
         -- metadata survive the vector-add upsert (and any later partial write).
         valid_from=COALESCE(EXCLUDED.valid_from, memories.valid_from),
         document_date=COALESCE(EXCLUDED.document_date, memories.document_date),
         project=EXCLUDED.project, project_ids=EXCLUDED.project_ids,
         metadata=(memories.metadata || EXCLUDED.metadata),
         -- recall reinforcement is owned by /v1/bump-recall + decay, NOT the
         -- ingest upsert — keep the existing values so a re-ingest / 2-phase
         -- vector write never resets a memory's accumulated recall_count/strength.
         recall_count=memories.recall_count, strength=memories.strength,
         vector_synced=false, deleted_at=NULL`,
      [r.id, ORG, r.userId || null, r.content || null, r.title || null, r.tags || [], r.memoryType || null,
       r.isLatest ?? true, r.layer || 'memory', r.cognitiveLayerRole || null, r.confidence ?? null,
       r.createdAt || null, r.validFrom || null, r.documentDate || null, r.project || null,
       r.projectIds || [], JSON.stringify(r.metadata || {}), r.scope || null, r.primaryTeamId || null,
       r.recallCount ?? 0, r.strength ?? 1.0]
    );
    if (Array.isArray(b.vector)) {
      const qr = await qFetch(`/collections/${QCOLL}/points`, {
        method: 'PUT',
        body: JSON.stringify({ points: [{ id: r.id, vector: b.vector, payload: payloadOf(r) }], wait: true }),
      });
      if (!qr.ok) return { ok: false, error: `qdrant upsert ${qr.status}` }; // caller retries; row stays synced=false
      await pg.query('UPDATE memories SET vector_synced=true WHERE id=$1', [r.id]);
    }
    for (const rel of (b.rels || [])) {
      if (rel?.fromId && rel?.toId) {
        await pg.query(
          `INSERT INTO relationships (id, org_id, from_id, to_id, type, confidence) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, confidence=EXCLUDED.confidence`,
          [rel.id, ORG, rel.fromId, rel.toId, rel.type || 'Mentions', rel.confidence ?? 1]
        );
      }
    }
    return { ok: true };
  },

  // Vector recall over Qdrant → Qdrant-shaped hits (content rides in payload).
  '/v1/recall': async (b) => {
    if (!Array.isArray(b.vector)) return { results: [] };
    const r = await qFetch(`/collections/${QCOLL}/points/search`, {
      method: 'POST',
      body: JSON.stringify({ vector: b.vector, limit: b.limit || 10, with_payload: true,
        score_threshold: b.scoreThreshold ?? 0.0, filter: qdrantFilter(b.filter || {}) }),
    });
    if (!r.ok) throw new Error(`qdrant search ${r.status}`);
    const j = await r.json();
    return { results: (j.result || []).map((h) => ({ id: h.id, score: h.score, payload: h.payload || {} })) };
  },

  // Lexical (keyword) leg over Postgres FTS — the hybrid recall's second leg. Same hit shape.
  '/v1/lexical': async (b) => {
    if (!b.text) return { results: [] };
    const f = b.filter || {};
    const conds = ['org_id=$1', 'deleted_at IS NULL', "content_tsv @@ plainto_tsquery('english',$2)"];
    const args = [ORG, b.text];
    if (f.is_latest !== undefined) { args.push(!!f.is_latest); conds.push(`is_latest=$${args.length}`); }
    if (f.layer) { args.push(f.layer); conds.push(`layer=$${args.length}`); }
    if (f.must_not?.layer) { args.push(f.must_not.layer); conds.push(`layer<>$${args.length}`); }
    args.push(b.limit || 10);
    const { rows } = await pg.query(
      `SELECT id, content, title, tags, memory_type, layer, cognitive_layer_role, is_latest, created_at, user_id,
              ts_rank(content_tsv, plainto_tsquery('english',$2)) AS score
       FROM memories WHERE ${conds.join(' AND ')} ORDER BY score DESC LIMIT $${args.length}`, args);
    return { results: rows.map((m) => ({ id: m.id, score: Number(m.score) || 0, payload: {
      memory_id: m.id, org_id: ORG, user_id: m.user_id, content: m.content, title: m.title, tags: m.tags,
      memory_type: m.memory_type, layer: m.layer, cognitive_layer_role: m.cognitive_layer_role,
      is_latest: m.is_latest, created_at: m.created_at } })) };
  },

  // Hydrate full rows by id (content stays on-box until requested).
  '/v1/hydrate': async (b) => {
    if (!Array.isArray(b.ids) || !b.ids.length) return { memories: [] };
    const { rows } = await pg.query('SELECT * FROM memories WHERE id = ANY($1::uuid[]) AND org_id=$2::uuid AND deleted_at IS NULL', [b.ids, ORG]);
    return { memories: rows };
  },

  // Filtered enumeration (cognition / derivation / profile-dreamer working set). Keyset by created_at.
  '/v1/list': async (b) => {
    const f = b.filter || {};
    const conds = ['org_id=$1', 'deleted_at IS NULL'];
    const args = [ORG];
    if (Array.isArray(f.memory_type) && f.memory_type.length) { args.push(f.memory_type); conds.push(`memory_type = ANY($${args.length})`); }
    if (f.layer) { args.push(f.layer); conds.push(`layer=$${args.length}`); }
    if (f.cognitive_layer_role === null) conds.push('cognitive_layer_role IS NULL');
    if (f.is_latest !== undefined) { args.push(!!f.is_latest); conds.push(`is_latest=$${args.length}`); }
    if (f.user_id) { args.push(f.user_id); conds.push(`user_id=$${args.length}`); }
    if (f.created_after) { args.push(f.created_after); conds.push(`created_at >= $${args.length}::timestamptz`); }
    if (b.cursor) { args.push(b.cursor); conds.push(`created_at < $${args.length}::timestamptz`); }
    args.push(Math.min(b.limit || 100, 500));
    const limitPos = args.length;
    let offsetClause = '';
    if (b.offset && Number(b.offset) > 0) { args.push(Number(b.offset)); offsetClause = ` OFFSET $${args.length}`; }
    const { rows } = await pg.query(
      `SELECT * FROM memories WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${limitPos}${offsetClause}`, args);
    const cursor = rows.length ? rows[rows.length - 1].created_at : null;
    return { memories: rows, cursor };
  },

  // Counts for the Profile/Overview stats cards (memory_count + relationship_count). The engine reads
  // these from here for remote orgs — central holds 0 rows for a self-host org.
  '/v1/stats': async (b) => {
    const f = b.filter || {};
    const conds = ['org_id=$1', 'deleted_at IS NULL', 'is_latest=true'];
    const args = [ORG];
    if (f.user_id) { args.push(f.user_id); conds.push(`user_id=$${args.length}`); }
    const mem = await pg.query(`SELECT count(*)::int AS c FROM memories WHERE ${conds.join(' AND ')}`, args);
    const rel = await pg.query('SELECT count(*)::int AS c FROM relationships WHERE org_id=$1', [ORG]);
    return { memories: mem.rows[0]?.c || 0, relationships: rel.rows[0]?.c || 0 };
  },

  // Graph nodes (memories) + edges (relationships) for the Memory Graph view. Remote orgs' graph lives
  // here, not central.
  '/v1/graph': async (b) => {
    const limit = Math.min(b.limit || 500, 2000);
    const args = [ORG];
    let cond = 'org_id=$1 AND deleted_at IS NULL AND is_latest=true';
    if (b.filter?.user_id) { args.push(b.filter.user_id); cond += ` AND user_id=$${args.length}`; }
    args.push(limit);
    const { rows: nodes } = await pg.query(
      `SELECT id, title, content, tags, memory_type, created_at, document_date,
              confidence, recall_count, strength, scope
         FROM memories WHERE ${cond} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    let edges = [];
    if (nodes.length) {
      const ids = nodes.map((n) => n.id);
      // Both directions so node-detail inbound+outbound relationships resolve.
      const r = await pg.query('SELECT id, from_id, to_id, type, confidence FROM relationships WHERE org_id=$1 AND (from_id = ANY($2) OR to_id = ANY($2))', [ORG, ids]);
      edges = r.rows;
    }
    return { nodes, edges };
  },

  // Typed relationship edge (deferred relationship extraction).
  '/v1/edge': async (b) => {
    const rel = b.rel;
    if (rel?.fromId && rel?.toId) {
      await pg.query(
        `INSERT INTO relationships (id, org_id, from_id, to_id, type, confidence) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, confidence=EXCLUDED.confidence`,
        [rel.id, ORG, rel.fromId, rel.toId, rel.type || 'Mentions', rel.confidence ?? 1]);
    }
    return { ok: true };
  },

  // Resync entity:* tags after deferred entity-linking (PG row + Qdrant payload).
  '/v1/update-tags': async (b) => {
    if (b.id && Array.isArray(b.tags)) {
      await pg.query('UPDATE memories SET tags=$2 WHERE id=$1 AND org_id=$3', [b.id, b.tags, ORG]);
      qFetch(`/collections/${QCOLL}/points/payload`, { method: 'POST',
        body: JSON.stringify({ payload: { tags: b.tags }, points: [b.id] }) }).catch(() => {});
    }
    return { ok: true };
  },

  // Recall reinforcement — bump recall_count + strength + last_accessed_at for the
  // delivered top-N on every recall hit. Mirrors central's prisma.memory.updateMany
  // (recallCount:{increment:1}, strength:{increment:0.05}) so the recall SCORING
  // log-boost (pow(recall_count+1,0.15)) + strength multiplier work on self-host too.
  '/v1/bump-recall': async (b) => {
    const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
    if (!ids.length) return { ok: true, bumped: 0 };
    const r = await pg.query(
      `UPDATE memories SET recall_count = recall_count + 1,
         strength = LEAST(1.0, COALESCE(strength, 1.0) + 0.05),
         last_accessed_at = now()
       WHERE id = ANY($1::uuid[]) AND org_id = $2::uuid AND deleted_at IS NULL`,
      [ids, ORG]);
    return { ok: true, bumped: r.rowCount };
  },

  // Generic partial update: tags / is_latest / memory_type. Used by the central engine's
  // updateMemory seam for remote orgs (entity-link type upgrades, supersession is_latest flips).
  '/v1/update': async (b) => {
    if (!b.id) return { ok: false, error: 'id required' };
    const sets = []; const args = [b.id, ORG];
    if (Array.isArray(b.tags)) { args.push(b.tags); sets.push(`tags=$${args.length}`); }
    if (b.is_latest !== undefined) { args.push(!!b.is_latest); sets.push(`is_latest=$${args.length}`); }
    if (b.memory_type !== undefined) { args.push(b.memory_type); sets.push(`memory_type=$${args.length}`); }
    if (!sets.length) return { ok: true };
    await pg.query(`UPDATE memories SET ${sets.join(', ')} WHERE id=$1 AND org_id=$2`, args);
    if (Array.isArray(b.tags)) {
      qFetch(`/collections/${QCOLL}/points/payload`, { method: 'POST',
        body: JSON.stringify({ payload: { tags: b.tags }, points: [b.id] }) }).catch(() => {});
    }
    return { ok: true };
  },

  // ── KB layer (self-host) — documents + evidence segments live on the agent, never central ──
  // Upsert a knowledge document row.
  '/v1/kb-doc': async (b) => {
    const d = b.doc || {};
    if (!d.id) return { ok: false, error: 'doc.id required' };
    await pg.query(
      `INSERT INTO knowledge_documents (id, org_id, user_id, filename, content_type, status, checksum, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,coalesce($9::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, content_type=EXCLUDED.content_type,
         status=EXCLUDED.status, checksum=EXCLUDED.checksum, metadata=EXCLUDED.metadata, deleted_at=NULL`,
      [d.id, ORG, d.userId || null, d.filename || null, d.contentType || null, d.status || 'ready',
       d.checksum || null, JSON.stringify(d.metadata || {}), d.createdAt || null]);
    return { ok: true };
  },

  // Upsert one evidence segment: row + vector (layer='segment' in the shared Qdrant collection).
  '/v1/kb-segment': async (b) => {
    const s = b.segment || {};
    if (!s.id || !s.documentId) return { ok: false, error: 'segment.id + documentId required' };
    await pg.query(
      `INSERT INTO knowledge_segments (id, org_id, user_id, document_id, content, content_hash, segment_type,
         segment_index, previous_segment_id, metadata, vector_synced, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,false,coalesce($11::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash,
         segment_type=EXCLUDED.segment_type, segment_index=EXCLUDED.segment_index, metadata=EXCLUDED.metadata,
         vector_synced=false`,
      [s.id, ORG, s.userId || null, s.documentId, s.content || null, s.contentHash || null, s.segmentType || 'chunk',
       s.segmentIndex ?? 0, s.previousSegmentId || null, JSON.stringify(s.metadata || {}), s.createdAt || null]);
    if (Array.isArray(b.vector)) {
      const qr = await qFetch(`/collections/${QCOLL}/points`, { method: 'PUT', body: JSON.stringify({
        points: [{ id: s.id, vector: b.vector, payload: { segment_id: s.id, document_id: s.documentId, org_id: ORG, user_id: s.userId || null, layer: 'segment', content: s.content || '' } }], wait: true }) });
      if (!qr.ok) return { ok: false, error: `qdrant seg upsert ${qr.status}` };
      await pg.query('UPDATE knowledge_segments SET vector_synced=true WHERE id=$1', [s.id]);
    }
    return { ok: true };
  },

  // Vector search over evidence segments (layer='segment'). Returns [{segment_id, document_id, content, score}].
  '/v1/kb-recall': async (b) => {
    if (!Array.isArray(b.vector)) return { results: [] };
    const filter = { must: [{ key: 'org_id', match: { value: ORG } }, { key: 'layer', match: { value: 'segment' } }] };
    if (b.documentId) filter.must.push({ key: 'document_id', match: { value: b.documentId } });
    const qr = await qFetch(`/collections/${QCOLL}/points/search`, { method: 'POST', body: JSON.stringify({
      vector: b.vector, limit: Math.min(b.limit || 20, 100), with_payload: true, score_threshold: b.scoreThreshold ?? 0.0, filter }) });
    if (!qr.ok) return { results: [] };
    const j = await qr.json();
    return { results: (j.result || []).map((h) => ({ segment_id: h.payload?.segment_id || h.id, document_id: h.payload?.document_id, content: h.payload?.content || '', score: h.score })) };
  },

  // Hydrate segment rows by id (full content + metadata for evidence display).
  '/v1/kb-hydrate': async (b) => {
    const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
    if (!ids.length) return { segments: [] };
    const { rows } = await pg.query('SELECT id, document_id, content, content_hash, segment_type, segment_index, metadata, created_at FROM knowledge_segments WHERE org_id=$1 AND id = ANY($2)', [ORG, ids]);
    return { segments: rows };
  },

  // Delete one memory: row + vector + edges (+ tombstone if soft).
  '/v1/delete': async (b) => {
    if (!b.id) return { ok: false, error: 'id required' };
    let deleted = 0;
    if (b.hard) {
      const r = await pg.query('DELETE FROM memories WHERE id=$1 AND org_id=$2', [b.id, ORG]); deleted = r.rowCount;
      await pg.query('DELETE FROM relationships WHERE org_id=$1 AND (from_id=$2 OR to_id=$2)', [ORG, b.id]);
    } else {
      const r = await pg.query('UPDATE memories SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, ORG]); deleted = r.rowCount;
    }
    await qFetch(`/collections/${QCOLL}/points/delete`, { method: 'POST', body: JSON.stringify({ points: [b.id] }) }).catch(() => {});
    return { ok: true, deleted };
  },

  // Bulk erase the whole org (account deletion saga). Drops + recreates the Qdrant collection.
  '/v1/purge': async () => {
    const m = await pg.query('DELETE FROM memories WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM relationships WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM knowledge_segments WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM knowledge_documents WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM meetings WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM tara_turns WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM tara_calls WHERE org_id=$1', [ORG]);
    await qFetch(`/collections/${QCOLL}`, { method: 'DELETE' }).catch(() => {});
    await ensureQdrant();
    return { ok: true, deleted: m.rowCount };
  },

  // ── Meetings layer (self-host) ──────────────────────────────────────────────
  // Upsert a meeting row. All fields optional except org_id (forced server-side).
  '/v1/meeting-write': async (b) => {
    const m = b.meeting || {};
    const id = m.id || (await pg.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    const J = (v, def = '[]') => JSON.stringify(Array.isArray(v) ? v : (v != null && typeof v === 'object' && !Array.isArray(v) ? v : JSON.parse(def)));
    await pg.query(
      `INSERT INTO meetings
         (id, org_id, user_id, project_id, title, summary, transcript, language, duration_sec,
          multi_speaker, speaker_count, action_items, decisions, key_points, questions, segments,
          topics, sentiment, source_memory_id, notes, insights, participants, scope,
          intelligence, intelligence_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::text[],$18,
               $19,$20,$21::jsonb,$22::jsonb,$23,$24::jsonb,$25,
               coalesce($26::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, summary=EXCLUDED.summary, transcript=EXCLUDED.transcript,
         language=EXCLUDED.language, duration_sec=EXCLUDED.duration_sec,
         multi_speaker=EXCLUDED.multi_speaker, speaker_count=EXCLUDED.speaker_count,
         action_items=EXCLUDED.action_items, decisions=EXCLUDED.decisions,
         key_points=EXCLUDED.key_points, questions=EXCLUDED.questions,
         segments=EXCLUDED.segments, topics=EXCLUDED.topics, sentiment=EXCLUDED.sentiment,
         source_memory_id=EXCLUDED.source_memory_id, notes=EXCLUDED.notes,
         insights=EXCLUDED.insights, participants=EXCLUDED.participants, scope=EXCLUDED.scope,
         intelligence=EXCLUDED.intelligence, intelligence_status=EXCLUDED.intelligence_status,
         deleted_at=NULL`,
      [id, ORG, m.user_id || null, m.project_id || null, m.title || null, m.summary || null,
       m.transcript || null, m.language || null,
       Number.isFinite(m.duration_sec) ? m.duration_sec : null,
       !!m.multi_speaker, Number.isFinite(m.speaker_count) ? m.speaker_count : null,
       J(m.action_items), J(m.decisions), J(m.key_points), J(m.questions),
       m.segments != null ? JSON.stringify(m.segments) : null,
       Array.isArray(m.topics) ? m.topics.slice(0, 20) : [],
       m.sentiment || null, m.source_memory_id || null,
       m.notes ? String(m.notes).slice(0, 8000) : null,
       J(m.insights, '{}'),
       J(m.participants), m.scope || null,
       m.intelligence != null ? JSON.stringify(m.intelligence) : null,
       m.intelligence_status || null, m.created_at || null]);
    const { rows } = await pg.query('SELECT id, created_at FROM meetings WHERE id=$1', [id]);
    return { ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at };
  },

  // List org's non-deleted meetings, newest first. Scope filter is simplified to
  // org + deleted_at + limit (no project-membership join on the agent; the central
  // server applies the rich scope predicate for managed orgs).
  '/v1/meeting-list': async (b) => {
    const f = b.filter || {};
    const limit = Math.min(Number(f.limit) || 40, 200);
    const { rows } = await pg.query(
      `SELECT id, user_id, org_id, project_id, title, summary, language, duration_sec,
              multi_speaker, speaker_count, action_items, decisions, key_points, questions,
              segments, topics, sentiment, source_memory_id, participants, scope, created_at
       FROM meetings
       WHERE org_id=$1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $2`,
      [ORG, limit]);
    return { meetings: rows };
  },

  // Fetch one meeting row by id (full detail including transcript/notes/insights).
  '/v1/meeting-get': async (b) => {
    if (!b.id) return { meeting: null };
    const { rows } = await pg.query(
      `SELECT id, user_id, org_id, project_id, title, summary, transcript, language,
              duration_sec, multi_speaker, speaker_count, action_items, decisions,
              key_points, questions, segments, topics, sentiment, notes, insights,
              participants, scope, intelligence, intelligence_status, source_memory_id, created_at
       FROM meetings WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [b.id, ORG]);
    return { meeting: rows[0] || null };
  },

  // Soft or hard delete a meeting row.
  '/v1/meeting-delete': async (b) => {
    if (!b.id) return { ok: false, error: 'id required' };
    if (b.hard) {
      const r = await pg.query('DELETE FROM meetings WHERE id=$1 AND org_id=$2', [b.id, ORG]);
      return { ok: true, deleted: r.rowCount };
    }
    const r = await pg.query('UPDATE meetings SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, ORG]);
    return { ok: true, deleted: r.rowCount };
  },

  // Patch selected fields on a meeting row (source_memory_id, title, summary,
  // intelligence, intelligence_status). Used by ingest and intelligence runner.
  '/v1/meeting-patch': async (b) => {
    if (!b.id) return { ok: false, error: 'id required' };
    const fields = b.fields || {};
    const sets = []; const args = [b.id, ORG];
    if (fields.source_memory_id !== undefined) {
      args.push(fields.source_memory_id || null);
      sets.push(`source_memory_id=$${args.length}::uuid`);
    }
    if (typeof fields.title === 'string' && fields.title.trim()) {
      args.push(fields.title.slice(0, 300)); sets.push(`title=$${args.length}`);
    }
    if (typeof fields.summary === 'string') {
      args.push(fields.summary); sets.push(`summary=$${args.length}`);
    }
    if (fields.intelligence !== undefined) {
      args.push(JSON.stringify(fields.intelligence)); sets.push(`intelligence=$${args.length}::jsonb`);
    }
    if (typeof fields.intelligence_status === 'string') {
      args.push(fields.intelligence_status); sets.push(`intelligence_status=$${args.length}`);
    }
    if (!sets.length) return { ok: true };
    const r = await pg.query(
      `UPDATE meetings SET ${sets.join(', ')} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL RETURNING id`,
      args);
    return { ok: true, updated: r.rowCount };
  },

  // ── KB doc LIST (self-host READ) ─────────────────────────────────────────
  // Returns the org's knowledge_documents with per-doc segment_count and promoted_count.
  // promoted_count = memories whose tags array contains 'filename:<filename>'.
  // Response: { documents: [...], pagination: { total, limit, offset, hasMore } }
  '/v1/kb-docs': async (b) => {
    const limit = Math.min(Number(b.limit) || 20, 200);
    const offset = Math.max(Number(b.offset) || 0, 0);
    const { rows: docs } = await pg.query(
      `SELECT id, filename, content_type, status, metadata, created_at
       FROM knowledge_documents
       WHERE org_id=$1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [ORG, limit, offset]
    );
    const { rows: totRow } = await pg.query(
      'SELECT count(*)::int AS c FROM knowledge_documents WHERE org_id=$1 AND deleted_at IS NULL',
      [ORG]
    );
    const total = totRow[0]?.c || 0;
    // Batch segment counts and promoted counts in two queries rather than N+1.
    const ids = docs.map((d) => d.id);
    const filenames = docs.map((d) => d.filename).filter(Boolean);
    let segMap = {};
    let proMap = {};
    if (ids.length) {
      const { rows: segs } = await pg.query(
        'SELECT document_id, count(*)::int AS c FROM knowledge_segments WHERE org_id=$1 AND document_id = ANY($2::uuid[]) GROUP BY document_id',
        [ORG, ids]
      );
      for (const r of segs) segMap[r.document_id] = r.c;
    }
    if (filenames.length) {
      // promoted = memories tagged 'filename:<filename>' — counted from the ACTIVE memory store.
      // In amr mode PG's memories table is frozen at cutover; counting from it showed 0 for every
      // post-cutover doc (the "14 seg · 0 mem" bug) and stale counts for pre-cutover ones.
      if (effectiveStore === 'amr' && amr) {
        const wanted = new Set(filenames.map((f) => `filename:${f}`));
        const { memories } = amr.list({}, undefined, 100000, 0);
        for (const m of memories) {
          for (const t of (m.tags || [])) {
            if (typeof t === 'string' && wanted.has(t)) {
              const fn = t.slice('filename:'.length);
              proMap[fn] = (proMap[fn] || 0) + 1;
            }
          }
        }
      } else {
        const tagPatterns = filenames.map((f) => `filename:${f}`);
        const { rows: prows } = await pg.query(
          `SELECT unnest(tags) AS tag, count(*)::int AS c
           FROM memories
           WHERE org_id=$1 AND deleted_at IS NULL AND tags && $2::text[]
           GROUP BY tag`,
          [ORG, tagPatterns]
        );
        for (const r of prows) {
          if (typeof r.tag === 'string' && r.tag.startsWith('filename:')) {
            const fn = r.tag.slice('filename:'.length);
            proMap[fn] = (proMap[fn] || 0) + r.c;
          }
        }
      }
    }
    const documents = docs.map((d) => ({
      id: d.id,
      // Map agent columns to the central shape the FE expects:
      title: (d.metadata?.title) || d.filename || d.id,
      documentType: d.content_type || (d.metadata?.document_type) || null,
      sourcePlatform: d.metadata?.source_platform || null,
      sourceUrl: d.metadata?.source_url || null,
      documentDate: d.metadata?.document_date || null,
      wordCount: d.metadata?.word_count || null,
      parseStatus: d.status || 'ready',
      parseEngine: d.metadata?.parse_engine || null,
      structureExtracted: d.metadata?.structure_extracted ?? false,
      tags: d.metadata?.tags || [],
      createdAt: d.created_at,
      updatedAt: d.created_at,
      // Extra fields used by agent schema (not in central — ignored by FE gracefully):
      filename: d.filename,
      content_type: d.content_type,
      status: d.status,
      metadata: d.metadata || {},
      // Counts:
      segmentCount: segMap[d.id] || 0,
      promotedCount: d.filename ? (proMap[d.filename] || 0) : 0,
    }));
    return { documents, pagination: { total, limit, offset, hasMore: offset + limit < total } };
  },

  // ── KB doc DETAIL (self-host READ) ───────────────────────────────────────
  // Returns one doc + its segments + promoted memories (memories tagged filename:<filename>).
  // Response: { document, segments, promotedMemories, segmentCount, promotedCount }
  '/v1/kb-doc-detail': async (b) => {
    if (!b.documentId) return { error: 'documentId required' };
    const { rows: docRows } = await pg.query(
      'SELECT id, filename, content_type, status, metadata, created_at FROM knowledge_documents WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [b.documentId, ORG]
    );
    if (!docRows.length) return { error: 'not found' };
    const d = docRows[0];
    const { rows: segs } = await pg.query(
      'SELECT id, document_id, content, content_hash, segment_type, segment_index, metadata, created_at FROM knowledge_segments WHERE document_id=$1 AND org_id=$2 ORDER BY segment_index ASC',
      [d.id, ORG]
    );
    // Map segments to central camelCase shape (FE reads segmentIndex, segmentType).
    const segments = segs.map((s) => ({
      id: s.id,
      documentId: s.document_id,
      content: s.content,
      contentHash: s.content_hash,
      segmentType: s.segment_type,
      segmentIndex: s.segment_index,
      metadata: s.metadata || {},
      createdAt: s.created_at,
    }));
    // Promoted memories: tagged filename:<filename> — from the ACTIVE memory store (same
    // amr-vs-frozen-PG split as /v1/kb-docs above).
    let promotedMemories = [];
    if (d.filename) {
      const tag = `filename:${d.filename}`;
      let mems;
      if (effectiveStore === 'amr' && amr) {
        mems = amr.list({}, undefined, 100000, 0).memories
          .filter((m) => (m.tags || []).includes(tag))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 100);
      } else {
        ({ rows: mems } = await pg.query(
          `SELECT id, title, content, memory_type, confidence, tags, created_at
           FROM memories WHERE org_id=$1 AND deleted_at IS NULL AND $2 = ANY(tags)
           ORDER BY created_at DESC LIMIT 100`,
          [ORG, tag]
        ));
      }
      promotedMemories = mems.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.content,
        memoryType: m.memory_type,
        importanceScore: m.confidence,
        tags: m.tags,
        createdAt: m.created_at,
        // evidence link fields (central shape includes these from evidenceLink join):
        linkType: 'extracted-fact',
        confidence: m.confidence,
        excerpt: null,
      }));
    }
    const document = {
      id: d.id,
      title: d.metadata?.title || d.filename || d.id,
      documentType: d.content_type || d.metadata?.document_type || null,
      sourcePlatform: d.metadata?.source_platform || null,
      sourceUrl: d.metadata?.source_url || null,
      documentDate: d.metadata?.document_date || null,
      wordCount: d.metadata?.word_count || null,
      parseStatus: d.status || 'ready',
      parseEngine: d.metadata?.parse_engine || null,
      structureExtracted: d.metadata?.structure_extracted ?? false,
      tags: d.metadata?.tags || [],
      createdAt: d.created_at,
      filename: d.filename,
      content_type: d.content_type,
      status: d.status,
      metadata: d.metadata || {},
    };
    return { document, segments, promotedMemories, segmentCount: segments.length, promotedCount: promotedMemories.length };
  },

  // ── Per-memory edge counts (self-host READ) ───────────────────────────────
  // Returns { <id>: { in: N, out: N } } for each requested memory id.
  // "in"  = relationships where to_id = this memory
  // "out" = relationships where from_id = this memory
  '/v1/mem-edges': async (b) => {
    const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
    if (!ids.length) return {};
    const { rows: outRows } = await pg.query(
      'SELECT from_id AS id, count(*)::int AS c FROM relationships WHERE org_id=$1 AND from_id = ANY($2::uuid[]) GROUP BY from_id',
      [ORG, ids]
    );
    const { rows: inRows } = await pg.query(
      'SELECT to_id AS id, count(*)::int AS c FROM relationships WHERE org_id=$1 AND to_id = ANY($2::uuid[]) GROUP BY to_id',
      [ORG, ids]
    );
    const result = {};
    for (const id of ids) result[id] = { in: 0, out: 0 };
    for (const r of outRows) if (result[r.id]) result[r.id].out = r.c;
    for (const r of inRows) if (result[r.id]) result[r.id].in = r.c;
    return result;
  },

  // ── Per-memory relationships (self-host READ) ─────────────────────────────
  // Returns the same shape as /api/memories/:id/relationships (central handler).
  // { memory_id, out: [...], in: [...], by_type: {...}, counts: { out, in, total } }
  '/v1/mem-relationships': async (b) => {
    if (!b.memoryId) return { error: 'memoryId required' };
    const memId = b.memoryId;
    const { rows: outRels } = await pg.query(
      'SELECT id, from_id, to_id, type, confidence, created_at FROM relationships WHERE org_id=$1 AND from_id=$2::uuid ORDER BY confidence DESC, created_at DESC LIMIT 200',
      [ORG, memId]
    );
    const { rows: inRels } = await pg.query(
      'SELECT id, from_id, to_id, type, confidence, created_at FROM relationships WHERE org_id=$1 AND to_id=$2::uuid ORDER BY confidence DESC, created_at DESC LIMIT 200',
      [ORG, memId]
    );
    // Batch-fetch peer memory titles.
    const peerIds = [...new Set([...outRels.map((r) => r.to_id), ...inRels.map((r) => r.from_id)])];
    let peerById = {};
    if (peerIds.length) {
      const { rows: peers } = await pg.query(
        'SELECT id, title, content, memory_type, is_latest, deleted_at, created_at FROM memories WHERE org_id=$1 AND id = ANY($2::uuid[])',
        [ORG, peerIds]
      );
      for (const p of peers) peerById[p.id] = p;
    }
    const peerTitle = (p) => p?.title || (p?.content || '').slice(0, 60) || '(untitled)';
    const enrichOut = outRels.map((r) => {
      const p = peerById[r.to_id];
      return {
        id: r.id,
        type: r.type || 'Mentions',
        confidence: r.confidence,
        created_by: null,
        created_at: r.created_at,
        metadata: {},
        direction: 'out',
        target_id: r.to_id,
        target_title: peerTitle(p),
        target_memory_type: p?.memory_type || null,
        target_is_latest: p?.is_latest ?? null,
        target_deleted: !!(p?.deleted_at),
      };
    });
    const enrichIn = inRels.map((r) => {
      const p = peerById[r.from_id];
      return {
        id: r.id,
        type: r.type || 'Mentions',
        confidence: r.confidence,
        created_by: null,
        created_at: r.created_at,
        metadata: {},
        direction: 'in',
        source_id: r.from_id,
        source_title: peerTitle(p),
        source_memory_type: p?.memory_type || null,
        source_is_latest: p?.is_latest ?? null,
        source_deleted: !!(p?.deleted_at),
      };
    });
    const by_type = {};
    for (const e of [...enrichOut, ...enrichIn]) {
      const t = e.type || 'Other';
      (by_type[t] = by_type[t] || []).push(e);
    }
    return {
      memory_id: memId,
      out: enrichOut,
      in: enrichIn,
      by_type,
      counts: { out: enrichOut.length, in: enrichIn.length, total: enrichOut.length + enrichIn.length },
    };
  },

  // ── TARA call ledger (self-host) ──────────────────────────────────────────
  // op: 'upsert'  → create-or-update a call row (session start / reconnect).
  // op: 'get'     → fetch by session_id.
  // op: 'update'  → increment turn_count/prompt_tokens/completion_tokens or set status.
  '/v1/tara-call': async (b) => {
    const op = b.op || 'upsert';
    if (op === 'upsert') {
      const sid = b.session_id;
      if (!sid) return { ok: false, error: 'session_id required' };
      await pg.query(
        `INSERT INTO tara_calls (org_id, user_id, session_id, status, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (session_id) DO UPDATE SET
           status=$4, metadata=EXCLUDED.metadata`,
        [ORG, b.user_id || null, sid, b.status || 'active',
         JSON.stringify(b.metadata || {})]);
      const { rows } = await pg.query('SELECT id FROM tara_calls WHERE session_id=$1 AND org_id=$2', [sid, ORG]);
      return { ok: true, id: rows[0]?.id };
    }
    if (op === 'get') {
      const sid = b.session_id;
      if (!sid) return { call: null };
      const { rows } = await pg.query(
        'SELECT id, org_id, user_id, session_id, status, turn_count, prompt_tokens, completion_tokens, metadata, created_at FROM tara_calls WHERE session_id=$1 AND org_id=$2',
        [sid, ORG]);
      return { call: rows[0] || null };
    }
    if (op === 'update') {
      const sid = b.session_id;
      if (!sid) return { ok: false, error: 'session_id required' };
      const sets = []; const args = [sid, ORG];
      if (Number.isFinite(b.turn_count_inc) && b.turn_count_inc !== 0) {
        args.push(b.turn_count_inc); sets.push(`turn_count=turn_count+$${args.length}`);
      }
      if (Number.isFinite(b.prompt_tokens_inc) && b.prompt_tokens_inc !== 0) {
        args.push(b.prompt_tokens_inc); sets.push(`prompt_tokens=prompt_tokens+$${args.length}`);
      }
      if (Number.isFinite(b.completion_tokens_inc) && b.completion_tokens_inc !== 0) {
        args.push(b.completion_tokens_inc); sets.push(`completion_tokens=completion_tokens+$${args.length}`);
      }
      if (typeof b.status === 'string') { args.push(b.status); sets.push(`status=$${args.length}`); }
      if (!sets.length) return { ok: true };
      await pg.query(`UPDATE tara_calls SET ${sets.join(', ')} WHERE session_id=$1 AND org_id=$2`, args);
      return { ok: true };
    }
    return { ok: false, error: `unknown op: ${op}` };
  },
};

await ensureSchema();
await ensureQdrant();

// ── .amr engine (only when the operator chose it at setup) ─────────────────────────────────────
// Dynamic import so pg-qdrant boxes never load (or need) the native binding. When active, the 11
// memory/relationship routes below are OVERRIDDEN with .amr-backed implementations — the KB routes
// (kb-doc / kb-segment / kb-recall / kb-hydrate / erase) keep using Postgres+Qdrant either way.
let amr = null;
let effectiveStore = STORE;
if (STORE === 'amr') {
  try {
  const { AmrMemoryStore, migrateFromPostgres } = await import('./mneme/amr.mjs');
  amr = new AmrMemoryStore({ dataRoot: process.env.MNEME_DATA_ROOT || '/data/mneme', org: ORG, dim: DIM });
  const migration = await migrateFromPostgres(amr, pg, qFetch, QCOLL, ORG).catch((e) => {
    console.error('[hm-agent] .amr migration failed (shard stays empty, retried next boot):', e.message);
    return { migrated: 0, error: e.message };
  });
  console.log(`[hm-agent] .amr active: live=${amr.liveCount()} migration=${JSON.stringify(migration)}`);
  Object.assign(routes, {
    '/v1/write': async (b) => {
      const r = b.record || {};
      if (!r.id) return { ok: false, error: 'record.id required' };
      amr.write(r, Array.isArray(b.vector) ? b.vector : undefined);
      for (const rel of (b.rels || [])) if (rel?.fromId && rel?.toId) amr.addEdge(rel);
      return { ok: true };
    },
    '/v1/recall': async (b) => Array.isArray(b.vector)
      ? { results: amr.recall(b.vector, b.limit || 10, b.filter || {}) } : { results: [] },
    '/v1/lexical': async (b) => b.text
      ? { results: amr.lexical(b.text, b.filter || {}, b.limit || 10) } : { results: [] },
    '/v1/hydrate': async (b) => ({ memories: Array.isArray(b.ids) && b.ids.length ? amr.hydrate(b.ids) : [] }),
    '/v1/list': async (b) => amr.list(b.filter || {}, b.cursor, b.limit || 100, Number(b.offset) || 0),
    '/v1/stats': async (b) => amr.stats(b.filter || {}),
    '/v1/graph': async (b) => amr.graph(b.filter || {}, b.limit || 500),
    '/v1/edge': async (b) => { if (b.rel?.fromId && b.rel?.toId) amr.addEdge(b.rel); return { ok: true }; },
    '/v1/update-tags': async (b) => { if (b.id && Array.isArray(b.tags)) amr.updateTags(b.id, b.tags); return { ok: true }; },
    '/v1/bump-recall': async (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
      return { ok: true, bumped: ids.length ? amr.bumpRecall(ids) : 0 };
    },
    '/v1/update': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      amr.patchUpdate(b.id, b);
      return { ok: true };
    },
    // Deletes MUST reach the shard — routed to frozen PG they'd leave stale memories serving
    // from .amr forever (the "relationship graph keeps stale memories" bug class).
    '/v1/delete': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      const deleted = amr.remove(b.id) ? 1 : 0;
      // Also clear any pre-cutover PG row + Qdrant point so every copy agrees.
      await pg.query('UPDATE memories SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, ORG]).catch(() => {});
      qFetch(`/collections/${QCOLL}/points/delete`, { method: 'POST', body: JSON.stringify({ points: [b.id] }) }).catch(() => {});
      return { ok: true, deleted };
    },
    '/v1/purge': async () => {
      const shardDeleted = amr.purge();
      await pg.query('DELETE FROM memories WHERE org_id=$1', [ORG]).catch(() => {});
      await pg.query('DELETE FROM relationships WHERE org_id=$1', [ORG]).catch(() => {});
      await pg.query('DELETE FROM knowledge_segments WHERE org_id=$1', [ORG]).catch(() => {});
      await pg.query('DELETE FROM knowledge_documents WHERE org_id=$1', [ORG]).catch(() => {});
      await pg.query('DELETE FROM meetings WHERE org_id=$1', [ORG]).catch(() => {});
      await qFetch(`/collections/${QCOLL}`, { method: 'DELETE' }).catch(() => {});
      await ensureQdrant().catch(() => {});
      return { ok: true, shard_deleted: shardDeleted };
    },
  });
  } catch (e) {
    // The operator chose .amr but the engine can't start here (e.g. no native binding for this
    // platform yet). Fail OPEN to the proven pg-qdrant path — the agent must never crash-loop and
    // take the org's memory offline over a storage-engine preference. Loud, so it's fixable.
    console.error(`[hm-agent] AGENT_STORE=amr requested but .amr failed to start — FALLING BACK to pg-qdrant. Fix and restart to activate .amr. Cause: ${e.message}`);
    amr = null;
    effectiveStore = 'pg-qdrant';
  }
}

console.log(`[hm-agent] org=${ORG} store=${effectiveStore} dim=${DIM}`);

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    let pgOk = false; try { await pg.query('SELECT 1'); pgOk = true; } catch { pgOk = false; }
    return send(res, 200, { ok: true, org: ORG, store: effectiveStore, pg: pgOk, qdrant: await qdrantHealthy(), dim: DIM, schemaVersion: SCHEMA_VERSION });
  }
  // Dashboard — read-only, GET, no token (same trust boundary as /health: private tailnet/LAN only,
  // counts never content). Lets the operator open http://<agent>:8787/ in a browser.
  if (req.method === 'GET' && req.url === '/') return sendHtml(res, 200, DASHBOARD_HTML);
  if (req.method === 'GET' && req.url === '/v1/dashboard/stats') return send(res, 200, await dashboardStats());
  if (req.method !== 'POST' || !routes[req.url]) return send(res, 404, { error: 'not found' });
  // Origin lock — the engine is server-to-server (no Origin). A present Origin/Referer means a browser
  // is calling the agent → reject (CSRF/SSRF guard). If ALLOWED_ENGINE_ORIGIN is set, it must match.
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    const o = String(origin).replace(/\/+$/, '');
    if (!ALLOWED_ENGINE_ORIGIN || o !== ALLOWED_ENGINE_ORIGIN) return send(res, 403, { error: 'forbidden_origin' });
  }
  // Bearer token — timing-safe constant-time compare (only the engine holds this org's token).
  if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
  // The engine always stamps x-org-id; if present it MUST be this agent's org (defense in depth — the
  // agent also hard-scopes every query to ORG server-side regardless).
  if (req.headers['x-org-id'] && req.headers['x-org-id'] !== ORG) return send(res, 403, { error: 'org mismatch' });
  try { send(res, 200, await routes[req.url](await readBody(req))); }
  catch (e) { console.error(`[hm-agent] ${req.url} failed:`, e.message); send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`[hm-agent] listening :${PORT} (org ${ORG})`));
