import assert from "node:assert/strict";
import test from "node:test";
import { taskPlaybookSnapshot } from "./playbook-snapshot.ts";

const pin = { playbookId: "local:outreach.prospect-list", snapshot: "Pinned version 4" };

test("a restarted continuation reuses its own immutable method without consulting its predecessor", () => {
  assert.equal(taskPlaybookSnapshot(pin.playbookId, pin, null, true, "new source version"), pin.snapshot);
});

test("a new continuation inherits only its predecessor's pinned snapshot", () => {
  assert.equal(taskPlaybookSnapshot(pin.playbookId, null, pin, true, "new source version"), pin.snapshot);
  assert.throws(() => taskPlaybookSnapshot(pin.playbookId, null, null, true, "new source version"), /continuation_playbook_unavailable/);
});

test("an existing pin cannot silently change versions", () => {
  assert.throws(() => taskPlaybookSnapshot("local:research.competitor-market", pin, null, true, "new source version"), /run_playbook_conflict/);
  assert.throws(() => taskPlaybookSnapshot(pin.playbookId, { ...pin, snapshot: "" }, null, true, "new source version"), /pinned_playbook_unavailable/);
});
