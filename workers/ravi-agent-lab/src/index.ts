import { Agent, getAgentByName, routeAgentRequest } from 'agents';
import { connectBrowserSession, createBrowserSession, deleteBrowserSession, listBrowserTargets, type BrowserBinding } from 'agents/browser';

type ToolName = 'fetch_public_source' | 'hivemind_web_search' | 'composio_execute';

type SourceReceipt = {
  tool: 'fetch_public_source'; url: string; title: string; status: number;
  captured_at: string; content_hash: string; excerpt: string;
};

type BrowserReceipt = {
  tool: 'cloudflare_browser'; url: string; title: string; captured_at: string;
  artifact_key: string; artifact_sha256: string;
};

type RunRecord = {
  request_id: string; task: string; status: 'running' | 'complete' | 'degraded';
  started_at: string; completed_at?: string; tools: ToolName[]; receipts: SourceReceipt[];
  browser_receipts?: BrowserReceipt[]; reviewer_verdict?: { passed: boolean; reason: string };
  synthesis?: string; warnings: string[];
};

type RaviState = { persona: string; runs: Record<string, RunRecord>; updated_at: string };

interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  RAVI_LAB_SECRET: string;
  RAVI_RESEARCH_AGENT: DurableObjectNamespace<RaviResearchAgent>;
  RAVI_REVIEWER_AGENT: DurableObjectNamespace<RaviReviewerAgent>;
  BROWSER: BrowserBinding;
  ARTIFACTS: R2Bucket;
}

const RAVI_PERSONA = `You are Ravi Patel, the User & Market Researcher for Singulance. You uncover enterprise needs, competitive landscape, and adoption evidence for sovereign, low-latency AI solutions. Focus on regulated European enterprises, use only supplied evidence, distinguish verified facts from gaps, and do not invent pricing, compliance claims, customers, metrics, or provider actions.`;
const DEFAULT_SOURCES = [
  'https://developers.cloudflare.com/agents/',
  'https://developers.cloudflare.com/agents/tools/browser/',
];
const ALLOWED_HOSTS = new Set(['developers.cloudflare.com', 'blog.cloudflare.com']);

function now() { return new Date().toISOString(); }

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleFromHtml(value: string): string {
  const match = value.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripHtml(match?.[1] || 'Untitled').slice(0, 240);
}

function allowedPublicUrl(raw: unknown): URL | null {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) ? url : null;
  } catch { return null; }
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(left)), crypto.subtle.digest('SHA-256', encoder.encode(right))]);
  const aa = new Uint8Array(a); const bb = new Uint8Array(b); let difference = aa.length ^ bb.length;
  for (let index = 0; index < Math.min(aa.length, bb.length); index += 1) difference |= aa[index] ^ bb[index];
  return difference === 0;
}

async function authorized(request: Request, env: Env) {
  return sameSecret(String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), env.RAVI_LAB_SECRET);
}

function modelText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const priorityKeys = ['response', 'result', 'text', 'generated_text', 'output_text', 'content'];
  const visit = (value: unknown, depth = 0): string => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || depth > 5) return '';
    if (Array.isArray(value)) {
      for (const item of value) { const found = visit(item, depth + 1); if (found) return found; }
      return '';
    }
    const row = value as Record<string, unknown>;
    for (const key of priorityKeys) { const found = visit(row[key], depth + 1); if (found) return found; }
    for (const key of ['message', 'choices', 'output']) { const found = visit(row[key], depth + 1); if (found) return found; }
    return '';
  };
  return visit(response);
}

export class RaviReviewerAgent extends Agent<Env, { reviewed: number }> {
  initialState = { reviewed: 0 };

  async review(receipts: SourceReceipt[], browserReceipts: BrowserReceipt[]) {
    const passed = receipts.length >= 2 && receipts.every((receipt) => receipt.status >= 200 && receipt.status < 300)
      && browserReceipts.length >= 1;
    this.setState({ reviewed: this.state.reviewed + 1 });
    return {
      passed,
      reason: passed
        ? 'Independent reviewer found current, successful source receipts and an immutable browser screenshot artifact.'
        : 'Review failed: required successful source receipts or browser artifact are missing.',
    };
  }
}

export class RaviResearchAgent extends Agent<Env, RaviState> {
  initialState: RaviState = { persona: RAVI_PERSONA, runs: {}, updated_at: now() };

  validateStateChange(next: RaviState) {
    if (Object.keys(next.runs || {}).length > 20) throw new Error('run_history_limit');
    for (const run of Object.values(next.runs || {})) {
      if (run.receipts.length > 8 || run.task.length > 4000) throw new Error('run_payload_limit');
    }
  }

  private async fetchPublicSource(value: unknown): Promise<SourceReceipt> {
    const url = allowedPublicUrl(value);
    if (!url) throw new Error('source_not_allowed');
    const response = await fetch(url, { headers: { accept: 'text/html,application/xhtml+xml' } });
    const html = await response.text();
    const text = stripHtml(html).slice(0, 12_000);
    return {
      tool: 'fetch_public_source', url: url.toString(), title: titleFromHtml(html), status: response.status,
      captured_at: now(), content_hash: await sha256(text), excerpt: text.slice(0, 1800),
    };
  }

  private async captureBrowser(value: unknown, requestId: string): Promise<BrowserReceipt> {
    const url = allowedPublicUrl(value);
    if (!url) throw new Error('browser_source_not_allowed');
    const created = await createBrowserSession(this.env.BROWSER, { keepAliveMs: 60_000, includeTargets: true, recording: true });
    try {
      const target = (await listBrowserTargets(this.env.BROWSER, created.sessionId)).find((row) => row.type === 'page');
      if (!target) throw new Error('browser_target_unavailable');
      const cdp = await connectBrowserSession(this.env.BROWSER, created.sessionId, 20_000);
      const sessionId = await cdp.attachToTarget(target.id, { timeoutMs: 20_000 });
      await cdp.send('Page.enable', {}, { sessionId, timeoutMs: 10_000 });
      await cdp.send('Page.navigate', { url: url.toString() }, { sessionId, timeoutMs: 20_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, { sessionId, timeoutMs: 20_000 }) as { data?: string };
      const raw = Uint8Array.from(atob(String(screenshot.data || '')), (character) => character.charCodeAt(0));
      const artifactKey = `runs/${requestId}/browser/${Date.now()}.png`;
      await this.env.ARTIFACTS.put(artifactKey, raw, { httpMetadata: { contentType: 'image/png' } });
      const title = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, { sessionId, timeoutMs: 10_000 }) as { result?: { value?: unknown } };
      return { tool: 'cloudflare_browser', url: url.toString(), title: String(title.result?.value || 'Untitled').slice(0, 240), captured_at: now(), artifact_key: artifactKey, artifact_sha256: await sha256(screenshot.data || '') };
    } finally {
      await deleteBrowserSession(this.env.BROWSER, created.sessionId).catch(() => undefined);
    }
  }

  private async synthesize(task: string, receipts: SourceReceipt[]): Promise<{ text: string; warning?: string }> {
    const evidence = receipts.map((item, index) => `SOURCE ${index + 1}\nURL: ${item.url}\nTITLE: ${item.title}\nCAPTURED: ${item.captured_at}\nCONTENT:\n${item.excerpt}`).join('\n\n');
    try {
      const result = await this.env.AI.run('@cf/zai-org/glm-5.3-flash', {
        prompt: `${this.state.persona}\n\nTask: ${task}\n\nUse only this captured evidence. Return: (1) concise findings, (2) verified capability table, (3) explicit gaps, (4) next safe action.\n\n${evidence}`,
        max_completion_tokens: 900,
        // This is a fast evidence synthesis, not a hidden-reasoning task. Keeping
        // thinking off makes its latency and token use predictable for the room UI.
        chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
      });
      const text = modelText(result).trim();
      if (text) return { text };
      return { text: 'Captured evidence is available, but the model returned no text.', warning: 'model_empty_response' };
    } catch (error) {
      return { text: 'Captured evidence is available, but the synthesis model was unavailable.', warning: `model_error:${String(error).slice(0, 160)}` };
    }
  }

  async onRequest(request: Request): Promise<Response> {
    if (!await authorized(request, this.env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.endsWith('/state')) return Response.json(this.state);
    if (request.method !== 'POST' || !url.pathname.endsWith('/run')) return Response.json({ error: 'not_found' }, { status: 404 });
    const input = await request.json<{ request_id?: string; task?: string; source_urls?: string[] }>()
      .catch(() => ({} as { request_id?: string; task?: string; source_urls?: string[] }));
    const requestId = String(input.request_id || ''); const task = String(input.task || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{7,80}$/i.test(requestId) || !task || task.length > 4000) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const existing = this.state.runs[requestId];
    if (existing?.status === 'complete') return Response.json({ ok: true, idempotent: true, run: existing });
    const requested = (Array.isArray(input.source_urls) && input.source_urls.length ? input.source_urls : DEFAULT_SOURCES).slice(0, 5);
    const running: RunRecord = { request_id: requestId, task, status: 'running', started_at: now(), tools: ['fetch_public_source', 'hivemind_web_search', 'composio_execute'], receipts: [], warnings: [
      'hivemind_web_search is intentionally unbound in this isolated lab; production requires the authenticated Core adapter.',
      'composio_execute is approval-gated and intentionally cannot invoke external actions in this lab.',
    ] };
    this.setState({ ...this.state, runs: { ...this.state.runs, [requestId]: running }, updated_at: now() });
    const receipts: SourceReceipt[] = [];
    for (const source of requested) {
      try { receipts.push(await this.fetchPublicSource(source)); }
      catch (error) { running.warnings.push(`source_failed:${String(error).slice(0, 160)}`); }
    }
    const browserReceipts: BrowserReceipt[] = [];
    try { browserReceipts.push(await this.captureBrowser(requested[0], requestId)); }
    catch (error) { running.warnings.push(`browser_capture_failed:${String(error).slice(0, 160)}`); }
    const synthesis = await this.synthesize(task, receipts);
    if (synthesis.warning) running.warnings.push(synthesis.warning);
    const reviewer = await getAgentByName(this.env.RAVI_REVIEWER_AGENT, 'ravi-lab-reviewer');
    const reviewerVerdict = await reviewer.review(receipts, browserReceipts);
    const complete: RunRecord = { ...running, receipts, browser_receipts: browserReceipts, reviewer_verdict: reviewerVerdict, synthesis: synthesis.text, status: receipts.length && reviewerVerdict.passed ? 'complete' : 'degraded', completed_at: now() };
    this.setState({ ...this.state, runs: { ...this.state.runs, [requestId]: complete }, updated_at: now() });
    return Response.json({ ok: complete.status === 'complete', idempotent: false, run: complete });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    if (!await authorized(request, env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, runtime: 'cloudflare-agent-lab', persona: 'Ravi Patel' });
    if (url.pathname === '/run' || url.pathname === '/state') {
      const agent = await getAgentByName(env.RAVI_RESEARCH_AGENT, 'ravi-patel-singulance-lab');
      return agent.fetch(new Request(`https://agent.internal${url.pathname}`, request));
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
