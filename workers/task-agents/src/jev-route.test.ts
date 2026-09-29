import assert from "node:assert/strict";
import test from "node:test";
import { readJevRoute, routeWithJev } from "./jev-route.ts";

const choice = (route: string, confidence: number, probabilities: Record<string, number>) => ({ answers: {
  route: { choice: route, confidence, probabilities },
  memory_intent: { choice: "none", confidence: 0.96, probabilities: { none: 0.96, agent_session: 0.01, agent_record: 0.01, company: 0.02 } },
  work_shape: { choice: "bounded", confidence: 0.96, probabilities: { bounded: 0.96, staged: 0.04 } },
} });

test("only confident action choices use fast route", () => {
  assert.equal(readJevRoute(choice("direct", 0.94, { direct: 0.95, action: 0.04, company: 0.01 })), null);
  assert.equal(readJevRoute(choice("action", 0.91, { direct: 0.02, action: 0.91, company: 0.07 })), "action");
  assert.equal(readJevRoute({ state: {}, result: choice("action", 0.94, { direct: 0.04, action: 0.95, company: 0.01 }) }), "action");
});

test("semantic private-memory destination takes the short durable route", () => {
  const result = { answers: {
    route: { choice: "action", confidence: 0.92, probabilities: { direct: 0.02, action: 0.92, company: 0.06 } },
    memory_intent: { choice: "agent_session", confidence: 0.96, probabilities: { none: 0.01, agent_session: 0.96, agent_record: 0.01, company: 0.02 } },
  } };
  assert.equal(readJevRoute(result), "agent_memory_session");
  assert.equal(readJevRoute({ answers: { ...result.answers, memory_intent: {
    choice: "agent_record", confidence: 0.97, probabilities: { none: 0.01, agent_session: 0.01, agent_record: 0.97, company: 0.01 },
  } } }), "agent_memory_record");
  assert.equal(readJevRoute({ answers: { ...result.answers, memory_intent: {
    choice: "company", confidence: 0.97, probabilities: { none: 0.01, agent_session: 0.01, agent_record: 0.01, company: 0.97 },
  } } }), null);
});

test("company, ambiguous, and malformed choices retain Think planner", () => {
  assert.equal(readJevRoute(choice("company", 0.98, { direct: 0, action: 0.02, company: 0.98 })), null);
  assert.equal(readJevRoute(choice("action", 0.7, { direct: 0.1, action: 0.7, company: 0.2 })), null);
  assert.equal(readJevRoute({ answers: { route: { choice: "direct", confidence: 1 } } }), null);
  assert.equal(readJevRoute({ answers: { route: { choice: "action", confidence: 0.99,
    probabilities: { direct: 0, action: 0.99, company: 0.01 } } } }), null);
});

test("saved or multi-stage deliverables cannot bypass the Think plan", () => {
  const routed = choice("action", 0.96, { direct: 0.01, action: 0.96, company: 0.03 });
  routed.answers.work_shape = { choice: "staged", confidence: 0.96, probabilities: { bounded: 0.04, staged: 0.96 } };
  assert.equal(readJevRoute(routed), null);
  assert.equal(readJevRoute({ answers: { route: routed.answers.route, memory_intent: routed.answers.memory_intent } }), null);
  assert.equal(readJevRoute({ answers: { ...routed.answers, memory_intent: {
    choice: "agent_session", confidence: 0.96,
    probabilities: { none: 0.01, agent_session: 0.96, agent_record: 0.01, company: 0.02 },
  } } }), null);
});

test("model failure falls back without failing turn", async () => {
  assert.equal(await routeWithJev({ run: async () => { throw new Error("unavailable"); } }, { request: "Hello" }), null);
});
