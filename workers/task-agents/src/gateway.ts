export interface GatewayEnv {
  HIVEMIND_CONTROL_URL?: string;
  HIVEMIND_MASTER_API_KEY?: string;
  HIVEMIND_META_URL?: string;
  HIVEMIND_CORE_URL?: string;
  AI?: unknown;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_MODEL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS?: string;
  GOOGLE_MAPS_API_KEY?: string;
  BROWSER?: unknown;
}

export async function getControl(env: GatewayEnv, path: string): Promise<unknown> {
  const base = env.HIVEMIND_CONTROL_URL?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "control_plane_unconfigured" };
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_control_response" }));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    return { error: message, status: response.status };
  }
  return payload;
}

export async function postControl(
  env: GatewayEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const base = env.HIVEMIND_CONTROL_URL?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "control_plane_unconfigured" };
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_control_response" }));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    return { error: message, status: response.status };
  }
  return payload;
}

export interface MapPlace {
  name: string;
  address: string;
  website: string;
  mapsUrl: string;
}

export async function mapsPlaces(env: GatewayEnv, textQuery: string): Promise<{ places: MapPlace[]; error?: string }> {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return { places: [], error: "google_maps_unconfigured" };
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.websiteUri,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery, pageSize: 5 }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") {
    return { places: [], error: `google_maps_${response.status}` };
  }
  const rows = "places" in payload && Array.isArray(payload.places) ? payload.places : [];
  const places = rows.slice(0, 5).map((row) => {
    const place = row && typeof row === "object" ? row as { displayName?: { text?: string }; formattedAddress?: string; websiteUri?: string; googleMapsUri?: string } : {};
    return {
      name: place.displayName?.text ?? "",
      address: place.formattedAddress ?? "",
      website: place.websiteUri ?? "",
      mapsUrl: place.googleMapsUri ?? "",
    };
  }).filter((place) => place.name);
  return { places };
}

export async function saveCompanyMemory(env: GatewayEnv, orgId: string, userId: string, title: string, content: string): Promise<unknown> {
  const base = (env.HIVEMIND_CORE_URL || env.HIVEMIND_CONTROL_URL)?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_meta_unconfigured", tool: "save_memory" };
  const response = await fetch(`${base}/api/memories`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-hm-user-id": userId,
      "x-hm-org-id": orgId,
    },
    body: JSON.stringify({
      title: title.slice(0, 180),
      content: content.slice(0, 8000),
      tags: ["hyperagent", "company"],
      memory_type: "decision",
      user_id: userId,
      org_id: orgId,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_memory_response" }));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    return { error: message, status: response.status };
  }
  return { ok: true, payload };
}

export async function recallCompany(env: GatewayEnv, orgId: string, userId: string, query: string): Promise<unknown> {
  const base = (env.HIVEMIND_CORE_URL || env.HIVEMIND_CONTROL_URL)?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_meta_unconfigured", tool: "hivemind_recall" };
  const response = await fetch(`${base}/api/recall`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-hm-user-id": userId,
      "x-hm-org-id": orgId,
    },
    body: JSON.stringify({ query_context: query, max_memories: 5, mode: "auto" }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_recall_response" }));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    return { error: message, status: response.status };
  }
  const memories = payload && typeof payload === "object" && "memories" in payload && Array.isArray(payload.memories)
    ? payload.memories.slice(0, 5).map((row) => {
      const memory = row && typeof row === "object" ? row as { title?: unknown; content?: unknown; id?: unknown } : {};
      return {
        id: typeof memory.id === "string" ? memory.id : "",
        title: typeof memory.title === "string" ? memory.title.slice(0, 160) : "",
        excerpt: typeof memory.content === "string" ? memory.content.slice(0, 240) : "",
      };
    })
    : [];
  return { ok: true, count: memories.length, memories };
}

export async function readCompanyProfile(env: GatewayEnv, orgId: string, userId: string): Promise<unknown> {
  const base = env.HIVEMIND_CORE_URL?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_profile_unconfigured" };
  const response = await fetch(`${base}/api/profiles`, {
    headers: { authorization: `Bearer ${key}`, "x-hm-user-id": userId, "x-hm-org-id": orgId },
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_profile_response" }));
  return response.ok ? payload : { error: "profile_read_failed", status: response.status };
}

export async function parallelSearch(env: GatewayEnv, query: string): Promise<unknown> {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_ID;
  const key = env.CLOUDFLARE_AI_GATEWAY_TOKEN;
  if (!account || !gateway || !key) return { error: "parallel_gateway_unconfigured" };
  const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/parallel/v1beta/search`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ objective: query.slice(0, 500), processor: "base", max_results: 10, max_chars_per_result: 700 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return { error: "parallel_search_failed", status: response.status };
  const payload: unknown = await response.json().catch(() => null);
  const rows = payload && typeof payload === "object" && "results" in payload && Array.isArray(payload.results) ? payload.results : [];
  const results = rows.map((row) => {
    const item = row && typeof row === "object" ? row as { title?: unknown; url?: unknown; text?: unknown; content?: unknown } : {};
    return {
      title: typeof item.title === "string" ? item.title.slice(0, 300) : "",
      url: typeof item.url === "string" ? item.url.slice(0, 1000) : "",
      snippet: String(item.text ?? item.content ?? "").slice(0, 700),
    };
  }).filter((item) => /^https?:\/\//.test(item.url));
  return { provider: "parallel-ai-gateway", results };
}

export async function postMeta(env: GatewayEnv, tool: string, body: Record<string, unknown>): Promise<unknown> {
  const base = env.HIVEMIND_META_URL?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_meta_unconfigured", tool };
  const response = await fetch(`${base}/internal/agent-tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_meta_response" }));
  if (!response.ok) return { error: "hivemind_meta_failed", status: response.status, payload };
  return payload;
}
