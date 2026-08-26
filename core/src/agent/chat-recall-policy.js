function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function documentIdentity(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  const taggedId = tags.find((tag) => typeof tag === 'string' && tag.startsWith('doc-id:'));
  const taggedTitle = tags.find((tag) => typeof tag === 'string' && tag.startsWith('filename:'));
  const metadata = {
    ...(item?.metadata || {}),
    ...(item?.sourceMetadata || {}),
    ...(item?.source_metadata || {}),
  };
  const citation = item?.citation || item?.source || {};
  const explicitTitle = item?.document_title || item?.documentTitle
    || metadata.source_title || metadata.document_title || metadata.filename
    || citation.source_label || citation.title || null;
  return {
    document_id: metadata.document_id || metadata.source_document_id || item?.document_id || item?.documentId
      || (taggedId ? taggedId.slice('doc-id:'.length) : null),
    title: explicitTitle
      || (taggedTitle ? taggedTitle.slice('filename:'.length) : null)
      || item?.title || null,
    anchored: !!(taggedId || taggedTitle || explicitTitle || metadata.document_id
      || metadata.source_document_id || item?.document_id || item?.documentId),
  };
}

function titleMatches(actual, expected) {
  const stored = normalized(actual);
  const requested = normalized(expected);
  if (!stored || !requested) return false;
  return stored === requested
    || stored.startsWith(`${requested} :`)
    || stored.startsWith(`${requested}:`)
    || stored.startsWith(`${requested} —`)
    || stored.startsWith(`${requested} -`);
}

function sourceKindMatches(item, expectedKind) {
  const wanted = normalized(expectedKind);
  if (!wanted) return false;
  const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => normalized(tag)) : [];
  const metadata = item?.source_metadata || item?.sourceMetadata || {};
  return tags.includes(`kind:${wanted}`)
    || normalized(metadata.kind) === wanted
    || normalized(metadata.source_kind) === wanted
    || normalized(item?.source_kind) === wanted;
}

export function resolveDocumentArtifact(memories = []) {
  for (const memory of memories) {
    const identity = documentIdentity(memory);
    if (identity.anchored) return { document_id: identity.document_id, title: identity.title };
  }
  return null;
}

export function assessRecallCoverage({ plan = {}, memories = [], evidence = [], relationships = [] } = {}) {
  // A retrieved document is evidence, not an instruction to narrow the turn to
  // that document. Only the structured planner or an explicit caller control
  // may establish a source boundary. Otherwise a broad entity question can be
  // accidentally converted into "what does the first matching PDF say?".
  const source = plan.source || null;
  const evidenceFound = memories.length > 0 || evidence.length > 0;
  // A named document can be represented by either lane. Evidence-only uploads
  // resolve through KnowledgeSegment rows; memories+evidence uploads may rank
  // their document-anchored memories above the raw segments. Both are verified
  // source material when they carry an exact doc-id / filename / document-title
  // anchor. Restricting identity checks to the evidence lane caused a valid
  // memory-only top-K result to fail source coverage and skip final synthesis.
  const sourceItems = [...memories, ...evidence];
  const sourceIds = new Set(sourceItems.map((item) => documentIdentity(item).document_id).filter(Boolean));
  const sourceTitles = sourceItems.map((item) => documentIdentity(item).title).filter(Boolean);
  // A source boundary can name a stored document, or refer to a direct upload
  // such as "the latest image". The latter is represented by its promoted
  // memory before it has a KnowledgeDocument row, so document identity alone
  // would wrongly discard the exact retrieved memory as "not covered".
  const sourceCovered = !source || (
    (source.document_id && sourceIds.has(source.document_id))
    || (source.title && sourceTitles.some((title) => titleMatches(title, source.title)))
    || (source.kind && [...memories, ...evidence].some((item) => sourceKindMatches(item, source.kind)))
  );

  const entities = Array.isArray(plan.named_entities) ? plan.named_entities.filter(Boolean) : [];
  const searchable = [...memories, ...evidence].map((item) => normalized([
    item?.title,
    item?.document_title,
    item?.content,
    item?.snippet,
    ...(Array.isArray(item?.tags) ? item.tags : []),
  ].filter(Boolean).join(' ')));
  const coveredEntities = entities.filter((entity) => searchable.some((text) => text.includes(normalized(entity))));
  const temporalRequested = !!(plan.time?.valid_at || plan.time?.known_at || plan.time?.range
    || plan.time_travel?.valid_time || plan.time_travel?.transaction_time);
  const graphRequested = plan.needs_traverse === true;

  return {
    source,
    evidence_found: evidenceFound,
    source_requested: !!source,
    source_covered: sourceCovered,
    entities_requested: entities.length,
    entities_covered: coveredEntities.length,
    temporal_requested: temporalRequested,
    temporal_covered: !temporalRequested || memories.length > 0,
    graph_requested: graphRequested,
    graph_covered: !graphRequested || relationships.length > 0,
    complete: evidenceFound
      && sourceCovered
      && coveredEntities.length === entities.length
      && (!temporalRequested || memories.length > 0)
      && (!graphRequested || relationships.length > 0),
  };
}

export function chooseRecallEscalation({ plan = {}, coverage = {}, query } = {}) {
  if (coverage.source_requested && !coverage.source_covered) {
    return {
      reason: 'source_coverage',
      args: {
        query,
        mode: 'explain',
        limit: 12,
        ...(coverage.source?.document_id ? { source_document_id: coverage.source.document_id } : {}),
        ...(!coverage.source?.document_id && coverage.source?.title ? { source_title: coverage.source.title } : {}),
      },
    };
  }
  if (coverage.temporal_requested && !coverage.temporal_covered) {
    const validAt = plan.time?.valid_at || plan.time_travel?.valid_time || null;
    const knownAt = plan.time?.known_at || plan.time_travel?.transaction_time || null;
    return {
      reason: 'temporal_coverage',
      args: {
        query,
        mode: 'explain',
        limit: 12,
        time: {
          ...(validAt ? { valid_at: validAt } : {}),
          ...(knownAt ? { known_at: knownAt } : {}),
          ...(plan.time?.range ? { range: plan.time.range } : {}),
        },
      },
    };
  }
  // Generic insufficiency is handled by progressive reveal from the already
  // ranked pool. Re-running the complete retrieval pipeline here doubled
  // remote fan-out and reranking before the answer model had even inspected
  // ranks 1-5. A genuinely empty result may still use the single, distinct
  // recovery rewrite owned by the top-level chat orchestration.
  if (coverage.graph_requested && !coverage.graph_covered) {
    return { reason: 'graph_coverage', args: { query, mode: 'explain', limit: 12 } };
  }
  return null;
}

export function applyExplicitRecallControls(plan, { mode, source, time } = {}) {
  const next = { ...plan };
  if (['fact', 'explain', 'full'].includes(mode)) {
    next.explicit_recall_mode = mode;
    next.recall_mode = mode;
  }
  if (source && typeof source === 'object') {
    const explicitSource = {
      ...(typeof source.document_id === 'string' && source.document_id.trim()
        ? { document_id: source.document_id.trim() }
        : {}),
      ...(typeof source.title === 'string' && source.title.trim() ? { title: source.title.trim() } : {}),
    };
    if (Object.keys(explicitSource).length > 0) next.source = explicitSource;
  }
  if (time && typeof time === 'object') {
    const explicitTime = {
      ...(typeof time.valid_at === 'string' ? { valid_at: time.valid_at } : {}),
      ...(typeof time.known_at === 'string' ? { known_at: time.known_at } : {}),
      ...(time.range && typeof time.range === 'object' ? { range: time.range } : {}),
    };
    if (Object.keys(explicitTime).length > 0) next.time = explicitTime;
  }
  return next;
}
