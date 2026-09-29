export const TOOL_GROUPS = {
  company: ["hivemind_meta", "hyperagents_memory"],
  web_research: ["parallel_search", "parallel_search_batch", "maps_search"],
  browser: ["browser_markdown", "browser_extract", "browser_links", "browser_capture"],
  connected_apps: ["hivemind_connected_task"],
  records: ["save_local_companies", "load_artifact", "employee_workruns"],
} as const;

export type ToolGroupName = keyof typeof TOOL_GROUPS;

export const BASIC_TOOLS = ["hivemind_meta", "hyperagents_memory", "hivemind_connected_task", "employee_workruns", "browser_markdown", "browser_capture", "load_artifact", "playbook_list", "playbook_list_local", "playbook_get", "refine_local_playbook", "reset_tools"] as const;

export function toolsForGroups(groups: readonly string[], strict = false): string[] {
  const names = new Set<string>(BASIC_TOOLS);
  for (const group of groups) {
    const members = TOOL_GROUPS[group as ToolGroupName];
    if (!members) continue;
    for (const name of members) names.add(name);
  }
  if (strict) {
    for (const [group, members] of Object.entries(TOOL_GROUPS)) {
      if (groups.includes(group)) continue;
      for (const name of members) names.delete(name);
    }
  }
  return [...names].sort();
}
