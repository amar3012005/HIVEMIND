export function sanitizeEvidenceText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

export function sanitizeEvidenceJson(value) {
  if (typeof value === 'string') return sanitizeEvidenceText(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeEvidenceJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [sanitizeEvidenceText(key), sanitizeEvidenceJson(item)]));
  }
  return value;
}

function clean(value) {
  const text = sanitizeEvidenceText(value).trim();
  return text || null;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function list(value) {
  return [...new Set((Array.isArray(value) ? value : (value ? [value] : []))
    .map((item) => clean(item)).filter(Boolean))];
}

function stableCitationId(documentId, segmentIndex) {
  return `DOC-${clean(documentId) || 'UNKNOWN'}-SEG-${evidenceOrdinal(segmentIndex)}`;
}

export function evidenceOrdinal(segmentIndex) {
  return String(Math.max(0, Number(segmentIndex) || 0) + 1).padStart(2, '0');
}

export function evidenceTitle(sourceTitle, segmentIndex) {
  return `${clean(sourceTitle) || 'Untitled document'} : ${evidenceOrdinal(segmentIndex)}`;
}

export function memoryTitle(sourceTitle, extractedTitle) {
  const source = clean(sourceTitle) || 'Untitled document';
  const title = clean(extractedTitle) || 'Summary';
  return `${source} : ${title}`;
}

/** Metadata shared by PostgreSQL KnowledgeSegment rows and vector payloads. */
export function buildEvidenceMetadata({
  existing = {}, documentId, sourceId, sourceTitle, sourceKind = 'document',
  segmentId, segmentIndex, segmentType, userId, orgId, scope, projectId,
  projectIds, teamId, startPage, endPage, headingPath, createdAt, documentDate,
  eventTime, validFrom, validTo, knownAt, language, contentHash,
  sourceType = 'upload', sourcePlatform = 'knowledge_base',
  embeddingModel = process.env.SINGULANCE_EMBED_MODEL || process.env.EMBEDDING_MODEL_NAME
    || process.env.BLAIQ_EMBED_MODEL || process.env.OPENROUTER_EMBED_MODEL || 'bge-m3',
  embeddingVersion = process.env.EMBEDDING_VERSION || process.env.EMBEDDING_MODEL_VERSION || '1',
} = {}) {
  const title = evidenceTitle(sourceTitle, segmentIndex);
  const projects = list(projectIds?.length ? projectIds : (projectId || existing.project_ids || existing.project_id));
  const pages = { start: startPage ?? existing.page_start ?? existing.start_page ?? null,
    end: endPage ?? existing.page_end ?? existing.end_page ?? null };
  return sanitizeEvidenceJson({
    ...existing,
    semantic_layer: 'evidence',
    evidence_title: title,
    citation_id: stableCitationId(documentId || sourceId, segmentIndex),
    segment_id: segmentId || existing.segment_id || null,
    document_id: documentId || existing.document_id || null,
    source_id: sourceId || documentId || null,
    source_document_id: documentId || null,
    source_title: clean(sourceTitle),
    document_title: clean(sourceTitle),
    source_kind: sourceKind,
    source_type: sourceType || existing.source_type || 'upload',
    source_platform: sourcePlatform || existing.source_platform || 'knowledge_base',
    segment_index: Number(segmentIndex) || 0,
    segment_ordinal: evidenceOrdinal(segmentIndex),
    segment_type: segmentType || null,
    uploaded_by_user_id: userId || existing.uploaded_by_user_id || existing.uploader_user_id || null,
    uploader_user_id: userId || existing.uploader_user_id || existing.uploaded_by_user_id || null,
    org_id: orgId || null,
    scope: scope || existing.scope || null,
    project_id: projectId || projects[0] || existing.project_id || null,
    project_ids: projects,
    team_id: teamId || existing.team_id || null,
    page_start: pages.start,
    page_end: pages.end,
    start_page: pages.start,
    end_page: pages.end,
    heading_path: list(headingPath?.length ? headingPath : existing.heading_path),
    language: clean(language) || clean(existing.language),
    document_date: iso(documentDate),
    event_time: iso(eventTime || existing.event_time),
    valid_from: iso(validFrom || existing.valid_from || eventTime || existing.event_time),
    valid_to: iso(validTo || existing.valid_to),
    known_at: iso(knownAt || existing.known_at || createdAt),
    created_at: iso(createdAt),
    content_hash: clean(contentHash) || clean(existing.content_hash),
    embedding_model: clean(embeddingModel) || clean(existing.embedding_model),
    embedding_version: clean(embeddingVersion) || clean(existing.embedding_version),
  });
}

export function buildEvidenceVectorPayload(segment = {}) {
  const metadata = buildEvidenceMetadata({
    existing: segment.metadata || {},
    documentId: segment.documentId,
    sourceId: segment.metadata?.source_id,
    sourceTitle: segment.metadata?.source_title || segment.metadata?.document_title
      || segment.documentTitle || segment.document?.title,
    sourceKind: segment.metadata?.source_kind || 'document',
    segmentId: segment.id,
    segmentIndex: segment.segmentIndex,
    segmentType: segment.segmentType,
    userId: segment.userId,
    orgId: segment.orgId,
    scope: segment.metadata?.scope,
    projectId: segment.metadata?.project_id,
    projectIds: segment.metadata?.project_ids,
    teamId: segment.metadata?.team_id,
    startPage: segment.startPage, endPage: segment.endPage,
    headingPath: segment.metadata?.heading_path,
    createdAt: segment.createdAt,
    documentDate: segment.metadata?.document_date,
    eventTime: segment.metadata?.event_time, validFrom: segment.metadata?.valid_from,
    validTo: segment.metadata?.valid_to, knownAt: segment.metadata?.known_at,
    language: segment.metadata?.language, contentHash: segment.contentHash,
    sourceType: segment.metadata?.source_type, sourcePlatform: segment.metadata?.source_platform,
    embeddingModel: segment.embeddingModel || segment.metadata?.embedding_model,
    embeddingVersion: segment.embeddingVersion || segment.metadata?.embedding_version,
  });
  return sanitizeEvidenceJson({
    segment_id: segment.id,
    document_id: segment.documentId,
    user_id: segment.userId,
    org_id: segment.orgId,
    segment_type: segment.segmentType,
    layer: 'evidence',
    ...metadata,
    content_preview: sanitizeEvidenceText(segment.content).slice(0, 200),
  });
}

const VECTOR_REQUIRED = [
  'segment_id', 'document_id', 'document_title', 'citation_id', 'source_type',
  'source_platform', 'uploaded_by_user_id', 'org_id', 'scope', 'content_hash',
  'embedding_model', 'embedding_version',
];

export function assertEvidenceVectorPayload(payload = {}) {
  const missing = VECTOR_REQUIRED.filter((field) => {
    const value = payload[field];
    return value == null || value === '';
  });
  if (missing.length) {
    const error = new Error(`evidence vector metadata missing: ${missing.join(', ')}`);
    error.code = 'EVIDENCE_VECTOR_METADATA_INVALID';
    error.missing = missing;
    throw error;
  }
  return payload;
}

export function buildMemoryProvenance({
  existing = {}, documentId, sourceId, sourceTitle, sourceKind = 'document',
  memoryId, segmentIds = [], userId, orgId, scope, projectIds = [], teamId,
  documentDate, eventTime, validFrom, validTo, knownAt, claimKind, isLatest = true,
  language, contentHash,
} = {}) {
  const supporting = list(segmentIds);
  return {
    ...existing,
    memory_id: memoryId || existing.memory_id || null,
    semantic_layer: 'memory',
    source_id: sourceId || documentId || null,
    source_document_id: documentId || null,
    source_title: clean(sourceTitle),
    source_kind: sourceKind,
    supporting_segment_ids: supporting,
    support_segment_ids: supporting,
    uploaded_by_user_id: userId || existing.uploaded_by_user_id || existing.uploader_user_id || null,
    uploader_user_id: userId || existing.uploader_user_id || existing.uploaded_by_user_id || null,
    org_id: orgId || null,
    scope: scope || null,
    project_ids: Array.isArray(projectIds) ? projectIds : [],
    team_id: teamId || null,
    document_date: iso(documentDate),
    event_time: iso(eventTime || existing.event_time),
    valid_from: iso(validFrom || existing.valid_from || eventTime || existing.event_time),
    valid_to: iso(validTo || existing.valid_to),
    known_at: iso(knownAt || existing.known_at),
    claim_kind: clean(claimKind) || clean(existing.claim_kind) || 'fact',
    is_latest: isLatest !== false,
    language: clean(language) || clean(existing.language),
    content_hash: clean(contentHash) || clean(existing.content_hash),
  };
}
