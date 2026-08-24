function clean(value) {
  const text = String(value || '').trim();
  return text || null;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  teamId, startPage, endPage, createdAt, documentDate, knownAt,
} = {}) {
  const title = evidenceTitle(sourceTitle, segmentIndex);
  return {
    ...existing,
    semantic_layer: 'evidence',
    evidence_title: title,
    citation_id: segmentId || `${documentId || sourceId || 'document'}:${evidenceOrdinal(segmentIndex)}`,
    source_id: sourceId || documentId || null,
    source_document_id: documentId || null,
    source_title: clean(sourceTitle),
    document_title: clean(sourceTitle),
    source_kind: sourceKind,
    segment_index: Number(segmentIndex) || 0,
    segment_ordinal: evidenceOrdinal(segmentIndex),
    segment_type: segmentType || null,
    uploader_user_id: userId || null,
    org_id: orgId || null,
    scope: scope || existing.scope || null,
    project_id: projectId || existing.project_id || null,
    team_id: teamId || existing.team_id || null,
    start_page: startPage ?? null,
    end_page: endPage ?? null,
    document_date: iso(documentDate),
    known_at: iso(knownAt || createdAt),
    created_at: iso(createdAt),
  };
}

export function buildEvidenceVectorPayload(segment = {}) {
  const metadata = buildEvidenceMetadata({
    existing: segment.metadata || {},
    documentId: segment.documentId,
    sourceId: segment.metadata?.source_id,
    sourceTitle: segment.metadata?.source_title || segment.metadata?.document_title,
    sourceKind: segment.metadata?.source_kind || 'document',
    segmentId: segment.id,
    segmentIndex: segment.segmentIndex,
    segmentType: segment.segmentType,
    userId: segment.userId,
    orgId: segment.orgId,
    scope: segment.metadata?.scope,
    projectId: segment.metadata?.project_id,
    teamId: segment.metadata?.team_id,
    startPage: segment.startPage,
    endPage: segment.endPage,
    createdAt: segment.createdAt,
    documentDate: segment.metadata?.document_date,
    knownAt: segment.metadata?.known_at,
  });
  return {
    segment_id: segment.id,
    document_id: segment.documentId,
    user_id: segment.userId,
    org_id: segment.orgId,
    segment_type: segment.segmentType,
    layer: 'evidence',
    ...metadata,
    content_preview: String(segment.content || '').slice(0, 200),
  };
}

export function buildMemoryProvenance({
  existing = {}, documentId, sourceId, sourceTitle, sourceKind = 'document',
  segmentIds = [], userId, orgId, scope, projectIds = [], teamId,
  documentDate, knownAt,
} = {}) {
  return {
    ...existing,
    semantic_layer: 'memory',
    source_id: sourceId || documentId || null,
    source_document_id: documentId || null,
    source_title: clean(sourceTitle),
    source_kind: sourceKind,
    support_segment_ids: [...new Set((segmentIds || []).filter(Boolean))],
    uploader_user_id: userId || null,
    org_id: orgId || null,
    scope: scope || null,
    project_ids: Array.isArray(projectIds) ? projectIds : [],
    team_id: teamId || null,
    document_date: iso(documentDate),
    known_at: iso(knownAt),
  };
}
