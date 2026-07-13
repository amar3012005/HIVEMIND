// embedded-agent.mjs — the hm-agent's route table, PORTED IN-PROCESS for central .amr orgs.
//
// WHY THIS EXISTS: a self-host box runs `hm-agent` (agent/server.mjs) over HTTP so the org's data
// stays on their box. A CENTRAL personal/managed org that has been cut over to .amr storage has NO
// box — the box IS central. Rather than loop back over HTTP to itself, this module gives central
// orgs the EXACT SAME storage semantics (same SQL, same route shapes, same amr-store calls) as a
// self-host box, in-process. The registry's per-org url field carries `local:` for these orgs;
// wherever the engine would normally `fetch(agentUrl + route, ...)` it instead calls
// `dispatch(orgId, route, body)` from this module — same JSON in, same JSON out, zero HTTP hop.
//
// SOURCE OF TRUTH this was ported from: /Users/amar/hivemind-byod/agent/server.mjs
//   - routes table (~line 431) — request/response shapes kept byte-identical.
//   - amr-mode Object.assign override block (~line 1226) — the ONLY memory/relationship path here;
//     this module has no pg-qdrant memory path (self-host operators can still choose pg-qdrant on
//     their own box; central .amr orgs are amr-only by construction).
//   - ensureSchema / qFetch / ensureQdrant / qdrantFilter / payloadOf helpers — ported verbatim,
//     parameterized by org instead of a single process-wide ORG constant.
//
// MULTI-ORG: the agent is single-org (one process, one ORG env var, one pg pool already scoped via
// search_path). This module serves MANY orgs from one hm-core process, so every route is threaded
// through a per-org context `ctx = { org, amr, qcoll, routes }` built lazily by getCtx(orgId) and
// kept in a small LRU (open .amr shards are mmap'd files — bounded concurrent-open count matters).
//
// Amr-store: reuses the ALREADY-PORTED v2 streaming AmrMemoryStore (./amr-store.mjs) — not
// reimplemented here.
import { AmrMemoryStore } from './amr-store.mjs';

const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const MAX_OPEN = Number(process.env.MNEME_EMBEDDED_MAX_OPEN || 64);
const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';

let ready = false;
export function isEmbeddedReady() { return ready; }

// ── Postgres (rows + lexical) — lazy singleton, schema `hm` on CENTRAL postgres ────────────────
let pg = null;
let schemaEnsured = null; // promise, so concurrent first-callers don't race the DDL
async function getPg() {
  if (pg) return pg;
  const { default: Pg } = await import('pg');
  pg = new Pg.Pool({
    connectionString: process.env.DATABASE_URL || (() => { throw new Error('DATABASE_URL required for embedded agent'); })(),
    max: 8,
    options: '-c search_path=hm,public',
  });
  return pg;
}

// Ported verbatim from agent/server.mjs ensureSchema() — same DDL, same schema `hm`.
async function ensureSchema() {
  const db = await getPg();
  await db.query(`
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
      superseded_at timestamptz,
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
      recall_count int NOT NULL DEFAULT 0,
      strength real NOT NULL DEFAULT 1.0,
      last_accessed_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}',
      deleted_at timestamptz,
      vector_synced boolean NOT NULL DEFAULT false,
      content_tsv tsvector GENERATED ALWAYS AS
        (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
    );
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS primary_team_id uuid;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count int NOT NULL DEFAULT 0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS strength real NOT NULL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
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
  console.log(`[embedded-agent] ready (schema hm, dataRoot ${DATA_ROOT}, dim ${DIM})`);
}

async function countDerivedMemories(db, org, docIds = []) {
  const ids = Array.from(new Set((docIds || []).filter(Boolean)));
  if (!ids.length) return {};
  const tagIds = ids.map((id) => `doc-id:${id}`);
  const { rows } = await db.query(
    `SELECT doc_id::text AS document_id, count(DISTINCT memory_id)::int AS c
       FROM (
         SELECT m.metadata->'source_metadata'->>'document_id' AS doc_id, m.id AS memory_id
           FROM memories m
          WHERE m.org_id = $1::uuid
            AND m.deleted_at IS NULL
            AND (m.metadata->'source_metadata'->>'document_id') = ANY($2::text[])
         UNION
         SELECT m.metadata->>'document_id' AS doc_id, m.id AS memory_id
           FROM memories m
          WHERE m.org_id = $1::uuid
            AND m.deleted_at IS NULL
            AND (m.metadata->>'document_id') = ANY($2::text[])
         UNION
         SELECT regexp_replace(t.tag, '^doc-id:', '') AS doc_id, m.id AS memory_id
           FROM memories m
           CROSS JOIN LATERAL unnest(m.tags) AS t(tag)
          WHERE m.org_id = $1::uuid
            AND m.deleted_at IS NULL
            AND t.tag = ANY($3::text[])
       ) derived
      GROUP BY doc_id`,
    [org, ids, tagIds],
  );
  return Object.fromEntries((rows || []).map((row) => [row.document_id, Number(row.c) || 0]));
}

// ── Qdrant (vectors) — per-org collection. Central Qdrant is API-key-protected (a self-host box's
// Qdrant is keyless — the byod agent never sent a key); send api-key when QDRANT_API_KEY is set,
// else the embedded agent's KB-segment vector ops 401 on central.
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || process.env.QDRANT_CLOUD_API_KEY || '';
const qFetch = (path, opts = {}, ms = 4000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  const headers = { 'content-type': 'application/json', ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}), ...(opts.headers || {}) };
  return fetch(`${QDRANT_URL}${path}`, { ...opts, headers, signal: ac.signal }).finally(() => clearTimeout(t));
};
async function ensureQdrant(qcoll) {
  if (!QDRANT_URL) throw new Error('QDRANT_URL required for embedded agent');
  const r = await qFetch(`/collections/${qcoll}`, { method: 'PUT', body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }) });
  if (!r.ok && r.status !== 409) console.warn(`[embedded-agent] qdrant ensure ${qcoll} → ${r.status}`);
}
async function qdrantHealthy(qcoll) {
  try { const r = await qFetch(`/collections/${qcoll}`, {}, 1500); return r.ok; } catch { return false; }
}

// Ported verbatim (org substituted for the process-wide ORG constant).
function qdrantFilter(org, f = {}) {
  if (Array.isArray(f.must) || Array.isArray(f.must_not)) {
    const must = [...(f.must || [])];
    if (!must.some((c) => c && c.key === 'org_id')) must.push({ key: 'org_id', match: { value: org } });
    const out = { must };
    if (Array.isArray(f.must_not) && f.must_not.length) out.must_not = f.must_not;
    return out;
  }
  const must = [{ key: 'org_id', match: { value: org } }];
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

// Ported verbatim.
function payloadOf(org, rec) {
  return {
    memory_id: rec.id, org_id: org, user_id: rec.userId || null,
    content: rec.content || '', title: rec.title || null, tags: rec.tags || [],
    memory_type: rec.memoryType || null, layer: rec.layer || 'memory',
    cognitive_layer_role: rec.cognitiveLayerRole || null,
    is_latest: rec.isLatest ?? true, created_at: rec.createdAt || null,
  };
}

// ── per-org context, LRU-capped ─────────────────────────────────────────────────────────────────
// Map preserves insertion order; re-inserting on access implements LRU eviction (evict oldest key).
const ctxCache = new Map();
const ctxPending = new Map();

async function getCtx(orgId) {
  if (ctxCache.has(orgId)) {
    const c = ctxCache.get(orgId);
    ctxCache.delete(orgId); ctxCache.set(orgId, c); // bump to MRU
    return c;
  }
  if (ctxPending.has(orgId)) return ctxPending.get(orgId);
  const opening = (async () => {
    if (!schemaEnsured) schemaEnsured = ensureSchema();
    await schemaEnsured;
    const org = orgId;
    const qcoll = `org_${org}`.replace(/[^a-zA-Z0-9]/g, '_');
    await ensureQdrant(qcoll);
    const amr = new AmrMemoryStore({ dataRoot: DATA_ROOT, org, dim: DIM });
    const ctx = { org, amr, qcoll, routes: null };
    ctx.routes = routesFor(ctx);
    ctxCache.set(orgId, ctx);
    ready = true;
    console.log(`[embedded-agent] shard open org=${org} live=${amr.liveCount()}`);
    if (ctxCache.size > MAX_OPEN) {
      const oldestKey = ctxCache.keys().next().value;
      const oldest = ctxCache.get(oldestKey);
      ctxCache.delete(oldestKey);
      try { oldest.amr.flush(); } catch { /* best-effort */ }
    }
    return ctx;
  })();
  ctxPending.set(orgId, opening);
  try { return await opening; } finally { ctxPending.delete(orgId); }
}

// ── route table, built once per ctx ─────────────────────────────────────────────────────────────
// All memory/relationship routes below are the amr-mode overrides from agent/server.mjs (the ONLY
// memory path this module serves — central .amr orgs have no pg-qdrant memory fallback). KB routes,
// meetings, and TARA routes are the plain pg-qdrant handlers (self-host's KB layer always uses
// Postgres+Qdrant regardless of AGENT_STORE; central .amr orgs mirror that).
function routesFor(ctx) {
  const { org, amr, qcoll } = ctx;
  const db = () => pg; // pg is the lazy singleton; already open by the time getCtx awaited ensureSchema

  return {
    // ── memory + relationships (amr) ──────────────────────────────────────────────────────────
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
      const sets = []; const args = [b.id, org];
      if (b.is_latest !== undefined) { args.push(!!b.is_latest); sets.push(`is_latest=$${args.length}`); }
      if (b.memory_type !== undefined) { args.push(b.memory_type); sets.push(`memory_type=$${args.length}`); }
      if (Array.isArray(b.tags)) { args.push(b.tags); sets.push(`tags=$${args.length}::text[]`); }
      if (b.superseded_at !== undefined) { args.push(b.superseded_at || null); sets.push(`superseded_at=$${args.length}::timestamptz`); }
      if (sets.length) {
        await db().query(`UPDATE memories SET ${sets.join(', ')} WHERE id=$1 AND org_id=$2`, args);
      }
      return { ok: true };
    },
    '/v1/delete': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      const deleted = amr.remove(b.id) ? 1 : 0;
      await db().query('UPDATE memories SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, org]).catch(() => {});
      qFetch(`/collections/${qcoll}/points/delete`, { method: 'POST', body: JSON.stringify({ points: [b.id] }) }).catch(() => {});
      return { ok: true, deleted };
    },
    '/v1/purge': async () => {
      const shardDeleted = amr.purge();
      await db().query('DELETE FROM memories WHERE org_id=$1', [org]).catch(() => {});
      await db().query('DELETE FROM relationships WHERE org_id=$1', [org]).catch(() => {});
      await db().query('DELETE FROM knowledge_segments WHERE org_id=$1', [org]).catch(() => {});
      await db().query('DELETE FROM knowledge_documents WHERE org_id=$1', [org]).catch(() => {});
      await db().query('DELETE FROM meetings WHERE org_id=$1', [org]).catch(() => {});
      await db().query('DELETE FROM tara_turns WHERE org_id=$1', [org]).catch(() => {});
      await db().query('DELETE FROM tara_calls WHERE org_id=$1', [org]).catch(() => {});
      await qFetch(`/collections/${qcoll}`, { method: 'DELETE' }).catch(() => {});
      await ensureQdrant(qcoll).catch(() => {});
      return { ok: true, shard_deleted: shardDeleted };
    },
    '/v1/mem-edges': async (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
      if (!ids.length) return {};
      const result = {};
      for (const id of ids) {
        const { out, in: inn } = amr.edgesOf(id);
        result[id] = { in: inn.length, out: out.length };
      }
      return result;
    },
    '/v1/mem-relationships': async (b) => {
      if (!b.memoryId) return { error: 'memoryId required' };
      const memId = b.memoryId;
      const peerTitle = (rec) => rec?.title || (rec?.content || '').slice(0, 60) || '(untitled)';
      const { out: outE, in: inE } = amr.edgesOf(memId);
      const enrichOut = outE.slice(0, 200).map((e) => ({
        id: `e:${memId}:${e.toId}:${e.type}`, type: e.type || 'Mentions', confidence: e.confidence,
        created_by: null, created_at: null, metadata: {}, direction: 'out',
        target_id: e.toId, target_title: peerTitle(e.peer), target_memory_type: e.peer?.memory_type || null,
        target_is_latest: e.peer?.is_latest ?? null, target_deleted: !!(e.peer?.deleted_at),
      }));
      const enrichIn = inE.slice(0, 200).map((e) => ({
        id: `e:${e.fromId}:${memId}:${e.type}`, type: e.type || 'Mentions', confidence: e.confidence,
        created_by: null, created_at: null, metadata: {}, direction: 'in',
        source_id: e.fromId, source_title: peerTitle(e.peer), source_memory_type: e.peer?.memory_type || null,
        source_is_latest: e.peer?.is_latest ?? null, source_deleted: !!(e.peer?.deleted_at),
      }));
      const by_type = {};
      for (const e of [...enrichOut, ...enrichIn]) {
        const t = e.type || 'Other';
        (by_type[t] = by_type[t] || []).push(e);
      }
      return {
        memory_id: memId, out: enrichOut, in: enrichIn, by_type,
        counts: { out: enrichOut.length, in: enrichIn.length, total: enrichOut.length + enrichIn.length },
      };
    },

    // ── KB layer (documents + evidence segments) — Postgres + Qdrant, same as self-host ────────
    '/v1/kb-doc': async (b) => {
      const d = b.doc || {};
      if (!d.id) return { ok: false, error: 'doc.id required' };
      await db().query(
        `INSERT INTO knowledge_documents (id, org_id, user_id, filename, content_type, status, checksum, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,coalesce($9::timestamptz,now()))
         ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, content_type=EXCLUDED.content_type,
           status=EXCLUDED.status, checksum=EXCLUDED.checksum, metadata=EXCLUDED.metadata, deleted_at=NULL`,
        [d.id, org, d.userId || null, d.filename || null, d.contentType || null, d.status || 'ready',
         d.checksum || null, JSON.stringify(d.metadata || {}), d.createdAt || null]);
      return { ok: true };
    },

    '/v1/kb-segment': async (b) => {
      const s = b.segment || {};
      if (!s.id || !s.documentId) return { ok: false, error: 'segment.id + documentId required' };
      // Postgres text columns reject NUL bytes — strip them or the segment (evidence) is lost.
      if (typeof s.content === 'string') s.content = s.content.replace(/\u0000/g, '');
      await db().query(
        `INSERT INTO knowledge_segments (id, org_id, user_id, document_id, content, content_hash, segment_type,
           segment_index, previous_segment_id, metadata, vector_synced, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,false,coalesce($11::timestamptz,now()))
         ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash,
           segment_type=EXCLUDED.segment_type, segment_index=EXCLUDED.segment_index, metadata=EXCLUDED.metadata,
           vector_synced=false`,
        [s.id, org, s.userId || null, s.documentId, s.content || null, s.contentHash || null, s.segmentType || 'chunk',
         s.segmentIndex ?? 0, s.previousSegmentId || null, JSON.stringify(s.metadata || {}), s.createdAt || null]);
      if (Array.isArray(b.vector)) {
        const qr = await qFetch(`/collections/${qcoll}/points`, { method: 'PUT', body: JSON.stringify({
          points: [{ id: s.id, vector: b.vector, payload: { segment_id: s.id, document_id: s.documentId, org_id: org, user_id: s.userId || null, layer: 'segment', content: s.content || '' } }], wait: true }) });
        if (!qr.ok) return { ok: false, error: `qdrant seg upsert ${qr.status}` };
        await db().query('UPDATE knowledge_segments SET vector_synced=true WHERE id=$1', [s.id]);
      }
      return { ok: true };
    },

    '/v1/kb-recall': async (b) => {
      if (!Array.isArray(b.vector)) return { results: [] };
      const filter = { must: [{ key: 'org_id', match: { value: org } }, { key: 'layer', match: { value: 'segment' } }] };
      if (b.documentId) filter.must.push({ key: 'document_id', match: { value: b.documentId } });
      const qr = await qFetch(`/collections/${qcoll}/points/search`, { method: 'POST', body: JSON.stringify({
        vector: b.vector, limit: Math.min(b.limit || 20, 100), with_payload: true, score_threshold: b.scoreThreshold ?? 0.0, filter }) });
      if (!qr.ok) return { results: [] };
      const j = await qr.json();
      return { results: (j.result || []).map((h) => ({ segment_id: h.payload?.segment_id || h.id, document_id: h.payload?.document_id, content: h.payload?.content || '', score: h.score })) };
    },

    '/v1/kb-hydrate': async (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
      if (!ids.length) return { segments: [] };
      const { rows } = await db().query('SELECT id, document_id, content, content_hash, segment_type, segment_index, metadata, created_at FROM knowledge_segments WHERE org_id=$1 AND id = ANY($2)', [org, ids]);
      return { segments: rows };
    },

    // KB doc LIST (READ) — amr branch only (countByTags path; no pg-qdrant fallback here).
    '/v1/kb-docs': async (b) => {
      const limit = Math.min(Number(b.limit) || 20, 200);
      const offset = Math.max(Number(b.offset) || 0, 0);
      const { rows: docs } = await db().query(
        `SELECT id, filename, content_type, status, metadata, created_at
         FROM knowledge_documents
         WHERE org_id=$1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [org, limit, offset]);
      const { rows: totRow } = await db().query(
        'SELECT count(*)::int AS c FROM knowledge_documents WHERE org_id=$1 AND deleted_at IS NULL',
        [org]);
      const total = totRow[0]?.c || 0;
      const ids = docs.map((d) => d.id);
      let segMap = {};
      let proMap = {};
      if (ids.length) {
        const { rows: segs } = await db().query(
          'SELECT document_id, count(*)::int AS c FROM knowledge_segments WHERE org_id=$1 AND document_id = ANY($2::uuid[]) GROUP BY document_id',
          [org, ids]);
        for (const r of segs) segMap[r.document_id] = r.c;
        proMap = await countDerivedMemories(db(), org, ids);
      }
      const documents = docs.map((d) => ({
        id: d.id,
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
        filename: d.filename,
        content_type: d.content_type,
        status: d.status,
        metadata: d.metadata || {},
        segmentCount: segMap[d.id] || 0,
        promotedCount: proMap[d.id] || 0,
      }));
      return { documents, pagination: { total, limit, offset, hasMore: offset + limit < total } };
    },

    // KB doc DETAIL (READ) — amr branch only (findByTags path).
    '/v1/kb-doc-detail': async (b) => {
      if (!b.documentId) return { error: 'documentId required' };
      const { rows: docRows } = await db().query(
        'SELECT id, filename, content_type, status, metadata, created_at FROM knowledge_documents WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
        [b.documentId, org]);
      if (!docRows.length) return { error: 'not found' };
      const d = docRows[0];
      const { rows: segs } = await db().query(
        'SELECT id, document_id, content, content_hash, segment_type, segment_index, metadata, created_at FROM knowledge_segments WHERE document_id=$1 AND org_id=$2 ORDER BY segment_index ASC',
        [d.id, org]);
      const segments = segs.map((s) => ({
        id: s.id, documentId: s.document_id, content: s.content, contentHash: s.content_hash,
        segmentType: s.segment_type, segmentIndex: s.segment_index, metadata: s.metadata || {}, createdAt: s.created_at,
      }));
      let promotedMemories = [];
      {
        const tags = [`doc-id:${d.id}`, ...(d.filename ? [`filename:${d.filename}`] : [])];
        const mems = amr.findByTags(tags, 5000)
          .sort((a, b2) => new Date(b2.created_at) - new Date(a.created_at))
          .slice(0, 100);
        promotedMemories = mems.map((m) => ({
          id: m.id, title: m.title, content: m.content, memoryType: m.memory_type,
          importanceScore: m.confidence, tags: m.tags, createdAt: m.created_at,
          linkType: 'extracted-fact', confidence: m.confidence, excerpt: null,
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
      const derivedCounts = await countDerivedMemories(db(), org, [d.id]);
      return { document, segments, promotedMemories, segmentCount: segments.length, promotedCount: derivedCounts[d.id] ?? promotedMemories.length };
    },

    // KB doc DELETE + cascade — amr branch only (findByTags/remove path).
    '/v1/kb-doc-delete': async (b) => {
      let doc = null;
      if (b.document_id) {
        const { rows } = await db().query('SELECT id, filename FROM knowledge_documents WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.document_id, org]);
        doc = rows[0] || null;
      }
      if (!doc && b.filename) {
        const { rows } = await db().query('SELECT id, filename FROM knowledge_documents WHERE filename=$1 AND org_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', [b.filename, org]);
        doc = rows[0] || null;
      }
      if (!doc) return { ok: false, error: 'document not found', deleted_memories: 0 };

      const fnTag = `filename:${doc.filename}`;
      const idTag = `doc-id:${doc.id}`;
      const memIds = amr.findByTags([fnTag, idTag], 100000).map((m) => m.id);
      for (const id of memIds) amr.remove(id);
      if (memIds.length) {
        await db().query('UPDATE memories SET deleted_at=now(), is_latest=false WHERE id = ANY($1::uuid[]) AND org_id=$2 AND deleted_at IS NULL', [memIds, org]).catch(() => {});
        await qFetch(`/collections/${qcoll}/points/delete`, { method: 'POST', body: JSON.stringify({ points: memIds }) }).catch(() => {});
        await db().query('DELETE FROM relationships WHERE org_id=$1 AND (from_id = ANY($2::uuid[]) OR to_id = ANY($2::uuid[]))', [org, memIds]).catch(() => {});
      }

      const { rows: segRows } = await db().query('SELECT id FROM knowledge_segments WHERE org_id=$1 AND document_id=$2', [org, doc.id]);
      const segIds = segRows.map((r) => r.id);
      await db().query('DELETE FROM knowledge_segments WHERE org_id=$1 AND document_id=$2', [org, doc.id]);
      if (segIds.length) {
        await qFetch(`/collections/${qcoll}/points/delete`, { method: 'POST', body: JSON.stringify({ points: segIds }) }).catch(() => {});
      }

      await db().query('UPDATE knowledge_documents SET deleted_at=now() WHERE id=$1 AND org_id=$2', [doc.id, org]);
      return { ok: true, document_id: doc.id, deleted_memories: memIds.length, deleted_segments: segIds.length };
    },

    // ── Meetings (pure hm.* SQL) ────────────────────────────────────────────────────────────────
    '/v1/meeting-write': async (b) => {
      const m = b.meeting || {};
      const id = m.id || (await db().query('SELECT gen_random_uuid() AS id')).rows[0].id;
      const J = (v, def = '[]') => JSON.stringify(Array.isArray(v) ? v : (v != null && typeof v === 'object' && !Array.isArray(v) ? v : JSON.parse(def)));
      await db().query(
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
        [id, org, m.user_id || null, m.project_id || null, m.title || null, m.summary || null,
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
      const { rows } = await db().query('SELECT id, created_at FROM meetings WHERE id=$1', [id]);
      return { ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at };
    },

    '/v1/meeting-list': async (b) => {
      const f = b.filter || {};
      const limit = Math.min(Number(f.limit) || 40, 200);
      const { rows } = await db().query(
        `SELECT id, user_id, org_id, project_id, title, summary, language, duration_sec,
                multi_speaker, speaker_count, action_items, decisions, key_points, questions,
                segments, topics, sentiment, source_memory_id, participants, scope, created_at
         FROM meetings
         WHERE org_id=$1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT $2`,
        [org, limit]);
      return { meetings: rows };
    },

    '/v1/meeting-get': async (b) => {
      if (!b.id) return { meeting: null };
      const { rows } = await db().query(
        `SELECT id, user_id, org_id, project_id, title, summary, transcript, language,
                duration_sec, multi_speaker, speaker_count, action_items, decisions,
                key_points, questions, segments, topics, sentiment, notes, insights,
                participants, scope, intelligence, intelligence_status, source_memory_id, created_at
         FROM meetings WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
        [b.id, org]);
      return { meeting: rows[0] || null };
    },

    '/v1/meeting-delete': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      if (b.hard) {
        const r = await db().query('DELETE FROM meetings WHERE id=$1 AND org_id=$2', [b.id, org]);
        return { ok: true, deleted: r.rowCount };
      }
      const r = await db().query('UPDATE meetings SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, org]);
      return { ok: true, deleted: r.rowCount };
    },

    '/v1/meeting-patch': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      const fields = b.fields || {};
      const sets = []; const args = [b.id, org];
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
      const r = await db().query(
        `UPDATE meetings SET ${sets.join(', ')} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL RETURNING id`,
        args);
      return { ok: true, updated: r.rowCount };
    },

    // ── TARA call ledger (pure hm.* SQL) ────────────────────────────────────────────────────────
    '/v1/tara-call': async (b) => {
      const op = b.op || 'upsert';
      if (op === 'upsert') {
        const sid = b.session_id;
        if (!sid) return { ok: false, error: 'session_id required' };
        await db().query(
          `INSERT INTO tara_calls (org_id, user_id, session_id, status, metadata)
           VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (session_id) DO UPDATE SET
             status=$4, metadata=EXCLUDED.metadata`,
          [org, b.user_id || null, sid, b.status || 'active', JSON.stringify(b.metadata || {})]);
        const { rows } = await db().query('SELECT id FROM tara_calls WHERE session_id=$1 AND org_id=$2', [sid, org]);
        return { ok: true, id: rows[0]?.id };
      }
      if (op === 'get') {
        const sid = b.session_id;
        if (!sid) return { call: null };
        const { rows } = await db().query(
          'SELECT id, org_id, user_id, session_id, status, turn_count, prompt_tokens, completion_tokens, metadata, created_at FROM tara_calls WHERE session_id=$1 AND org_id=$2',
          [sid, org]);
        return { call: rows[0] || null };
      }
      if (op === 'update') {
        const sid = b.session_id;
        if (!sid) return { ok: false, error: 'session_id required' };
        const sets = []; const args = [sid, org];
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
        await db().query(`UPDATE tara_calls SET ${sets.join(', ')} WHERE session_id=$1 AND org_id=$2`, args);
        return { ok: true };
      }
      if (op === 'turn') {
        // One row per conversational turn: role='turn', content = JSON payload
        // {seq, user_text, agent_text, llm_ttfb_ms} — matches the FE pair shape
        // without a schema change.
        const sid = b.session_id;
        if (!sid) return { ok: false, error: 'session_id required' };
        const { rows } = await db().query('SELECT id FROM tara_calls WHERE session_id=$1 AND org_id=$2', [sid, org]);
        const callId = rows[0]?.id;
        if (!callId) return { ok: false, error: 'call not found' };
        await db().query(
          'INSERT INTO tara_turns (org_id, call_id, role, content) VALUES ($1,$2,$3,$4)',
          [org, callId, 'turn', JSON.stringify({
            seq: b.seq || null, user_text: b.user_text || '', agent_text: b.agent_text || '',
            llm_ttfb_ms: b.llm_ttfb_ms || null,
          })]);
        return { ok: true };
      }
      if (op === 'list') {
        const lim = Math.min(100, Number(b.limit) || 30);
        const { rows } = await db().query(
          `SELECT id, session_id, status, turn_count, prompt_tokens, completion_tokens, metadata, created_at
           FROM tara_calls WHERE org_id=$1 ORDER BY created_at DESC LIMIT $2`, [org, lim]);
        return { calls: rows };
      }
      if (op === 'detail') {
        const { rows } = await db().query(
          `SELECT id, session_id, status, turn_count, prompt_tokens, completion_tokens, metadata, created_at
           FROM tara_calls WHERE id=$1 AND org_id=$2`, [b.id, org]);
        if (!rows[0]) return { call: null, turns: [] };
        const t = await db().query(
          'SELECT content, created_at FROM tara_turns WHERE call_id=$1 AND org_id=$2 ORDER BY created_at ASC',
          [b.id, org]);
        return { call: rows[0], turns: t.rows };
      }
      return { ok: false, error: `unknown op: ${op}` };
    },
  };
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────
export async function dispatch(orgId, route, body) {
  if (!orgId) return { ok: false, error: 'orgId required' };
  const ctx = await getCtx(orgId);
  const h = ctx.routes[route];
  if (!h) return { ok: false, error: `unknown route ${route}` };
  return h(body || {});
}
