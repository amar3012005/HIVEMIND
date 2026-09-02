import { enqueuePlatformRegistryEvent } from "../control-plane/platform-registry-outbox.js";

const MAX_TITLE = 180;
const MAX_BODY = 1000;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export async function createWorkspaceNotification(prisma, input) {
  if (!prisma?.workspaceNotification || !input?.orgId || !input?.userId)
    return null;
  const title = clean(input.title, MAX_TITLE);
  if (!title) return null;
  const data = input.data && typeof input.data === "object" ? input.data : {};
  const create = {
    orgId: input.orgId,
    userId: input.userId,
    type: clean(input.type, 80) || "workspace.update",
    title,
    body: clean(input.body, MAX_BODY) || null,
    resourceType: clean(input.resourceType, 80) || null,
    resourceId: clean(input.resourceId, 128) || null,
    data,
    dedupeKey: clean(input.dedupeKey, 200) || null,
  };
  const notification = !create.dedupeKey
    ? await prisma.workspaceNotification.create({ data: create })
    : await prisma.workspaceNotification.upsert({
        where: {
          orgId_userId_dedupeKey: {
            orgId: create.orgId,
            userId: create.userId,
            dedupeKey: create.dedupeKey,
          },
        },
        create,
        update: {
          title: create.title,
          body: create.body,
          data: create.data,
          readAt: null,
          createdAt: new Date(),
        },
      });

  // This function receives the caller's Prisma client.  When that client is a
  // transaction client, the registry row is committed atomically with the
  // notification; otherwise the existing non-transactional caller behaviour
  // remains unchanged while still producing a repairable event.
  await enqueuePlatformRegistryEvent(prisma, {
    entityType: "notification",
    entityId: notification.id,
    operation: "upsert",
    payload: {
      org_id: notification.orgId,
      user_id: notification.userId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      resource_type: notification.resourceType,
      resource_id: notification.resourceId,
      data: notification.data || {},
      read_at: notification.readAt?.toISOString?.() || null,
    },
  });
  return notification;
}
