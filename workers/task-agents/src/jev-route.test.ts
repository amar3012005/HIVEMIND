import assert from "node:assert/strict";
import test from "node:test";
import { readJevRoute, routeWithJev } from "./jev-route.ts";

const choice = (route: string, confidence: number, probabilities: Record<string, number>) => ({ answers: { route: { choice: route, confidence, probabilities } } });

test("confident direct and action choices use fast route", () => {
  assert.equal(readJevRoute(choice("direct", 0.94, { direct: 0.95, action: 0.04, company: 0.01 })), "direct");
  assert.equal(readJevRoute(choice("action", 0.91, { direct: 0.02, action: 0.91, company: 0.07 })), "action");
  assert.equal(readJevRoute({ state: {}, result: choice("direct", 0.94, { direct: 0.95, action: 0.04, company: 0.01 }) }), "direct");
});

test("company, ambiguous, and malformed choices retain Think planner", () => {
  assert.equal(readJevRoute(choice("company", 0.98, { direct: 0, action: 0.02, company: 0.98 })), null);
  assert.equal(readJevRoute(choice("action", 0.7, { direct: 0.1, action: 0.7, company: 0.2 })), null);
  assert.equal(readJevRoute({ answers: { route: { choice: "direct", confidence: 1 } } }), null);
});

test("model failure falls back without failing turn", async () => {
  assert.equal(await routeWithJev({ run: async () => { throw new Error("unavailable"); } }, { request: "Hello" }), null);
});
