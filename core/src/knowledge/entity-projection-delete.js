function normalizeResources(resources = []) {
  const seen = new Set();
  const normalized = [];
  for (const resource of resources) {
    const resourceType = String(resource?.resourceType || '').trim();
    const resourceId = String(resource?.resourceId || '').trim();
    if (!resourceType || !resourceId) continue;
    const key = `${resourceType}:${resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ resourceType, resourceId });
  }
  return normalized;
}

/**
 * Remove every canonical-entity projection for resources that are being
 * deleted. ResourceEntityLink and EntityExtractionReceipt deliberately have no
 * foreign key to the polymorphic resource, so document/memory cascade deletes
 * cannot clean them automatically.
 */
export async function purgeEntityResourceProjections({ prisma, organizationId, resources = [] }) {
  const targets = normalizeResources(resources);
  if (!prisma || !organizationId || targets.length === 0) {
    return { resources: 0, resourceLinks: 0, memoryLinks: 0, receipts: 0, entities: 0 };
  }

  const resourceFilter = {
    organizationId,
    OR: targets.map(({ resourceType, resourceId }) => ({ resourceType, resourceId })),
  };
  const memoryIds = targets
    .filter(({ resourceType }) => resourceType === 'memory')
    .map(({ resourceId }) => resourceId);

  return prisma.$transaction(async (tx) => {
    const [resourceEntityRows, memoryEntityRows] = await Promise.all([
      tx.resourceEntityLink.findMany({
        where: resourceFilter,
        select: { entityId: true },
      }),
      memoryIds.length
        ? tx.memoryEntityLink.findMany({
          where: { memoryId: { in: memoryIds } },
          select: { entityId: true },
        })
        : [],
    ]);
    const candidateEntityIds = Array.from(new Set([
      ...resourceEntityRows.map(({ entityId }) => entityId),
      ...memoryEntityRows.map(({ entityId }) => entityId),
    ].filter(Boolean)));

    const [resourceLinks, memoryLinks, receipts] = await Promise.all([
      tx.resourceEntityLink.deleteMany({ where: resourceFilter }),
      memoryIds.length
        ? tx.memoryEntityLink.deleteMany({ where: { memoryId: { in: memoryIds } } })
        : { count: 0 },
      tx.entityExtractionReceipt.deleteMany({ where: resourceFilter }),
    ]);

    const entities = candidateEntityIds.length
      ? await tx.canonicalEntity.deleteMany({
        where: {
          organizationId,
          id: { in: candidateEntityIds },
          resourceLinks: { none: {} },
          memoryLinks: { none: {} },
          subjectClaims: { none: {} },
          objectClaims: { none: {} },
        },
      })
      : { count: 0 };

    return {
      resources: targets.length,
      resourceLinks: resourceLinks.count,
      memoryLinks: memoryLinks.count,
      receipts: receipts.count,
      entities: entities.count,
    };
  });
}

