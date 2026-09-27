import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedWriteKey } from "./connected-write.ts";

test("connected write fingerprint ignores object key order but binds run and arguments", async () => {
  const first = await connectedWriteKey("run-1", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: { subject: "Hi", text: "Hello" } });
  assert.equal(first, await connectedWriteKey("run-1", "GMAIL_SEND_EMAIL", { body: { text: "Hello", subject: "Hi" }, to: "a@example.com" }));
  assert.notEqual(first, await connectedWriteKey("run-2", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: { subject: "Hi", text: "Hello" } }));
  assert.notEqual(first, await connectedWriteKey("run-1", "GMAIL_SEND_EMAIL", { to: "b@example.com", body: { subject: "Hi", text: "Hello" } }));
});

test("reconciliation requires original unique marker and provider record", async () => {
  const { reconciledRecord } = await import("./connected-write.ts");
  const args = { subject: "HyperAgent recovery canary unique-123" };
  assert.equal(reconciledRecord(args, { id: "draft-1", subject: args.subject }, "/subject", "/subject", "/id"), "draft-1");
  assert.equal(reconciledRecord(args, { id: "draft-1", subject: "another draft" }, "/subject", "/subject", "/id"), null);
  assert.equal(reconciledRecord(args, { subject: args.subject }, "/subject", "/subject", "/id"), null);
});
