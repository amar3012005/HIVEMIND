const RELATIONSHIP_ALIASES = new Map([
  ['update', 'Updates'],
  ['updates', 'Updates'],
  ['updated', 'Updates'],
  ['supersede', 'Updates'],
  ['supersedes', 'Updates'],
  ['replace', 'Updates'],
  ['replaces', 'Updates'],
  ['correct', 'Updates'],
  ['corrects', 'Updates'],
  ['revise', 'Updates'],
  ['revises', 'Updates'],
  ['extend', 'Extends'],
  ['extends', 'Extends'],
  ['extended', 'Extends'],
  ['augment', 'Extends'],
  ['augments', 'Extends'],
  ['derive', 'Derives'],
  ['derives', 'Derives'],
  ['derived', 'Derives'],
  ['synthesise', 'Derives'],
  ['synthesises', 'Derives'],
  ['synthesize', 'Derives'],
  ['synthesizes', 'Derives'],
  ['synthesis', 'Derives'],
]);

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function normalizeReference(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (typeof value !== 'object') return null;

  const id = value.id || value.memoryId || value.memory_id || value.sourceId || value.targetId || value.target_id || value.claimId || value.findingId || value.observationId || null;
  if (!id) return null;

  return {
    ...value,
    id: String(id).trim(),
    score: Number.isFinite(value.score) ? value.score : (Number.isFinite(value.confidence) ? value.confidence : null),
  };
}

function normalizeReferenceList(values = []) {
  const raw = Array.isArray(values) ? values : [values];
  const references = [];
  const seen = new Set();

  for (const value of raw) {
    const ref = normalizeReference(value);
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    references.push(ref);
  }

  return references;
}

export function normalizeRelationshipType(type) {
  if (!type) return null;
  const canonical = RELATIONSHIP_ALIASES.get(String(type).trim().toLowerCase());
  if (canonical) return canonical;
  if (['Updates', 'Extends', 'Derives'].includes(type)) return type;
  return null;
}

export function relationshipOperationForType(type) {
  const canonical = normalizeRelationshipType(type);
  if (canonical === 'Updates') return 'updated';
  if (canonical === 'Extends') return 'extended';
  if (canonical === 'Derives') return 'derived';
  return 'created';
}

export function inferMemorySemanticRole(memory = {}) {
  const tags = new Set(memory.tags || []);
  const memoryType = String(memory.memory_type || memory.memoryType || '').toLowerCase();
  const sourceType = String(
    memory.source_metadata?.source_type
    || memory.source_metadata?.source_platform
    || memory.source
    || ''
  ).toLowerCase();

  if (tags.has('observation') || sourceType === 'observation' || memoryType === 'observation') {
    return 'observation';
  }

  if (
    tags.has('research-observation')
    || tags.has('research-execution-event')
    || memoryType === 'finding'
  ) {
    return 'finding';
  }

  if (
    tags.has('research-finding')
    || tags.has('extracted-fact')
    || memoryType === 'fact'
    || memoryType === 'claim'
  ) {
    return 'claim';
  }

  if (
    tags.has('source')
    || sourceType === 'manual'
    || sourceType === 'web'
    || sourceType === 'url'
    || sourceType === 'document'
    || sourceType === 'pdf'
    || sourceType === 'source'
  ) {
    return 'source';
  }

  return 'memory';
}

export function normalizeRelationshipDescriptor(input = {}, context = {}) {
  const descriptor = input.relationship && typeof input.relationship === 'object'
    ? { ...input.relationship, ...input }
    : { ...input };

  const type = normalizeRelationshipType(
    descriptor.type
    || descriptor.relationship_type
    || context.type
  );

  const sourceRefs = normalizeReferenceList(
    descriptor.sourceRefs
    || descriptor.source_refs
    || descriptor.sourceIds
    || descriptor.source_ids
    || descriptor.derivedFrom
    || descriptor.derived_from
    || descriptor._derives_from
    || context.sourceRefs
    || context.sourceIds
    || context.source_ids
  );

  const claimRefs = normalizeReferenceList(
    descriptor.claimRefs
    || descriptor.claim_refs
    || descriptor.claimIds
    || descriptor.claim_ids
    || context.claimRefs
    || context.claimIds
    || context.claim_ids
  );

  const findingRefs = normalizeReferenceList(
    descriptor.findingRefs
    || descriptor.finding_refs
    || descriptor.findingIds
    || descriptor.finding_ids
    || context.findingRefs
    || context.findingIds
    || context.finding_ids
  );

  const observationRefs = normalizeReferenceList(
    descriptor.observationRefs
    || descriptor.observation_refs
    || descriptor.observationIds
    || descriptor.observation_ids
    || context.observationRefs
    || context.observationIds
    || context.observation_ids
  );

  const sourceId = normalizeReference(descriptor.sourceId || descriptor.source_id || descriptor.from_id || descriptor.fromId || context.sourceId)?.id || null;
  const targetId = normalizeReference(descriptor.targetId || descriptor.target_id || descriptor.to_id || descriptor.toId || context.targetId)?.id || null;
  const sourceRole = descriptor.sourceRole || descriptor.source_role || context.sourceRole || inferMemorySemanticRole(context.sourceMemory || descriptor.sourceMemory || {});
  const targetRole = descriptor.targetRole || descriptor.target_role || context.targetRole || inferMemorySemanticRole(context.targetMemory || descriptor.targetMemory || {});
  const semanticRole = descriptor.semanticRole || descriptor.semantic_role || context.semanticRole || inferMemorySemanticRole(context.memory || descriptor.memory || {});
  const confidence = Number.isFinite(descriptor.confidence)
    ? descriptor.confidence
    : Number.isFinite(descriptor.relationship?.confidence)
      ? descriptor.relationship.confidence
      : Number.isFinite(context.confidence)
        ? context.confidence
        : 1;
  const reason = descriptor.reason || descriptor.relationship?.reason || context.reason || null;
  const operator = descriptor.operator || descriptor.action || descriptor.kind || relationshipOperationForType(type);

  const sourceIds = uniqueStrings([
    sourceId,
    ...sourceRefs.map(ref => ref.id),
  ]);
  const claimIds = uniqueStrings([
    ...claimRefs.map(ref => ref.id),
  ]);
  const findingIds = uniqueStrings([
    ...findingRefs.map(ref => ref.id),
  ]);
  const observationIds = uniqueStrings([
    ...observationRefs.map(ref => ref.id),
  ]);

  return {
    type,
    operator,
    operation: relationshipOperationForType(type),
    confidence,
    reason,
    sourceId,
    targetId,
    sourceIds,
    claimIds,
    findingIds,
    observationIds,
    sourceRefs,
    claimRefs,
    findingRefs,
    observationRefs,
    sourceRole,
    targetRole,
    semanticRole,
  };
}

export function buildSemanticMetadata({
  semanticRole,
  relationship,
  sourceIds = [],
  claimIds = [],
  findingIds = [],
  observationIds = [],
  sourceRefs = [],
  claimRefs = [],
  findingRefs = [],
  observationRefs = [],
  sourceMetadata = null,
  sourceMemory = null,
  targetMemory = null,
  reason = null,
  confidence = null,
} = {}) {
  const normalizedRelationship = relationship
    ? normalizeRelationshipDescriptor(relationship, {
      sourceMemory,
      targetMemory,
      sourceIds,
      claimIds,
      findingIds,
      observationIds,
      reason,
      confidence,
    })
    : null;

  const role = semanticRole || inferMemorySemanticRole(sourceMemory || targetMemory || {});
  const mergedSourceIds = uniqueStrings([
    ...sourceIds,
    ...(normalizedRelationship?.sourceIds || []),
  ]);
  const mergedClaimIds = uniqueStrings([
    ...claimIds,
    ...(normalizedRelationship?.claimIds || []),
  ]);
  const mergedFindingIds = uniqueStrings([
    ...findingIds,
    ...(normalizedRelationship?.findingIds || []),
  ]);
  const mergedObservationIds = uniqueStrings([
    ...observationIds,
    ...(normalizedRelationship?.observationIds || []),
  ]);

  const semanticProvenance = {
    semantic_role: role,
    source_ids: mergedSourceIds,
    claim_ids: mergedClaimIds,
    finding_ids: mergedFindingIds,
    observation_ids: mergedObservationIds,
    source_refs: sourceRefs.length ? sourceRefs : normalizedRelationship?.sourceRefs || [],
    claim_refs: claimRefs.length ? claimRefs : normalizedRelationship?.claimRefs || [],
    finding_refs: findingRefs.length ? findingRefs : normalizedRelationship?.findingRefs || [],
    observation_refs: observationRefs.length ? observationRefs : normalizedRelationship?.observationRefs || [],
    source_metadata: sourceMetadata || null,
    reason: reason || normalizedRelationship?.reason || null,
    confidence: confidence ?? normalizedRelationship?.confidence ?? null,
    operator: normalizedRelationship?.operator || null,
  };

  return {
    semantic_role: role,
    semantic_source_ids: mergedSourceIds,
    semantic_claim_ids: mergedClaimIds,
    semantic_finding_ids: mergedFindingIds,
    semantic_observation_ids: mergedObservationIds,
    semantic_relationship: normalizedRelationship ? {
      type: normalizedRelationship.type,
      operator: normalizedRelationship.operator,
      operation: normalizedRelationship.operation,
      confidence: normalizedRelationship.confidence,
      reason: normalizedRelationship.reason,
      sourceId: normalizedRelationship.sourceId,
      targetId: normalizedRelationship.targetId,
      sourceIds: mergedSourceIds,
      claimIds: mergedClaimIds,
      findingIds: mergedFindingIds,
      observationIds: mergedObservationIds,
      sourceRole: normalizedRelationship.sourceRole,
      targetRole: normalizedRelationship.targetRole,
      semanticRole: normalizedRelationship.semanticRole,
    } : null,
    semantic_provenance: semanticProvenance,
  };
}
