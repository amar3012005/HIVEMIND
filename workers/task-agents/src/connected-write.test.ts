import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedWriteKey } from "./connected-write.ts";

test("connected write fingerprint ignores object key order but binds run and arguments", async () => {
  const first = await connectedWriteKey("run-1", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: { subject: "Hi", text: "Hello" } });
  assert.equal(first, await connectedWriteKey("run-1", "GMAIL_SEND_EMAIL", { body: { text: "Hello", subject: "Hi" }, to: "a@example.com" }));
  assert.notEqual(first, await connectedWriteKey("run-2", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: { subject: "Hi", text: "Hello" } }));
  assert.notEqual(first, await connectedWriteKey("run-1", "GMAIL_SEND_EMAIL", { to: "b@example.com", body: { subject: "Hi", text: "Hello" } }));
});
