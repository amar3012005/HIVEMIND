import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoomRoute } from "./room-route.ts";

test("accepts native route and only known tool groups", () => {
  assert.deepEqual(parseRoomRoute('```json\n{"mode":"action","groups":["browser","unknown"]}\n```'), { mode: "action", groups: ["browser"] });
  assert.equal(parseRoomRoute('{"mode":"unknown","groups":[]}'), null);
  assert.equal(parseRoomRoute("not JSON"), null);
});
