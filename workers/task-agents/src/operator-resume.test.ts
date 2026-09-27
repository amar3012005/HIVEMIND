import assert from "node:assert/strict";
import { test } from "node:test";
import { approvePendingInput } from "./operator-resume.ts";

test("operator answer stays pending until workflow approval succeeds", async () => {
  assert.deepEqual(await approvePendingInput(async () => { throw new Error("approval_unavailable"); }), { approved: false, error: "approval_unavailable" });
  assert.deepEqual(await approvePendingInput(async () => undefined), { approved: true });
});
