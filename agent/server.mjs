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

const ORG = process.env.ORG_ID || die('ORG_ID required');
const TOKEN = process.env.AGENT_TOKEN || die('AGENT_TOKEN required');
const PORT = Number(process.env.AGENT_PORT || 8787);
const DIM = Number(process.env.MNEME_DIM || 1024);
const SCHEMA_VERSION = 1; // bump when the agent's local schema changes
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const QCOLL = `org_${ORG}`.replace(/[^a-zA-Z0-9]/g, '_');

function die(m) { console.error(`[hm-agent] ${m}`); process.exit(1); }

// ── Postgres (rows + lexical) ───────────────────────────────────────────────────────────────────
const { default: Pg } = await import('pg');
const pg = new Pg.Pool({ connectionString: process.env.DATABASE_URL || die('DATABASE_URL required'), max: 8 });

// The agent's OWN schema — minimal, plain types, no enums, no FKs to global tables. content_tsv is a
// generated column so lexical search is always in sync. Idempotent; created on boot.
async function ensureSchema() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS memories (
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
    if (f.created_after) { args.push(f.created_after); conds.push(`created_at >= $${args.length}::timestamptz`); }
    if (b.cursor) { args.push(b.cursor); conds.push(`created_at < $${args.length}::timestamptz`); }
    args.push(Math.min(b.limit || 100, 500));
    const { rows } = await pg.query(
      `SELECT * FROM memories WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    const cursor = rows.length ? rows[rows.length - 1].created_at : null;
    return { memories: rows, cursor };
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
    await qFetch(`/collections/${QCOLL}`, { method: 'DELETE' }).catch(() => {});
    await ensureQdrant();
    return { ok: true, deleted: m.rowCount };
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
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  if (req.headers['x-org-id'] && req.headers['x-org-id'] !== ORG) return send(res, 403, { error: 'org mismatch' });
  try { send(res, 200, await routes[req.url](await readBody(req))); }
  catch (e) { console.error(`[hm-agent] ${req.url} failed:`, e.message); send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`[hm-agent] listening :${PORT} (org ${ORG})`));
