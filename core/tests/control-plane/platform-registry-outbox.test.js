import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchPlatformRegistryOutbox,
  enqueuePlatformRegistryEvent,
} from "../../src/control-plane/platform-registry-outbox.js";
import { createWorkspaceNotification } from "../../src/workspace/notifications.js";

test("outbox rejects unknown entity types", async () => {
  const prisma = {
    platformRegistryOutbox: {
      create: async () => {
        throw new Error("must not write");
      },
    },
  };
  assert.equal(
    await enqueuePlatformRegistryEvent(prisma, {
      entityType: "memory",
      entityId: "x",
      payload: {},
    }),
    null,
  );
});

test("disabled client leaves durable rows untouched", async () => {
  const result = await dispatchPlatformRegistryOutbox(
    {},
    { client: { enabled: false } },
  );
  assert.deepEqual(result, { skipped: true, delivered: 0, failed: 0 });
});

test("notification writes a redacted registry projection event", async () => {
  const events = [];
  const notification = {
    id: "00000000-0000-0000-0000-000000000001",
    orgId: "00000000-0000-0000-0000-000000000002",
    userId: "00000000-0000-0000-0000-000000000003",
    type: "workspace.update",
    title: "Registry ready",
    body: null,
    resourceType: null,
    resourceId: null,
    data: {},
    readAt: null,
  };
  const prisma = {
    workspaceNotification: { create: async () => notification },
    platformRegistryOutbox: {
      create: async ({ data }) => {
        events.push(data);
        return data;
      },
    },
  };
  const result = await createWorkspaceNotification(prisma, {
    orgId: notification.orgId,
    userId: notification.userId,
    title: notification.title,
  });
  assert.equal(result.id, notification.id);
  assert.deepEqual(events, [
    {
      entityType: "notification",
      entityId: notification.id,
      operation: "upsert",
      payload: {
        org_id: notification.orgId,
        user_id: notification.userId,
        type: "workspace.update",
        title: "Registry ready",
        body: null,
        resource_type: null,
        resource_id: null,
        data: {},
        read_at: null,
      },
    },
  ]);
});
