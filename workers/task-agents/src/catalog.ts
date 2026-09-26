import type { ToolGrant } from "./types";

const READ_ROLES = ["research", "strategy", "verification"] as const;

export const TASK_TOOL_CATALOG: readonly ToolGrant[] = [
  {
    name: "load_company_packet",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: [...READ_ROLES],
  },
  {
    name: "hivemind_recall",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: [...READ_ROLES],
  },
  {
    name: "hivemind_get_memory",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research", "verification"],
  },
  {
    name: "hivemind_list_memories",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "hivemind_list_projects",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "get_user_profile",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research", "strategy"],
  },
  {
    name: "composio_discover_reads",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research", "strategy"],
  },
  {
    name: "composio_read",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "parallel_search",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "browser_markdown",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "browser_extract",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "browser_links",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "record_evidence",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["research"],
  },
  {
    name: "draft_recommendation",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["strategy"],
  },
  {
    name: "check_receipt",
    orgIds: [],
    userIds: [],
    tasks: ["day4_position"],
    roles: ["verification"],
  },
];

export function catalogForTenant(orgId: string, userId: string, enabled: readonly string[]): ToolGrant[] {
  return TASK_TOOL_CATALOG.filter((grant) => enabled.includes(grant.name)).map((grant) => ({
    ...grant,
    orgIds: [orgId],
    userIds: [userId],
  }));
}
