export type RoomRoute = { mode: "direct" | "action" | "company"; groups: string[] };

const groups = new Set(["company", "web_research", "browser", "connected_apps", "records"]);

export function parseRoomRoute(text: string): RoomRoute | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as { mode?: unknown; groups?: unknown };
    if (value.mode !== "direct" && value.mode !== "action" && value.mode !== "company") return null;
    return { mode: value.mode, groups: Array.isArray(value.groups) ? value.groups.filter((name): name is string => typeof name === "string" && groups.has(name)) : [] };
  } catch { return null; }
}
