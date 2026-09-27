function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export async function connectedWriteKey(runId: string, toolSlug: string, args: Record<string, unknown>): Promise<string> {
  const payload = JSON.stringify([runId, toolSlug, canonical(args)]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function pointer(value: unknown, path: string): unknown {
  if (!path.startsWith("/") || path.length > 500) return undefined;
  return path.slice(1).split("/").reduce<unknown>((item, key) => {
    const part = key.replace(/~1/g, "/").replace(/~0/g, "~");
    return item && typeof item === "object" && Object.hasOwn(item, part) ? (item as Record<string, unknown>)[part] : undefined;
  }, value);
}

// A unique caller-supplied marker must match a concrete provider record. Absence never authorizes replay.
export function reconciledRecord(args: unknown, data: unknown, inputPath: string, resultPath: string, recordIdPath: string): string | null {
  const expected = pointer(args, inputPath);
  const actual = pointer(data, resultPath);
  const id = pointer(data, recordIdPath);
  if (typeof expected !== "string" || expected.length < 16 || actual !== expected) return null;
  return typeof id === "string" && id.trim() ? id : null;
}
