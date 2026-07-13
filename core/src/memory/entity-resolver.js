/**
 * EntityResolver — auto-link memories to canonical entities + manage
 * cross-system identity. One canonical entity per real-world thing.
 *
 * Resolution signal hierarchy (highest confidence first):
 *   1.00 — Same external_ref (salesforce/Account/<id>) already mapped to entity
 *   0.98 — Same primary_email (case-insensitive)
 *   0.95 — Cross-system: known SF Contact email matches Slack user profile email
 *   0.90 — Same email_domain + canonical name fuzzy ≥0.85 (entity_kind=company)
 *   0.70-0.85 — LLM name match with shared org context → review queue
 *   <0.70 — Treat as new canonical entity
 *
 * Public API:
 *   resolveAndLink({memoryId, candidates, organizationId, ...})
 *     - candidates: [{name, kind, email?, emailDomain?, externalRefs?}]
 *     - returns: [{ entityId, role, confidence, action: 'linked'|'created'|'review' }]
 *
 *   findByExternalRef({organizationId, system, externalId})
 *   findByEmail({organizationId, email})
 *   mergeEntities({srcId, dstId, userId})  — manual review approval path
 */

import { v4 as uuidv4 } from 'uuid';

const AUTO_LINK_FLOOR = 0.95;
const REVIEW_FLOOR = 0.70;

export function normalizeEntityName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/\s+/g, ' ')
    .trim();
}

function emailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

export function verifiedIdentityKey({ email, externalRefs = {} } = {}) {
  if (email) return `email:${String(email).normalize('NFKC').toLocaleLowerCase('und').trim()}`;
  const verified = Object.entries(externalRefs)
    .filter(([system, id]) => system && id != null && String(id).trim())
    .sort(([left], [right]) => left.localeCompare(right))[0];
  return verified ? `external:${verified[0]}:${String(verified[1]).trim()}` : null;
}

export class EntityResolver {
  constructor({ prisma } = {}) {
    if (!prisma) throw new Error('EntityResolver requires prisma client');
    this.prisma = prisma;
  }

  /**
   * Lookup canonical entity by external system ID. Used by router for
   * idempotent re-sync.
   */
  async findByExternalRef({ organizationId, system, externalId }) {
    const ref = await this.prisma.externalRef.findFirst({
      where: { organizationId, system, externalId: String(externalId) },
      select: { memoryId: true, externalUrl: true, objectType: true },
    });
    if (!ref) return null;
    const link = await this.prisma.memoryEntityLink.findFirst({
      where: { memoryId: ref.memoryId },
      select: { entityId: true },
    });
    if (!link) return { entity: null, memoryId: ref.memoryId, externalUrl: ref.externalUrl };
    const entity = await this.prisma.canonicalEntity.findUnique({ where: { id: link.entityId } });
    return { entity, memoryId: ref.memoryId, externalUrl: ref.externalUrl };
  }

  async findByEmail({ organizationId, email }) {
    if (!email) return null;
    return this.prisma.canonicalEntity.findFirst({
      where: { organizationId, primaryEmail: String(email).toLowerCase() },
    });
  }

  /**
   * Find best-match canonical entity for a candidate. Returns
   * { entity, confidence, reason } or null.
   */
  async _bestMatch({ organizationId, name, kind, email, emailDomain: domain, externalRefs = {} }) {
    // 1. External ref (1.00)
    for (const [system, externalId] of Object.entries(externalRefs)) {
      if (!externalId) continue;
      const m = await this.findByExternalRef({ organizationId, system, externalId });
      if (m?.entity) return { entity: m.entity, confidence: 1.00, reason: `external_ref(${system})` };
    }

    // 2. Primary email (0.98)
    if (email) {
      const e = await this.findByEmail({ organizationId, email });
      if (e) return { entity: e, confidence: 0.98, reason: 'primary_email' };
    }

    // 3. Domain is a review signal only. Shared/hosted domains are not identity.
    if (kind === 'company' && domain) {
      const candidates = await this.prisma.canonicalEntity.findMany({
        where: { organizationId, entityKind: 'company', emailDomains: { has: domain } },
        take: 25,
      });
      if (candidates.length === 1) {
        return { entity: candidates[0], confidence: 0.85, reason: 'email_domain_review' };
      }
    }

    // 4. Name/alias matches never auto-link. They enter review because names
    // are not globally unique and language/transliteration can be ambiguous.
    if (name && kind) {
      const normalizedName = normalizeEntityName(name);
      if (normalizedName) {
        const candidates = await this.prisma.canonicalEntity.findMany({
          where: {
            organizationId,
            entityKind: kind,
            OR: [
              { normalizedName },
              { aliases: { has: name } },
            ],
          },
          take: 5,
        });
        if (candidates.length === 1) {
          return { entity: candidates[0], confidence: 0.80, reason: 'normalized_name_review' };
        }
      }
    }
    return null;
  }

  /**
   * Auto-link memory to canonical entities. Creates new entity if no
   * match above AUTO_LINK_FLOOR. Queues fuzzy candidates above REVIEW_FLOOR
   * for human review.
   */
  async resolveAndLink({ memoryId, candidates = [], organizationId, role = 'subject', userId }) {
    if (!memoryId || !organizationId) return [];
    const results = [];
    for (const cand of candidates) {
      if (!cand?.name && !cand?.email) continue;
      const kind = cand.kind || 'person';
      const domain = cand.emailDomain || emailDomain(cand.email);
      const externalRefs = cand.externalRefs || {};

      const match = await this._bestMatch({
        organizationId, name: cand.name, kind, email: cand.email, emailDomain: domain, externalRefs,
      });

      if (match && match.confidence >= AUTO_LINK_FLOOR) {
        await this._link({ memoryId, entityId: match.entity.id, role, confidence: match.confidence });
        // Merge new aliases / email_domains / external_refs into existing entity.
        await this._enrichEntity(match.entity.id, { name: cand.name, email: cand.email, domain, externalRefs });
        results.push({ entityId: match.entity.id, role, confidence: match.confidence, action: 'linked', reason: match.reason });
        continue;
      }
      if (match && match.confidence >= REVIEW_FLOOR) {
        const reviewId = await this._queueReview({ organizationId, memoryId, candidate: cand, proposedEntityId: match.entity.id, confidence: match.confidence, reason: match.reason });
        results.push({ reviewCandidateId: reviewId, entityId: match.entity.id, confidence: match.confidence, action: 'review', reason: match.reason });
        continue;
      }

      // Create new canonical entity.
      const canonicalName = cand.name || cand.email || 'Unknown';
      const identityKey = verifiedIdentityKey({ email: cand.email, externalRefs });
      let created;
      try {
        created = await this.prisma.canonicalEntity.create({
          data: {
            organizationId,
            canonicalName,
            normalizedName: normalizeEntityName(canonicalName),
            identityKey,
            entityKind: kind,
            aliases: cand.name ? [cand.name] : [],
            primaryEmail: cand.email ? String(cand.email).toLowerCase() : null,
            emailDomains: domain ? [domain] : [],
            externalRefs,
            metadata: cand.metadata || {},
          },
        });
      } catch (error) {
        if (!identityKey || error?.code !== 'P2002') throw error;
        created = await this.prisma.canonicalEntity.findUnique({
          where: { organizationId_entityKind_identityKey: { organizationId, entityKind: kind, identityKey } },
        });
        if (!created) throw error;
      }
      await this._link({ memoryId, entityId: created.id, role, confidence: 1.00 });
      results.push({ entityId: created.id, role, confidence: 1.00, action: 'created' });
    }
    return results;
  }

  async _link({ memoryId, entityId, role, confidence }) {
    try {
      await this.prisma.memoryEntityLink.upsert({
        where: { memoryId_entityId_role: { memoryId, entityId, role } },
        update: { confidence },
        create: { memoryId, entityId, role, confidence },
      });
    } catch (err) {
      // primary-key form may differ if Prisma client not regen'd; fall back to raw.
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO memory_entity_links (memory_id, entity_id, role, confidence) VALUES ($1::uuid,$2::uuid,$3,$4)
         ON CONFLICT (memory_id, entity_id, role) DO UPDATE SET confidence = EXCLUDED.confidence`,
        memoryId, entityId, role, confidence
      );
    }
  }

  async _enrichEntity(entityId, { name, email, domain, externalRefs }) {
    const e = await this.prisma.canonicalEntity.findUnique({ where: { id: entityId } });
    if (!e) return;
    const newAliases = name && !e.aliases.includes(name) ? [...e.aliases, name] : e.aliases;
    const newDomains = domain && !e.emailDomains.includes(domain) ? [...e.emailDomains, domain] : e.emailDomains;
    const mergedRefs = { ...(e.externalRefs || {}), ...externalRefs };
    const updates = {};
    if (newAliases.length !== e.aliases.length) updates.aliases = newAliases;
    if (newDomains.length !== e.emailDomains.length) updates.emailDomains = newDomains;
    if (JSON.stringify(mergedRefs) !== JSON.stringify(e.externalRefs)) updates.externalRefs = mergedRefs;
    if (!e.primaryEmail && email) updates.primaryEmail = String(email).toLowerCase();
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await this.prisma.canonicalEntity.update({ where: { id: entityId }, data: updates });
    }
  }

  async _queueReview({ organizationId, memoryId, candidate, proposedEntityId, confidence, reason }) {
    const row = await this.prisma.entityReviewCandidate.create({
      data: {
        organizationId,
        proposedEntityId,
        memoryId,
        candidateName: candidate.name || candidate.email || 'Unknown',
        candidateKind: candidate.kind || 'person',
        confidence,
        reason,
      },
    });
    return row.id;
  }

  async approveReview({ candidateId, userId }) {
    const c = await this.prisma.entityReviewCandidate.findUnique({ where: { id: candidateId } });
    if (!c) throw new Error('review candidate not found');
    if (c.proposedEntityId && c.memoryId) {
      await this._link({ memoryId: c.memoryId, entityId: c.proposedEntityId, role: 'subject', confidence: c.confidence });
    }
    await this.prisma.entityReviewCandidate.update({
      where: { id: candidateId },
      data: { status: 'approved', resolvedAt: new Date() },
    });
    return { ok: true };
  }

  async rejectReview({ candidateId }) {
    await this.prisma.entityReviewCandidate.update({
      where: { id: candidateId },
      data: { status: 'rejected', resolvedAt: new Date() },
    });
    return { ok: true };
  }

  async mergeEntities({ srcId, dstId }) {
    if (srcId === dstId) return { ok: true, noop: true };
    await this.prisma.$transaction(async (tx) => {
      const [src, dst] = await Promise.all([
        tx.canonicalEntity.findUnique({ where: { id: srcId } }),
        tx.canonicalEntity.findUnique({ where: { id: dstId } }),
      ]);
      if (!src || !dst) throw new Error('canonical entity not found');
      if (src.organizationId !== dst.organizationId) {
        throw new Error('Tenant scope violation in mergeEntities');
      }
      // Re-link memories from src to dst.
      await tx.$executeRawUnsafe(
        `UPDATE memory_entity_links SET entity_id = $1::uuid WHERE entity_id = $2::uuid
         ON CONFLICT (memory_id, entity_id, role) DO NOTHING`,
        dstId, srcId
      ).catch(async () => {
        // Postgres ON CONFLICT requires INSERT; do plain UPDATE + ignore unique violations.
        const links = await tx.memoryEntityLink.findMany({ where: { entityId: srcId } });
        for (const l of links) {
          try {
            await tx.memoryEntityLink.upsert({
              where: { memoryId_entityId_role: { memoryId: l.memoryId, entityId: dstId, role: l.role } },
              update: { confidence: Math.max(l.confidence, 1) },
              create: { memoryId: l.memoryId, entityId: dstId, role: l.role, confidence: l.confidence },
            });
          } catch {}
          await tx.memoryEntityLink.delete({
            where: { memoryId_entityId_role: { memoryId: l.memoryId, entityId: srcId, role: l.role } },
          }).catch(() => {});
        }
      });
      if (src && dst) {
        const mergedAliases = Array.from(new Set([...(dst.aliases || []), src.canonicalName, ...(src.aliases || [])])).filter(Boolean);
        const mergedDomains = Array.from(new Set([...(dst.emailDomains || []), ...(src.emailDomains || [])])).filter(Boolean);
        const mergedRefs = { ...(src.externalRefs || {}), ...(dst.externalRefs || {}) };
        const mergedFrom = [...(dst.mergedFrom || []), srcId];
        await tx.canonicalEntity.update({
          where: { id: dstId },
          data: {
            aliases: mergedAliases,
            emailDomains: mergedDomains,
            externalRefs: mergedRefs,
            mergedFrom,
            primaryEmail: dst.primaryEmail || src.primaryEmail,
            updatedAt: new Date(),
          },
        });
        await tx.canonicalEntity.delete({ where: { id: srcId } });
      }
    });
    return { ok: true, srcId, dstId };
  }

  async stats({ organizationId }) {
    const [total, byKind, pendingReview] = await Promise.all([
      this.prisma.canonicalEntity.count({ where: { organizationId } }),
      this.prisma.canonicalEntity.groupBy({ by: ['entityKind'], where: { organizationId }, _count: true }),
      this.prisma.entityReviewCandidate.count({ where: { organizationId, status: 'pending' } }),
    ]);
    const linkCount = await this.prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM memory_entity_links l
         JOIN canonical_entities e ON l.entity_id=e.id WHERE e.organization_id = $1::uuid`,
      organizationId
    );
    return {
      total_entities: total,
      by_kind: byKind.reduce((acc, r) => { acc[r.entityKind] = r._count; return acc; }, {}),
      memory_links: linkCount?.[0]?.n || 0,
      pending_review: pendingReview,
    };
  }
}
