import { TOOL_GROUPS, type ToolGroupName } from "./tool-groups.ts";

/** Explicit API calls in an operator request are execution requirements. */
export function explicitToolGroups(request: string): ToolGroupName[] {
  const groups: ToolGroupName[] = [];
  for (const [group, names] of Object.entries(TOOL_GROUPS) as [ToolGroupName, readonly string[]][]) {
    const required = names.some((name) => {
      const call = new RegExp(`\\b(?:use|call|run|invoke)\\s+(?:the\\s+)?${name}\\b`, "gi");
      return [...request.matchAll(call)].some((match) =>
        !/\b(?:do not|don't|never|without|no)\s*$/i.test(request.slice(Math.max(0, match.index - 20), match.index)));
    });
    if (required) groups.push(group);
  }
  return groups;
}
