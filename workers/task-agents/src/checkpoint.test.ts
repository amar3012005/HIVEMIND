import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpoint } from "./checkpoint.ts";

test("restart reuses completed work and retries only interrupted stage, scoped to run", async () => {
  const journal = new Map<string, unknown>();
  const store = {
    async readWorkCheckpoint(run: string, stage: string) { const key = `${run}:${stage}`; return journal.has(key) ? { value: journal.get(key) } : null; },
    async writeWorkCheckpoint(run: string, stage: string, value: unknown) { journal.set(`${run}:${stage}`, value); },
  };
  let calls = 0;
  const work = async () => ({ receipt: ++calls });
  assert.deepEqual(await checkpoint(store, "one", "save", work), { receipt: 1 });
  await assert.rejects(checkpoint(store, "one", "next", async () => { throw new Error("interrupted"); }));
  assert.deepEqual(await checkpoint(store, "one", "save", work), { receipt: 1 });
  assert.deepEqual(await checkpoint(store, "one", "next", work), { receipt: 2 });
  assert.deepEqual(await checkpoint(store, "two", "save", work), { receipt: 3 });
});
