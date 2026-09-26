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

export async function saveCompanyMemory(env: GatewayEnv, orgId: string, userId: string, title: string, content: string, options: { scope?: "personal" | "organization" | "project"; project?: string; idempotencyKey?: string } = {}): Promise<unknown> {
  const base = (env.HIVEMIND_CORE_URL || env.HIVEMIND_CONTROL_URL)?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_meta_unconfigured", tool: "save_memory" };
  const response = await fetch(`${base}/api/memories?sync=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-hm-user-id": userId,
      "x-hm-org-id": orgId,
      ...(options.idempotencyKey ? { "x-idempotency-key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      title: title.slice(0, 180),
      content: content.slice(0, 8000),
      tags: ["hyperagent", "company"],
      memory_type: "decision",
      user_id: userId,
      org_id: orgId,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.project ? { project: options.project } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_memory_response" }));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    return { error: message, status: response.status };
  }
  return { ok: response.status !== 202, status: response.status === 202 ? "pending" : "completed", payload, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) };
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

export async function readCompactProfile(env: GatewayEnv, orgId: string, userId: string): Promise<{ context: string } | { error: string; status?: number }> {
  const base = env.HIVEMIND_CORE_URL?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_profile_unconfigured" };
  const response = await fetch(`${base}/api/profiles/context`, {
    headers: { authorization: `Bearer ${key}`, "x-hm-user-id": userId, "x-hm-org-id": orgId },
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object" || !("context" in payload) || typeof payload.context !== "string") {
    return { error: "profile_context_unavailable", status: response.status };
  }
  return { context: payload.context.slice(0, 1200) };
}

async function coreMetaRequest(env: GatewayEnv, orgId: string, userId: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const base = env.HIVEMIND_CORE_URL?.replace(/\/$/, "");
  const key = env.HIVEMIND_MASTER_API_KEY;
  if (!base || !key) return { error: "hivemind_meta_unconfigured" };
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${key}`, "x-hm-user-id": userId, "x-hm-org-id": orgId,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid_meta_response" }));
  if (!response.ok) return { error: "hivemind_meta_failed", status: response.status, payload };
  return payload;
}

export async function readMetaEntities(env: GatewayEnv, orgId: string, userId: string, query: string, limit = 10): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(Math.max(1, Math.min(limit, 25))) });
  const result = await coreMetaRequest(env, orgId, userId, `/api/entities?${params}`);
  if (!result || typeof result !== "object" || !("items" in result) || !Array.isArray(result.items)) return result;
  return { items: result.items.slice(0, limit).map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { id: row.id, name: row.canonicalName, kind: row.entityKind, aliases: row.aliases };
  }), total: "total" in result ? result.total : undefined };
}

export async function readMetaRecall(env: GatewayEnv, orgId: string, userId: string, input: {
  query: string; limit?: number; mode?: string; scopeFilter?: string; validAt?: string; transactionAt?: string;
  project?: string; tags?: string[]; sourcePlatforms?: string[]; filename?: string; mediaKind?: string;
  entities?: string[]; sort?: string; includeSuperseded?: boolean;
}): Promise<unknown> {
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const result = await coreMetaRequest(env, orgId, userId, "/api/recall", {
    query_context: input.query, max_memories: limit, mode: input.mode || "auto",
    ...(input.scopeFilter ? { scope_filter: input.scopeFilter } : {}),
    ...(input.validAt ? { valid_at: input.validAt } : {}),
    ...(input.transactionAt ? { transaction_at: input.transactionAt } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.sourcePlatforms?.length ? { source_platforms: input.sourcePlatforms } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.mediaKind ? { media_kind: input.mediaKind } : {}),
    ...(input.entities?.length ? { entities: input.entities } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.includeSuperseded ? { include_superseded: true } : {}),
  });
  if (!result || typeof result !== "object" || !("memories" in result) || !Array.isArray(result.memories)) return result;
  const memories = result.memories.slice(0, limit).map((row) => {
    const memory = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return { id: memory.id, title: memory.title, content: typeof memory.content === "string" ? memory.content.slice(0, 1200) : "", source: memory.source, citation: memory.citation, createdAt: memory.created_at, validAt: memory.valid_at };
  });
  return { ok: true, count: memories.length, scoped: true, memories };
}

export async function readMetaSaveStatus(env: GatewayEnv, orgId: string, userId: string, key: string): Promise<unknown> {
  return coreMetaRequest(env, orgId, userId, `/api/memories/save-status?idempotency_key=${encodeURIComponent(key)}`);
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
