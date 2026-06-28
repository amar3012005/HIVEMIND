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
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const ORG = process.env.ORG_ID || die('ORG_ID required');
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
      metadata jsonb NOT NULL DEFAULT '{}',
      deleted_at timestamptz,
      vector_synced boolean NOT NULL DEFAULT false,
      content_tsv tsvector GENERATED ALWAYS AS
        (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
    );
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
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const routes = {
  // Upsert one finished memory: row (idempotent by id) + vector. Atomic-ish: insert row synced=false,
  // upsert vector (wait), then mark synced. If the vector fails the route returns non-ok so the caller retries.
  '/v1/write': async (b) => {
    const r = b.record || {};
    if (!r.id) return { ok: false, error: 'record.id required' };
    await pg.query(
      `INSERT INTO memories (id, org_id, user_id, content, title, tags, memory_type, is_latest, layer,
         cognitive_layer_role, confidence, created_at, valid_from, document_date, project, project_ids,
         metadata, vector_synced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::timestamptz,now()),$13,$14,$15,$16,$17::jsonb,false)
       ON CONFLICT (id) DO UPDATE SET
         content=EXCLUDED.content, title=EXCLUDED.title, tags=EXCLUDED.tags, memory_type=EXCLUDED.memory_type,
         is_latest=EXCLUDED.is_latest, layer=EXCLUDED.layer, cognitive_layer_role=EXCLUDED.cognitive_layer_role,
         confidence=EXCLUDED.confidence, valid_from=EXCLUDED.valid_from, document_date=EXCLUDED.document_date,
         project=EXCLUDED.project, project_ids=EXCLUDED.project_ids, metadata=EXCLUDED.metadata,
         vector_synced=false, deleted_at=NULL`,
      [r.id, ORG, r.userId || null, r.content || null, r.title || null, r.tags || [], r.memoryType || null,
       r.isLatest ?? true, r.layer || 'memory', r.cognitiveLayerRole || null, r.confidence ?? null,
       r.createdAt || null, r.validFrom || null, r.documentDate || null, r.project || null,
       r.projectIds || [], JSON.stringify(r.metadata || {})]
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
      `SELECT id, title, content, tags, memory_type, created_at FROM memories WHERE ${cond} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    let edges = [];
    if (nodes.length) {
      const ids = nodes.map((n) => n.id);
      const r = await pg.query('SELECT id, from_id, to_id, type, confidence FROM relationships WHERE org_id=$1 AND from_id = ANY($2)', [ORG, ids]);
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
      // promoted = memories tagged 'filename:<filename>'
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
    // Promoted memories: tagged filename:<filename>.
    let promotedMemories = [];
    if (d.filename) {
      const tag = `filename:${d.filename}`;
      const { rows: mems } = await pg.query(
        `SELECT id, title, content, memory_type, confidence, tags, created_at
         FROM memories WHERE org_id=$1 AND deleted_at IS NULL AND $2 = ANY(tags)
         ORDER BY created_at DESC LIMIT 100`,
        [ORG, tag]
      );
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
console.log(`[hm-agent] org=${ORG} store=pg-qdrant dim=${DIM}`);

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    let pgOk = false; try { await pg.query('SELECT 1'); pgOk = true; } catch { pgOk = false; }
    return send(res, 200, { ok: true, org: ORG, store: 'pg-qdrant', pg: pgOk, qdrant: await qdrantHealthy(), dim: DIM, schemaVersion: SCHEMA_VERSION });
  }
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
