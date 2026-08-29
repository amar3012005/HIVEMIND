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

import { entityMatchVariants } from './entity-normalize.js';

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\b(gmbh|ag|kg|inc|llc|ltd|corp|corporation|company|co|sa|sas|srl|bv|nv|pte|plc|group|holding|holdings)\b\.?/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function emailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

function jaccard(a, b) {
  if (!a || !b) return 0;
  const sa = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersect = 0;
  for (const t of sa) if (sb.has(t)) intersect += 1;
  return intersect / (sa.size + sb.size - intersect);
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

    // 3. Domain + fuzzy name (0.90) — companies only
    if (kind === 'company' && domain) {
      const candidates = await this.prisma.canonicalEntity.findMany({
        where: { organizationId, entityKind: 'company', emailDomains: { has: domain } },
        take: 25,
      });
      if (candidates.length === 1) {
        return { entity: candidates[0], confidence: 0.92, reason: 'email_domain_unique' };
      }
      const normName = normalizeName(name);
      for (const c of candidates) {
        const score = jaccard(normName, normalizeName(c.canonicalName));
        if (score >= 0.85) return { entity: c, confidence: 0.90, reason: `domain+name_fuzzy(${score.toFixed(2)})` };
      }
    }

    // 4. Alias match
    if (name && kind) {
      const normName = normalizeName(name);
      if (normName.length >= 3) {
        const candidates = await this.prisma.canonicalEntity.findMany({
          where: {
            organizationId,
            entityKind: kind,
            OR: [
              { canonicalName: { equals: name, mode: 'insensitive' } },
              { aliases: { has: name } },
            ],
          },
          take: 5,
        });
        if (candidates.length === 1) {
          // 0.96, ABOVE AUTO_LINK_FLOOR (0.95). This was 0.93 — below the floor — so an
          // EXACT match auto-linked nothing and every hit went to the review queue instead.
          // Effect in production: the first document to mention an entity took the CREATE
          // path and linked fine; every later document mentioning the SAME entity resolved
          // here, scored 0.93, and silently linked nothing. Entity linking therefore decayed
          // to zero as an org's entity set saturated — measured on ten ingests of one file:
          // 31, 35, 28, 19, 12, 12, 0, 1 links, with "+0 entities, 0 links, 1 queued for
          // review" in the log. The graph quietly stopped growing on exactly the documents
          // that reinforce known entities, which are the ones that matter most.
          //
          // This branch is not a guess: the query is scoped by organizationId AND entityKind,
          // matches canonicalName case-insensitively or an exact alias, and requires EXACTLY
          // ONE candidate. That is identity. Raising this score (rather than lowering the
          // floor) keeps the floor meaningful — the 0.90 domain+name_fuzzy and 0.80/0.72
          // jaccard branches below ARE guesses and must still go to review.
          return { entity: candidates[0], confidence: 0.96, reason: 'name_alias_exact' };
        }
        // Fuzzy across all same-kind entities (cap 100, prefer recent)
        const fuzzyPool = await this.prisma.canonicalEntity.findMany({
          where: { organizationId, entityKind: kind },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        });
        let best = null;
        for (const c of fuzzyPool) {
          const score = jaccard(normName, normalizeName(c.canonicalName));
          if (!best || score > best.score) best = { entity: c, score };
        }
        if (best && best.score >= 0.85) return { entity: best.entity, confidence: 0.80, reason: `name_fuzzy(${best.score.toFixed(2)})` };
        if (best && best.score >= 0.70) return { entity: best.entity, confidence: 0.72, reason: `name_fuzzy_low(${best.score.toFixed(2)})` };
      }
    }
    return null;
  }

  /**
   * Auto-link memory to canonical entities. Creates new entity if no
   * match above AUTO_LINK_FLOOR. Queues fuzzy candidates above REVIEW_FLOOR
   * for human review.
   */
  async resolveAndLink({ memoryId, candidates = [], organizationId, role = 'subject', userId, linkMemory = true }) {
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
        if (linkMemory) await this._link({ memoryId, entityId: match.entity.id, role, confidence: match.confidence });
        // Merge new aliases / email_domains / external_refs into existing entity.
        await this._enrichEntity(match.entity.id, { name: cand.name, email: cand.email, domain, externalRefs });
        results.push({ entityId: match.entity.id, role, confidence: match.confidence, action: 'linked', reason: match.reason });
        continue;
      }
      if (match && match.confidence >= REVIEW_FLOOR) {
        const reviewId = linkMemory
          ? await this._queueReview({ organizationId, memoryId, candidate: cand, proposedEntityId: match.entity.id, confidence: match.confidence, reason: match.reason })
          : null;
        results.push({ reviewCandidateId: reviewId, entityId: match.entity.id, confidence: match.confidence, action: 'review', reason: match.reason });
        continue;
      }

      // Create new canonical entity.
      const _canonName = cand.name || cand.email || 'Unknown';
      // V5 dedup guard: reuse an existing entity with the SAME normalized name in
      // this org REGARDLESS of entityKind, before minting a new row. _bestMatch
      // scopes by kind, so the same real-world entity classified under different
      // kinds by different ingestion paths (e.g. "SolvisMax" as product vs
      // "solvismax" as company) would otherwise create case/kind variants. The
      // normalized name is a unicode-aware lowercase key (language-neutral), and
      // Postgres is immediately consistent so near-simultaneous saves can't race a
      // duplicate. Only reuse a specific (non-empty) normalized key.
      const _normKey = normalizeName(_canonName);
      if (_normKey && _normKey.length >= 2) {
        const existing = await this.prisma.canonicalEntity.findFirst({
          // in: variants — plural + diacritic folds of the key, so 'Wärmepumpen'
          // reuses 'Wärmepumpe' instead of minting a sibling canonical.
          where: { organizationId, normalizedName: { in: entityMatchVariants(_normKey) } },
          orderBy: { createdAt: 'asc' }, // oldest wins — the canonical original
        }).catch(() => null);
        if (existing) {
          if (linkMemory) await this._link({ memoryId, entityId: existing.id, role, confidence: 0.9 });
          await this._enrichEntity(existing.id, { name: cand.name, email: cand.email, domain, externalRefs });
          results.push({ entityId: existing.id, role, confidence: 0.9, action: 'linked', reason: 'normalized_name_reuse' });
          continue;
        }
      }
      const created = await this.prisma.canonicalEntity.create({
        data: {
          organizationId,
          canonicalName: _canonName,
          // normalized_name is NOT NULL in the DB; without it every create threw
          // P2011 and canonical_entities could never populate. Stable identity key.
          normalizedName: normalizeName(_canonName) || String(_canonName).toLowerCase(),
          entityKind: kind,
          aliases: cand.name ? [cand.name] : [],
          primaryEmail: cand.email ? String(cand.email).toLowerCase() : null,
          emailDomains: domain ? [domain] : [],
          externalRefs,
          metadata: cand.metadata || {},
        },
      });
      if (linkMemory) await this._link({ memoryId, entityId: created.id, role, confidence: 1.00 });
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
      const src = await tx.canonicalEntity.findUnique({ where: { id: srcId } });
      const dst = await tx.canonicalEntity.findUnique({ where: { id: dstId } });
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
