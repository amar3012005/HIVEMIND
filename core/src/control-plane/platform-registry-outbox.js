import {
  PlatformRegistryClient,
  registryEventId,
} from "./platform-registry-client.js";

const ENTITY_TYPES = new Set([
  "user",
  "organization",
  "membership",
  "invite",
  "api_key",
  "entitlement",
  "memory_box",
  "team",
  "project",
  "team_member",
  "project_member",
  "notification",
  "organization_profile",
  "billing_checkout",
  "plan_catalog",
]);

export async function enqueuePlatformRegistryEvent(
  prisma,
  { entityType, entityId, operation = "upsert", payload },
) {
  if (!prisma?.platformRegistryOutbox || !ENTITY_TYPES.has(entityType))
    return null;
  return prisma.platformRegistryOutbox.create({
    data: { entityType, entityId, operation, payload },
  });
}

export async function dispatchPlatformRegistryOutbox(
  prisma,
  { limit = 100, now = new Date(), client = new PlatformRegistryClient() } = {},
) {
  if (!client.enabled || !prisma?.platformRegistryOutbox)
    return { skipped: true, delivered: 0, failed: 0 };
  const rows = await prisma.platformRegistryOutbox.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { revision: "asc" },
    take: Math.max(1, Math.min(500, limit)),
  });
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await client.mirror({
        event_id: registryEventId(),
        entity_type: row.entityType,
        entity_id: row.entityId,
        revision: Number(row.revision),
        operation: row.operation,
        payload: row.payload,
      });
      await prisma.platformRegistryOutbox.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      delivered += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      await prisma.platformRegistryOutbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: String(error?.message || error).slice(0, 2000),
          nextAttemptAt: new Date(
            Date.now() + Math.min(300000, 1000 * 2 ** Math.min(8, attempts)),
          ),
        },
      });
      failed += 1;
      if (client.mode === "authoritative") throw error;
    }
  }
  return { skipped: false, delivered, failed };
}
