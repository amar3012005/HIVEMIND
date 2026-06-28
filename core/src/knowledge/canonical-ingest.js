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
  const sourceId = source.sourceId || source.filename || null;
  const sourceUrl = source.url || null;
  const title = env.title || source.title || source.filename || null;

  let documentDate = null;
  if (env.occurredAt) {
    const d = env.occurredAt instanceof Date ? env.occurredAt : new Date(env.occurredAt);
    if (!Number.isNaN(d.getTime())) documentDate = d;
  }

  const sourceMetadata = {
    source_platform: platform,
    source_type: source.type,
    source_id: sourceId,
    source_url: sourceUrl,
    ingest_source: source.type,
  };

  // Uniform provenance tags on EVERY memory regardless of source. Slugged +
  // length-capped so they never blow up the tag index.
  const slug = (v) => String(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const provenanceTags = [
    `source:${source.type}`,
    `platform:${slug(platform)}`,
  ];
  if (sourceId) provenanceTags.push(`source-id:${slug(sourceId)}`);
  if (source.filename) provenanceTags.push(`filename:${source.filename}`);

  return { sourcePlatform: platform, sourceMetadata, documentDate, provenanceTags, title };
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
