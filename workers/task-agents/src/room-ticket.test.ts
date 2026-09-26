import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyRoomTicket } from "./room-ticket.ts";

test("room ticket binds user, organization, room and expiry", async () => {
  const secret = "test-secret";
  const orgId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const roomId = "33333333-3333-4333-8333-333333333333";
  const agentName = `session-${orgId}-${roomId}`;
  const now = 100_000;
  const encoded = Buffer.from(JSON.stringify({ v: 1, orgId, userId, agentName, expiresAt: now + 60_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const ticket = `${encoded}.${signature}`;
  assert.equal((await verifyRoomTicket(ticket, secret, agentName, now))?.userId, userId);
  assert.equal(await verifyRoomTicket(ticket, secret, `session-${orgId}-44444444-4444-4444-8444-444444444444`, now), null);
  assert.equal(await verifyRoomTicket(ticket, secret, agentName, now + 60_000), null);
  assert.equal(await verifyRoomTicket(`${encoded}.bad`, secret, agentName, now), null);
});
