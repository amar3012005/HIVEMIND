/**
 * Canonical Ingest Envelope — the single front door for memory creation.
 *
 * Every source (KB upload, connector record, MCP save, meeting notes, chat
 * autosave, raw API) normalizes into ONE envelope shape and calls one
 * dispatcher (`DocumentFirstIngestion.ingestSource`). From that point the
 * pipeline is IDENTICAL regardless of where the data came from:
 *   normalizeProvenance() → mode(document|atomic) → existing proven pipeline
 *     - document → _promoteMemories  (chunk → unified extract → fact memories)
 *     - atomic   → engine.ingestMemory (single memory, smart-router, edges)
 *
 * This module is PURE (no DB, no network, no engine refs) so the schema,
 * provenance normalization, and mode detection are unit-testable in isolation
 * and applied symmetrically. The dispatcher that uses these lives on the
 * ingestion engine (it needs the engine + pipeline refs).
 *
 * The value is uniform PROVENANCE: today each source hand-rolls its own
 * source_platform / source_id / date shape. Here it is normalized ONCE — every
 * memory, no matter the source, carries the same canonical source_metadata +
 * provenance tags + event date (document_date / valid_from). That uniformity is
 * what makes recall, dedup, and audit consistent across ingestion types.
 */

/** Allowed ingestion source types. `api` = raw external caller of the endpoint. */
export const INGEST_SOURCE_TYPES = Object.freeze([
  'kb', 'connector', 'mcp', 'meeting', 'chat', 'api',
]);

/** Allowed memory scopes (mirrors the upload-route / save scopes). */
export const INGEST_SCOPES = Object.freeze([
  'personal', 'organization', 'project', 'team',
]);

// Relationship is intentionally absent: graph semantics are typed edges, not
// user-visible memory rows. Synthesis is accepted only for trusted internal
// producers; source extraction itself never emits it.
export const CANONICAL_MEMORY_TYPES = Object.freeze([
  'fact', 'preference', 'decision', 'lesson', 'goal', 'event',
  'summary', 'synthesis', 'conversation',
]);

const LEGACY_MEMORY_TYPE_MAP = Object.freeze({
  note: 'fact',
  task: 'goal',
  commitment: 'goal',
  observation: 'fact',
  insight: 'lesson',
});

/** Default per-source platform label when the caller does not name one. */
const DEFAULT_PLATFORM_BY_TYPE = Object.freeze({
  kb: 'knowledge_base',
  connector: 'connector',
  mcp: 'mcp',
  meeting: 'meeting',
  chat: 'chat',
  api: 'api',
});

/** Content length (chars) at/above which a connector/api record is treated as a
 * document (chunked into multiple facts) rather than one atomic memory. */
const DEFAULT_DOCUMENT_THRESHOLD = 1200;

/**
 * @typedef {Object} IngestSource
 * @property {('kb'|'connector'|'mcp'|'meeting'|'chat'|'api')} type  where the data came from
 * @property {string} [platform]   provider/system label (e.g. 'gmail', 'knowledge_base'); defaults per type
 * @property {string} [provider]   connector provider key (gmail/slack/...) — folds into platform as connector:<provider>
 * @property {string} [sourceId]   stable external id (message id, doc id, meeting id)
 * @property {string} [url]        canonical source URL
 * @property {string} [title]      human title of the source item
 * @property {string} [filename]   filename when the payload is a file
 * @property {Object} [metadata]   provider-native source identifiers
 */

/**
 * @typedef {Object} IngestFile
 * @property {Buffer} buffer
 * @property {string} contentType
 * @property {string} filename
 */

/**
 * @typedef {Object} IngestEnvelope
 * @property {string} userId
 * @property {string} orgId
 * @property {string} [content]            already-extracted text (atomic or text-document)
 * @property {string} [title]              memory title (atomic mode)
 * @property {IngestFile} [file]           raw file (document mode; parsed by docling/OCR/STT)
 * @property {IngestSource} source
 * @property {(string|Date)} [occurredAt]  event date (NOT ingest time) → document_date / valid_from
 * @property {('personal'|'organization'|'project'|'team')} [scope]
 * @property {string} [projectId]
 * @property {string} [primaryTeamId]
 * @property {('document'|'atomic'|'evidence')} [mode]  override; auto-detected when omitted. 'evidence' = one recall-excluded, non-distilled memory (transcripts/raw evidence)
 * @property {('both'|'evidence')} [ingestMode] document materialization policy; independent from legacy mode
 * @property {string[]} [tags]
 * @property {Object} [metadata]
 * @property {number} [documentThreshold]   override DEFAULT_DOCUMENT_THRESHOLD
 * @property {Object} [relationship]         atomic-save supersession descriptor (engine-owned)
 * @property {string} [relatedTo]            id this atomic memory supersedes/extends
 * @property {Function} [onProgress]         internal-only per-stage progress callback (document+file)
 */

/**
 * Validate a canonical ingest envelope. Returns { ok:true } or
 * { ok:false, error } — never throws, so callers shape their own HTTP/RPC error.
 * @param {IngestEnvelope} env
 * @returns {{ok:true}|{ok:false,error:string}}
 */
export function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'envelope must be an object' };
  if (!env.userId || typeof env.userId !== 'string') return { ok: false, error: 'userId is required' };
  if (!env.orgId || typeof env.orgId !== 'string') return { ok: false, error: 'orgId is required' };
  if (!env.source || typeof env.source !== 'object') return { ok: false, error: 'source is required' };
  if (!INGEST_SOURCE_TYPES.includes(env.source.type)) {
    return { ok: false, error: `source.type must be one of ${INGEST_SOURCE_TYPES.join('|')}` };
  }
  const hasFile = env.file && Buffer.isBuffer(env.file.buffer) && env.file.buffer.length > 0;
  const hasContent = typeof env.content === 'string' && env.content.trim() !== '';
  if (!hasFile && !hasContent) {
    return { ok: false, error: 'envelope requires non-empty content or file.buffer' };
  }
  if (hasFile && (!env.file.contentType || !env.file.filename)) {
    return { ok: false, error: 'file requires contentType and filename' };
  }
  if (env.scope && !INGEST_SCOPES.includes(env.scope)) {
    return { ok: false, error: `scope must be one of ${INGEST_SCOPES.join('|')}` };
  }
  if (env.mode && env.mode !== 'document' && env.mode !== 'atomic' && env.mode !== 'evidence') {
    return { ok: false, error: 'mode must be document|atomic|evidence' };
  }
  if (env.ingestMode && env.ingestMode !== 'both' && env.ingestMode !== 'evidence') {
    return { ok: false, error: 'ingestMode must be both|evidence' };
  }
  const memoryType = env.metadata?.memory_type || env.metadata?.memoryType;
  if (memoryType && !CANONICAL_MEMORY_TYPES.includes(memoryType)) {
    return { ok: false, error: `metadata.memory_type must be one of ${CANONICAL_MEMORY_TYPES.join('|')}` };
  }
  return { ok: true };
}

/**
 * Resolve the canonical platform label from the source descriptor.
 * connector + provider → `connector:<provider>`; else explicit platform; else
 * per-type default.
 * @param {IngestSource} source
 * @returns {string}
 */
export function resolvePlatform(source) {
  if (source.type === 'connector' && source.provider) return `connector:${source.provider}`;
  if (source.platform) return source.platform;
  return DEFAULT_PLATFORM_BY_TYPE[source.type] || 'unknown';
}

/**
 * Normalize an envelope's provenance into the ONE shape the memory engine
 * consumes everywhere — identical for KB, connector, MCP, meeting, chat.
 * @param {IngestEnvelope} env
 * @returns {{
 *   sourcePlatform: string,
 *   sourceMetadata: Object,
 *   documentDate: (Date|null),
 *   provenanceTags: string[],
 *   title: (string|null),
 * }}
 */
export function normalizeProvenance(env) {
  const source = env.source || {};
  const platform = resolvePlatform(source);
  const sourceId = source.sourceId || source.source_id || source.filename || null;
  const sourceUrl = source.url || null;
  const title = env.title || source.title || source.filename || null;

  let documentDate = null;
  if (env.occurredAt) {
    const d = env.occurredAt instanceof Date ? env.occurredAt : new Date(env.occurredAt);
    if (!Number.isNaN(d.getTime())) documentDate = d;
  }

  // Ingest-time (known_at) timestamp — when HIVEMIND recorded this memory, as
  // distinct from documentDate/occurredAt (when the fact was true / the event
  // happened). Every canonical memory carries it in THREE places: metadata
  // (recorded_at, queryable), a ts: tag (read by temporal event-time ranking),
  // and — appended by the caller — the content body. Idempotent: an existing
  // recorded_at (re-ingest / dedup) is preserved so the timestamp and its
  // ts: tag never drift or stack on re-processing.
  const existingRecordedAt = source.metadata?.recorded_at;
  const recordedAtDate = existingRecordedAt && !Number.isNaN(new Date(existingRecordedAt).getTime())
    ? new Date(existingRecordedAt)
    : new Date();
  const recordedAtIso = recordedAtDate.toISOString();
  const recordedAtDay = recordedAtIso.slice(0, 10);

  const sourceMetadata = {
    ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}),
    source_platform: platform,
    source_type: source.type,
    source_id: sourceId,
    source_url: sourceUrl,
    ingest_source: source.type,
    recorded_at: recordedAtIso,
  };

  // Uniform provenance tags on EVERY memory regardless of source. Slugged +
  // length-capped so they never blow up the tag index.
  const slug = (v) => String(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const provenanceTags = [
    `source:${source.type}`,
    `platform:${slug(platform)}`,
    `ts:${recordedAtDay}`,
  ];
  if (sourceId) provenanceTags.push(`source-id:${slug(sourceId)}`);
  if (source.filename) provenanceTags.push(`filename:${source.filename}`);

  return { sourcePlatform: platform, sourceMetadata, documentDate, provenanceTags, title, recordedAtIso };
}

/**
 * Decide document vs atomic. Explicit mode wins; else per-source default:
 *   - file present, kb, meeting → document
 *   - mcp, chat → atomic (the caller is saving ONE memory; never chunk it)
 *   - connector, api → document when content ≥ threshold, else atomic
 * @param {IngestEnvelope} env
 * @returns {'document'|'atomic'}
 */
export function detectMode(env) {
  if (env.mode === 'document' || env.mode === 'atomic' || env.mode === 'evidence') return env.mode;
  if (env.file) return 'document';
  const type = env.source?.type;
  if (type === 'mcp' || type === 'chat') return 'atomic';
  if (type === 'kb' || type === 'meeting') return 'document';
  const len = (env.content || '').length;
  const threshold = Number(env.documentThreshold) || DEFAULT_DOCUMENT_THRESHOLD;
  return len >= threshold ? 'document' : 'atomic';
}

export function canonicalMemoryType(value, fallback = 'fact') {
  const normalized = String(value || '').trim().toLowerCase();
  if (CANONICAL_MEMORY_TYPES.includes(normalized)) return normalized;
  return LEGACY_MEMORY_TYPE_MAP[normalized] || fallback;
}

export function canonicalSourceType(payload = {}) {
  const metadata = payload.source_metadata || payload.sourceMetadata || {};
  const explicit = metadata.ingest_source || metadata.source_type || payload.ingest_source;
  if (INGEST_SOURCE_TYPES.includes(explicit)) return explicit;
  const platform = String(metadata.source_platform || payload.source_platform || payload.source_type || '').toLowerCase();
  if (platform.includes('knowledge') || platform === 'kb') return 'kb';
  if (platform.includes('meeting') || platform.includes('tara')) return 'meeting';
  if (platform.includes('chat') || platform.includes('talk-to-hive')) return 'chat';
  if (platform.includes('mcp')) return 'mcp';
  if (platform && platform !== 'api' && platform !== 'webapp') return 'connector';
  return 'api';
}

/**
 * Normalize an existing flat ingest payload at compatibility boundaries. New
 * code should construct an IngestEnvelope directly; this keeps legacy routes
 * on the same validation, provenance, residency, and quality path meanwhile.
 */
export function legacyPayloadToEnvelope(payload, overrides = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const sourceMetadata = payload.source_metadata || payload.sourceMetadata || {};
  const sourceType = overrides.sourceType || canonicalSourceType(payload);
  const platform = overrides.platform || sourceMetadata.source_platform || payload.source_platform || undefined;
  const projectIds = Array.isArray(payload.project_ids) ? payload.project_ids.filter(Boolean) : [];
  const memoryType = canonicalMemoryType(payload.memory_type || payload.memoryType || payload.metadata?.memory_type);
  return {
    userId: payload.user_id || payload.userId,
    orgId: payload.org_id || payload.orgId,
    content: payload.content,
    title: payload.title,
    occurredAt: payload.document_date || payload.documentDate || payload.event_time || undefined,
    scope: payload.scope || payload.target_scope || undefined,
    projectId: payload.project_id || projectIds[0] || undefined,
    primaryTeamId: payload.primary_team_id || payload.primaryTeamId || undefined,
    mode: overrides.mode || payload.ingest_mode || undefined,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    relationship: payload.relationship || undefined,
    relatedTo: payload.related_to || payload.relatedTo || undefined,
    metadata: {
      ...(payload.metadata || {}),
      memory_type: memoryType,
      ...(payload.valid_from || payload.validFrom
        ? { valid_from: payload.valid_from || payload.validFrom }
        : {}),
      ...(payload.valid_to || payload.validTo
        ? { valid_to: payload.valid_to || payload.validTo }
        : {}),
      // Structured save intents already extracted these entities. Preserve
      // them across the legacy compatibility boundary so entity materialization
      // does not depend on a second LLM returning valid JSON.
      ...(Array.isArray(payload.entities) && payload.entities.length
        ? { extracted_entities: payload.entities.slice(0, 12) }
        : {}),
      visibility: payload.visibility || payload.metadata?.visibility,
      project_ids: projectIds,
      // V5: bounded engine processing-flag passthrough (enterprise/bulk callers).
      // Only these four are honored downstream; anything else stays metadata-only.
      ...(payload.skip_fact_extraction === true ? { skip_fact_extraction: true } : {}),
      ...(payload.skipPredictCalibrate === true ? { skipPredictCalibrate: true } : {}),
      ...(payload.skipProcessing === true ? { skipProcessing: true } : {}),
      ...(payload.smartIngest === false ? { smartIngest: false } : {}),
    },
    source: {
      type: sourceType,
      platform,
      provider: overrides.provider || sourceMetadata.provider || undefined,
      sourceId: sourceMetadata.source_id || payload.source_id || undefined,
      url: sourceMetadata.source_url || payload.source_url || undefined,
      title: payload.title,
      filename: sourceMetadata.filename || payload.filename || undefined,
      metadata: sourceMetadata,
    },
  };
}
