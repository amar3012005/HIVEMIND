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
      layer text NOT NULL DEFAULT 'memory',
      cognitive_layer_role text,
      confidence real,
      created_at timestamptz NOT NULL DEFAULT now(),
      valid_from timestamptz,
      valid_to timestamptz,
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
        (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
    );
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS primary_team_id uuid;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count int NOT NULL DEFAULT 0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS strength real NOT NULL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to timestamptz;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'memories'::regclass AND attname = 'content_tsv' AND NOT attisdropped)
         OR NOT EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE a.attrelid='memories'::regclass AND a.attname='content_tsv' AND pg_get_expr(d.adbin, d.adrelid) LIKE '%simple%') THEN
        ALTER TABLE memories DROP COLUMN IF EXISTS content_tsv;
        ALTER TABLE memories ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))) STORED;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS memories_org_idx     ON memories(org_id);
    CREATE INDEX IF NOT EXISTS memories_tags_idx    ON memories USING gin(tags);


    -- SPREADSHEET GRIDS (parity with hivemind.document_tables/_rows). These held tenant cell
    -- contents CENTRALLY only, and the ingestion skipped the write for .amr orgs behind a
    -- not-orgIsRemote guard, so a self-host tenant's XLSX/CSV grids were never stored at all.
    -- Removing that guard was NOT the fix: MNEME_MODE is dual, so wrapPrisma returns the real
    -- client and the write would have landed in CENTRAL Postgres referencing a document that only
    -- exists in this schema — an FK failure at best, tenant cell data in the wrong box at worst.
    CREATE TABLE IF NOT EXISTS document_tables (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      org_id uuid NOT NULL,
      user_id uuid,
      sheet text,
      table_index int NOT NULL DEFAULT 0,
      headers text[] NOT NULL DEFAULT '{}',
      row_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, table_index)
    );
    CREATE INDEX IF NOT EXISTS doctbl_org_idx ON document_tables(org_id);
    CREATE INDEX IF NOT EXISTS doctbl_doc_idx ON document_tables(document_id);

    CREATE TABLE IF NOT EXISTS document_table_rows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id uuid NOT NULL REFERENCES document_tables(id) ON DELETE CASCADE,
      org_id uuid NOT NULL,
      row_index int NOT NULL,
      cells jsonb NOT NULL DEFAULT '{}',
      UNIQUE (table_id, row_index)
    );
    CREATE INDEX IF NOT EXISTS doctblrow_tbl_idx ON document_table_rows(table_id);
    -- PROVENANCE (parity with the central hivemind schema). These two tables existed ONLY
    -- centrally, hard-FK'd to hivemind.memories / knowledge_documents / knowledge_segments, so
    -- for an .amr org whose memories live HERE the rows could never be written and the ingestion
    -- path skipped them behind its not-orgIsRemote guards. Consequence on screen: the Memories
    -- "Evidence - source segments and citations" tab was permanently empty for those tenants, and
    -- "which model extracted this claim" was unanswerable.
    -- Same columns and cascade semantics as central, FK'd to THIS schema's rows, so integrity is
    -- preserved rather than traded away by dropping the central FKs.
    CREATE TABLE IF NOT EXISTS memory_evidence_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      document_id uuid REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      segment_id uuid REFERENCES knowledge_segments(id) ON DELETE CASCADE,
      link_type text NOT NULL DEFAULT 'supports',
      confidence double precision,
      excerpt text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (memory_id, segment_id, link_type)
    );
    CREATE INDEX IF NOT EXISTS mevl_org_idx ON memory_evidence_links(org_id);
    CREATE INDEX IF NOT EXISTS mevl_mem_idx ON memory_evidence_links(memory_id);
    CREATE INDEX IF NOT EXISTS mevl_doc_idx ON memory_evidence_links(document_id);

    CREATE TABLE IF NOT EXISTS memory_derivations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      derivation_method text,
      derivation_agent text,
      confidence double precision,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mder_org_idx ON memory_derivations(org_id);
    CREATE INDEX IF NOT EXISTS mder_mem_idx ON memory_derivations(memory_id);
    CREATE INDEX IF NOT EXISTS memories_tsv_idx     ON memories USING gin(content_tsv);
    CREATE INDEX IF NOT EXISTS memories_latest_idx  ON memories(org_id, is_latest) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(org_id, created_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS memories_valid_idx   ON memories(org_id, valid_from, valid_to) WHERE deleted_at IS NULL;
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
      start_page int,
      end_page int,
      word_count int,
      content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED
    );
    CREATE INDEX IF NOT EXISTS kbseg_org_idx  ON knowledge_segments(org_id);
    CREATE INDEX IF NOT EXISTS kbseg_doc_idx  ON knowledge_segments(document_id);
    CREATE INDEX IF NOT EXISTS kbseg_tsv_idx  ON knowledge_segments USING gin(content_tsv);
    ALTER TABLE knowledge_segments ADD COLUMN IF NOT EXISTS start_page int;
    ALTER TABLE knowledge_segments ADD COLUMN IF NOT EXISTS end_page int;
    ALTER TABLE knowledge_segments ADD COLUMN IF NOT EXISTS word_count int;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'knowledge_segments'::regclass AND attname = 'content_tsv' AND NOT attisdropped)
         OR NOT EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE a.attrelid='knowledge_segments'::regclass AND a.attname='content_tsv' AND pg_get_expr(d.adbin, d.adrelid) LIKE '%simple%') THEN
        ALTER TABLE knowledge_segments DROP COLUMN IF EXISTS content_tsv;
        ALTER TABLE knowledge_segments ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS memories_tsv_idx ON memories USING gin(content_tsv);
    CREATE INDEX IF NOT EXISTS kbseg_tsv_idx ON knowledge_segments USING gin(content_tsv);
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
    CREATE TABLE IF NOT EXISTS meeting_segments (
      session_id uuid NOT NULL,
      org_id uuid NOT NULL,
      user_id uuid NOT NULL,
      idx int NOT NULL,
      text text NOT NULL,
      speakers jsonb,
      start_ms int,
      end_ms int,
      meeting_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, idx)
    );
    CREATE INDEX IF NOT EXISTS meeting_segments_owner_idx ON meeting_segments(org_id, user_id, session_id);
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

function lexicalTsQuery(text) {
  const tokens = [...new Set((String(text || '').normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [])
    .map((token) => token.toLocaleLowerCase())
    .filter((token) => /\p{N}/u.test(token) || token.length >= 3))];
  return tokens.join(' | ');
}
function appendDocumentAccess(conds, args, alias, org, access = {}) {
  const userId = access.userId || access.user_id || null;
  if (!userId) { conds.push('FALSE'); return; }
  const add = (value) => { args.push(value); return `$${args.length}`; };
  const tags = `${alias}.metadata->'tags'`;
  const orgTag = `scope-key:org:${org}`;
  const organizationTag = 'scope-key:organization';
  const personalTag = `scope-key:personal:${userId}`;
  const projectIds = access.projectId ? [access.projectId] : (access.accessContext?.projectIds || []);
  const teamIds = access.accessContext?.teamIds || [];
  const projectTags = projectIds.map((id) => `scope-key:project:${id}`);
  const teamTags = teamIds.map((id) => `scope-key:team:${id}`);
  const scope = access.scopeFilter || null;
  if (scope === 'organization') {
    const orgScope = add(orgTag); const legacy = add(organizationTag);
    conds.push(`(${tags} ? ${orgScope} OR ${tags} ? ${legacy})`);
  } else if (scope === 'project') {
    if (!projectTags.length) { conds.push('FALSE'); return; }
    conds.push(`${tags} ?| ${add(projectTags)}::text[]`);
  } else if (scope === 'team') {
    if (!teamTags.length) { conds.push('FALSE'); return; }
    conds.push(`${tags} ?| ${add(teamTags)}::text[]`);
  } else if (scope === 'personal') {
    conds.push(`(${alias}.user_id=${add(userId)}::uuid OR ${tags} ? ${add(personalTag)})`);
  } else {
    const user = add(userId); const orgScope = add(orgTag); const legacy = add(organizationTag); const personal = add(personalTag);
    const clauses = [`${alias}.user_id=${user}::uuid`, `${tags} ? ${orgScope}`, `${tags} ? ${legacy}`, `${tags} ? ${personal}`];
    if (projectTags.length) clauses.push(`${tags} ?| ${add(projectTags)}::text[]`);
    if (teamTags.length) clauses.push(`${tags} ?| ${add(teamTags)}::text[]`);
    conds.push(`(${clauses.join(' OR ')})`);
  }
}

// Ported verbatim.
function payloadOf(org, rec) {
  return {
    memory_id: rec.id, org_id: org, user_id: rec.userId || null,
    content: rec.content || '', title: rec.title || null, tags: rec.tags || [],
    memory_type: rec.memoryType || null, layer: rec.layer || 'memory',
    cognitive_layer_role: rec.cognitiveLayerRole || null,
    is_latest: rec.isLatest ?? true, created_at: rec.createdAt || null,
    document_date: rec.documentDate || null, valid_from: rec.validFrom || null,
    valid_to: rec.validTo || null,
  };
}

// ── per-org context, LRU-capped ─────────────────────────────────────────────────────────────────
// Map preserves insertion order; re-inserting on access implements LRU eviction (evict oldest key).
const ctxCache = new Map();

/**
 * Compact every shard that is ALREADY OPEN in this process (Phase A maintenance).
 *
 * Deliberately does not open a shard just to compact it: opening takes the per-open
 * shard lock and would collide with live traffic for no benefit — a slot nobody has
 * touched is not accruing garbage. Callers sweep periodically; whatever is hot gets
 * compacted, the rest waits until it is next opened.
 *
 * @param {(orgId:string)=>boolean} [allow] optional per-org gate (e.g. "only if snapshotted")
 * @returns {{attempted:number,compacted:number,failed:number,reclaimed:number}}
 */
/**
 * Backfill the SQL mirror (`memories`) from the shard for one org.
 *
 * WHY: `/v1/lexical` — the lexical half of hybrid recall — runs Postgres FTS over the
 * `memories` mirror, NOT over the shard. `/v1/write` mirrors each new record, but any
 * memory written before that mirror existed was never backfilled. Measured on prod:
 * 6 of 7 amr_embedded orgs had ZERO mirror rows while their shards held real data
 * (38, 24, 12 memories), so those tenants were silently running VECTOR-ONLY recall —
 * the same silent-partial shape as the Qdrant embedding drift the embed-reconciler fixes.
 *
 * SAFETY: strictly additive. `ON CONFLICT (id) DO NOTHING` — it can only insert rows the
 * mirror is missing, never overwrite a live row, so it cannot clobber the provenance the
 * two-phase write path carefully merges. Bounded per call.
 *
 * @returns {Promise<{shard:number,existing:number,inserted:number,failed:number}>}
 */
export async function backfillSqlMirror(orgId, { max = 2000, logger = console } = {}) {
  const out = { shard: 0, existing: 0, inserted: 0, failed: 0 };
  const ctx = await getCtx(orgId);
  if (!ctx?.amr || !pg) return out;

  // Stream the shard so a large slot never materialises in JS heap.
  const records = [];
  let from = 0;
  for (;;) {
    const page = ctx.amr.store.recordsPage(from, 500);
    for (const row of (page.rows || [])) {
      try {
        const r = JSON.parse(row.text);
        // MEMORY LAYER ONLY. The shard also holds evidence (layer 1) and cognitive
        // (layer 2) records — evidence arrives via the kb-segment dual-write. Mirroring
        // those into `memories` would file evidence segments AS memories, and the lexical
        // lane reads that table, so they would surface in recall as first-class memories.
        // The mirror exists to back the memory lane; evidence has its own store.
        if (r?.id && (r.layer || 'memory') === 'memory') records.push(r);
      } catch { /* skip unparseable slot */ }
    }
    if (page.nextSlot === 4294967295 || records.length >= max) break;
    from = page.nextSlot;
  }
  out.shard = records.length;
  if (!records.length) return out;

  const { rows: have } = await pg.query('SELECT id::text FROM memories WHERE org_id=$1', [ctx.org]);
  const known = new Set(have.map((h) => h.id));
  out.existing = known.size;

  for (const r of records) {
    if (known.has(String(r.id))) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await pg.query(
        `INSERT INTO memories (id, org_id, user_id, content, title, tags, memory_type, is_latest, layer,
           cognitive_layer_role, confidence, created_at, valid_from, valid_to, document_date, project,
           project_ids, metadata, scope, primary_team_id, recall_count, strength, vector_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::timestamptz,now()),$13,$14,$15,$16,$17,
                 $18::jsonb,$19,$20::uuid,coalesce($21::int,0),coalesce($22::real,1.0),true)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, ctx.org, r.user_id || null, r.content || null, r.title || null, r.tags || [],
          r.memory_type || null, r.is_latest ?? true, r.layer || 'memory', r.cognitive_layer_role || null,
          r.confidence ?? null, r.created_at || null, r.valid_from || null, r.valid_to || null,
          r.document_date || null, r.project || null, r.project_ids || [],
          JSON.stringify(r.metadata || {}), r.scope || null, r.primary_team_id || null,
          r.recall_count ?? 0, r.strength ?? 1.0],
      );
      out.inserted += 1;
    } catch (e) {
      out.failed += 1;
      if (out.failed <= 3) logger.warn?.(`[mirror-backfill] org=${String(orgId).slice(0, 8)} id=${r.id}: ${e.message}`);
    }
  }
  return out;
}

/**
 * Backfill EVIDENCE into the shard from Postgres + Qdrant (B4 step 1b).
 *
 * The kb-segment dual-write only fires on NEW ingests, so a slot starts with none of
 * its historical evidence — and the shard cannot be read-compared against the current
 * lane, let alone serve it, until it holds the same segments. This is the mirror image
 * of backfillSqlMirror (which pushed shard→Postgres for memories): here Postgres holds
 * the content and Qdrant the vector, and both go into the slot.
 *
 * SAFETY: additive and idempotent. amr.write() upserts by id, segments already in the
 * shard are skipped, and NO read path consults shard evidence yet beyond the
 * access-gated union. Postgres and Qdrant remain the source of truth.
 *
 * @returns {Promise<{pg:number,already:number,written:number,novector:number,failed:number}>}
 */
export async function backfillEvidenceToShard(orgId, { max = 500, logger = console } = {}) {
  const out = { pg: 0, already: 0, written: 0, novector: 0, failed: 0 };
  const ctx = await getCtx(orgId);
  if (!ctx?.amr || !pg) return out;

  const { rows } = await pg.query(
    `SELECT s.id::text AS id, s.document_id::text AS document_id, s.user_id::text AS user_id,
            s.content, s.segment_index, s.segment_type, s.start_page, s.end_page, s.word_count,
            s.metadata, s.created_at,
            coalesce(d.metadata->>'title', d.filename) AS doc_title
       FROM knowledge_segments s JOIN knowledge_documents d ON d.id = s.document_id
      WHERE s.org_id=$1 AND d.deleted_at IS NULL
      ORDER BY s.created_at DESC LIMIT $2`, [ctx.org, max]);
  out.pg = rows.length;
  if (!rows.length) return out;

  // Only fetch vectors for segments the shard is actually missing.
  const missing = rows.filter((r) => {
    try { return ctx.amr.store.findById(r.id) < 0; } catch { return true; }
  });
  out.already = rows.length - missing.length;
  if (!missing.length) return out;

  // Qdrant holds the evidence vectors; pull them in one retrieve rather than per-row.
  const vectors = new Map();
  try {
    const qr = await qFetch(`/collections/${ctx.qcoll}/points`, {
      method: 'POST',
      body: JSON.stringify({ ids: missing.map((m) => m.id), with_vector: true, with_payload: false }),
    });
    if (qr.ok) {
      const j = await qr.json();
      for (const p of (j?.result || [])) {
        const v = Array.isArray(p.vector) ? p.vector : p.vector?.default;
        if (Array.isArray(v)) vectors.set(String(p.id), v);
      }
    }
  } catch (e) {
    logger.warn?.(`[evidence-backfill] vector fetch failed org=${String(orgId).slice(0, 8)}: ${e.message}`);
  }

  for (const r of missing) {
    const vec = vectors.get(String(r.id));
    // A segment with no vector would be dead weight in the slot: recallLayer could never
    // return it. Skip rather than write an unsearchable record — the embed reconciler
    // owns re-embedding, and the next pass will pick it up once a vector exists.
    if (!vec) { out.novector += 1; continue; }
    try {
      const meta = r.metadata || {};
      ctx.amr.write({
        id: r.id,
        userId: r.user_id || null,
        content: r.content || null,
        title: meta.heading || r.doc_title || null,
        layer: 'evidence',
        memoryType: 'evidence_segment',
        createdAt: r.created_at || null,
        tags: [`doc-id:${r.document_id}`],
        metadata: {
          document_id: r.document_id,
          segment_index: r.segment_index ?? 0,
          segment_type: r.segment_type || 'chunk',
          start_page: r.start_page ?? null,
          end_page: r.end_page ?? null,
          word_count: r.word_count ?? null,
          heading: meta.heading ?? null,
          heading_path: meta.heading_path ?? null,
        },
      }, Float32Array.from(vec));
      out.written += 1;
    } catch (e) {
      out.failed += 1;
      if (out.failed <= 3) logger.warn?.(`[evidence-backfill] seg=${r.id}: ${e.message}`);
    }
  }
  return out;
}

/**
 * READ-COMPARE the two evidence lanes (B4 step 2) — measurement only, writes nothing.
 *
 * The cutover discipline that proved storage parity 1.00 originally is dual-write →
 * read-compare on REAL embeddings → cutover. This is the middle step: for a sample of
 * evidence segments it issues the SAME query vector to both lanes —
 *   A) Qdrant `points/search` filtered to layer 'segment' (what /v1/kb-recall serves today)
 *   B) the shard's own `recallLayer(..., layer 1)` (what it would serve after cutover)
 * — and reports top-k overlap.
 *
 * Runs INSIDE hm-core on purpose: the shard takes a per-open lock, so an external probe
 * process cannot read it while the server holds it. This is the only place the
 * comparison can honestly be made.
 *
 * Overlap near 1.0 across a real sample is the evidence needed to flip reads. Anything
 * lower is a reason NOT to, and says so in the log rather than being averaged away.
 *
 * @returns {Promise<{samples:number,qdrant:number,shard:number,overlap:number}|null>}
 */
export async function readCompareEvidence(orgId, { samples = 5, topK = 10, logger = console } = {}) {
  const ctx = await getCtx(orgId);
  if (!ctx?.amr || !pg) return null;

  const { rows } = await pg.query(
    `SELECT id::text FROM knowledge_segments WHERE org_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [ctx.org, samples],
  );
  if (!rows.length) return null;

  let qTotal = 0; let sTotal = 0; let overlapSum = 0; let compared = 0;
  for (const r of rows) {
    let vec = null;
    try {
      const qr = await qFetch(`/collections/${ctx.qcoll}/points`, {
        method: 'POST',
        body: JSON.stringify({ ids: [r.id], with_vector: true, with_payload: false }),
      });
      if (qr.ok) {
        const j = await qr.json();
        const p = (j?.result || [])[0];
        vec = Array.isArray(p?.vector) ? p.vector : p?.vector?.default;
      }
    } catch { /* sample skipped below */ }
    if (!Array.isArray(vec)) continue;

    // Lane A — Qdrant (today's lane)
    let qIds = [];
    try {
      const qr = await qFetch(`/collections/${ctx.qcoll}/points/search`, {
        method: 'POST',
        body: JSON.stringify({
          vector: vec, limit: topK, with_payload: true,
          filter: { must: [{ key: 'org_id', match: { value: ctx.org } }, { key: 'layer', match: { value: 'segment' } }] },
        }),
      });
      if (qr.ok) {
        const j = await qr.json();
        qIds = (j?.result || []).map((h) => String(h.payload?.segment_id || h.id)).filter(Boolean);
      }
    } catch { /* lane A empty */ }

    // Lane B — the shard
    let sIds = [];
    try {
      sIds = ctx.amr.recall(Float32Array.from(vec), topK, { layer: 'evidence' }).map((h) => String(h.id));
    } catch { /* lane B empty */ }

    if (!qIds.length && !sIds.length) continue;
    const inter = sIds.filter((id) => qIds.includes(id)).length;
    const denom = Math.max(qIds.length, 1);
    overlapSum += inter / denom;
    qTotal += qIds.length; sTotal += sIds.length; compared += 1;
  }

  if (!compared) return null;
  const result = { samples: compared, qdrant: qTotal, shard: sTotal, overlap: Number((overlapSum / compared).toFixed(3)) };
  logger.info?.(`[evidence-read-compare] org=${String(orgId).slice(0, 8)} samples=${result.samples} `
    + `qdrant_hits=${result.qdrant} shard_hits=${result.shard} top${topK}_overlap=${result.overlap}`
    + `${result.overlap < 0.9 ? '  ← BELOW 0.9, do NOT cut over' : ''}`);
  return result;
}

const lastCompacted = new Map(); // orgId -> epoch ms of the last successful compaction

/**
 * Compact the given slots, newest-garbage-first, bounded per pass.
 *
 * The first cut only compacted shards ALREADY in ctxCache, on the theory that a slot
 * nobody opens is not accruing garbage. True for ONGOING growth — but it left HISTORIC
 * garbage stranded forever, and in practice it fired ZERO times in an hour of production:
 * whatever was open at the tick simply never lined up. A maintenance job that never runs
 * is worse than none, because it reads as covered.
 *
 * So: open through getCtx — the SAME single-flighted, LRU-managed path live traffic uses,
 * so this cannot double-open a shard or race the per-open lock. Only slots that were
 * snapshotted this pass are eligible (never compact unbacked data), at most `max` per
 * pass, and each slot at most once per `cooldownMs`, so write amplification stays bounded.
 *
 * @param {string[]} orgIds  slots eligible for compaction (already snapshotted)
 * @returns {Promise<{attempted:number,compacted:number,failed:number,reclaimed:number,skipped:number}>}
 */
export async function compactShards(orgIds = [], {
  max = Number(process.env.MNEME_COMPACT_MAX_PER_PASS || 2),
  cooldownMs = Number(process.env.MNEME_COMPACT_COOLDOWN_MS || 24 * 60 * 60 * 1000),
  logger = console,
} = {}) {
  const out = { attempted: 0, compacted: 0, failed: 0, reclaimed: 0, skipped: 0 };
  const now = Date.now();
  // Already-open slots first — they cost nothing to reach.
  const open = []; const cold = [];
  for (const o of orgIds) (ctxCache.has(o) ? open : cold).push(o);

  for (const orgId of [...open, ...cold]) {
    if (out.attempted >= max) break;
    if (now - (lastCompacted.get(orgId) || 0) < cooldownMs) { out.skipped += 1; continue; }
    out.attempted += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const ctx = await getCtx(orgId);
      if (typeof ctx?.amr?.compact !== 'function') { out.failed += 1; continue; }
      out.reclaimed += ctx.amr.compact() || 0;
      lastCompacted.set(orgId, now);
      out.compacted += 1;
    } catch (e) {
      out.failed += 1;
      logger.warn?.(`[shard-compact] org=${String(orgId).slice(0, 8)} failed: ${e.message}`);
    }
  }
  return out;
}

// SINGLE-FLIGHT, keyed by org. The shard lock is per-OPEN, not per-process, so two
// `MnemeStore.open()` calls for the same shard collide even inside ONE process — and the loser
// reports "shard is locked by another process", which reads like a competing container and is not.
// Verified: `fuser` showed a single PID holding every shard.lock, and its parent was hm-core's own
// main PID.
//
// The race was structural: getCtx checked `ctxCache`, then `await`ed ensureSchema() and
// ensureQdrant() BEFORE constructing the store and populating the cache. Two concurrent requests for
// the same org therefore both missed the cache, both awaited, and both constructed. The startup
// sweep does exactly that — it fans stats/list across every org at once — which is why the warnings
// always arrived in one burst on the same handful of orgs. (Not LRU eviction: MAX_OPEN is 64 and
// there are 13 orgs, so nothing is ever evicted.)
// Memoising the in-flight PROMISE — not just the result — makes concurrent callers share one open.
const ctxPending = new Map();

async function getCtx(orgId) {
  if (ctxCache.has(orgId)) {
    const c = ctxCache.get(orgId);
    ctxCache.delete(orgId); ctxCache.set(orgId, c); // bump to MRU
    return c;
  }
  const inflight = ctxPending.get(orgId);
  if (inflight) return inflight;
  const p = openCtx(orgId);
  ctxPending.set(orgId, p);
  try {
    return await p;
  } finally {
    // Cleared on success AND failure: a failed open must never be cached as a poison entry, or one
    // transient collision would make that org unreadable for the life of the process.
    ctxPending.delete(orgId);
  }
}

async function openCtx(orgId) {
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
      // SQL MIRROR — ported verbatim from the external agent's /v1/write.
      // The embedded agent wrote ONLY to the AMR shard, while the external agent also inserts
      // into hm.memories. Same endpoint, different persistence — which is why hm.memories held
      // 17 rows for byod and ZERO for all 7 amr_embedded orgs, why provenance rows could not
      // satisfy their memory_id FK, and why embedded lexical had to use amr.lexical() while byod
      // could use content_tsv. The shard stays the recall index; this row is the relational
      // mirror everything else joins against.
      // NON-FATAL BY DESIGN: the shard write above has already succeeded, so a SQL failure must
      // never cost a memory. Worst case we are back to today's behaviour (no provenance), which
      // is why this is safe to add to a live write path.
      try {
  await db().query(
        `INSERT INTO memories (id, org_id, user_id, content, title, tags, memory_type, is_latest, layer,
           cognitive_layer_role, confidence, created_at, valid_from, valid_to, document_date, project, project_ids,
           metadata, scope, primary_team_id, recall_count, strength, vector_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::timestamptz,now()),$13,$14,$15,$16,$17,$18::jsonb,$19,$20::uuid,coalesce($21::int,0),coalesce($22::real,1.0),false)
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
           valid_to=COALESCE(EXCLUDED.valid_to, memories.valid_to),
           document_date=COALESCE(EXCLUDED.document_date, memories.document_date),
           project=EXCLUDED.project, project_ids=EXCLUDED.project_ids,
           metadata=(memories.metadata || EXCLUDED.metadata),
           -- recall reinforcement is owned by /v1/bump-recall + decay, NOT the
           -- ingest upsert — keep the existing values so a re-ingest / 2-phase
           -- vector write never resets a memory's accumulated recall_count/strength.
           recall_count=memories.recall_count, strength=memories.strength,
           vector_synced=false, deleted_at=NULL`,
        [r.id, org, r.userId || null, r.content || null, r.title || null, r.tags || [], r.memoryType || null,
         r.isLatest ?? true, r.layer || 'memory', r.cognitiveLayerRole || null, r.confidence ?? null,
         r.createdAt || null, r.validFrom || null, r.validTo || null, r.documentDate || null, r.project || null,
         r.projectIds || [], JSON.stringify(r.metadata || {}), r.scope || null, r.primaryTeamId || null,
         r.recallCount ?? 0, r.strength ?? 1.0]
      );
      } catch (e) {
        console.warn(`[embedded-agent] memories mirror failed id=${r.id} org=${org}: ${e.message} `
          + `— memory IS in the shard and recallable; provenance/lexical parity is degraded for it`);
      }
      for (const rel of (b.rels || [])) {
        if (!rel?.fromId || !rel?.toId) continue;
        amr.addEdge(rel);

        // SQL MIRROR for edges, same reason as the memories mirror in /v1/write: the external agent
        // inserts into relationships while this one only called amr.addEdge, so hm.relationships held
        // ZERO rows globally while the shard reported 43 edges for a single org. Anything that reads
        // relationships from SQL (relations-summary, central joins, the byod-shaped /v1/stats) saw
        // nothing for amr_embedded. Non-fatal: the shard edge is already written above.
        try {
          await db().query(
            `INSERT INTO relationships (id, org_id, from_id, to_id, type, confidence) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, confidence=EXCLUDED.confidence`,
            [rel.id, org, rel.fromId, rel.toId, rel.type || 'Mentions', rel.confidence ?? 1]);
        } catch (e) {
          console.warn(`[embedded-agent] relationship mirror failed ${rel.fromId}->${rel.toId} org=${org}: ${e.message}`);
        }
      }
      return { ok: true };
    },
    '/v1/recall': async (b) => Array.isArray(b.vector)
      ? { results: amr.recall(b.vector, b.limit || 10, b.filter || {}) } : { results: [] },
    // MEMORY LEXICAL: Postgres FTS on the SQL mirror, identical to the external agent.
    // This used to be `amr.lexical()` (the shard's own text index) purely because the embedded agent
    // had no SQL rows to search — so the two .amr modes ranked text differently from each other AND
    // from hybrid, with no justification. Now that /v1/write mirrors to hm.memories the same query
    // works here, and it also GAINS the filters the shard index cannot express: layer, must_not.layer,
    // known_at, and the valid_at temporal snapshot.
    '/v1/lexical': async (b) => {
      if (!b.text) return { results: [] };
      const f = b.filter || {};
      const tsQuery = lexicalTsQuery(b.text);
      if (!tsQuery) return { results: [] };
      const conds = ['org_id=$1', 'deleted_at IS NULL', "content_tsv @@ to_tsquery('simple',$2)"];
      const args = [org, tsQuery];
      if (f.is_latest !== undefined) { args.push(!!f.is_latest); conds.push(`is_latest=$${args.length}`); }
      if (f.layer) { args.push(f.layer); conds.push(`layer=$${args.length}`); }
      if (f.must_not?.layer) { args.push(f.must_not.layer); conds.push(`layer<>$${args.length}`); }
      const snapshot = f.valid_at || null;
      if (f.known_at) { args.push(f.known_at); conds.push(`created_at<=$${args.length}::timestamptz`); }
      if (snapshot) {
        args.push(snapshot); conds.push(`(valid_from IS NULL OR valid_from<=$${args.length}::timestamptz)`);
        args.push(snapshot); conds.push(`(valid_to IS NULL OR valid_to>$${args.length}::timestamptz)`);
      }
      const lim = Number(b.limit) || 10;
      args.push(lim);
      const { rows } = await db().query(
        `SELECT id, content, title, tags, memory_type, layer, cognitive_layer_role, is_latest, created_at, user_id,
                project, project_ids, scope, primary_team_id, document_date, valid_from, valid_to,
                ts_rank(content_tsv, to_tsquery('simple',$2)) AS score
         FROM memories WHERE ${conds.join(' AND ')} ORDER BY score DESC LIMIT $${args.length}`, args);
      const results = rows.map((m) => ({ id: m.id, score: Number(m.score) || 0, payload: {
        memory_id: m.id, org_id: org, user_id: m.user_id, content: m.content, title: m.title, tags: m.tags,
        project: m.project || null, project_ids: m.project_ids || [], scope: m.scope || null,
        primary_team_id: m.primary_team_id || null,
        memory_type: m.memory_type, layer: m.layer, cognitive_layer_role: m.cognitive_layer_role,
        is_latest: m.is_latest, created_at: m.created_at, document_date: m.document_date,
        valid_from: m.valid_from, valid_to: m.valid_to } }));

      // ── IN-SHARD LEXICAL, UNIONED ────────────────────────────────────────────
      // The Postgres FTS above is the better-ranked lane, so it goes first. But it
      // reads the SQL mirror, and a slot whose mirror is thin or absent gets NOTHING
      // from it — which is exactly how 6 of 7 .amr orgs ended up silently running
      // vector-only recall. The shard's own lane needs no mirror, so union it in to
      // top up the candidate pool. Strictly additive: dedup by id and never drop a
      // Postgres hit, so this can only widen the pool the reranker then scores.
      try {
        const seen = new Set(results.map((r) => r.id));
        for (const h of amr.lexical(b.text, f, lim)) {
          if (results.length >= lim) break;
          if (!h?.id || seen.has(h.id)) continue;
          seen.add(h.id);
          const p = h.payload || {};
          results.push({ id: h.id, score: h.score, payload: {
            memory_id: h.id, org_id: org, user_id: p.user_id || null, content: p.content, title: p.title,
            tags: p.tags || [], project: p.project || null, project_ids: p.project_ids || [],
            scope: p.scope || null, primary_team_id: p.primary_team_id || null,
            memory_type: p.memory_type, layer: p.layer, cognitive_layer_role: p.cognitive_layer_role,
            is_latest: p.is_latest, created_at: p.created_at, document_date: p.document_date,
            valid_from: p.valid_from, valid_to: p.valid_to } });
        }
      } catch (e) {
        console.warn(`[embedded-agent] shard lexical lane failed org=${org}: ${e.message} — Postgres results still returned`);
      }
      return { results };
    },

    // Hydrate full rows by id (content stays on-box until requested).
    '/v1/hydrate': async (b) => ({ memories: Array.isArray(b.ids) && b.ids.length ? amr.hydrate(b.ids) : [] }),
    '/v1/list': async (b) => amr.list(b.filter || {}, b.cursor, b.limit || 100, Number(b.offset) || 0),
    '/v1/stats': async (b) => amr.stats(b.filter || {}),
    '/v1/graph': async (b) => amr.graph(b.filter || {}, b.limit || 500),
    '/v1/edge': async (b) => {
      const rel = b.rel;
      if (rel?.fromId && rel?.toId) {
        amr.addEdge(rel);

        // SQL MIRROR for edges, same reason as the memories mirror in /v1/write: the external agent
        // inserts into relationships while this one only called amr.addEdge, so hm.relationships held
        // ZERO rows globally while the shard reported 43 edges for a single org. Anything that reads
        // relationships from SQL (relations-summary, central joins, the byod-shaped /v1/stats) saw
        // nothing for amr_embedded. Non-fatal: the shard edge is already written above.
        try {
          await db().query(
            `INSERT INTO relationships (id, org_id, from_id, to_id, type, confidence) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, confidence=EXCLUDED.confidence`,
            [rel.id, org, rel.fromId, rel.toId, rel.type || 'Mentions', rel.confidence ?? 1]);
        } catch (e) {
          console.warn(`[embedded-agent] relationship mirror failed ${rel.fromId}->${rel.toId} org=${org}: ${e.message}`);
        }
      }
      return { ok: true };
    },
    '/v1/update-tags': async (b) => {
      if (b.id && Array.isArray(b.tags)) {
        amr.updateTags(b.id, b.tags);
        // SQL mirror (see /v1/write). Non-fatal: the shard is authoritative for recall; this keeps
        // hm.memories from going STALE, which for anything reading SQL is worse than no mirror.
        try { await db().query('UPDATE memories SET tags=$2 WHERE id=$1 AND org_id=$3', [b.id, b.tags, org]); }
        catch (e) { console.warn(`[embedded-agent] tag mirror failed id=${b.id}: ${e.message}`); }
      }
      return { ok: true };
    },
    '/v1/bump-recall': async (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
      const bumped = ids.length ? amr.bumpRecall(ids) : 0;
        // SQL mirror (see /v1/write). Non-fatal: the shard is authoritative for recall; this keeps
        // hm.memories from going STALE, which for anything reading SQL is worse than no mirror.
      if (ids.length) {
        try {
          await db().query(
            `UPDATE memories SET recall_count = recall_count + 1,
               strength = LEAST(1.0, COALESCE(strength, 1.0) + 0.05), last_accessed_at = now()
             WHERE id = ANY($1::uuid[]) AND org_id = $2::uuid AND deleted_at IS NULL`, [ids, org]);
        } catch (e) { console.warn(`[embedded-agent] bump-recall mirror failed: ${e.message}`); }
      }
      return { ok: true, bumped };
    },
    '/v1/update': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      amr.patchUpdate(b.id, b);
      // SQL mirror (see /v1/write). Non-fatal; keeps hm.memories from drifting from the shard.
      try {
        const sets = []; const args = [b.id, org];
        if (Array.isArray(b.tags)) { args.push(b.tags); sets.push(`tags=$${args.length}`); }
        if (b.is_latest !== undefined) { args.push(!!b.is_latest); sets.push(`is_latest=$${args.length}`); }
        if (b.memory_type !== undefined) { args.push(b.memory_type); sets.push(`memory_type=$${args.length}`); }
        if (b.valid_to !== undefined) { args.push(b.valid_to); sets.push(`valid_to=$${args.length}::timestamptz`); }
        if (sets.length) await db().query(`UPDATE memories SET ${sets.join(', ')} WHERE id=$1 AND org_id=$2`, args);
      } catch (e) { console.warn(`[embedded-agent] patch mirror failed id=${b.id}: ${e.message}`); }
      return { ok: true };
    },
    '/v1/delete': async (b) => {
      if (!b.id) return { ok: false, error: 'id required' };
      const deleted = amr.remove(b.id) ? 1 : 0;
      await db().query('UPDATE memories SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, org]).catch(() => {});
      // Edges and provenance must go with the memory. The external agent already did this; the
      // embedded one did not, which was harmless only while edges were shard-only. Now that they
      // are mirrored to SQL, skipping it leaves ORPHAN relationships and provenance behind on every
      // single-memory delete — and the memory row is SOFT-deleted, so no cascade rescues it.
      await db().query('DELETE FROM relationships WHERE org_id=$1 AND (from_id=$2 OR to_id=$2)', [org, b.id]).catch(() => {});
      await db().query('DELETE FROM memory_derivations WHERE org_id=$1 AND memory_id=$2', [org, b.id]).catch(() => {});
      await db().query('DELETE FROM memory_evidence_links WHERE org_id=$1 AND memory_id=$2', [org, b.id]).catch(() => {});
      qFetch(`/collections/${qcoll}/points/delete`, { method: 'POST', body: JSON.stringify({ points: [b.id] }) }).catch(() => {});
      return { ok: true, deleted };
    },
    // Clear MEMORIES only, leaving the KB (documents + segments) intact. /v1/purge is the
    // whole-org erase; this is the narrower one, and it existed only on the external agent —
    // so an amr_embedded org calling it got nothing back while a byod org was cleared. The
    // two agents implement the same 31-endpoint API and must not diverge on which half of a
    // destructive pair they support.
    '/v1/clear-memories': async () => {
      const shardDeleted = amr.purge();
      const m = await db().query('DELETE FROM memories WHERE org_id=$1', [org]).catch(() => ({ rowCount: 0 }));
      await db().query('DELETE FROM relationships WHERE org_id=$1', [org]).catch(() => {});
      // Drop and recreate the collection rather than deleting points one by one: the KB
      // segments live in the SAME collection, so they are re-embedded by the reconciler,
      // which is exactly what the external agent's clear-memories does.
      await qFetch(`/collections/${qcoll}`, { method: 'DELETE' }).catch(() => {});
      await ensureQdrant(qcoll).catch(() => {});
      return { ok: true, deleted: m.rowCount, shard_deleted: shardDeleted };
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
         d.checksum || null, JSON.stringify({ ...(d.metadata || {}), title: d.title || d.filename || null, tags: d.tags || d.metadata?.tags || [] }), d.createdAt || null]);
      return { ok: true };
    },

    '/v1/kb-segment': async (b) => {
      const s = b.segment || {};
      if (!s.id || !s.documentId) return { ok: false, error: 'segment.id + documentId required' };
      // Postgres text columns reject NUL bytes — strip them or the segment (evidence) is lost.
      if (typeof s.content === 'string') s.content = s.content.replace(/\u0000/g, '');
      await db().query(
      `INSERT INTO knowledge_segments (id, org_id, user_id, document_id, content, content_hash, segment_type,
         segment_index, previous_segment_id, metadata, start_page, end_page, word_count, vector_synced, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,false,coalesce($14::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash,
         segment_type=EXCLUDED.segment_type, segment_index=EXCLUDED.segment_index, metadata=EXCLUDED.metadata,
         start_page=EXCLUDED.start_page, end_page=EXCLUDED.end_page, word_count=EXCLUDED.word_count, vector_synced=false`,
      [s.id, org, s.userId || null, s.documentId, s.content || null, s.contentHash || null, s.segmentType || 'chunk',
         s.segmentIndex ?? 0, s.previousSegmentId || null, JSON.stringify(s.metadata || {}), s.startPage || null,
         s.endPage || null, s.wordCount || null, s.createdAt || null]);
      if (Array.isArray(b.vector)) {
        const qr = await qFetch(`/collections/${qcoll}/points`, { method: 'PUT', body: JSON.stringify({
          points: [{ id: s.id, vector: b.vector, payload: { segment_id: s.id, document_id: s.documentId, org_id: org, user_id: s.userId || null, layer: 'segment', content: s.content || '' } }], wait: true }) });
        if (!qr.ok) return { ok: false, error: `qdrant seg upsert ${qr.status}` };
        await db().query('UPDATE knowledge_segments SET vector_synced=true WHERE id=$1', [s.id]);
      }

      // ── B4 step 1: DUAL-WRITE evidence into the shard (layer 1) ──────────────
      // Evidence currently lives OUTSIDE the slot — content in Postgres, vector in
      // Qdrant — so an `.amr` tenant is not actually self-contained: half the engine
      // is external. The shard has supported this the whole time (insertLayered with
      // layer=1, recallLayer to read it back); nothing wrote to it.
      //
      // This is deliberately a DUAL-write, not a cutover: Postgres and Qdrant remain
      // the source of truth and every read path is untouched, so this cannot change
      // recall behaviour. It exists so the shard accumulates the evidence needed to
      // read-compare against the current lane before anything is switched over.
      // Carries the doc/scope fields the eventual shard-side hydrate + access check
      // will need, so the record is self-sufficient when reads do move.
      //
      // amr.write() is an UPSERT (findById → merge), so a re-ingest of the same
      // segment id updates in place rather than appending a duplicate. Non-fatal by
      // design: the authoritative writes above already succeeded.
      if (String(process.env.MNEME_EVIDENCE_DUAL_WRITE ?? 'true').toLowerCase() !== 'false') {
        try {
          amr.write({
            id: s.id,
            userId: s.userId || null,
            content: s.content || null,
            title: s.metadata?.heading || s.metadata?.heading_path || null,
            layer: 'evidence',
            memoryType: 'evidence_segment',
            scope: s.metadata?.scope || null,
            createdAt: s.createdAt || null,
            tags: [`doc-id:${s.documentId}`],
            metadata: {
              document_id: s.documentId,
              segment_index: s.segmentIndex ?? 0,
              segment_type: s.segmentType || 'chunk',
              start_page: s.startPage ?? null,
              end_page: s.endPage ?? null,
              word_count: s.wordCount ?? null,
              heading: s.metadata?.heading ?? null,
              heading_path: s.metadata?.heading_path ?? null,
            },
          }, Array.isArray(b.vector) ? Float32Array.from(b.vector) : null);
        } catch (e) {
          console.warn(`[kb-segment] shard dual-write failed seg=${s.id} org=${org}: ${e.message} `
            + '— evidence IS in Postgres/Qdrant and fully searchable; only the shard copy is behind');
        }
      }
      return { ok: true };
    },

    '/v1/kb-recall': async (b) => {
      if (!Array.isArray(b.vector)) return { results: [] };
      const filter = { must: [{ key: 'org_id', match: { value: org } }, { key: 'layer', match: { value: 'segment' } }] };
      const documentIds = Array.isArray(b.documentIds) ? [...new Set(b.documentIds.filter(Boolean))] : [];
      if (b.documentId) filter.must.push({ key: 'document_id', match: { value: b.documentId } });
      else if (documentIds.length) filter.must.push({ key: 'document_id', match: { any: documentIds } });
      const qr = await qFetch(`/collections/${qcoll}/points/search`, { method: 'POST', body: JSON.stringify({
        vector: b.vector, limit: Number(b.limit) || 20, with_payload: true, score_threshold: b.scoreThreshold ?? 0.0, filter }) });
      if (!qr.ok) return { results: [] };
      const j = await qr.json();
      const hitIds = (j.result || []).map((h) => h.payload?.segment_id || h.id).filter(Boolean);
      if (!hitIds.length) return { results: [] };
      const conds = ['s.org_id=$1', 'd.org_id=$1', 'd.deleted_at IS NULL', 's.id = ANY($2::uuid[])'];
      const args = [org, hitIds];
      appendDocumentAccess(conds, args, 'd', org, b.access);
      const { rows } = await db().query(
        `SELECT s.id AS segment_id, s.document_id, s.content, coalesce(d.metadata->>'title', d.filename) AS title,
                s.start_page, s.end_page, s.word_count, s.segment_type, s.segment_index, s.metadata
           FROM knowledge_segments s JOIN knowledge_documents d ON d.id=s.document_id
          WHERE ${conds.join(' AND ')}`,
        args,
      );
      const allowed = new Map(rows.map((row) => [row.segment_id, row]));
      return { results: (j.result || []).map((h) => {
        const id = h.payload?.segment_id || h.id;
        const row = allowed.get(id);
        return row ? { ...row, score: h.score } : null;
      }).filter(Boolean) };
    },

    '/v1/kb-lexical': async (b) => {
      const tsQuery = lexicalTsQuery(b.text);
      if (!tsQuery) return { results: [] };
      const f = b.filter || {};
      const conds = ['s.org_id=$1', 'd.org_id=$1', 'd.deleted_at IS NULL', "s.content_tsv @@ to_tsquery('simple',$2)"];
      const args = [org, tsQuery];
      const documentIds = Array.isArray(f.documentIds) ? [...new Set(f.documentIds.filter(Boolean))] : [];
      if (f.documentId) { args.push(f.documentId); conds.push(`s.document_id=$${args.length}::uuid`); }
      else if (documentIds.length) { args.push(documentIds); conds.push(`s.document_id = ANY($${args.length}::uuid[])`); }
      appendDocumentAccess(conds, args, 'd', org, f.access);
      args.push(Number(b.limit) || 20);
      const { rows } = await db().query(
        `SELECT s.id AS segment_id, s.document_id, s.content,
                ts_rank(s.content_tsv, to_tsquery('simple',$2)) AS score,
                coalesce(d.metadata->>'title', d.filename) AS title,
                s.start_page, s.end_page, s.word_count, s.segment_type, s.segment_index, s.metadata
           FROM knowledge_segments s JOIN knowledge_documents d ON d.id=s.document_id
          WHERE ${conds.join(' AND ')} ORDER BY score DESC, s.segment_index ASC LIMIT $${args.length}`,
        args,
      );
      const results = rows.map((row) => ({ ...row, score: Number(row.score) || 0 }));

      // ── IN-SHARD EVIDENCE LEXICAL, ACCESS-GATED ──────────────────────────────
      // Evidence is dual-written into the shard (layer 'evidence'), so the slot can
      // answer this lane without the SQL mirror. But evidence access is NOT a property
      // of the segment — it is gated by scope-key tags on the parent DOCUMENT
      // (appendDocumentAccess). Returning shard hits directly would bypass that check
      // and leak segments across scopes.
      //
      // So we do not reimplement the scope rules against the shard record: we take the
      // shard's candidate ids and ask Postgres which of their documents this caller may
      // actually see, using THE SAME appendDocumentAccess. Correct by construction, and
      // it fails closed (that helper pushes FALSE when there is no userId).
      try {
        const lim = Number(b.limit) || 20;
        if (results.length < lim) {
          const seen = new Set(results.map((r) => r.segment_id));
          const shardHits = amr.lexical(b.text, { layer: 'evidence' }, lim * 2)
            .filter((h) => h?.id && !seen.has(h.id));
          if (shardHits.length) {
            const docIds = [...new Set(shardHits.map((h) => h.payload?.metadata?.document_id).filter(Boolean))];
            let allowed = new Set();
            if (docIds.length) {
              const aConds = ['d.org_id=$1', 'd.deleted_at IS NULL', 'd.id = ANY($2::uuid[])'];
              const aArgs = [org, docIds];
              appendDocumentAccess(aConds, aArgs, 'd', org, f.access);
              const { rows: ok } = await db().query(
                `SELECT d.id::text AS id FROM knowledge_documents d WHERE ${aConds.join(' AND ')}`, aArgs);
              allowed = new Set(ok.map((r) => r.id));
            }
            for (const h of shardHits) {
              if (results.length >= lim) break;
              const m = h.payload?.metadata || {};
              if (!m.document_id || !allowed.has(String(m.document_id))) continue; // fails closed
              results.push({
                segment_id: h.id,
                document_id: m.document_id,
                content: h.payload?.content ?? null,
                score: h.score,
                title: h.payload?.title ?? m.heading ?? null,
                start_page: m.start_page ?? null,
                end_page: m.end_page ?? null,
                word_count: m.word_count ?? null,
                segment_type: m.segment_type ?? 'chunk',
                segment_index: m.segment_index ?? 0,
                metadata: m,
              });
            }
          }
        }
      } catch (e) {
        console.warn(`[embedded-agent] shard evidence lexical failed org=${org}: ${e.message} — Postgres results still returned`);
      }
      return { results };
    },

    '/v1/kb-hydrate': async (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
      if (!ids.length) return { segments: [] };
      const conds = ['s.org_id=$1', 'd.org_id=$1', 'd.deleted_at IS NULL', 's.id = ANY($2::uuid[])'];
      const args = [org, ids];
      appendDocumentAccess(conds, args, 'd', org, b.access);
      const { rows } = await db().query(
        `SELECT s.id, s.document_id, s.content, s.content_hash, s.segment_type, s.segment_index, s.metadata,
                s.start_page, s.end_page, s.word_count, s.created_at,
                coalesce(d.metadata->>'title', d.filename) AS title
           FROM knowledge_segments s JOIN knowledge_documents d ON d.id=s.document_id
          WHERE ${conds.join(' AND ')}`,
        args,
      );
      return { segments: rows };
    },

    // KB doc LIST (READ) — amr branch only (countByTags path; no pg-qdrant fallback here).
    '/v1/kb-docs': async (b) => {
      const limit = Math.min(Number(b.limit) || 20, 200);
      const offset = Math.max(Number(b.offset) || 0, 0);
      const conds = ['d.org_id=$1', 'd.deleted_at IS NULL'];
      const args = [org];
      appendDocumentAccess(conds, args, 'd', org, b.access);
      args.push(limit); const limitArg = `$${args.length}`;
      args.push(offset); const offsetArg = `$${args.length}`;
      const { rows: docs } = await db().query(
        `SELECT d.id, d.user_id, d.filename, d.content_type, d.status, d.metadata, d.created_at
         FROM knowledge_documents d WHERE ${conds.join(' AND ')}
         ORDER BY d.created_at DESC LIMIT ${limitArg} OFFSET ${offsetArg}`,
        args);
      const { rows: totRow } = await db().query(
        `SELECT count(*)::int AS c FROM knowledge_documents d WHERE ${conds.join(' AND ')}`,
        args.slice(0, -2));
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
        userId: d.user_id,
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
      const detailConds = ['d.id=$1', 'd.org_id=$2', 'd.deleted_at IS NULL'];
      const detailArgs = [b.documentId, org];
      appendDocumentAccess(detailConds, detailArgs, 'd', org, b.access);
      const { rows: docRows } = await db().query(
        `SELECT d.id, d.filename, d.content_type, d.status, d.metadata, d.created_at FROM knowledge_documents d WHERE ${detailConds.join(' AND ')}`,
        detailArgs);
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
  // Provenance writes (parity with central). Batched upsert-ish inserts; ON CONFLICT DO NOTHING so
    // a re-ingest of the same document is idempotent, matching skipDuplicates on the central path.
    // Spreadsheet grids for a remote org. Mirrors the central documentTable/documentTableRow upsert.
      '/v1/kb-tables': async (b) => {
      const docId = b.document_id;
      const tables = Array.isArray(b.tables) ? b.tables : [];
      if (!docId || !tables.length) return { ok: true, tables: 0, rows: 0 };
      // The document must already exist HERE. On a second ingest pass the skip-unchanged path can carry
      // a document id that was never persisted to this agent, and the FK then throws
      // "document_tables_document_id_fkey" — an alarming error for a benign re-run. Say what actually
      // happened instead.
      const { rows: _dchk } = await db().query('SELECT 1 FROM knowledge_documents WHERE id=$1 AND org_id=$2', [docId, org]);
      if (!_dchk.length) {
        console.warn(`[kb-tables] document ${docId} is not on this agent — grids NOT stored (likely a re-ingest pass whose document row was skipped)`);
        return { ok: false, error: 'document_not_found', tables: 0, rows: 0 };
      }
      let nt = 0, nr = 0;
      for (let ti = 0; ti < tables.length; ti++) {
        const t = tables[ti] || {};
        const headers = (Array.isArray(t.headers) ? t.headers : []).map((h) => String(h ?? '').slice(0, 300));
        const rows = Array.isArray(t.rows) ? t.rows : [];
        if (!rows.length) continue;
        try {
          const { rows: ins } = await db().query(
            `INSERT INTO document_tables (document_id, org_id, user_id, sheet, table_index, headers, row_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (document_id, table_index) DO UPDATE SET headers=EXCLUDED.headers, row_count=EXCLUDED.row_count
             RETURNING id`,
            [docId, org, b.user_id || null, t.sheet ? String(t.sheet).slice(0, 255) : null, ti, headers, rows.length]);
          const tableId = ins[0]?.id;
          if (!tableId) continue;
          nt += 1;
          for (let ri = 0; ri < Math.min(rows.length, 20000); ri++) {
            const arr = Array.isArray(rows[ri]) ? rows[ri] : [rows[ri]];
            const cells = {};
            arr.forEach((v, ci) => {
              const key = headers[ci] && String(headers[ci]).trim() ? String(headers[ci]).trim() : `col_${ci}`;
              cells[key] = v === null || v === undefined ? null : String(v).slice(0, 2000);
            });
            await db().query(
              `INSERT INTO document_table_rows (table_id, org_id, row_index, cells) VALUES ($1,$2,$3,$4::jsonb)
               ON CONFLICT (table_id, row_index) DO UPDATE SET cells=EXCLUDED.cells`,
              [tableId, org, ri, JSON.stringify(cells)]);
            nr += 1;
          }
        } catch (e) { console.warn(`[kb-tables] table ${ti} failed doc=${docId}: ${e.message}`); }
      }
      return { ok: true, tables: nt, rows: nr };
    },

    '/v1/kb-provenance': async (b) => {
      const links = Array.isArray(b.evidence_links) ? b.evidence_links : [];
      const ders = Array.isArray(b.derivations) ? b.derivations : [];
      let linked = 0, derived = 0;
      for (const l of links) {
        if (!l?.memory_id) continue;
        try {
          await db().query(
            `INSERT INTO memory_evidence_links (org_id, memory_id, document_id, segment_id, link_type, confidence, excerpt)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (memory_id, segment_id, link_type) DO NOTHING`,
            [org, l.memory_id, l.document_id || null, l.segment_id || null, l.link_type || 'supports',
             l.confidence ?? null, l.excerpt || null]);
          linked += 1;
        } catch (e) { console.warn(`[kb-provenance] link failed mem=${l.memory_id}: ${e.message}`); }
      }
      for (const d of ders) {
        if (!d?.memory_id) continue;
        try {
          await db().query(
            `INSERT INTO memory_derivations (org_id, memory_id, derivation_method, derivation_agent, confidence, metadata)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [org, d.memory_id, d.derivation_method || null, d.derivation_agent || null,
             d.confidence ?? null, JSON.stringify(d.metadata || {})]);
          derived += 1;
        } catch (e) { console.warn(`[kb-provenance] derivation failed mem=${d.memory_id}: ${e.message}`); }
      }
      return { ok: true, linked, derived };
    },

    // Read back the evidence for ONE memory, shaped like the central getMemoryEvidence result so the
    // FE's Evidence tab renders identically regardless of storage mode.
      '/v1/memory-evidence': async (b) => {
      if (!b.memory_id) return { evidenceLinks: [] };
      const { rows } = await db().query(
        `SELECT l.link_type, l.confidence, l.excerpt, l.segment_id, l.document_id,
                s.content, s.segment_type, s.segment_index, s.start_page, s.end_page, s.metadata,
                coalesce(d.metadata->>'title', d.filename) AS document_title
           FROM memory_evidence_links l
           LEFT JOIN knowledge_segments s ON s.id = l.segment_id
           LEFT JOIN knowledge_documents d ON d.id = l.document_id
          WHERE l.org_id=$1 AND l.memory_id=$2
          ORDER BY s.segment_index ASC NULLS LAST`,
        [org, b.memory_id]);
      return { evidenceLinks: rows.map((r) => ({
        type: 'segment', linkType: r.link_type, confidence: r.confidence, excerpt: r.excerpt,
        segment: r.segment_id ? {
          id: r.segment_id, content: r.content, segmentType: r.segment_type,
          segmentIndex: r.segment_index, startPage: r.start_page, endPage: r.end_page, metadata: r.metadata,
        } : null,
        document: r.document_id ? { id: r.document_id, title: r.document_title } : null,
      })) };
    },

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
      // Provenance is the SECOND source of truth for "which memories came from this
      // document". Finding them only by the filename:/doc-id: tags missed any memory that
      // does not carry them (measured: 24 of 27 derivations cleaned, 4 left behind), so union
      // in whatever the evidence links themselves claim for this document.
      try {
        const { rows: _pv } = await db().query(
          'SELECT DISTINCT memory_id FROM memory_evidence_links WHERE org_id=$1 AND document_id=$2',
          [org, doc.id]);
        for (const r of _pv) if (r.memory_id && !memIds.includes(r.memory_id)) memIds.push(r.memory_id);
      } catch { /* table may not exist on an older agent — the tag path still applies */ }
      for (const id of memIds) amr.remove(id);
      if (memIds.length) {
        await db().query('UPDATE memories SET deleted_at=now(), is_latest=false WHERE id = ANY($1::uuid[]) AND org_id=$2 AND deleted_at IS NULL', [memIds, org]).catch(() => {});
        await qFetch(`/collections/${qcoll}/points/delete`, { method: 'POST', body: JSON.stringify({ points: memIds }) }).catch(() => {});
        await db().query('DELETE FROM relationships WHERE org_id=$1 AND (from_id = ANY($2::uuid[]) OR to_id = ANY($2::uuid[]))', [org, memIds]).catch(() => {});
        // Provenance must go with the memory. The memory row is SOFT-deleted (deleted_at), so the
        // ON DELETE CASCADE on memory_id never fires — measured after a real document delete:
        // evidence links vanished (they also cascade off the hard-deleted segments) but 25
        // derivations were left behind, pointing at soft-deleted memories and unreadable forever.
        await db().query('DELETE FROM memory_derivations WHERE org_id=$1 AND memory_id = ANY($2::uuid[])', [org, memIds]).catch(() => {});
        await db().query('DELETE FROM memory_evidence_links WHERE org_id=$1 AND memory_id = ANY($2::uuid[])', [org, memIds]).catch(() => {});
      }

      const { rows: segRows } = await db().query('SELECT id FROM knowledge_segments WHERE org_id=$1 AND document_id=$2', [org, doc.id]);
      const segIds = segRows.map((r) => r.id);
      await db().query('DELETE FROM knowledge_segments WHERE org_id=$1 AND document_id=$2', [org, doc.id]);
      // Grids too. document_tables FKs knowledge_documents ON DELETE CASCADE, but the document row
      // is SOFT-deleted here (deleted_at), so the cascade never fires — measured after a real
      // delete: docs=0 but tables=1 / tablerows=3 left behind. This is the THIRD time tonight that
      // adding a table meant its LIFECYCLE also had to be routed (derivations, evidence links, now
      // grids). document_table_rows cascades off document_tables, which IS a hard delete.
      await db().query('DELETE FROM document_tables WHERE org_id=$1 AND document_id=$2', [org, doc.id]).catch(() => {});
      if (segIds.length) {
        await qFetch(`/collections/${qcoll}/points/delete`, { method: 'POST', body: JSON.stringify({ points: segIds }) }).catch(() => {});
      }

      await db().query('UPDATE knowledge_documents SET deleted_at=now() WHERE id=$1 AND org_id=$2', [doc.id, org]);
      return { ok: true, document_id: doc.id, deleted_memories: memIds.length, deleted_segments: segIds.length };
    },

    // ── Meetings (pure hm.* SQL) ────────────────────────────────────────────────────────────────
    '/v1/meeting-write': async (b) => {
      const m = b.meeting || {};
      if (m.session_id) {
        const existing = await db().query(
          'SELECT meeting_id FROM meeting_segments WHERE session_id=$1 AND org_id=$2 AND user_id=$3 AND meeting_id IS NOT NULL LIMIT 1',
          [m.session_id, org, m.user_id]);
        if (existing.rows[0]?.meeting_id) return { ok: true, id: existing.rows[0].meeting_id, existing: true };
      }
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
      if (m.session_id && m.user_id) {
        await db().query(
          'UPDATE meeting_segments SET meeting_id=$1 WHERE session_id=$2 AND org_id=$3 AND user_id=$4 AND meeting_id IS NULL',
          [id, m.session_id, org, m.user_id]);
      }
      return { ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at };
    },

    '/v1/meeting-segment-write': async (b) => {
      const s = b.segment || {};
      if (!s.session_id || !s.user_id || !Number.isInteger(s.idx) || !String(s.text || '').trim()) return { ok: false, error: 'invalid segment' };
      await db().query(
        `INSERT INTO meeting_segments (session_id,org_id,user_id,idx,text,speakers,start_ms,end_ms)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
         ON CONFLICT (session_id,idx) DO UPDATE SET text=EXCLUDED.text,speakers=EXCLUDED.speakers,start_ms=EXCLUDED.start_ms,end_ms=EXCLUDED.end_ms`,
        [s.session_id, org, s.user_id, s.idx, String(s.text).slice(0, 200000), s.speakers ? JSON.stringify(s.speakers) : null, s.start_ms ?? null, s.end_ms ?? null]);
      return { ok: true };
    },

    '/v1/meeting-segment-list': async (b) => {
      const f = b.filter || {};
      if (!f.session_id || !f.user_id) return { segments: [] };
      const { rows } = await db().query(
        'SELECT idx,text,speakers,start_ms,end_ms,meeting_id FROM meeting_segments WHERE session_id=$1 AND org_id=$2 AND user_id=$3 ORDER BY idx',
        [f.session_id, org, f.user_id]);
      return { segments: rows };
    },

    '/v1/meeting-list': async (b) => {
      const f = b.filter || {};
      const limit = Math.min(Number(f.limit) || 40, 5000);
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
      await db().query('DELETE FROM meeting_segments WHERE meeting_id=$1 AND org_id=$2', [b.id, org]);
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
