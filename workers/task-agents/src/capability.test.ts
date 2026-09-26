import assert from "node:assert/strict";
import test from "node:test";
import { authorizeCall, resolveToolkit } from "./capability.ts";
import { catalogForTenant } from "./catalog.ts";
import type { ToolGrant } from "./types.ts";

const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";

const catalog: ToolGrant[] = [
  { name: "load_company_packet", orgIds: [org], userIds: [user], tasks: ["day4_position"], roles: ["research", "strategy"] },
  { name: "record_evidence", orgIds: [org], userIds: [user], tasks: ["day4_position"], roles: ["research"] },
  { name: "draft_recommendation", orgIds: [org], userIds: [user], tasks: ["day4_position"], roles: ["strategy"] },
  { name: "check_receipt", orgIds: [org, other], userIds: [user], tasks: ["day4_position"], roles: ["verification"] },
  { name: "send_email", orgIds: [org], userIds: [user], tasks: ["day4_position"], roles: ["strategy"] },
];

const envelope = {
  runId: "run-1",
  orgId: org,
  userId: user,
  taskType: "day4_position",
  phase: "day4",
  inputRefs: ["receipt:day2"],
  outputSchemaId: "campaign_position_v1",
};

test("intersects task, org, user, and role", () => {
  const research = resolveToolkit(envelope, "research", catalog.filter((grant) => grant.name !== "send_email"));
  assert.deepEqual(research.tools, ["load_company_packet", "record_evidence"]);
  const verify = resolveToolkit(envelope, "verification", catalog);
  assert.deepEqual(verify.tools, ["check_receipt"]);
});

test("rejects a model-supplied organization", () => {
  const resolved = resolveToolkit(envelope, "research", catalog.filter((grant) => grant.name !== "send_email"));
  assert.throws(() => authorizeCall(resolved, "load_company_packet", other), /tenant_override_rejected/);
  assert.throws(() => authorizeCall(resolved, "draft_recommendation", org), /tool_not_granted/);
});

test("research receives the four toolkit families and verification does not", () => {
  const enabled = [
    "hivemind_recall", "parallel_search", "composio_discover_reads", "composio_read",
    "browser_markdown", "draft_recommendation",
  ];
  const catalog = catalogForTenant(org, user, enabled);
  const research = resolveToolkit(envelope, "research", catalog);
  assert.deepEqual(research.tools, ["browser_markdown", "composio_discover_reads", "composio_read", "hivemind_recall", "parallel_search"]);
  const verification = resolveToolkit(envelope, "verification", catalog);
  assert.deepEqual(verification.tools, ["hivemind_recall"]);
});

test("does not grant tools for another organization", () => {
  const foreign = resolveToolkit({ ...envelope, orgId: other, userId: user }, "research", catalog);
  assert.deepEqual(foreign.tools, []);
});
