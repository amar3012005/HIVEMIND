import crypto from 'node:crypto';
import { normalizeEntity } from './entity-normalize.js';

const ENTITY_KIND_ALIASES = new Map([['company', 'organization'], ['org', 'organization'], ['people', 'person'], ['individual', 'person'], ['tech', 'technology'], ['tool', 'technology'], ['software', 'system'], ['place', 'location']]);
const normalizeEntityKind = (kind) => ENTITY_KIND_ALIASES.get(plain(kind).toLowerCase()) || plain(kind).toLowerCase() || 'concept';

export const CANONICAL_KNOWLEDGE_MODES = new Set(['off', 'shadow', 'write', 'read', 'full']);
export const CANONICAL_ENTITY_ROLES = new Set([
  'subject', 'object', 'actor', 'recipient', 'location', 'organization',
  'product', 'technology', 'mentioned',
]);

const PREDICATES = new Map([
  ['teach', ['teaches', false]], ['teaches', ['teaches', false]], ['is_taught_by', ['teaches', true]],
  ['works_for', ['works_for', false]], ['employed_by', ['works_for', false]],
  ['manages', ['manages', false]], ['reports_to', ['reports_to', false]], ['owns', ['owns', false]],
  ['uses', ['uses', false]], ['develops', ['develops', false]], ['manufactures', ['manufactures', false]],
  ['located_in', ['located_in', false]], ['member_of', ['member_of', false]], ['depends_on', ['depends_on', false]],
  ['responsible_for', ['responsible_for', false]], ['prefers', ['prefers', false]],
  ['targets', ['targets', false]], ['scheduled_for', ['scheduled_for', false]],
]);

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const plain = (value) => String(value || '').trim();

export function canonicalKnowledgeMode({ evaluatedMode, env = process.env } = {}) {
  if (String(env.CANONICAL_KNOWLEDGE_KILL_SWITCH || '').toLowerCase() === 'true') return 'off';
  if (String(env.CANONICAL_KNOWLEDGE_ENABLED || '').toLowerCase() !== 'true') return 'off';
  const mode = plain(evaluatedMode || env.CANONICAL_KNOWLEDGE_MODE).toLowerCase();
  return CANONICAL_KNOWLEDGE_MODES.has(mode) ? mode : 'off';
}

export function normalizePredicate(raw) {
  const token = plain(raw).toLowerCase().replace(/[\s-]+/g, '_');
  const match = PREDICATES.get(token);
  return match ? { name: match[0], swap: match[1] } : null;
}

function resolveTomorrow(text, knownAt, timeZone) {
  if (!/\btomorrow\b/i.test(text)) return null;
  // Calendar arithmetic is deliberately anchored to the admitted local date.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(knownAt).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const next = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  return next.toISOString().slice(0, 10);
}

function deriveBoundedClaim({ title, content, entities, knownAt, timeZone }) {
  // This is a bounded fallback for explicit SVO statements. Rich extraction may
  // supply `claims`; this fallback never guesses across more than one candidate.
  const text = `${plain(title)}\n${plain(content)}`;
  const typed = entities.filter((e) => e?.name);
  let people = typed.filter((e) => normalizeEntityKind(e.kind) === 'person');
  if (!people.length) {
    const titleActor = plain(title).match(/^(.+?)\s+(?:is\s+)?(?:teaching|teaches|teach)\b/i)?.[1]?.trim();
    if (titleActor) people = [{ name: titleActor, kind: 'person' }];
  }
  const teach = plain(content).match(/\b(?:he|she|they|[\p{L}][\p{L} .'-]{1,100})\s+(?:started\s+)?(?:teaches|teaching|teach)\s+([\p{L}][\p{L}0-9 +#.-]{1,120}?)(?:\s+from\s+tomorrow|[.!?]|$)/iu);
  if (!teach) return null;
  const pronounSubject = /^\s*(he|she|they)\b/i.test(plain(content));
  const subject = pronounSubject
    ? (people.length === 1 ? people[0] : null)
    : typed.find((e) => text.toLowerCase().includes(plain(e.name).toLowerCase())) || null;
  if (!subject) return { unresolved_subject: true };
  const objectName = teach[1].replace(/\s+too$/i, '').trim();
  const object = typed.find((e) => normalizeEntity(e.name) === normalizeEntity(objectName))
    || { name: objectName, kind: 'technology' };
  return {
    subject, predicate: 'teaches', object, confidence: 1,
    qualifiers: {}, valid_from: resolveTomorrow(text, knownAt, timeZone),
  };
}

export function prepareCanonicalProjection(input = {}) {
  const knownAt = input.knownAt ? new Date(input.knownAt) : new Date();
  const timeZone = input.timeZone || 'UTC';
  const entities = (Array.isArray(input.entities) ? input.entities : []).map((entity) => (
    typeof entity === 'string' ? { name: entity, kind: 'concept', role: 'mentioned' } : entity
  )).filter((entity) => entity?.name);
  const source = `${plain(input.title)}\n${plain(input.content)}`;
  const sourceDigest = sha256(source);
  const supplied = Array.isArray(input.claims) ? input.claims : [];
  const fallback = supplied.length ? null : deriveBoundedClaim({ ...input, entities, knownAt, timeZone });
  const candidates = supplied.length ? supplied : (fallback ? [fallback] : []);
  const claims = [];
  for (const candidate of candidates) {
    if (candidate?.unresolved_subject) continue;
    const normalized = normalizePredicate(candidate?.predicate);
    if (!normalized) continue;
    let subject = candidate.subject;
    let object = candidate.object;
    if (normalized.swap) [subject, object] = [object, subject];
    if (!subject?.name || (!object?.name && object?.literal === undefined)) continue;
    claims.push({
      subject, object, predicate: normalized.name,
      confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 1,
      qualifiers: candidate.qualifiers || {},
      validFrom: resolveTomorrow(source, knownAt, timeZone) || candidate.valid_from || candidate.validFrom || null,
      validTo: candidate.valid_to || candidate.validTo || null,
      assertionStatus: candidate.assertion_status || 'user_asserted',
    });
  }
  // Identifier-only Workflow repair often reconstructs entity hints from tags,
  // where the original type is unavailable.  Claim endpoints are stronger than
  // those generic hints: collapse same-name hints onto the typed claim entity so
  // replay cannot create both `concept:uwe-egly` and `person:uwe-egly`.
  const preferred = new Map();
  for (const claim of claims) {
    for (const endpoint of [claim.subject, claim.object]) {
      if (endpoint?.name) preferred.set(normalizeEntity(endpoint.name), endpoint);
    }
  }
  const canonicalEntities = new Map();
  for (const entity of entities) {
    const key = normalizeEntity(entity.name);
    const stronger = preferred.get(key);
    canonicalEntities.set(key, stronger ? { ...entity, ...stronger } : entity);
  }
  for (const [key, entity] of preferred) canonicalEntities.set(key, entity);
  return { entities: [...canonicalEntities.values()], claims, sourceDigest, knownAt, timeZone, unresolvedSubject: Boolean(fallback?.unresolved_subject) };
}

async function upsertEntity(tx, organizationId, raw) {
  const kind = normalizeEntityKind(raw.kind || 'concept');
  const slug = normalizeEntity(raw.name);
  if (!slug) throw new Error(`invalid canonical entity: ${raw.name}`);
  const identityKey = `${kind}:${slug}`;
  return tx.canonicalEntity.upsert({
    where: { organizationId_identityKey: { organizationId, identityKey } },
    update: { updatedAt: new Date() },
    create: { organizationId, canonicalName: plain(raw.name), normalizedName: slug, identityKey, entityKind: kind },
  });
}

export async function materializeCanonicalKnowledge({ prisma, mode, input, processingVersion = 1 } = {}) {
  const admittedMode = canonicalKnowledgeMode({ evaluatedMode: mode });
  const prepared = prepareCanonicalProjection(input);
  if (admittedMode === 'off') return { mode: 'off' };
  if (admittedMode === 'shadow' || admittedMode === 'read') {
    const diagnostic = { claims: prepared.claims.length, unresolved_subject: prepared.unresolvedSubject };
    if (prisma?.memoryProjectionState && input?.memoryId && input?.organizationId) {
      await prisma.memoryProjectionState.upsert({
        where: { memoryId: input.memoryId },
        update: { admittedMode, processingVersion, claimsStatus: admittedMode === 'shadow' ? 'pending' : 'complete', receipt: { diagnostic } },
        create: { memoryId: input.memoryId, organizationId: input.organizationId, admittedMode, processingVersion, claimsStatus: admittedMode === 'shadow' ? 'pending' : 'complete', receipt: { diagnostic } },
      });
    }
    return { mode: admittedMode, diagnostic };
  }
  if (!prisma || !input?.memoryId || !input?.organizationId) throw new Error('canonical materialization requires prisma, memoryId and organizationId');

  return prisma.$transaction(async (tx) => {
    await tx.memoryProjectionState.upsert({
      where: { memoryId: input.memoryId },
      update: { admittedMode, processingVersion, claimsStatus: 'pending', entitiesStatus: 'pending', lastError: null },
      create: { memoryId: input.memoryId, organizationId: input.organizationId, admittedMode, processingVersion },
    });
    const entityByKey = new Map();
    const resolve = async (raw) => {
      const key = `${normalizeEntityKind(raw.kind || 'concept')}:${normalizeEntity(raw.name)}`;
      if (!entityByKey.has(key)) entityByKey.set(key, await upsertEntity(tx, input.organizationId, raw));
      return entityByKey.get(key);
    };
    for (const entity of prepared.entities) {
      const row = await resolve(entity);
      const role = CANONICAL_ENTITY_ROLES.has(entity.role) ? entity.role : 'mentioned';
      await tx.memoryEntityLink.upsert({
        where: { memoryId_entityId_role: { memoryId: input.memoryId, entityId: row.id, role } },
        update: { confidence: entity.confidence ?? 1 },
        create: { memoryId: input.memoryId, entityId: row.id, role, confidence: entity.confidence ?? 1 },
      });
    }
    const persisted = [];
    const replacementAsserted = /\binstead\b|\bno longer\b|\breplaces?\b/i.test(`${input.title || ''}\n${input.content || ''}`);
    for (const claim of prepared.claims) {
      const subject = await resolve(claim.subject);
      const objectEntity = claim.object?.name ? await resolve(claim.object) : null;
      const predicate = await tx.canonicalPredicate.upsert({
        where: { name_version: { name: claim.predicate, version: 1 } }, update: {}, create: { name: claim.predicate, version: 1 },
      });
      for (const [entity, role] of [[subject, 'subject'], [subject, 'actor'], [objectEntity, 'object']]) {
        if (!entity) continue;
        await tx.memoryEntityLink.upsert({
          where: { memoryId_entityId_role: { memoryId: input.memoryId, entityId: entity.id, role } },
          update: {}, create: { memoryId: input.memoryId, entityId: entity.id, role },
        });
      }
      const objectToken = objectEntity?.id || JSON.stringify(claim.object?.literal);
      const claimKey = sha256([input.organizationId, subject.id, claim.predicate, objectToken, prepared.sourceDigest, processingVersion].join('|'));
      let superseded = null;
      if (replacementAsserted && tx.canonicalClaim.findFirst) {
        superseded = await tx.canonicalClaim.findFirst({
          where: {
            organizationId: input.organizationId, subjectEntityId: subject.id, predicateId: predicate.id,
            lifecycleStatus: 'active', NOT: objectEntity ? { objectEntityId: objectEntity.id } : { objectLiteral: claim.object.literal },
          },
          include: { evidence: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { knownAt: 'desc' },
        });
      }
      const row = await tx.canonicalClaim.upsert({
        where: { organizationId_claimKey: { organizationId: input.organizationId, claimKey } }, update: {},
        create: {
          organizationId: input.organizationId, claimKey, subjectEntityId: subject.id, predicateId: predicate.id,
          objectEntityId: objectEntity?.id || null, objectLiteral: objectEntity ? undefined : claim.object.literal,
          qualifiers: claim.qualifiers, confidence: claim.confidence, assertionStatus: claim.assertionStatus,
          validFrom: claim.validFrom ? new Date(claim.validFrom) : null, validTo: claim.validTo ? new Date(claim.validTo) : null,
          knownAt: prepared.knownAt, processingVersion, sourceDigest: prepared.sourceDigest,
          supersedesClaimId: superseded?.id || null,
        },
      });
      await tx.claimEvidenceLink.upsert({
        where: { claimId_memoryId_sourceDigest: { claimId: row.id, memoryId: input.memoryId, sourceDigest: prepared.sourceDigest } },
        update: {}, create: {
          claimId: row.id, memoryId: input.memoryId, documentId: input.documentId || null, segmentId: input.segmentId || null,
          exactQuote: input.exactQuote || input.content || null, startOffset: input.startOffset ?? null,
          endOffset: input.endOffset ?? null, sourceDigest: prepared.sourceDigest,
        },
      });
      if (superseded) {
        await tx.canonicalClaim.update({
          where: { id: superseded.id }, data: { lifecycleStatus: 'superseded', validTo: claim.validFrom ? new Date(claim.validFrom) : prepared.knownAt },
        });
        const priorMemoryId = superseded.evidence?.[0]?.memoryId;
        if (priorMemoryId && priorMemoryId !== input.memoryId && tx.relationship?.upsert) {
          await tx.relationship.upsert({
            where: { fromId_toId_type: { fromId: input.memoryId, toId: priorMemoryId, type: 'Updates' } },
            update: { confidence: 1, metadata: { canonical_claim_supersession: true, old_claim_id: superseded.id, new_claim_id: row.id } },
            create: { fromId: input.memoryId, toId: priorMemoryId, type: 'Updates', confidence: 1, createdBy: 'canonical_knowledge', metadata: { canonical_claim_supersession: true, old_claim_id: superseded.id, new_claim_id: row.id } },
          });
        }
      }
      persisted.push(row);
    }
    await tx.memoryProjectionState.update({
      where: { memoryId: input.memoryId }, data: { entitiesStatus: 'complete', claimsStatus: 'complete', receipt: { claim_count: persisted.length } },
    });
    return { mode: admittedMode, claimCount: persisted.length, claims: persisted };
  });
}

export async function getCanonicalClaimsForMemory({ prisma, organizationId, memoryId, filters = {} }) {
  const evidence = await prisma.claimEvidenceLink.findMany({
    where: { memoryId, claim: { organizationId } },
    include: { claim: { include: { subject: true, objectEntity: true, predicate: true } } },
    orderBy: { createdAt: 'asc' }, take: 200,
  });
  return evidence.map(({ claim, ...link }) => ({
    id: claim.id, claim_key: claim.claimKey, subject: claim.subject, predicate: claim.predicate.name,
    object: claim.objectEntity || claim.objectLiteral, qualifiers: claim.qualifiers,
    confidence: Number(claim.confidence), assertion_status: claim.assertionStatus,
    lifecycle_status: claim.lifecycleStatus, valid_from: claim.validFrom, valid_to: claim.validTo,
    evidence: link,
  })).filter((claim) => (!filters.subject || normalizeEntity(claim.subject.canonicalName) === normalizeEntity(filters.subject))
    && (!filters.predicate || claim.predicate === normalizePredicate(filters.predicate)?.name)
    && (!filters.object || normalizeEntity(claim.object?.canonicalName || claim.object?.value) === normalizeEntity(filters.object))
    && (!filters.validAt || ((!claim.valid_from || new Date(claim.valid_from) <= new Date(filters.validAt))
      && (!claim.valid_to || new Date(claim.valid_to) > new Date(filters.validAt)))));
}

export function verifyCanonicalProjectionSignature({ headers = {}, pathname, rawBody, secret, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'secret_unconfigured' };
  const timestamp = plain(headers['x-hivemind-timestamp']);
  const nonce = plain(headers['x-hivemind-nonce']);
  const bodyDigest = plain(headers['x-hivemind-content-sha256']).toLowerCase();
  const signature = plain(headers['x-hivemind-signature']).toLowerCase().replace(/^sha256=/, '');
  if (!/^\d{10,13}$/.test(timestamp) || !nonce || !/^[a-f0-9]{64}$/.test(bodyDigest) || !/^[a-f0-9]{64}$/.test(signature)) return { ok: false, reason: 'malformed' };
  const epochMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (Math.abs(now - epochMs) > 300000) return { ok: false, reason: 'expired' };
  if (sha256(rawBody) !== bodyDigest) return { ok: false, reason: 'digest_mismatch' };
  const canonical = `${timestamp}\n${nonce}\nPOST\n${pathname}\n${bodyDigest}`;
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  const a = Buffer.from(signature, 'hex'); const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true, nonce } : { ok: false, reason: 'signature_mismatch' };
}
