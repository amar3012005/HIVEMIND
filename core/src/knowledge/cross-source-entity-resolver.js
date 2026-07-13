/**
 * CrossSourceEntityResolver — merges entities only when providers supply the
 * same stable external identifier. Names, aliases, and domains are evidence
 * for review, never identity proof.
 */

function stableExternalIds(entity) {
  const ids = entity?.externalIds && typeof entity.externalIds === 'object'
    ? entity.externalIds : {};
  return new Set(Object.entries(ids)
    .filter(([key, value]) => key !== 'email' && key !== 'email_domain' && typeof value === 'string' && value.trim())
    .map(([key, value]) => `${key}:${value.trim()}`));
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
          const aIds = stableExternalIds(a);
          if (!aIds.size) continue;
          for (let j = i + 1; j < entities.length; j++) {
            if (merged.has(entities[j].id)) continue;
            const b = entities[j];
            const bIds = stableExternalIds(b);
            if ([...aIds].some((id) => bIds.has(id))) {
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

export { stableExternalIds };
