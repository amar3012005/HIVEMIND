import { PlatformRegistryClient } from "./platform-registry-client.js";

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
  {
    limit = 100,
    now = new Date(),
    leaseMs = 60_000,
    workerId = `core-${process.pid}`,
    client = new PlatformRegistryClient(),
  } = {},
) {
  if (!client.enabled || !prisma?.platformRegistryOutbox)
    return { skipped: true, delivered: 0, failed: 0 };
  // A process may have died after claiming work.  Make those events retryable
  // before selecting fresh rows.  This never changes the immutable revision.
  await prisma.platformRegistryOutbox.updateMany({
    where: { status: "processing", leaseExpiresAt: { lt: now } },
    data: { status: "pending", leaseOwner: null, leaseExpiresAt: null },
  });
  const candidates = await prisma.platformRegistryOutbox.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { revision: "asc" },
    take: Math.max(1, Math.min(500, limit)),
  });
  let delivered = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const claim = await prisma.platformRegistryOutbox.updateMany({
      where: {
        id: candidate.id,
        status: "pending",
        nextAttemptAt: { lte: now },
      },
      data: { status: "processing", leaseOwner: workerId, leaseExpiresAt },
    });
    if (claim.count !== 1) continue;
    const row = candidate;
    try {
      await client.mirror({
        // The outbox primary key is the idempotency key.  Replays must send
        // exactly the same event ID so D1 can return the original receipt.
        event_id: row.id,
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
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      delivered += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      await prisma.platformRegistryOutbox.update({
        where: { id: row.id },
        data: {
          attempts,
          status: "pending",
          leaseOwner: null,
          leaseExpiresAt: null,
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

export function startPlatformRegistryOutboxDispatcher(
  prisma,
  {
    intervalMs = 5_000,
    limit = 100,
    logger = console,
    client = new PlatformRegistryClient(),
  } = {},
) {
  if (!client.enabled || !prisma?.platformRegistryOutbox) return () => {};
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await dispatchPlatformRegistryOutbox(prisma, {
        limit,
        client,
      });
      if (result.failed)
        logger.warn?.("[platform-registry] outbox replay failed", result);
    } catch (error) {
      logger.warn?.("[platform-registry] outbox dispatcher failed", {
        error: error?.message,
      });
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
