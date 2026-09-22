import crypto from 'node:crypto';
import { decideEntityProfileCandidate } from './entity-profile-jev.js';

export const ENTITY_PROFILE_MODES = new Set(['off', 'shadow', 'dynamic_auto', 'review_only']);
const FACT_CLASSES = new Set(['static', 'dynamic', 'relationship', 'historical']);
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Core trusts only a signed, explicit admission mode from the Cloudflare
// Worker.  There is deliberately no second environment flag: Flagship is the
// single rollout and rollback authority.
export function entityProfileMode({ evaluatedMode } = {}) {
  const mode = String(evaluatedMode || 'off').toLowerCase();
  return ENTITY_PROFILE_MODES.has(mode) ? mode : 'off';
}

function defaultClass(claim) {
  if (claim.objectEntityId) return 'relationship';
  if (claim.validTo || claim.validFrom) return 'historical';
  return 'dynamic';
}

function allowed(mode, factClass, decision, evidenceCount, confidence) {
  if (mode !== 'dynamic_auto') return false;
  return factClass === 'dynamic' && decision === 'auto_apply' && evidenceCount > 0 && confidence >= 0.8;
}

export async function projectEntityProfile({ prisma, organizationId, entityId, mode, sourceWatermark, jev = decideEntityProfileCandidate }) {
  const admittedMode = entityProfileMode({ evaluatedMode: mode });
  if (admittedMode === 'off') return { mode: 'off', facts: 0, reviews: 0 };
  const entity = await prisma.canonicalEntity.findFirst({ where: { id: entityId, organizationId } });
  if (!entity) return { mode: admittedMode, missing: true, facts: 0, reviews: 0 };
  const claims = await prisma.canonicalClaim.findMany({
    where: { organizationId, OR: [{ subjectEntityId: entityId }, { objectEntityId: entityId }], lifecycleStatus: 'active' },
    include: { predicate: true, evidence: true }, orderBy: { knownAt: 'desc' }, take: 100,
  });
  const receipts = [];
  let written = 0; let reviews = 0;
  for (const claim of claims) {
    const evidence = (claim.evidence || []).filter((item) => item.memoryId);
    const candidate = {
      predicate: claim.predicate?.name,
      subject_kind: entity.entityKind,
      object_kind: claim.objectEntityId ? 'entity' : 'literal',
      object_literal: claim.objectLiteral,
      evidence_count: evidence.length,
      direct_evidence: evidence.length > 0,
      confidence: Number(claim.confidence || 0),
    };
    const jevDecision = await jev({ candidate }).catch(() => null);
    const factClass = FACT_CLASSES.has(jevDecision?.fact_class) ? jevDecision.fact_class : defaultClass(claim);
    const decision = jevDecision?.action || 'review';
    const factKey = `${claim.predicate?.name || 'claim'}:${claim.objectEntityId || hash(claim.objectLiteral || null).slice(0, 20)}`;
    const value = { predicate: claim.predicate?.name || null, object_entity_id: claim.objectEntityId || null, object_literal: claim.objectLiteral || null, qualifiers: claim.qualifiers || {} };
    const receipt = { claim_id: claim.id, fact_class: factClass, decision, evidence_count: evidence.length, jev: jevDecision ? { ...jevDecision } : null };
    receipts.push(receipt);
    if (admittedMode === 'shadow') continue;
    const status = allowed(admittedMode, factClass, decision, evidence.length, Number(claim.confidence || 0)) ? 'active' : 'review';
    const fact = await prisma.entityProfileFact.upsert({
      where: { entityId_canonicalClaimId_factKey_projectionVersion: { entityId, canonicalClaimId: claim.id, factKey, projectionVersion: 1 } },
      update: { value, confidence: claim.confidence, freshnessAt: claim.knownAt, status, decision, sourceWatermark },
      create: { organizationId, entityId, canonicalClaimId: claim.id, factClass, factKey, value, confidence: claim.confidence, freshnessAt: claim.knownAt, status, decision, sourceWatermark },
    });
    for (const item of evidence) {
      await prisma.entityProfileFactEvidence.upsert({
        where: { profileFactId_memoryId_sourceDigest: { profileFactId: fact.id, memoryId: item.memoryId, sourceDigest: item.sourceDigest } },
        update: {}, create: { profileFactId: fact.id, memoryId: item.memoryId, documentId: item.documentId, segmentId: item.segmentId, exactQuote: item.exactQuote, sourceDigest: item.sourceDigest },
      });
    }
    written += 1;
    if (status === 'review') {
      const kind = factClass === 'relationship' ? 'relationship' : 'admission';
      const existingReview = await prisma.entityProfileReview.findFirst({ where: { profileFactId: fact.id, kind, status: 'pending' } });
      if (!existingReview) {
        await prisma.entityProfileReview.create({ data: { organizationId, profileFactId: fact.id, kind } });
        reviews += 1;
      }
    }
  }
  return { mode: admittedMode, entity_id: entityId, source_watermark: sourceWatermark, facts: written, reviews, receipts };
}

export async function getEntityProfileDossier({ prisma, organizationId, entityId, includeEvidence = false }) {
  const entity = await prisma.canonicalEntity.findFirst({ where: { id: entityId, organizationId } });
  if (!entity) return null;
  const facts = await prisma.entityProfileFact.findMany({
    where: { organizationId, entityId, status: { in: ['active', 'review', 'superseded'] } },
    include: {
      reviews: true,
      claim: { include: { predicate: true, objectEntity: true } },
      ...(includeEvidence ? { evidence: true } : {}),
    },
    orderBy: [{ factClass: 'asc' }, { freshnessAt: 'desc' }], take: 200,
  });
  return { entity, facts, timeline: buildEntityProfileTimeline(facts) };
}

/**
 * A bi-temporal, evidence-first view of an entity profile.
 * valid_at answers when the underlying claim was known to be true; recorded_at
 * answers when HIVE recorded the fact or human review. Neither field is model
 * generated, so a timeline remains auditable and replay-safe.
 */
export function buildEntityProfileTimeline(facts = []) {
  const events = [];
  for (const fact of facts) {
    const predicate = fact.claim?.predicate?.name || fact.value?.predicate || fact.factKey || 'Profile fact';
    const evidenceCount = Array.isArray(fact.evidence) ? fact.evidence.length : 0;
    const validAt = fact.freshnessAt || null;
    events.push({
      id: `fact:${fact.id}`,
      kind: 'fact',
      title: predicate,
      fact_id: fact.id,
      fact_class: fact.factClass,
      status: fact.status,
      decision: fact.decision,
      value: {
        ...(fact.value || {}),
        object_entity_name: fact.claim?.objectEntity?.canonicalName || fact.value?.object_entity_name || null,
      },
      evidence_count: evidenceCount,
      valid_at: validAt,
      recorded_at: fact.createdAt || null,
      updated_at: fact.updatedAt || null,
    });
    for (const review of fact.reviews || []) {
      events.push({
        id: `review:${review.id}:requested`,
        kind: 'review_requested',
        title: review.kind === 'relationship' ? 'Relationship review requested' : 'Fact review requested',
        fact_id: fact.id,
        status: review.status,
        valid_at: validAt,
        recorded_at: review.createdAt || null,
      });
      if (review.resolvedAt) {
        events.push({
          id: `review:${review.id}:resolved`,
          kind: 'review_resolved',
          title: review.status === 'approved' ? 'Fact approved' : 'Fact rejected',
          fact_id: fact.id,
          status: review.status,
          valid_at: validAt,
          recorded_at: review.resolvedAt,
        });
      }
    }
  }
  return events.sort((left, right) => {
    const validOrder = new Date(left.valid_at || 0).getTime() - new Date(right.valid_at || 0).getTime();
    if (validOrder) return validOrder;
    return new Date(left.recorded_at || 0).getTime() - new Date(right.recorded_at || 0).getTime();
  });
}
