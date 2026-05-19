/**
 * CrossSourceEntityResolver — merges entities representing the same real-world
 * thing across providers. Runs as part of hygiene scanner cron.
 *
 * Strategy:
 *   1. For each entityType, group entities sharing aliases (canonical names
 *      OR alias strings overlap).
 *   2. Score similarity: name match + alias overlap + email-domain match.
 *   3. If score >= threshold, merge: pick row with highest mentionCount as
 *      canonical, append aliases, repoint entity_mentions, mark merged.
 */

const MERGE_THRESHOLD = 0.85;

function normalize(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9@._-]/g, ''); }

function aliasSet(entity) {
  const set = new Set();
  set.add(normalize(entity.canonicalName));
  for (const a of entity.aliases || []) set.add(normalize(a));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

function emailDomain(s) {
  const m = /^[^@]+@([a-z0-9.-]+)/i.exec(String(s || ''));
  return m ? m[1].toLowerCase().split('.')[0] : null;
}

export class CrossSourceEntityResolver {
  constructor({ prisma, logger = console }) { this.prisma = prisma; this.logger = logger; }

  async resolveOrg(orgId) {
    let mergedCount = 0;
    for (const entityType of ['person', 'organization', 'project', 'product']) {
      try {
        const entities = await this.prisma.entity.findMany({
          where: { orgId, entityType, isActive: true },
          select: { id: true, canonicalName: true, aliases: true, mentionCount: true, externalIds: true },
          orderBy: { mentionCount: 'desc' },
          take: 200,
        });
        if (entities.length < 2) continue;

        const merged = new Set();
        for (let i = 0; i < entities.length; i++) {
          if (merged.has(entities[i].id)) continue;
          const a = entities[i];
          const aSet = aliasSet(a);
          for (let j = i + 1; j < entities.length; j++) {
            if (merged.has(entities[j].id)) continue;
            const b = entities[j];
            const bSet = aliasSet(b);
            const sim = jaccard(aSet, bSet);
            // Email-domain heuristic: same domain → strong signal
            const aDomain = [...aSet].map(emailDomain).find(Boolean);
            const bDomain = [...bSet].map(emailDomain).find(Boolean);
            const domainBoost = (aDomain && bDomain && aDomain === bDomain) ? 0.25 : 0;
            if (sim + domainBoost >= MERGE_THRESHOLD) {
              try {
                await this._mergeInto(a, b);
                merged.add(b.id);
                mergedCount++;
              } catch (err) {
                this.logger.warn?.(`[entity-resolver] merge ${a.canonicalName}<-${b.canonicalName} failed: ${err.message}`);
              }
            }
          }
        }
      } catch (err) {
        this.logger.warn?.(`[entity-resolver] type ${entityType} failed: ${err.message}`);
      }
    }
    return mergedCount;
  }

  async _mergeInto(canonical, duplicate) {
    await this.prisma.$transaction([
      this.prisma.entityMention.updateMany({
        where: { entityId: duplicate.id },
        data: { entityId: canonical.id },
      }),
      this.prisma.entity.update({
        where: { id: canonical.id },
        data: {
          aliases: { set: Array.from(new Set([...(canonical.aliases || []), duplicate.canonicalName, ...(duplicate.aliases || [])])).slice(0, 50) },
          mentionCount: { increment: duplicate.mentionCount || 0 },
          mergedFromIds: { push: duplicate.id },
          lastSeenAt: new Date(),
        },
      }),
      this.prisma.entity.update({
        where: { id: duplicate.id },
        data: { isActive: false, mergedFromIds: { push: canonical.id } },
      }),
    ]);
  }
}
