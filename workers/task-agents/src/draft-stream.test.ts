import assert from "node:assert/strict";
import test from "node:test";
import { partialToolText } from "./draft-stream.ts";

test("extracts text from an unfinished structured tool call", async () => {
  assert.equal(await partialToolText('{"needsInput":false,"report":"# Campaign\\nFirst', "report"), "# Campaign\nFirst");
  assert.equal(await partialToolText('{"message":"I will check company', "message"), "I will check company");
  assert.equal(await partialToolText('{"mode":"direct","reply":"A square has four equal', "report"), "A square has four equal");
});
