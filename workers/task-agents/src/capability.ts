import type { ResolvedToolkit, SpecialistRole, TaskEnvelope, ToolGrant } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertEnvelope(value: TaskEnvelope): TaskEnvelope {
  if (!UUID.test(value.orgId) || !UUID.test(value.userId)) {
    throw new Error("tenant_identity_invalid");
  }
  if (!value.runId || !value.taskType || !value.phase || !value.outputSchemaId) {
    throw new Error("task_envelope_incomplete");
  }
  return value;
}

export function resolveToolkit(
  envelope: TaskEnvelope,
  role: SpecialistRole,
  catalog: readonly ToolGrant[],
): ResolvedToolkit {
  const trusted = assertEnvelope(envelope);
  const tools = catalog
    .filter((grant) => grant.roles.includes(role))
    .filter((grant) => grant.tasks.includes(trusted.taskType))
    .filter((grant) => grant.orgIds.includes(trusted.orgId))
    .filter((grant) => grant.userIds.includes(trusted.userId))
    .map((grant) => grant.name)
    .sort();
  return {
    orgId: trusted.orgId,
    userId: trusted.userId,
    taskType: trusted.taskType,
    role,
    tools: [...new Set(tools)],
  };
}

export function authorizeCall(resolved: ResolvedToolkit, toolName: string, claimedOrgId: string): void {
  if (claimedOrgId !== resolved.orgId) throw new Error("tenant_override_rejected");
  if (!resolved.tools.includes(toolName)) throw new Error("tool_not_granted");
}
