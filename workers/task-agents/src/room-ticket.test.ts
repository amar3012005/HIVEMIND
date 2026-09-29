import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { bindRoomEmployee, verifyRoomTicket } from "./room-ticket.ts";

test("room roster restores a missing ticket persona and rejects reassignment", () => {
  const lead = { id: "44444444-4444-4444-8444-444444444444", slug: "maya", name: "Maya", role: "Lead", persona: "Research." };
  assert.equal(bindRoomEmployee(null, lead).name, "Maya");
  assert.equal(bindRoomEmployee(lead, lead).id, lead.id);
  assert.throws(() => bindRoomEmployee({ ...lead, id: "55555555-5555-4555-8555-555555555555" }, lead), /room_employee_changed/);
  assert.throws(() => bindRoomEmployee(null, null), /room_employee_unavailable/);
});

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

test("signed room ticket binds the selected employee persona", async () => {
  const secret = "test-secret";
  const orgId = "11111111-1111-4111-8111-111111111111";
  const agentName = `session-${orgId}-33333333-3333-4333-8333-333333333333`;
  const payload = { v: 2, orgId, userId: "22222222-2222-4222-8222-222222222222", agentName, expiresAt: 160_000,
    employee: { id: "44444444-4444-4444-8444-444444444444", slug: "maya", name: "Maya", role: "Research lead", persona: "Research with citations." } };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
  assert.equal((await verifyRoomTicket(signed, secret, agentName, 100_000))?.employee?.name, "Maya");
  const tampered = Buffer.from(JSON.stringify({ ...payload, employee: { ...payload.employee, name: "Other" } })).toString("base64url");
  assert.equal(await verifyRoomTicket(`${tampered}.${signed.split(".")[1]}`, secret, agentName, 100_000), null);
});
