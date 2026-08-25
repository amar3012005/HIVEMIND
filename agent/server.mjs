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
import { timingSafeEqual, randomUUID } from 'node:crypto';

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
const SCHEMA_VERSION = 2; // v2 adds valid_to and indexed bi-temporal eligibility.
const PROTOCOL_VERSION = 'memory-box.v1';
const AGENT_RELEASE = process.env.AGENT_RELEASE || 'unknown';
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const QCOLL = `org_${ORG}`.replace(/[^a-zA-Z0-9]/g, '_');

function die(m) { console.error(`[hm-agent] ${m}`); process.exit(1); }

function sanitizeJson(value) {
  if (typeof value === 'string') return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [sanitizeJson(key), sanitizeJson(item)]));
  }
  return value;
}

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
      valid_to timestamptz,
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
        (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
    );
    -- Self-host parity (added after the table shipped): idempotent backfill for
    -- existing boxes so scope/team + recall-reinforcement round-trip like central.
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS primary_team_id uuid;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count int NOT NULL DEFAULT 0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS strength real NOT NULL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to timestamptz;
    -- Existing agents created the generated vectors with the English stemmer.
    -- Rebuild only when the stored expression differs; document text is untouched.
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
    CREATE INDEX IF NOT EXISTS memories_tsv_idx ON memories USING gin(content_tsv);
    CREATE INDEX IF NOT EXISTS kbseg_tsv_idx ON knowledge_segments USING gin(content_tsv);
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
    CREATE TABLE IF NOT EXISTS meeting_sessions (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      user_id uuid NOT NULL,
      status varchar(24) NOT NULL DEFAULT 'recording',
      consent_recorded boolean NOT NULL DEFAULT false,
      expected_segment_ms int NOT NULL DEFAULT 600000,
      expected_segments int,
      finalized_meeting_id uuid,
      failure_code varchar(80),
      failure_detail text,
      finalization_payload jsonb,
      finalization_attempts int NOT NULL DEFAULT 0,
      finalization_next_attempt_at timestamptz,
      finalization_lease_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finalized_at timestamptz
    );
    ALTER TABLE meeting_sessions
      ADD COLUMN IF NOT EXISTS finalization_payload jsonb,
      ADD COLUMN IF NOT EXISTS finalization_attempts int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS finalization_next_attempt_at timestamptz,
      ADD COLUMN IF NOT EXISTS finalization_lease_expires_at timestamptz;
    CREATE INDEX IF NOT EXISTS meeting_sessions_retry_idx ON meeting_sessions(status,finalization_next_attempt_at,updated_at);
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
    -- Raw recorder chunks remain in the tenant DB. Core is compute-only: it
    -- claims a bounded bytea into memory for STT and settles this retry lease.
    CREATE TABLE IF NOT EXISTS meeting_audio_segments (
      session_id uuid NOT NULL,
      org_id uuid NOT NULL,
      user_id uuid NOT NULL,
      idx int NOT NULL,
      checksum varchar(64) NOT NULL,
      content_type varchar(160) NOT NULL,
      audio bytea NOT NULL,
      start_ms int,
      end_ms int,
      status varchar(16) NOT NULL DEFAULT 'queued',
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      lease_expires_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, idx)
    );
    CREATE INDEX IF NOT EXISTS meeting_audio_segments_retry_idx ON meeting_audio_segments(status, next_attempt_at, created_at);
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

async function countDerivedMemoriesByDocumentIds(docIds = []) {
  const ids = Array.from(new Set((docIds || []).filter(Boolean)));
  if (!ids.length) return {};
  const tagIds = ids.map((id) => `doc-id:${id}`);
  const { rows } = await pg.query(
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
    [ORG, ids, tagIds],
  );
  return Object.fromEntries((rows || []).map((row) => [row.document_id, Number(row.c) || 0]));
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
  if (Array.isArray(f.must)) {
    const must = f.must.filter((condition) => condition?.key !== 'org_id');
    must.unshift({ key: 'org_id', match: { value: ORG } });
    return {
      ...f,
      must,
      ...(Array.isArray(f.must_not) ? { must_not: f.must_not } : {}),
    };
  }
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
    project: rec.project || null, project_ids: rec.projectIds || [], scope: rec.scope || null,
    primary_team_id: rec.primaryTeamId || null,
    memory_type: rec.memoryType || null, layer: rec.layer || 'memory',
    cognitive_layer_role: rec.cognitiveLayerRole || null,
    is_latest: rec.isLatest ?? true, created_at: rec.createdAt || null,
    document_date: rec.documentDate || null, valid_from: rec.validFrom || null,
    valid_to: rec.validTo || null,
  };
}

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
// OR semantics preserve a literal match when natural-language filler differs.
// `simple` keeps the same lexemes for German and every other tenant language.
function lexicalTsQuery(text) {
  const tokens = [...new Set((String(text || '').normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [])
    .map((token) => token.toLocaleLowerCase())
    .filter((token) => /\p{N}/u.test(token) || token.length >= 3))];
  return tokens.join(' | ');
}
function appendDocumentAccess(conds, args, alias, access = {}) {
  const userId = access.userId || access.user_id || null;
  if (!userId) { conds.push('FALSE'); return; }
  const add = (value) => { args.push(value); return `$${args.length}`; };
  const tags = `${alias}.metadata->'tags'`;
  const orgTag = `scope-key:org:${ORG}`;
  const organizationTag = 'scope-key:organization';
  const personalTag = `scope-key:personal:${userId}`;
  const projectIds = access.projectId ? [access.projectId] : (access.accessContext?.projectIds || []);
  const teamIds = access.accessContext?.teamIds || [];
  const projectTags = projectIds.map((id) => `scope-key:project:${id}`);
  const teamTags = teamIds.map((id) => `scope-key:team:${id}`);
  const scope = access.scopeFilter || null;
  if (scope === 'organization') {
    const org = add(orgTag); const legacy = add(organizationTag);
    conds.push(`(${tags} ? ${org} OR ${tags} ? ${legacy})`);
  } else if (scope === 'project') {
    if (!projectTags.length) { conds.push('FALSE'); return; }
    conds.push(`${tags} ?| ${add(projectTags)}::text[]`);
  } else if (scope === 'team') {
    if (!teamTags.length) { conds.push('FALSE'); return; }
    conds.push(`${tags} ?| ${add(teamTags)}::text[]`);
  } else if (scope === 'personal') {
    conds.push(`(${alias}.user_id=${add(userId)}::uuid OR ${tags} ? ${add(personalTag)})`);
  } else {
    const user = add(userId); const org = add(orgTag); const legacy = add(organizationTag); const personal = add(personalTag);
    const clauses = [`${alias}.user_id=${user}::uuid`, `${tags} ? ${org}`, `${tags} ? ${legacy}`, `${tags} ? ${personal}`];
    if (projectTags.length) clauses.push(`${tags} ?| ${add(projectTags)}::text[]`);
    if (teamTags.length) clauses.push(`${tags} ?| ${add(teamTags)}::text[]`);
    conds.push(`(${clauses.join(' OR ')})`);
  }
}
const MAX_BODY_BYTES = 1024 * 1024; // vectors fit comfortably; unbounded bodies are a remote DoS risk.
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } });
  req.on('error', reject);
});

const routes = {
  '/v1/capabilities': async () => ({
    ok: true,
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    agent_release: AGENT_RELEASE,
    storage_mode: 'byod_postgres_qdrant',
    vector_dimension: DIM,
    capabilities: [
      'memory.recall',
      'memory.lexical',
      'memory.hydrate',
      'evidence.recall',
      'evidence.lexical',
      'evidence.hydrate',
      'graph.read',
      'relationship.read',
      'vector.status',
      'vector.pending',
      'vector.repair',
    ],
  }),

  // Upsert one finished memory: row (idempotent by id) + vector. Atomic-ish: insert row synced=false,
  // upsert vector (wait), then mark synced. If the vector fails the route returns non-ok so the caller retries.
  '/v1/write': async (b) => {
    const r = b.record || {};
    if (!r.id) return { ok: false, error: 'record.id required' };
    await pg.query(
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
         -- A metadata/relationship replay without a vector must not mark a
         -- previously indexed row unsynced. Only a new vector-bearing write
         -- begins the two-phase vector replacement.
         vector_synced=CASE WHEN $23::boolean THEN false ELSE memories.vector_synced END,
         deleted_at=NULL`,
      [r.id, ORG, r.userId || null, r.content || null, r.title || null, r.tags || [], r.memoryType || null,
       r.isLatest ?? true, r.layer || 'memory', r.cognitiveLayerRole || null, r.confidence ?? null,
       r.createdAt || null, r.validFrom || null, r.validTo || null, r.documentDate || null, r.project || null,
       r.projectIds || [], JSON.stringify(r.metadata || {}), r.scope || null, r.primaryTeamId || null,
       r.recallCount ?? 0, r.strength ?? 1.0, Array.isArray(b.vector)]
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
        // id has no DEFAULT and is NOT NULL — a caller that omits it (the engine's remote-org edge
        // path did, until fixed) must not 500 the whole write; generate one server-side.
        await pg.query(
          `INSERT INTO relationships (id, org_id, from_id, to_id, type, confidence) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, confidence=EXCLUDED.confidence`,
          [rel.id || randomUUID(), ORG, rel.fromId, rel.toId, rel.type || 'Mentions', rel.confidence ?? 1]
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
    const tsQuery = lexicalTsQuery(b.text);
    if (!tsQuery) return { results: [] };
    const conds = ['org_id=$1', 'deleted_at IS NULL', "content_tsv @@ to_tsquery('simple',$2)"];
    const args = [ORG, tsQuery];
    if (f.is_latest !== undefined) { args.push(!!f.is_latest); conds.push(`is_latest=$${args.length}`); }
    if (f.layer) { args.push(f.layer); conds.push(`layer=$${args.length}`); }
    if (f.must_not?.layer) { args.push(f.must_not.layer); conds.push(`layer<>$${args.length}`); }
    const snapshot = f.valid_at || null;
    if (f.known_at) { args.push(f.known_at); conds.push(`created_at<=$${args.length}::timestamptz`); }
    if (snapshot) {
      args.push(snapshot); conds.push(`(valid_from IS NULL OR valid_from<=$${args.length}::timestamptz)`);
      args.push(snapshot); conds.push(`(valid_to IS NULL OR valid_to>$${args.length}::timestamptz)`);
    }
    args.push(b.limit || 10);
    const { rows } = await pg.query(
      `SELECT id, content, title, tags, memory_type, layer, cognitive_layer_role, is_latest, created_at, user_id,
              project, project_ids, scope, primary_team_id, document_date, valid_from, valid_to,
              ts_rank(content_tsv, to_tsquery('simple',$2)) AS score
       FROM memories WHERE ${conds.join(' AND ')} ORDER BY score DESC LIMIT $${args.length}`, args);
    return { results: rows.map((m) => ({ id: m.id, score: Number(m.score) || 0, payload: {
      memory_id: m.id, org_id: ORG, user_id: m.user_id, content: m.content, title: m.title, tags: m.tags,
      project: m.project || null, project_ids: m.project_ids || [], scope: m.scope || null,
      primary_team_id: m.primary_team_id || null,
      memory_type: m.memory_type, layer: m.layer, cognitive_layer_role: m.cognitive_layer_role,
      is_latest: m.is_latest, created_at: m.created_at, document_date: m.document_date,
      valid_from: m.valid_from, valid_to: m.valid_to } })) };
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
    // This endpoint enumerates memories. Evidence belongs to knowledge_segments
    // and is exposed through `/v1/kb-evidence`, never as a memory row.
    const conds = ["org_id=$1", 'deleted_at IS NULL', "layer IN ('memory','cognitive')"];
    const args = [ORG];
    if (Array.isArray(f.memory_type) && f.memory_type.length) { args.push(f.memory_type); conds.push(`memory_type = ANY($${args.length})`); }
    if (f.cognitive_layer_role === null) conds.push('cognitive_layer_role IS NULL');
    if (f.is_latest !== undefined) { args.push(!!f.is_latest); conds.push(`is_latest=$${args.length}`); }
    if (f.user_id) { args.push(f.user_id); conds.push(`user_id=$${args.length}`); }
    if (Array.isArray(f.tags) && f.tags.length) { args.push(f.tags); conds.push(`tags @> $${args.length}`); }
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
    const conds = ["org_id=$1", 'deleted_at IS NULL', 'is_latest=true', "layer IN ('memory','cognitive')"];
    const args = [ORG];
    if (f.user_id) { args.push(f.user_id); conds.push(`user_id=$${args.length}`); }
    const [mem, rel, docs, evidence] = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM memories WHERE ${conds.join(' AND ')}`, args),
      pg.query('SELECT count(*)::int AS c FROM relationships WHERE org_id=$1', [ORG]),
      pg.query(`SELECT count(*)::int AS c FROM knowledge_documents WHERE org_id=$1 AND deleted_at IS NULL${f.user_id ? ' AND user_id=$2' : ''}`, f.user_id ? [ORG, f.user_id] : [ORG]),
      pg.query(`SELECT count(*)::int AS c FROM knowledge_segments WHERE org_id=$1${f.user_id ? ' AND user_id=$2' : ''}`, f.user_id ? [ORG, f.user_id] : [ORG]),
    ]);
    return {
      memories: mem.rows[0]?.c || 0,
      relationships: rel.rows[0]?.c || 0,
      documents: docs.rows[0]?.c || 0,
      evidence: evidence.rows[0]?.c || 0,
    };
  },

  // Vector durability is explicit and queryable. These endpoints expose only
  // this agent's fixed ORG and require the same bearer authentication as every
  // other data-plane route.
  '/v1/vector-status': async () => {
    const [mem, seg] = await Promise.all([
      pg.query(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE vector_synced=false)::int AS pending
                 FROM memories
                WHERE org_id=$1 AND deleted_at IS NULL AND is_latest=true
                  AND layer IN ('memory','cognitive')`, [ORG]),
      pg.query(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE s.vector_synced=false)::int AS pending
                 FROM knowledge_segments s
                 JOIN knowledge_documents d ON d.id=s.document_id
                WHERE s.org_id=$1 AND d.org_id=$1 AND d.deleted_at IS NULL`, [ORG]),
    ]);
    return {
      ok: true,
      memories: mem.rows[0] || { total: 0, pending: 0 },
      evidence: seg.rows[0] || { total: 0, pending: 0 },
    };
  },

  '/v1/vector-pending': async (b) => {
    const kind = b.kind === 'evidence' ? 'evidence' : 'memory';
    const limit = Math.min(Math.max(Number(b.limit) || 100, 1), 500);
    const cursor = b.cursor || null;
    if (kind === 'memory') {
      const args = [ORG];
      let cursorSql = '';
      if (cursor) { args.push(cursor); cursorSql = ` AND id > $${args.length}::uuid`; }
      args.push(limit);
      const { rows } = await pg.query(
        `SELECT * FROM memories
          WHERE org_id=$1 AND deleted_at IS NULL AND is_latest=true
            AND layer IN ('memory','cognitive') AND vector_synced=false${cursorSql}
          ORDER BY id ASC LIMIT $${args.length}`,
        args,
      );
      return { ok: true, items: rows, cursor: rows.length === limit ? rows.at(-1).id : null };
    }
    const args = [ORG];
    let cursorSql = '';
    if (cursor) { args.push(cursor); cursorSql = ` AND s.id > $${args.length}::uuid`; }
    args.push(limit);
    const { rows } = await pg.query(
      `SELECT s.* FROM knowledge_segments s
       JOIN knowledge_documents d ON d.id=s.document_id
       WHERE s.org_id=$1 AND d.org_id=$1 AND d.deleted_at IS NULL
         AND s.vector_synced=false${cursorSql}
       ORDER BY s.id ASC LIMIT $${args.length}`,
      args,
    );
    return { ok: true, items: rows, cursor: rows.length === limit ? rows.at(-1).id : null };
  },

  // Specialized id+vector repair: the canonical row never leaves this box and
  // cannot be overwritten by replay. The agent rebuilds the payload from its
  // own PostgreSQL row, acknowledges Qdrant wait=true, then flips the status.
  '/v1/vector-repair': async (b) => {
    const kind = b.kind === 'evidence' ? 'evidence' : 'memory';
    if (!b.id || !Array.isArray(b.vector) || b.vector.length !== DIM
        || b.vector.some((value) => !Number.isFinite(value))) {
      return { ok: false, error: `id and a finite ${DIM}-dimension vector are required` };
    }
    if (kind === 'memory') {
      const { rows } = await pg.query(
        `SELECT * FROM memories WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
        [b.id, ORG],
      );
      const row = rows[0];
      if (!row) return { ok: false, error: 'memory not found' };
      const record = {
        id: row.id, userId: row.user_id, content: row.content, title: row.title,
        tags: row.tags, project: row.project, projectIds: row.project_ids,
        scope: row.scope, primaryTeamId: row.primary_team_id,
        memoryType: row.memory_type, layer: row.layer,
        cognitiveLayerRole: row.cognitive_layer_role, isLatest: row.is_latest,
        createdAt: row.created_at, documentDate: row.document_date,
        validFrom: row.valid_from, validTo: row.valid_to,
      };
      const qr = await qFetch(`/collections/${QCOLL}/points`, {
        method: 'PUT',
        body: JSON.stringify({ points: [{ id: row.id, vector: b.vector, payload: payloadOf(record) }], wait: true }),
      });
      if (!qr.ok) return { ok: false, error: `qdrant repair ${qr.status}: ${(await qr.text()).slice(0, 300)}` };
      await pg.query('UPDATE memories SET vector_synced=true WHERE id=$1 AND org_id=$2', [row.id, ORG]);
      return { ok: true, id: row.id, kind };
    }
    const { rows } = await pg.query(
      `SELECT s.* FROM knowledge_segments s
       JOIN knowledge_documents d ON d.id=s.document_id
       WHERE s.id=$1 AND s.org_id=$2 AND d.org_id=$2 AND d.deleted_at IS NULL`,
      [b.id, ORG],
    );
    const row = rows[0];
    if (!row) return { ok: false, error: 'evidence segment not found' };
    const payload = {
      segment_id: row.id, document_id: row.document_id, org_id: ORG,
      user_id: row.user_id || null, layer: 'segment',
      content: String(row.content || '').slice(0, 400),
    };
    const qr = await qFetch(`/collections/${QCOLL}/points`, {
      method: 'PUT',
      body: JSON.stringify({ points: [{ id: row.id, vector: b.vector, payload }], wait: true }),
    });
    if (!qr.ok) return { ok: false, error: `qdrant evidence repair ${qr.status}: ${(await qr.text()).slice(0, 300)}` };
    await pg.query('UPDATE knowledge_segments SET vector_synced=true WHERE id=$1 AND org_id=$2', [row.id, ORG]);
    return { ok: true, id: row.id, kind };
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
      // id has no DEFAULT and is NOT NULL — a caller that omits it (the engine's remote-org edge
      // path did, until fixed) must not 500 the whole write; generate one server-side.
      await pg.query(
        `INSERT INTO relationships (id, org_id, from_id, to_id, type, confidence) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, confidence=EXCLUDED.confidence`,
        [rel.id || randomUUID(), ORG, rel.fromId, rel.toId, rel.type || 'Mentions', rel.confidence ?? 1]);
    }
    return { ok: true };
  },

  '/v1/delete-edge': async (b) => {
    const rel = b.rel || {};
    if (!rel.fromId || !rel.toId || !rel.type) return { ok: false, error: 'fromId, toId and type required' };
    const result = await pg.query(
      'DELETE FROM relationships WHERE org_id=$1 AND from_id=$2 AND to_id=$3 AND type=$4',
      [ORG, rel.fromId, rel.toId, rel.type],
    );
    return { ok: true, removed: result.rowCount > 0 };
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

  // Generic partial update: tags / is_latest / memory_type / valid_to / metadata. Used by the central engine's
  // updateMemory seam for remote orgs (entity-link type upgrades, supersession is_latest flips).
  '/v1/update': async (b) => {
    if (!b.id) return { ok: false, error: 'id required' };
    const sets = []; const args = [b.id, ORG];
    if (Array.isArray(b.tags)) { args.push(b.tags); sets.push(`tags=$${args.length}`); }
    if (b.is_latest !== undefined) { args.push(!!b.is_latest); sets.push(`is_latest=$${args.length}`); }
    if (b.memory_type !== undefined) { args.push(b.memory_type); sets.push(`memory_type=$${args.length}`); }
    if (b.valid_to !== undefined) { args.push(b.valid_to); sets.push(`valid_to=$${args.length}::timestamptz`); }
    if (b.content !== undefined) { args.push(b.content); sets.push(`content=$${args.length}`); }
    if (b.title !== undefined) { args.push(b.title); sets.push(`title=$${args.length}`); }
    if (b.importance_score !== undefined) { args.push(Number(b.importance_score)); sets.push(`confidence=$${args.length}`); }
    if (b.metadata !== undefined) { args.push(JSON.stringify(b.metadata || {})); sets.push(`metadata=$${args.length}::jsonb`); }
    if (!sets.length) return { ok: true };
    await pg.query(`UPDATE memories SET ${sets.join(', ')} WHERE id=$1 AND org_id=$2`, args);
    const payload = {
      ...(Array.isArray(b.tags) ? { tags: b.tags } : {}),
      ...(b.is_latest !== undefined ? { is_latest: !!b.is_latest } : {}),
      ...(b.memory_type !== undefined ? { memory_type: b.memory_type } : {}),
      ...(b.valid_to !== undefined ? { valid_to: b.valid_to } : {}),
      ...(b.content !== undefined ? { content: String(b.content).slice(0, 400) } : {}),
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.importance_score !== undefined ? { importance_score: Number(b.importance_score) } : {}),
      ...(b.metadata !== undefined ? { metadata: b.metadata || {} } : {}),
    };
    if (Object.keys(payload).length > 0) {
      qFetch(`/collections/${QCOLL}/points/payload`, { method: 'POST',
        body: JSON.stringify({ payload, points: [b.id] }) }).catch(() => {});
    }
    return { ok: true };
  },

  // ── KB layer (self-host) — documents + evidence segments live on the agent, never central ──
  // Upsert a knowledge document row.
  '/v1/kb-doc': async (b) => {
    const d = sanitizeJson(b.doc || {});
    if (!d.id) return { ok: false, error: 'doc.id required' };
    await pg.query(
      `INSERT INTO knowledge_documents (id, org_id, user_id, filename, content_type, status, checksum, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,coalesce($9::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, content_type=EXCLUDED.content_type,
         status=EXCLUDED.status, checksum=EXCLUDED.checksum, metadata=EXCLUDED.metadata, deleted_at=NULL`,
      [d.id, ORG, d.userId || null, d.filename || null, d.contentType || null, d.status || 'ready',
       d.checksum || null, JSON.stringify({ ...(d.metadata || {}), title: d.title || d.filename || null, tags: d.tags || d.metadata?.tags || [] }), d.createdAt || null]);
    return { ok: true };
  },

  // Upsert one evidence segment: row + vector (layer='segment' in the shared Qdrant collection).
  '/v1/kb-segment': async (b) => {
    const s = sanitizeJson(b.segment || {});
    if (!s.id || !s.documentId) return { ok: false, error: 'segment.id + documentId required' };
    await pg.query(
      `INSERT INTO knowledge_segments (id, org_id, user_id, document_id, content, content_hash, segment_type,
         segment_index, previous_segment_id, metadata, start_page, end_page, word_count, vector_synced, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,false,coalesce($14::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash,
         segment_type=EXCLUDED.segment_type, segment_index=EXCLUDED.segment_index, metadata=EXCLUDED.metadata,
         start_page=EXCLUDED.start_page, end_page=EXCLUDED.end_page, word_count=EXCLUDED.word_count, vector_synced=false`,
      [s.id, ORG, s.userId || null, s.documentId, s.content || null, s.contentHash || null, s.segmentType || 'chunk',
       s.segmentIndex ?? 0, s.previousSegmentId || null, JSON.stringify(s.metadata || {}), s.startPage || null,
       s.endPage || null, s.wordCount || null, s.createdAt || null]);
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
    const documentIds = Array.isArray(b.documentIds) ? [...new Set(b.documentIds.filter(Boolean))] : [];
    if (b.documentId) filter.must.push({ key: 'document_id', match: { value: b.documentId } });
    else if (documentIds.length) filter.must.push({ key: 'document_id', match: { any: documentIds } });
    const qr = await qFetch(`/collections/${QCOLL}/points/search`, { method: 'POST', body: JSON.stringify({
      vector: b.vector, limit: Number(b.limit) || 20, with_payload: true, score_threshold: b.scoreThreshold ?? 0.0, filter }) });
    if (!qr.ok) return { results: [] };
    const j = await qr.json();
    const hitIds = (j.result || []).map((h) => h.payload?.segment_id || h.id).filter(Boolean);
    if (!hitIds.length) return { results: [] };
    const conds = ['s.org_id=$1', 'd.org_id=$1', 'd.deleted_at IS NULL', 's.id = ANY($2::uuid[])'];
    const args = [ORG, hitIds];
    appendDocumentAccess(conds, args, 'd', b.access);
    const { rows } = await pg.query(
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

  // Lexical evidence lane. It searches only segment rows, joins the owning active
  // document, and returns the same core fields as kb-recall plus display metadata.
  '/v1/kb-lexical': async (b) => {
    const tsQuery = lexicalTsQuery(b.text);
    if (!tsQuery) return { results: [] };
    const f = b.filter || {};
    const conds = [
      's.org_id=$1',
      'd.org_id=$1',
      'd.deleted_at IS NULL',
      "s.content_tsv @@ to_tsquery('simple',$2)",
    ];
    const args = [ORG, tsQuery];
    const documentIds = Array.isArray(f.documentIds) ? [...new Set(f.documentIds.filter(Boolean))] : [];
    if (f.documentId) { args.push(f.documentId); conds.push(`s.document_id=$${args.length}::uuid`); }
    else if (documentIds.length) { args.push(documentIds); conds.push(`s.document_id = ANY($${args.length}::uuid[])`); }
    // Prefer the EXPLICIT top-level `access` (the contract remoteKbRecall already used);
    // fall back to filter.access for callers/deployments still on the old shape. A missing
    // access silently fails the whole query closed (appendDocumentAccess: no userId -> FALSE),
    // so accepting only one shape here is how a caller matching the OTHER route's convention
    // gets an empty result set with no error -- exactly what happened investigating this.
    appendDocumentAccess(conds, args, 'd', (b.access || f.access));
    args.push(Number(b.limit) || 20);
    const { rows } = await pg.query(
      `SELECT s.id AS segment_id, s.document_id, s.content,
              ts_rank(s.content_tsv, to_tsquery('simple',$2)) AS score,
              coalesce(d.metadata->>'title', d.filename) AS title,
              s.start_page, s.end_page, s.word_count, s.segment_type, s.segment_index, s.metadata
         FROM knowledge_segments s
         JOIN knowledge_documents d ON d.id=s.document_id
        WHERE ${conds.join(' AND ')}
        ORDER BY score DESC, s.segment_index ASC LIMIT $${args.length}`,
      args,
    );
    return { results: rows.map((row) => ({ ...row, score: Number(row.score) || 0 })) };
  },

  // Hydrate segment rows by id (full content + metadata for evidence display).
  '/v1/kb-hydrate': async (b) => {
    const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
    if (!ids.length) return { segments: [] };
    const conds = ['s.org_id=$1', 'd.org_id=$1', 'd.deleted_at IS NULL', 's.id = ANY($2::uuid[])'];
    const args = [ORG, ids];
    appendDocumentAccess(conds, args, 'd', b.access);
    const { rows } = await pg.query(
      `SELECT s.id, s.document_id, s.content, s.content_hash, s.segment_type, s.segment_index, s.metadata,
              s.start_page, s.end_page, s.word_count, s.created_at,
              coalesce(d.metadata->>'title', d.filename) AS title
         FROM knowledge_segments s
         JOIN knowledge_documents d ON d.id=s.document_id
        WHERE ${conds.join(' AND ')}`,
      args,
    );
    return { segments: rows };
  },

  // Delete one memory: row + vector + edges (+ tombstone if soft).
  '/v1/delete': async (b) => {
    if (!b.id) return { ok: false, error: 'id required' };
    let deleted = 0;
    if (b.hard) {
      const r = await pg.query('DELETE FROM memories WHERE id=$1 AND org_id=$2', [b.id, ORG]); deleted = r.rowCount;
      await pg.query('DELETE FROM relationships WHERE org_id=$1 AND (from_id=$2 OR to_id=$2)', [ORG, b.id]);
    // Provenance too. This agent already removed edges on a single-memory delete but left
    // memory_evidence_links / memory_derivations behind, and the memory row is SOFT-deleted so the
    // ON DELETE CASCADE never fires. Same leak found and fixed on the embedded side; keeping the two
    // implementations identical is the whole point.
    await pg.query('DELETE FROM memory_derivations WHERE org_id=$1 AND memory_id=$2', [ORG, b.id]).catch(() => {});
    await pg.query('DELETE FROM memory_evidence_links WHERE org_id=$1 AND memory_id=$2', [ORG, b.id]).catch(() => {});
    } else {
      const r = await pg.query('UPDATE memories SET deleted_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [b.id, ORG]); deleted = r.rowCount;
    }
    await qFetch(`/collections/${QCOLL}/points/delete`, { method: 'POST', body: JSON.stringify({ points: [b.id] }) }).catch(() => {});
    return { ok: true, deleted };
  },

  // Clear ONLY the memory layer for this org (hard) — memories + their edges +
  // memory vectors. Leaves KB, meetings, TARA, and all usage/billing untouched.
  // Backs the dashboard "Clear all memories" action. Idempotent.
  // Delete ONE document and everything derived from it. Ported from the embedded agent's
  // /v1/kb-doc-delete so the two implementations of this API match: the endpoint existed only
  // on the embedded side, so on a self-host org a document delete hit a 404 that
  // remoteKbDocDelete swallowed into null — the delete silently did nothing.
  // Pure SQL here (no in-memory AMR index on the external agent): the derived fact memories
  // are found by the same `filename:` / `doc-id:` tags the ingestion writes.
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
    const { rows: _dchk } = await pg.query('SELECT 1 FROM knowledge_documents WHERE id=$1 AND org_id=$2', [docId, ORG]);
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
        const { rows: ins } = await pg.query(
          `INSERT INTO document_tables (document_id, org_id, user_id, sheet, table_index, headers, row_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (document_id, table_index) DO UPDATE SET headers=EXCLUDED.headers, row_count=EXCLUDED.row_count
           RETURNING id`,
          [docId, ORG, b.user_id || null, t.sheet ? String(t.sheet).slice(0, 255) : null, ti, headers, rows.length]);
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
          await pg.query(
            `INSERT INTO document_table_rows (table_id, org_id, row_index, cells) VALUES ($1,$2,$3,$4::jsonb)
             ON CONFLICT (table_id, row_index) DO UPDATE SET cells=EXCLUDED.cells`,
            [tableId, ORG, ri, JSON.stringify(cells)]);
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
        await pg.query(
          `INSERT INTO memory_evidence_links (org_id, memory_id, document_id, segment_id, link_type, confidence, excerpt)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (memory_id, segment_id, link_type) DO NOTHING`,
          [ORG, l.memory_id, l.document_id || null, l.segment_id || null, l.link_type || 'supports',
           l.confidence ?? null, l.excerpt || null]);
        linked += 1;
      } catch (e) { console.warn(`[kb-provenance] link failed mem=${l.memory_id}: ${e.message}`); }
    }
    for (const d of ders) {
      if (!d?.memory_id) continue;
      try {
        await pg.query(
          `INSERT INTO memory_derivations (org_id, memory_id, derivation_method, derivation_agent, confidence, metadata)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ORG, d.memory_id, d.derivation_method || null, d.derivation_agent || null,
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
    const { rows } = await pg.query(
      `SELECT l.link_type, l.confidence, l.excerpt, l.segment_id, l.document_id,
              s.content, s.segment_type, s.segment_index, s.start_page, s.end_page, s.metadata,
              coalesce(d.metadata->>'title', d.filename) AS document_title
         FROM memory_evidence_links l
         LEFT JOIN knowledge_segments s ON s.id = l.segment_id
         LEFT JOIN knowledge_documents d ON d.id = l.document_id
        WHERE l.org_id=$1 AND l.memory_id=$2
        ORDER BY s.segment_index ASC NULLS LAST`,
      [ORG, b.memory_id]);
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
      const { rows } = await pg.query(
        'SELECT id, filename FROM knowledge_documents WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
        [b.document_id, ORG]);
      doc = rows[0] || null;
    }
    if (!doc && b.filename) {
      const { rows } = await pg.query(
        'SELECT id, filename FROM knowledge_documents WHERE filename=$1 AND org_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
        [b.filename, ORG]);
      doc = rows[0] || null;
    }
    if (!doc) return { ok: false, error: 'document not found', deleted_memories: 0 };

    // Memories derived from this document, by the tags ingestion stamps on them.
    const tags = [`filename:${doc.filename}`, `doc-id:${doc.id}`];
    const { rows: memRows } = await pg.query(
      'SELECT id FROM memories WHERE org_id=$1 AND deleted_at IS NULL AND tags && $2::text[]', [ORG, tags]);
    const memIds = memRows.map((r) => r.id);
    // Provenance is the SECOND source of truth for "which memories came from this
    // document". Finding them only by the filename:/doc-id: tags missed any memory that
    // does not carry them (measured: 24 of 27 derivations cleaned, 4 left behind), so union
    // in whatever the evidence links themselves claim for this document.
    try {
      const { rows: _pv } = await pg.query(
        'SELECT DISTINCT memory_id FROM memory_evidence_links WHERE org_id=$1 AND document_id=$2',
        [ORG, doc.id]);
      for (const r of _pv) if (r.memory_id && !memIds.includes(r.memory_id)) memIds.push(r.memory_id);
    } catch { /* table may not exist on an older agent — the tag path still applies */ }
    if (memIds.length) {
      await pg.query('UPDATE memories SET deleted_at=now(), is_latest=false WHERE id = ANY($1::uuid[]) AND org_id=$2',
        [memIds, ORG]).catch(() => {});
      await pg.query('DELETE FROM relationships WHERE org_id=$1 AND (from_id = ANY($2::uuid[]) OR to_id = ANY($2::uuid[]))',
        [ORG, memIds]).catch(() => {});
      // Provenance must go with the memory. The memory row is SOFT-deleted (deleted_at), so the
      // ON DELETE CASCADE on memory_id never fires — measured after a real document delete:
      // evidence links vanished (they also cascade off the hard-deleted segments) but 25
      // derivations were left behind, pointing at soft-deleted memories and unreadable forever.
      await pg.query('DELETE FROM memory_derivations WHERE org_id=$1 AND memory_id = ANY($2::uuid[])',
        [ORG, memIds]).catch(() => {});
      await pg.query('DELETE FROM memory_evidence_links WHERE org_id=$1 AND memory_id = ANY($2::uuid[])',
        [ORG, memIds]).catch(() => {});
      // Vectors last: a Postgres-only delete leaves orphan points that break recall while
      // looking exactly like a broken retriever.
      await qFetch(`/collections/${QCOLL}/points/delete?wait=true`,
        { method: 'POST', body: JSON.stringify({ points: memIds }) }).catch(() => {});
    }

    const { rows: segRows } = await pg.query('SELECT id FROM knowledge_segments WHERE org_id=$1 AND document_id=$2',
      [ORG, doc.id]);
    const segIds = segRows.map((r) => r.id);
    await pg.query('DELETE FROM knowledge_segments WHERE org_id=$1 AND document_id=$2', [ORG, doc.id]);
    // Grids too. document_tables FKs knowledge_documents ON DELETE CASCADE, but the document row
    // is SOFT-deleted here (deleted_at), so the cascade never fires — measured after a real
    // delete: docs=0 but tables=1 / tablerows=3 left behind. This is the THIRD time tonight that
    // adding a table meant its LIFECYCLE also had to be routed (derivations, evidence links, now
    // grids). document_table_rows cascades off document_tables, which IS a hard delete.
    await pg.query('DELETE FROM document_tables WHERE org_id=$1 AND document_id=$2', [ORG, doc.id]).catch(() => {});
    if (segIds.length) {
      await qFetch(`/collections/${QCOLL}/points/delete?wait=true`,
        { method: 'POST', body: JSON.stringify({ points: segIds }) }).catch(() => {});
    }

    await pg.query('UPDATE knowledge_documents SET deleted_at=now() WHERE id=$1 AND org_id=$2', [doc.id, ORG]);
    return { ok: true, document_id: doc.id, deleted_memories: memIds.length, deleted_segments: segIds.length };
  },

  '/v1/clear-memories': async () => {
    const m = await pg.query('DELETE FROM memories WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM relationships WHERE org_id=$1', [ORG]);
    await qFetch(`/collections/${QCOLL}`, { method: 'DELETE' }).catch(() => {});
    await ensureQdrant();
    return { ok: true, deleted: m.rowCount };
  },

  // Bulk erase the whole org (account deletion saga). Drops + recreates the Qdrant collection.
  '/v1/purge': async () => {
    const m = await pg.query('DELETE FROM memories WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM relationships WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM knowledge_segments WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM knowledge_documents WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM meeting_audio_segments WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM meeting_segments WHERE org_id=$1', [ORG]);
    await pg.query('DELETE FROM meeting_sessions WHERE org_id=$1', [ORG]);
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
    if (m.session_id) {
      const existing = await pg.query(
        'SELECT meeting_id FROM meeting_segments WHERE session_id=$1 AND org_id=$2 AND user_id=$3 AND meeting_id IS NOT NULL LIMIT 1',
        [m.session_id, ORG, m.user_id]);
      if (existing.rows[0]?.meeting_id) return { ok: true, id: existing.rows[0].meeting_id, existing: true };
    }
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
    if (m.session_id && m.user_id) {
      await pg.query(
        'UPDATE meeting_segments SET meeting_id=$1 WHERE session_id=$2 AND org_id=$3 AND user_id=$4 AND meeting_id IS NULL',
        [id, m.session_id, ORG, m.user_id]);
    }
    return { ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at };
  },

  '/v1/meeting-segment-write': async (b) => {
    const s = b.segment || {};
    if (!s.session_id || !s.user_id || !Number.isInteger(s.idx) || !String(s.text || '').trim()) return { ok: false, error: 'invalid segment' };
    // Older recorder clients mint a session id locally. Match managed storage:
    // create the tenant-local parent before acknowledging the transcript.
    await pg.query(
      `INSERT INTO meeting_sessions (id,org_id,user_id,status,consent_recorded)
       VALUES ($1,$2,$3,'recording',false)
       ON CONFLICT (id) DO NOTHING`,
      [s.session_id, ORG, s.user_id]);
    await pg.query(
      `INSERT INTO meeting_segments (session_id,org_id,user_id,idx,text,speakers,start_ms,end_ms)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (session_id,idx) DO UPDATE SET text=EXCLUDED.text,speakers=EXCLUDED.speakers,start_ms=EXCLUDED.start_ms,end_ms=EXCLUDED.end_ms`,
      [s.session_id, ORG, s.user_id, s.idx, String(s.text).slice(0, 200000), s.speakers ? JSON.stringify(s.speakers) : null, s.start_ms ?? null, s.end_ms ?? null]);
    await pg.query(
      `UPDATE meeting_sessions SET updated_at=now()
        WHERE id=$1 AND org_id=$2 AND user_id=$3 AND status='recording'`,
      [s.session_id, ORG, s.user_id]);
    // A finalize request can arrive before the browser's last acknowledged
    // transcript segment. Missing coverage is terminal until new data exists,
    // but the late durable segment is precisely the recovery signal: once all
    // expected indexes exist, requeue the same persisted payload for the
    // reconciler instead of requiring the browser to submit finalize again.
    await pg.query(
      `UPDATE meeting_sessions ms
          SET status='queued', finalization_attempts=0,
              finalization_next_attempt_at=NULL, finalization_lease_expires_at=NULL,
              failure_code=NULL, failure_detail=NULL, updated_at=now()
        WHERE ms.id=$1 AND ms.org_id=$2 AND ms.user_id=$3
          AND ms.status='failed' AND ms.failure_code='missing_segments'
          AND ms.expected_segments IS NOT NULL
          AND (SELECT COUNT(DISTINCT g.idx) FROM meeting_segments g
                WHERE g.session_id=ms.id AND g.org_id=ms.org_id AND g.user_id=ms.user_id)
              >= ms.expected_segments`,
      [s.session_id, ORG, s.user_id]);
    return { ok: true };
  },

  '/v1/meeting-segment-list': async (b) => {
    const f = b.filter || {};
    if (!f.session_id || !f.user_id) return { segments: [] };
    const { rows } = await pg.query(
      'SELECT idx,text,speakers,start_ms,end_ms,meeting_id FROM meeting_segments WHERE session_id=$1 AND org_id=$2 AND user_id=$3 ORDER BY idx',
      [f.session_id, ORG, f.user_id]);
    return { segments: rows };
  },

  '/v1/meeting-session-write': async (b) => {
    const s = b.session || {};
    if (!s.id || !s.user_id || !['create','finalize'].includes(s.action)) return { ok: false, error: 'invalid meeting session' };
    if (s.action === 'create') {
      await pg.query(
        `INSERT INTO meeting_sessions (id,org_id,user_id,status,consent_recorded,expected_segment_ms)
         VALUES ($1,$2,$3,'recording',$4,$5)
         ON CONFLICT (id) DO UPDATE SET updated_at=now()
         WHERE meeting_sessions.org_id=EXCLUDED.org_id AND meeting_sessions.user_id=EXCLUDED.user_id`,
        [s.id,ORG,s.user_id,s.consent === true,Math.min(1800000,Math.max(60000,Number(s.expected_segment_ms)||600000))]);
    } else {
      await pg.query(
        `UPDATE meeting_sessions SET status=CASE WHEN status='ready' THEN status ELSE 'queued' END,
                finalization_attempts=CASE WHEN status='failed' THEN 0 ELSE finalization_attempts END,
                expected_segments=COALESCE($4,expected_segments),finalization_payload=$5::jsonb,
                finalization_next_attempt_at=NULL,finalization_lease_expires_at=NULL,
                failure_code=NULL,failure_detail=NULL,updated_at=now()
          WHERE id=$1 AND org_id=$2 AND user_id=$3`,
        [s.id,ORG,s.user_id,Number.isInteger(Number(s.expected_segments))?Math.min(1000,Number(s.expected_segments)):null,JSON.stringify(s.payload||{})]);
    }
    const { rows } = await pg.query('SELECT id,status,finalized_meeting_id,expected_segments FROM meeting_sessions WHERE id=$1 AND org_id=$2 AND user_id=$3',[s.id,ORG,s.user_id]);
    return rows[0] ? { ok:true,session:rows[0] } : { ok:false,error:'not_found' };
  },

  '/v1/meeting-session-status': async (b) => {
    const f=b.filter||{};
    if (!f.user_id) return { sessions: [] };
    const args=f.id?[f.id,ORG,f.user_id]:[ORG,f.user_id];
    const where=f.id?'s.id=$1 AND s.org_id=$2 AND s.user_id=$3':'s.org_id=$1 AND s.user_id=$2';
    const { rows }=await pg.query(
      `SELECT s.id,s.status,s.expected_segments,s.finalized_meeting_id,s.failure_code,s.failure_detail,
              s.finalization_attempts,s.finalization_next_attempt_at,s.finalization_lease_expires_at,s.updated_at,s.finalized_at,
              COUNT(DISTINCT g.idx)::int segment_count,ARRAY_REMOVE(ARRAY_AGG(DISTINCT g.idx ORDER BY g.idx),NULL) segment_indexes,
              COUNT(DISTINCT a.idx)::int audio_count,COUNT(DISTINCT a.idx) FILTER (WHERE a.status='transcribed')::int audio_transcribed_count,
              COUNT(DISTINCT a.idx) FILTER (WHERE a.status='error' AND a.attempts>=3)::int audio_error_count
         FROM meeting_sessions s
         LEFT JOIN meeting_segments g ON g.session_id=s.id AND g.org_id=s.org_id AND g.user_id=s.user_id
         LEFT JOIN meeting_audio_segments a ON a.session_id=s.id AND a.org_id=s.org_id AND a.user_id=s.user_id
        WHERE ${where} GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 25`,args);
    return f.id ? { session: rows[0]||null } : { sessions: rows };
  },

  '/v1/meeting-session-pending': async (b) => {
    const abandonedAfterMs=Math.max(300000,Number(process.env.MEETING_ABANDONED_AFTER_MS)||1800000);
    await pg.query(
      `UPDATE meeting_sessions s
          SET status='queued',expected_segments=NULL,
              finalization_payload=COALESCE(s.finalization_payload,'{}'::jsonb)||jsonb_build_object('recovered_partial',true,'recovery_reason','recording_inactive','recovered_at',now()),
              finalization_next_attempt_at=NULL,finalization_lease_expires_at=NULL,
              failure_code=NULL,failure_detail=NULL,updated_at=now()
        WHERE s.org_id=$1 AND s.status='recording' AND s.consent_recorded=true
          AND s.updated_at<=now()-($2::bigint*interval '1 millisecond')
          AND EXISTS(SELECT 1 FROM meeting_segments g WHERE g.session_id=s.id AND g.org_id=s.org_id AND g.user_id=s.user_id)
          AND NOT EXISTS(SELECT 1 FROM meeting_audio_segments a WHERE a.session_id=s.id AND a.org_id=s.org_id AND a.user_id=s.user_id AND a.status NOT IN('transcribed','expired') AND NOT(a.status='error' AND a.attempts>=3))`,
      [ORG,abandonedAfterMs]);
    const { rows }=await pg.query(
      `SELECT s.id,s.user_id FROM meeting_sessions s
        WHERE (s.status IN ('queued','error') OR (s.status='analyzing' AND s.finalization_lease_expires_at<now()))
          AND s.finalization_attempts<3 AND (s.finalization_next_attempt_at IS NULL OR s.finalization_next_attempt_at<=now())
          AND NOT EXISTS (SELECT 1 FROM meeting_audio_segments a WHERE a.session_id=s.id AND a.org_id=s.org_id AND a.user_id=s.user_id AND a.status<>'transcribed' AND NOT(a.status='error' AND a.attempts>=3))
        ORDER BY s.updated_at LIMIT $1`,[Math.min(20,Math.max(1,Number(b.limit)||5))]);
    return { sessions: rows };
  },

  '/v1/meeting-session-claim': async (b) => {
    const f=b.filter||{};
    const { rows }=await pg.query(
      `UPDATE meeting_sessions SET status='analyzing',finalization_attempts=finalization_attempts+1,
              finalization_next_attempt_at=NULL,finalization_lease_expires_at=now()+interval '10 minutes',failure_code=NULL,failure_detail=NULL,updated_at=now()
        WHERE id=$1 AND org_id=$2 AND user_id=$3 AND finalization_attempts<3
          AND (status IN ('queued','error') OR (status='analyzing' AND finalization_lease_expires_at<now()))
          AND (finalization_next_attempt_at IS NULL OR finalization_next_attempt_at<=now())
        RETURNING id,user_id,expected_segments,finalization_payload,finalization_attempts`,[f.id,ORG,f.user_id]);
    return { ok:true,session:rows[0]||null };
  },

  '/v1/meeting-session-settle': async (b) => {
    const r=b.result||{};
    if (!r.id||!r.user_id||!['ready','error','failed'].includes(r.status)) return {ok:false,error:'invalid settlement'};
    await pg.query(
      `UPDATE meeting_sessions SET status=$1::varchar(24),finalized_meeting_id=$2,failure_code=$3,failure_detail=$4,
              finalization_next_attempt_at=$5,finalization_lease_expires_at=NULL,
              finalized_at=CASE WHEN $1::text='ready' THEN now() ELSE finalized_at END,updated_at=now()
        WHERE id=$6 AND org_id=$7 AND user_id=$8`,
      [r.status,r.meeting_id||null,r.failure_code||null,r.failure_detail?String(r.failure_detail).slice(0,1000):null,r.next_attempt_at||null,r.id,ORG,r.user_id]);
    return {ok:true};
  },

  '/v1/meeting-audio-write': async (b) => {
    const s = b.segment || {};
    if (!s.session_id || !s.user_id || !Number.isInteger(s.idx) || !/^[a-f0-9]{64}$/i.test(String(s.checksum || '')) || !String(s.audio_base64 || '')) return { ok: false, error: 'invalid audio segment' };
    const bytes = Buffer.from(String(s.audio_base64), 'base64');
    if (!bytes.length || bytes.length > 24 * 1024 * 1024) return { ok: false, error: 'invalid audio bytes' };
    await pg.query(
      `INSERT INTO meeting_audio_segments (session_id,org_id,user_id,idx,checksum,content_type,audio,start_ms,end_ms,status)
       VALUES ($1,$2,$3,$4,$5,$6,decode($7,'base64'),$8,$9,'queued')
       ON CONFLICT (session_id,idx) DO UPDATE SET updated_at=now(), status=CASE WHEN meeting_audio_segments.checksum=EXCLUDED.checksum THEN meeting_audio_segments.status ELSE meeting_audio_segments.status END
       WHERE meeting_audio_segments.checksum=EXCLUDED.checksum`,
      [s.session_id, ORG, s.user_id, s.idx, s.checksum, String(s.content_type || 'audio/webm').slice(0, 160), String(s.audio_base64), s.start_ms ?? null, s.end_ms ?? null]);
    const existing = await pg.query('SELECT checksum,status FROM meeting_audio_segments WHERE session_id=$1 AND idx=$2 AND org_id=$3 AND user_id=$4', [s.session_id, s.idx, ORG, s.user_id]);
    if (existing.rows[0]?.checksum !== s.checksum) return { ok: false, error: 'audio_segment_conflict' };
    return { ok: true, status: existing.rows[0]?.status || 'queued' };
  },

  '/v1/meeting-audio-claim': async (b) => {
    const f = b.filter || {};
    if (!f.session_id || !f.user_id || !Number.isInteger(f.idx)) return { ok: false, error: 'invalid audio claim' };
    const { rows } = await pg.query(
      `WITH candidate AS (
         SELECT session_id,idx FROM meeting_audio_segments
          WHERE session_id=$1 AND idx=$2 AND org_id=$3 AND user_id=$4
            AND (status IN ('queued','error') OR (status='processing' AND lease_expires_at < now()))
            AND attempts < 3 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          FOR UPDATE SKIP LOCKED
       ) UPDATE meeting_audio_segments a SET status='processing', attempts=a.attempts+1,
              next_attempt_at=NULL, lease_expires_at=now()+interval '10 minutes', last_error=NULL, updated_at=now()
         FROM candidate c WHERE a.session_id=c.session_id AND a.idx=c.idx
       RETURNING a.session_id,a.idx,a.user_id,a.content_type,encode(a.audio,'base64') AS audio_base64,a.start_ms,a.end_ms,a.attempts`,
      [f.session_id, f.idx, ORG, f.user_id]);
    return { ok: true, segment: rows[0] || null };
  },

  '/v1/meeting-audio-settle': async (b) => {
    const r = b.result || {};
    if (!r.session_id || !r.user_id || !Number.isInteger(r.idx) || !['transcribed','error'].includes(r.status)) return { ok: false, error: 'invalid audio settlement' };
    await pg.query(
      `UPDATE meeting_audio_segments SET status=$1, lease_expires_at=NULL, next_attempt_at=$2, last_error=$3, updated_at=now()
        WHERE session_id=$4 AND idx=$5 AND org_id=$6 AND user_id=$7`,
      [r.status, r.next_attempt_at || null, r.last_error ? String(r.last_error).slice(0, 500) : null, r.session_id, r.idx, ORG, r.user_id]);
    return { ok: true };
  },

  '/v1/meeting-audio-pending': async (b) => {
    const { rows } = await pg.query(
      `SELECT session_id,idx,user_id FROM meeting_audio_segments
        WHERE (status IN ('queued','error') OR (status='processing' AND lease_expires_at < now()))
          AND attempts < 3 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at ASC LIMIT $1`, [Math.min(Math.max(Number(b.limit) || 10, 1), 50)]);
    return { segments: rows };
  },

  // List org's non-deleted meetings, newest first. Scope filter is simplified to
  // org + deleted_at + limit (no project-membership join on the agent; the central
  // server applies the rich scope predicate for managed orgs).
  '/v1/meeting-list': async (b) => {
    const f = b.filter || {};
    const limit = Math.min(Number(f.limit) || 40, 5000);
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
    await pg.query('DELETE FROM meeting_segments WHERE meeting_id=$1 AND org_id=$2', [b.id, ORG]);
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
  // promoted_count = memories derived from the document by provenance or legacy doc-id tags.
  // Response: { documents: [...], pagination: { total, limit, offset, hasMore } }
  '/v1/kb-segments': async (b) => {
    const limit = Math.min(Number(b.limit) || 40, 200);
    const offset = Math.max(Number(b.offset) || 0, 0);
    const conds = ['s.org_id=$1', 'd.org_id=$1', 'd.deleted_at IS NULL'];
    const args = [ORG];
    if (b.documentId) { args.push(b.documentId); conds.push(`s.document_id=$${args.length}::uuid`); }
    appendDocumentAccess(conds, args, 'd', b.access);
    args.push(limit); const limitArg = `$${args.length}`;
    args.push(offset); const offsetArg = `$${args.length}`;
    const { rows } = await pg.query(
      `SELECT s.id, s.document_id, s.user_id, s.content, s.content_hash, s.segment_type,
              s.segment_index, s.start_page, s.end_page, s.word_count, s.vector_synced,
              s.metadata, s.created_at, d.filename, d.content_type, d.metadata AS document_metadata
         FROM knowledge_segments s JOIN knowledge_documents d ON d.id=s.document_id
        WHERE ${conds.join(' AND ')}
        ORDER BY s.created_at DESC, s.segment_index ASC LIMIT ${limitArg} OFFSET ${offsetArg}`,
      args,
    );
    const { rows: countRows } = await pg.query(
      `SELECT count(*)::int AS c FROM knowledge_segments s JOIN knowledge_documents d ON d.id=s.document_id
        WHERE ${conds.join(' AND ')}`,
      args.slice(0, -2),
    );
    const evidence = rows.map((s) => {
      const documentTitle = s.document_metadata?.title || s.filename || String(s.document_id);
      const segmentNumber = Number(s.segment_index || 0) + 1;
      return {
        id: s.id, segmentId: s.id, type: 'evidence_segment', documentId: s.document_id,
        title: `${documentTitle} : ${String(segmentNumber).padStart(2, '0')}`,
        content: s.content, createdAt: s.created_at,
        document: { id: s.document_id, title: documentTitle, contentType: s.content_type },
        metadata: {
          ...(s.metadata || {}), segmentType: s.segment_type, segmentIndex: s.segment_index,
          startPage: s.start_page, endPage: s.end_page, wordCount: s.word_count,
          contentHash: s.content_hash, vectorStored: Boolean(s.vector_synced),
          uploader_user_id: s.user_id, org_id: ORG, document_id: s.document_id,
          source_title: documentTitle, source_kind: 'knowledge_base',
        },
      };
    });
    const total = countRows[0]?.c || 0;
    return { evidence, pagination: { total, limit, offset, hasMore: offset + limit < total } };
  },

  '/v1/kb-docs': async (b) => {
    const limit = Math.min(Number(b.limit) || 20, 200);
    const offset = Math.max(Number(b.offset) || 0, 0);
    const conds = ['d.org_id=$1', 'd.deleted_at IS NULL', 'EXISTS (SELECT 1 FROM knowledge_segments sx WHERE sx.document_id=d.id AND sx.org_id=d.org_id)'];
    const args = [ORG];
    appendDocumentAccess(conds, args, 'd', b.access);
    args.push(limit); const limitArg = `$${args.length}`;
    args.push(offset); const offsetArg = `$${args.length}`;
    const { rows: docs } = await pg.query(
      `SELECT d.id, d.user_id, d.filename, d.content_type, d.status, d.metadata, d.created_at
       FROM knowledge_documents d WHERE ${conds.join(' AND ')}
       ORDER BY d.created_at DESC LIMIT ${limitArg} OFFSET ${offsetArg}`,
      args,
    );
    const { rows: totRow } = await pg.query(
      `SELECT count(*)::int AS c FROM knowledge_documents d WHERE ${conds.join(' AND ')}`,
      args.slice(0, -2),
    );
    const total = totRow[0]?.c || 0;
    // Batch segment counts and promoted counts in two queries rather than N+1.
    const ids = docs.map((d) => d.id);
    let segMap = {};
    let evidenceBytesMap = {};
    let proMap = {};
    if (ids.length) {
      const { rows: segs } = await pg.query(
        'SELECT document_id, count(*)::int AS c, COALESCE(SUM(octet_length(content)), 0)::text AS evidence_bytes FROM knowledge_segments WHERE org_id=$1 AND document_id = ANY($2::uuid[]) GROUP BY document_id',
        [ORG, ids]
      );
      for (const r of segs) {
        segMap[r.document_id] = r.c;
        evidenceBytesMap[r.document_id] = Number(r.evidence_bytes || 0);
      }
      proMap = await countDerivedMemoriesByDocumentIds(ids);
    }
    const documents = docs.map((d) => ({
      id: d.id,
      userId: d.user_id,
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
      evidenceBytes: evidenceBytesMap[d.id] || 0,
      promotedCount: proMap[d.id] || 0,
    }));
    return { documents, pagination: { total, limit, offset, hasMore: offset + limit < total } };
  },

  // ── KB doc DETAIL (self-host READ) ───────────────────────────────────────
  // Returns one doc + its segments + promoted memories (memories tagged filename:<filename>).
  // Response: { document, segments, promotedMemories, segmentCount, promotedCount }
  '/v1/kb-doc-detail': async (b) => {
    if (!b.documentId) return { error: 'documentId required' };
      const detailConds = ['d.id=$1', 'd.org_id=$2', 'd.deleted_at IS NULL'];
      const detailArgs = [b.documentId, ORG];
      appendDocumentAccess(detailConds, detailArgs, 'd', b.access);
      const { rows: docRows } = await pg.query(
      `SELECT d.id, d.user_id, d.filename, d.content_type, d.status, d.metadata, d.created_at FROM knowledge_documents d WHERE ${detailConds.join(' AND ')}`,
      detailArgs,
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
    // Promoted memories: prefer document-id provenance, with filename tag as legacy fallback.
    let promotedMemories = [];
    {
      const tags = [`doc-id:${d.id}`, ...(d.filename ? [`filename:${d.filename}`] : [])];
      const { rows: mems } = await pg.query(
        `SELECT id, title, content, memory_type, confidence, tags, created_at
         FROM memories WHERE org_id=$1 AND deleted_at IS NULL AND tags && $2::text[]
         ORDER BY created_at DESC LIMIT 100`,
        [ORG, tags]
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
      userId: d.user_id,
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
    const derivedCounts = await countDerivedMemoriesByDocumentIds([d.id]);
    return { document, segments, promotedMemories, segmentCount: segments.length, promotedCount: derivedCounts[d.id] ?? promotedMemories.length };
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
      if (b.metadata_merge && typeof b.metadata_merge === 'object') {
        args.push(JSON.stringify(b.metadata_merge));
        sets.push(`metadata = metadata || $${args.length}::jsonb`);
      }
      if (!sets.length) return { ok: true };
      await pg.query(`UPDATE tara_calls SET ${sets.join(', ')} WHERE session_id=$1 AND org_id=$2`, args);
      return { ok: true };
    }
    if (op === 'turn') {
      // One row per conversational turn: role='turn', content = JSON payload
      // {seq, user_text, agent_text, llm_ttfb_ms} — the FE pair shape without
      // a schema change.
      const sid = b.session_id;
      if (!sid) return { ok: false, error: 'session_id required' };
      const { rows } = await pg.query('SELECT id FROM tara_calls WHERE session_id=$1 AND org_id=$2', [sid, ORG]);
      const callId = rows[0]?.id;
      if (!callId) return { ok: false, error: 'call not found' };
      await pg.query(
        'INSERT INTO tara_turns (org_id, call_id, role, content) VALUES ($1,$2,$3,$4)',
        [ORG, callId, 'turn', JSON.stringify({
          seq: b.seq || null, user_text: b.user_text || '', agent_text: b.agent_text || '',
          llm_ttfb_ms: b.llm_ttfb_ms || null,
        })]);
      return { ok: true };
    }
    if (op === 'list') {
      const lim = Math.min(100, Number(b.limit) || 30);
      const { rows } = await pg.query(
        `SELECT id, session_id, status, turn_count, prompt_tokens, completion_tokens, metadata, created_at
         FROM tara_calls WHERE org_id=$1 ORDER BY created_at DESC LIMIT $2`, [ORG, lim]);
      return { calls: rows };
    }
    if (op === 'detail') {
      const { rows } = await pg.query(
        `SELECT id, session_id, status, turn_count, prompt_tokens, completion_tokens, metadata, created_at
         FROM tara_calls WHERE id=$1 AND org_id=$2`, [b.id, ORG]);
      if (!rows[0]) return { call: null, turns: [] };
      const t = await pg.query(
        'SELECT content, created_at FROM tara_turns WHERE call_id=$1 AND org_id=$2 ORDER BY created_at ASC',
        [b.id, ORG]);
      return { call: rows[0], turns: t.rows };
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
    const qdrantOk = await qdrantHealthy();
    return send(res, pgOk && qdrantOk ? 200 : 503, {
      ok: pgOk && qdrantOk,
      org: ORG,
      store: 'pg-qdrant',
      storage_mode: 'byod_postgres_qdrant',
      protocol_version: PROTOCOL_VERSION,
      agent_release: AGENT_RELEASE,
      pg: pgOk,
      qdrant: qdrantOk,
      dim: DIM,
      schemaVersion: SCHEMA_VERSION,
    });
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
  catch (e) { console.error(`[hm-agent] ${req.url} failed:`, e.message); send(res, e.statusCode || 500, { error: e.message }); }
}).listen(PORT, () => console.log(`[hm-agent] listening :${PORT} (org ${ORG})`));
