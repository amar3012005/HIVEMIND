export const TOOL_GROUPS = {
  company: ["hivemind_meta", "hivemind_recall", "get_user_profile", "load_company_packet"],
  web_research: ["parallel_search", "maps_search"],
  browser: ["browser_markdown", "browser_extract", "browser_links", "browser_capture"],
  connected_apps: ["hivemind_connected_task", "composio_discover_reads", "composio_read"],
  records: ["save_local_companies", "load_artifact"],
} as const;

export type ToolGroupName = keyof typeof TOOL_GROUPS;

export const BASIC_TOOLS = ["playbook_list", "playbook_list_local", "playbook_get", "refine_local_playbook", "reset_tools"] as const;

export function toolsForGroups(groups: readonly string[]): string[] {
  const names = new Set<string>(BASIC_TOOLS);
  for (const group of groups) {
    const members = TOOL_GROUPS[group as ToolGroupName];
    if (!members) continue;
    for (const name of members) names.add(name);
  }
  return [...names].sort();
}
