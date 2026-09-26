import { getAgentByName, routeAgentRequest } from "agents";
import { HivemindTaskAgent } from "./agent";
import { TaskLifecycleWorkflow } from "./workflow";
import { CompanyGovernor } from "./governor";

export { HivemindTaskAgent, TaskLifecycleWorkflow, CompanyGovernor };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/agents/")) {
      return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/v1/company/") && url.pathname.endsWith("/artifacts")) {
      const orgId = url.pathname.slice("/v1/company/".length, -"/artifacts".length);
      if (request.method === "POST") return saveCompanyArtifact(request, orgId, env);
      if (request.method === "GET") return companyArtifacts(orgId, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/runs/")) {
      const rest = url.pathname.slice("/v1/runs/".length);
      if (rest.endsWith("/events")) return runEvents(rest.slice(0, -"/events".length), request, env);
      return runTrace(rest, env);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/v1/tasks/tool-check") return toolCheck(request, env);
    if (url.pathname === "/v1/tasks/day1-research") return day1Research(request, env);
    if (url.pathname === "/v1/test-turn") return testTurn(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function saveCompanyArtifact(request: Request, orgId: string, env: Env): Promise<Response> {
  if (!routeAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => null) as { kind?: unknown; title?: unknown; contentType?: unknown; body?: unknown; storageLocation?: unknown } | null;
  const kind = typeof body?.kind === "string" ? body.kind : "";
  const title = typeof body?.title === "string" ? body.title : "";
  const contentType = typeof body?.contentType === "string" ? body.contentType : "";
  if (!kind || !title || !contentType) return Response.json({ error: "kind, title, and contentType are required" }, { status: 400 });
  const agent = await getAgentByName(env.HivemindTaskAgent as never, `company-${orgId}`);
  const artifact = await (agent as { saveCompanyArtifact(input: { kind: string; title: string; contentType: string; body?: string; storageLocation?: string }): Promise<unknown> }).saveCompanyArtifact({
    kind,
    title,
    contentType,
    body: typeof body?.body === "string" ? body.body : "",
    storageLocation: typeof body?.storageLocation === "string" ? body.storageLocation : "",
  });
  return Response.json({ orgId, artifact });
}

async function companyArtifacts(orgId: string, env: Env): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return new Response("Not found", { status: 404 });
  const agent = await getAgentByName(env.HivemindTaskAgent as never, `company-${orgId}`);
  const artifacts = await (agent as { listCompanyArtifacts(): Promise<unknown[]> }).listCompanyArtifacts();
  return Response.json({ orgId, artifacts });
}

async function runTrace(name: string, env: Env): Promise<Response> {
  const runId = decodeURIComponent(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
  if (!runId) return new Response("Not found", { status: 404 });
  const agent = await getAgentByName(env.HivemindTaskAgent as never, runId);
  const snap = await (agent as { snapshot(): Promise<{ events: { at: string; step: string; detail: string }[]; places: { name: string; website: string; phone: string; address: string }[]; transcript: string }> }).snapshot();
  const rows = (snap.events ?? []).map((event) => `<section><time>${escapeHtml(event.at)}</time><h2>${escapeHtml(event.step)}</h2><pre>${escapeHtml(event.detail)}</pre></section>`).join("");
  const places = (snap.places ?? []).map((place) => `<li><strong>${escapeHtml(place.name)}</strong> ${escapeHtml(place.website)} ${escapeHtml(place.phone)}<br>${escapeHtml(place.address)}</li>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(runId)}</title><style>body{margin:0;display:grid;grid-template-columns:380px 1fr;min-height:100vh;font:14px/1.45 ui-sans-serif,system-ui;background:#f4f1ea;color:#1c1c1c}aside{border-right:1px solid #e4e0d8;padding:20px;overflow:auto}main{padding:24px 28px;overflow:auto;background:#fff}h1{font-size:16px;margin:0 0 12px}h2{font-size:13px;margin:18px 0 8px;letter-spacing:.04em;text-transform:uppercase;color:#6b675f}time{display:block;color:#8a867e;font-size:11px}section{padding:10px 0;border-top:1px solid #eee}pre{white-space:pre-wrap;font:13px/1.45 ui-sans-serif,system-ui;margin:4px 0 0}</style><aside><h1>Run</h1><div id="log">${rows}</div></aside><main><h2>Artifact</h2><ol>${places || "<li>No companies saved yet.</li>"}</ol><h2>Transcript</h2><pre id="transcript">${escapeHtml(snap.transcript || "")}</pre></main>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function runEvents(name: string, request: Request, env: Env): Promise<Response> {
  const runId = decodeURIComponent(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
  if (!runId) return new Response("Not found", { status: 404 });
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: { at: string; step: string; detail: string }, id: number): void => {
        controller.enqueue(encoder.encode(`id: ${id}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`));
      };
      for (let tick = 0; tick < 60 && !closed; tick += 1) {
        const agent = await getAgentByName(env.HivemindTaskAgent as never, runId);
        const events = await (agent as { trace(): Promise<{ at: string; step: string; detail: string }[]> }).trace();
        (events ?? []).forEach((event, index) => send(event, index + 1));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      controller.close();
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char));
}

async function toolCheck(request: Request, env: Env): Promise<Response> {
  if (!routeAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => null) as { name?: unknown; orgId?: unknown; userId?: unknown; query?: unknown; url?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const input = {
    query: typeof body?.query === "string" ? body.query.slice(0, 300) : "",
    url: typeof body?.url === "string" ? body.url.slice(0, 300) : "",
  };
  if (!name || !/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(userId)) {
    return Response.json({ error: "name, org_id and user_id are required" }, { status: 400 });
  }
  const agent = await getAgentByName(env.HivemindTaskAgent as never, `check-${name}`);
  const result = await (agent as { checkToolkit(name: string, orgId: string, userId: string, input: { query: string; url: string }): Promise<unknown> }).checkToolkit(name, orgId, userId, input);
  return Response.json({ name, result });
}

function routeAuthorized(request: Request, env: Env): boolean {
  const testToken = env.TEST_TURN_TOKEN?.trim() ?? "";
  const roomToken = env.ROOM_STREAM_TOKEN?.trim() ?? "";
  const suppliedTest = (request.headers.get("x-hivemind-test-token") ?? "").trim();
  const suppliedRoom = (request.headers.get("x-hivemind-room-token") ?? "").trim();
  if (testToken && constantTimeEqual(suppliedTest, testToken)) return true;
  return Boolean(roomToken) && constantTimeEqual(suppliedRoom, roomToken);
}

async function day1Research(request: Request, env: Env): Promise<Response> {
  if (!routeAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => null) as { orgId?: unknown; userId?: unknown; company?: unknown; website?: unknown; market?: unknown; task?: unknown } | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(userId)) {
    return Response.json({ error: "org_id and user_id are required" }, { status: 400 });
  }
  const packet = {
    company: typeof body?.company === "string" ? body.company.slice(0, 200) : "",
    website: typeof body?.website === "string" ? body.website.slice(0, 300) : "",
    market: typeof body?.market === "string" ? body.market.slice(0, 200) : "",
  };
  const runId = `day1-${orgId}-flow`;
  const agent = await getAgentByName(env.HivemindTaskAgent as never, runId);
  const workflowId = await (agent as { startCompanyWork(work: { runId: string; orgId: string; userId: string; taskType: string; phase: string; inputRefs: string[]; outputSchemaId: string; company: string; website: string; market: string; task: string }): Promise<string> }).startCompanyWork({
    runId,
    orgId,
    userId,
    taskType: "local_market_competitors",
    phase: "day1",
    inputRefs: [packet.website],
    outputSchemaId: "competitor_market_brief_v1",
    company: packet.company,
    website: packet.website,
    market: packet.market,
    task: typeof body?.task === "string" ? body.task.slice(0, 2000) : "",
  });
  return Response.json({ status: "running", workflowId, runId, trace: `/v1/runs/${runId}` });
}

async function testTurn(request: Request, env: Env): Promise<Response> {
  // Never leave a prompt-execution endpoint open when the secret is missing.
  const expectedTurn = env.TEST_TURN_TOKEN?.trim() ?? "";
  if (!expectedTurn) return Response.json({ error: "test_turn_disabled" }, { status: 503 });
  const supplied = (request.headers.get("x-hivemind-test-token") ?? "").trim();
  if (!constantTimeEqual(supplied, expectedTurn)) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await request.json().catch(() => null) as { prompt?: unknown; runId?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
  const runId = typeof body?.runId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(body.runId)
    ? body.runId
    : crypto.randomUUID();
  if (!prompt) return Response.json({ error: "prompt_required" }, { status: 400 });
  try {
    const agent = await getAgentByName(env.HivemindTaskAgent as never, runId);
    const result = await (agent as { testPrompt(prompt: string): Promise<{ status: string; text: string; error: string }> }).testPrompt(prompt);
    return Response.json({ runId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "test_turn_failed";
    return Response.json({ runId, error: message }, { status: 502 });
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
