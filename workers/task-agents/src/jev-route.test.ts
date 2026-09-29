import assert from "node:assert/strict";
import test from "node:test";
import { readJevRoute, routeWithJev } from "./jev-route.ts";

const choice = (route: string, confidence: number, probabilities: Record<string, number>) => ({ answers: {
  route: { choice: route, confidence, probabilities },
  memory_destination: { choice: "none", confidence: 0.96, probabilities: { none: 0.96, agent: 0.02, company: 0.02 } },
} });

test("only confident action choices use fast route", () => {
  assert.equal(readJevRoute(choice("direct", 0.94, { direct: 0.95, action: 0.04, company: 0.01 })), null);
  assert.equal(readJevRoute(choice("action", 0.91, { direct: 0.02, action: 0.91, company: 0.07 })), "action");
  assert.equal(readJevRoute({ state: {}, result: choice("action", 0.94, { direct: 0.04, action: 0.95, company: 0.01 }) }), "action");
});

test("semantic private-memory destination takes the short durable route", () => {
  const result = { answers: {
    route: { choice: "action", confidence: 0.92, probabilities: { direct: 0.02, action: 0.92, company: 0.06 } },
    memory_destination: { choice: "agent", confidence: 0.96, probabilities: { none: 0.02, agent: 0.96, company: 0.02 } },
  } };
  assert.equal(readJevRoute(result), "agent_memory");
  assert.equal(readJevRoute({ answers: { ...result.answers, memory_destination: {
    choice: "company", confidence: 0.97, probabilities: { none: 0.02, agent: 0.01, company: 0.97 },
  } } }), null);
});

test("company, ambiguous, and malformed choices retain Think planner", () => {
  assert.equal(readJevRoute(choice("company", 0.98, { direct: 0, action: 0.02, company: 0.98 })), null);
  assert.equal(readJevRoute(choice("action", 0.7, { direct: 0.1, action: 0.7, company: 0.2 })), null);
  assert.equal(readJevRoute({ answers: { route: { choice: "direct", confidence: 1 } } }), null);
  assert.equal(readJevRoute({ answers: { route: { choice: "action", confidence: 0.99,
    probabilities: { direct: 0, action: 0.99, company: 0.01 } } } }), null);
});

test("model failure falls back without failing turn", async () => {
  assert.equal(await routeWithJev({ run: async () => { throw new Error("unavailable"); } }, { request: "Hello" }), null);
});
