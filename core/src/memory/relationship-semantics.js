import { assessClaimRelation } from './claim-signature.js';
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
  ['contradict', 'Contradicts'],
  ['contradicts', 'Contradicts'],
  ['conflicts', 'Contradicts'],
  ['partof', 'PartOf'],
  ['part_of', 'PartOf'],
  ['part-of', 'PartOf'],
  ['mentions', 'Mentions'],
]);

export const RELATIONSHIP_POLICY_VERSION = 'canonical-graph-v1';
export const SEMANTIC_RELATIONSHIP_TYPES = Object.freeze(['Updates', 'Extends', 'Derives', 'Contradicts']);

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
  if (['Updates', 'Extends', 'Derives', 'Contradicts', 'PartOf', 'Mentions'].includes(type)) return type;
  return null;
}

export function relationshipOperationForType(type) {
  const canonical = normalizeRelationshipType(type);
  if (canonical === 'Updates') return 'updated';
  if (canonical === 'Extends') return 'extended';
  if (canonical === 'Derives') return 'derived';
  if (canonical === 'Contradicts') return 'contradicted';
  if (canonical === 'PartOf') return 'attached';
  return 'created';
}

function _sameTenant(memories = [], orgId, userId) {
  return memories.every((memory) => memory
    && (!orgId || memory.org_id === orgId)
    && (!userId || memory.user_id === userId));
}

/**
 * The single deterministic admission policy for durable graph edges.
 * Models and heuristics may propose relationships; only this function certifies
 * a proposal for persistence. Entity co-occurrence remains an entity index and
 * is never promoted to a permanent memory-to-memory edge.
 */
export function validateRelationshipProposal({
  type,
  sourceMemory = null,
  targetMemory = null,
  sourceMemories = [],
  confidence = 1,
  orgId = null,
  userId = null,
  hubSlugs = [],
} = {}) {
  const canonical = normalizeRelationshipType(type);
  const score = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  const sources = sourceMemories.length ? sourceMemories : (sourceMemory ? [sourceMemory] : []);
  const all = [...sources, targetMemory].filter(Boolean);

  if (!canonical) return { ok: false, type: null, reason: 'unsupported-relationship-type' };
  if (canonical === 'Mentions') {
    return { ok: false, type: canonical, reason: 'co-mention-is-entity-metadata-not-memory-edge' };
  }
  if (!_sameTenant(all, orgId, userId)) {
    return { ok: false, type: canonical, reason: 'tenant-scope-violation' };
  }
  if (!targetMemory || sources.length === 0 || sources.some(source => source.id === targetMemory.id)) {
    return { ok: false, type: canonical, reason: 'missing-or-self-referential-endpoint' };
  }
  if (canonical === 'PartOf') {
    return { ok: true, type: canonical, reason: 'validated-structural-membership' };
  }

  const threshold = canonical === 'Updates' ? 0.85 : 0.75;
  if (score < threshold) {
    return { ok: false, type: canonical, reason: `confidence-below-${threshold}` };
  }

  if (canonical === 'Derives') {
    return { ok: true, type: canonical, reason: 'validated-source-provenance' };
  }

  const semantic = validateSupersedingEdge(sourceMemory || sources[0], targetMemory, {
    hubSlugs,
    requireChangeEvidence: canonical === 'Updates' || canonical === 'Contradicts',
  });
  if (!semantic.ok) return { ok: false, type: canonical, reason: semantic.reason, sharedSpecific: semantic.sharedSpecific };
  return { ok: true, type: canonical, reason: semantic.reason, sharedSpecific: semantic.sharedSpecific };
}

export function certifyRelationshipMetadata(metadata = {}, verdict = {}, { createdBy = 'canonical-relationship-dispatcher' } = {}) {
  if (!verdict?.ok || !verdict?.type) throw new Error('Cannot certify a rejected relationship proposal');
  return {
    ...(metadata || {}),
    relationship_policy_version: RELATIONSHIP_POLICY_VERSION,
    relationship_validation_status: 'validated',
    relationship_validation_reason: verdict.reason || 'validated',
    relationship_validated_by: createdBy,
  };
}

export function hasCanonicalRelationshipCertification(edge = {}) {
  if (!SEMANTIC_RELATIONSHIP_TYPES.includes(normalizeRelationshipType(edge.type))) return true;
  const metadata = edge.metadata || {};
  return metadata.relationship_policy_version === RELATIONSHIP_POLICY_VERSION
    && metadata.relationship_validation_status === 'validated';
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

// ── Strict superseding-edge validator ────────────────────────────────────────
// Deterministic structural gate for the DESTRUCTIVE relationship types
// (Updates flips is_latest=false on the target; Contradicts asserts
// incompatibility). Algorithmic edge factories (kb_hybrid_v1 gray-zone LLM,
// entity-co-mention, kb-enrich contradiction pass) must pass this validator
// before creating Updates/Contradicts or demoting is_latest — an LLM opinion
// alone is not enough. Conversational hot-path classification (full-context,
// user-driven) is intentionally NOT gated here.
//
// Rules (all must hold):
//   1. SAME SUBJECT — the two memories share ≥1 entity slug.
//   2. SPECIFIC SUBJECT — the shared set contains at least one NON-hub slug.
//      Sharing only a generic hub entity (the org name — e.g. SOLVIS — that
//      appears on most facts in a corpus) proves nothing about subject.
//   3. NO EXCLUSIVE-SUBJECT CONFLICT — if each side carries its own distinct
//      specific (non-hub, non-shared) entity, they are about DIFFERENT things
//      (SolvisPia vs SolvisLea) and cannot update/contradict each other.
//   4. SAME ATTRIBUTE (proxy) — content token overlap ≥ minAttributeOverlap
//      (default 0.18 Jaccard on non-trivial tokens): a replacement/changed
//      value keeps most of the sentence frame; disjoint statements (pellet
//      requirements vs heating-oil requirements) do not.

const _EDGE_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'on', 'at', 'is', 'are', 'be', 'has', 'have',
  'der', 'die', 'das', 'und', 'oder', 'von', 'zu', 'im', 'mit', 'auf', 'ist', 'sind', 'ein', 'eine', 'für', 'bei', 'den', 'dem', 'des',
]);

function _entitySlugs(tags = []) {
  const out = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    if (typeof t !== 'string') continue;
    if (t.startsWith('entity:') || t.startsWith('person:')) {
      const slug = t.replace(/^(entity|person):/, '').trim().toLowerCase();
      if (slug) out.add(slug);
    }
  }
  return out;
}

function _contentTokens(content = '') {
  return new Set(
    String(content || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3 && !_EDGE_STOP.has(t)),
  );
}

/**
 * @param {object} from  the NEW memory (source of the edge) — needs {tags, content}
 * @param {object} to    the OLD memory (target, would be demoted) — needs {tags, content}
 * @param {object} [opts]
 * @param {string[]} [opts.hubSlugs]  generic entity slugs (corpus-dominant, e.g. the org name)
 * @param {number} [opts.minAttributeOverlap]
 * @returns {{ok: boolean, reason: string, sharedSpecific: string[]}}
 */
export function validateSupersedingEdge(from = {}, to = {}, {
  hubSlugs = [],
  minAttributeOverlap = 0.18,
  requireChangeEvidence = false,
} = {}) {
  // PRIMARY: structural claim comparison (claim-signature.js) — canonical
  // subjects + typed value slots (numbers/units/years/dates/model ids).
  // Language-neutral and deterministic: an LLM edge proposal survives only when
  // the STRUCTURE supports it. Token-overlap Jaccard is retained ONLY as a
  // fallback for value-less prose claims (see below), because it conflates
  // "shares vocabulary" with "same attribute" and misses multilingual equals.
  const assessment = assessClaimRelation(from, to, { hubSlugs });
  switch (assessment.relation) {
    case 'no-shared-subject':
      return { ok: false, reason: 'no-shared-entity', sharedSpecific: [] };
    case 'different-subject':
      return { ok: false, reason: 'different-subjects', sharedSpecific: [] };
    case 'topical':
      if (assessment.reason === 'only corpus-hub subject shared') {
        return { ok: false, reason: 'only-generic-entity-shared', sharedSpecific: [] };
      }
      if (assessment.reason === 'subject evidence on one side only') {
        return { ok: false, reason: 'subject-evidence-one-sided', sharedSpecific: [] };
      }
      break; // same subject, no typed slots → fall through to frame fallback
    case 'corroboration':
      if (requireChangeEvidence) {
        return { ok: false, reason: 'no-change-evidence(values-agree)', sharedSpecific: assessment.sharedSpecific };
      }
      return { ok: true, reason: 'corroboration', sharedSpecific: assessment.sharedSpecific };
    case 'update':
      return { ok: true, reason: 'value-change-evidence', sharedSpecific: assessment.sharedSpecific };
    default:
      break;
  }

  // FALLBACK for value-less prose (no typed slots either side): a genuine
  // replacement keeps the sentence frame and swaps the value words; a
  // near-verbatim duplicate keeps everything; unrelated statements share
  // little. Weak signal — only when structure could not decide.
  const a = _contentTokens(from.content);
  const b = _contentTokens(to.content);
  if (a.size && b.size) {
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    const jac = inter / (a.size + b.size - inter);
    if (jac < minAttributeOverlap) {
      return { ok: false, reason: `attribute-mismatch(${jac.toFixed(2)})`, sharedSpecific: assessment.sharedSpecific };
    }
    if (requireChangeEvidence && jac >= 0.7) {
      return { ok: false, reason: `no-change-evidence(${jac.toFixed(2)})`, sharedSpecific: assessment.sharedSpecific };
    }
  }
  return { ok: true, reason: 'frame-fallback', sharedSpecific: assessment.sharedSpecific };
}

/**
 * Corpus-dominant ("hub") entity slugs: entities present on ≥ threshold share
 * of the given memories. In a product manual the manufacturer's org name tags
 * nearly every fact — sharing it proves nothing (rule 2 above).
 * @param {Array<{tags?: string[]}>} memories
 * @param {number} [threshold]  fraction of memories (default 0.5)
 * @returns {string[]}
 */
export function computeHubEntitySlugs(memories = [], threshold = 0.5) {
  const counts = new Map();
  let n = 0;
  for (const m of memories) {
    const ents = _entitySlugs(m?.tags);
    if (!ents.size) continue;
    n += 1;
    for (const e of ents) counts.set(e, (counts.get(e) || 0) + 1);
  }
  if (n < 3) return []; // too few tagged memories to call anything "dominant"
  const min = Math.ceil(n * threshold);
  return [...counts.entries()].filter(([, c]) => c >= min).map(([e]) => e);
}

// ── Enforcement mode ─────────────────────────────────────────────────────────
// The destructive-edge validator ships in SHADOW mode first: every gate still
// COMPUTES the verdict and logs it, but does NOT act on it (no downgrade, no
// is_latest withhold) until we have measured precision on a real corpus.
//   RELATIONSHIP_VALIDATOR_MODE = shadow (default) | enforce | off
//     shadow  → compute + log, take NO destructive action differently than before
//     enforce → act on the verdict (downgrade edges / withhold demotion)
//     off     → skip the validator entirely (legacy behaviour)
// Read per-call (not cached) so the mode can be flipped via env without redeploy
// where the process re-reads env, and always overridable in tests.
export function relationshipValidatorMode() {
  // DEFAULT enforce: the shadow measurement is complete (≈73% of algorithmic
  // destructive edges were false, with sound rejections), so the deterministic
  // validator now GATES every ingestion by default — no env needed, works the
  // same on any box. Set RELATIONSHIP_VALIDATOR_MODE=shadow to observe-only or
  // =off for the legacy (unsafe) behaviour.
  const m = String(process.env.RELATIONSHIP_VALIDATOR_MODE || 'enforce').toLowerCase();
  return (m === 'shadow' || m === 'off') ? m : 'enforce';
}
