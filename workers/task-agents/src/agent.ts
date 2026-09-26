import { Think, type ChunkContext, type ToolCallContext, type ToolCallDecision } from "@cloudflare/think";
import { createQuickActionTools } from "@cloudflare/think/tools/browser";
import type { SkillSource } from "agents/skills";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import MarkdownIt from "markdown-it";
import { authorizeCall } from "./capability";
import { getControl, mapsPlaces, parallelSearch, postControl, postMeta, readCompanyProfile, recallCompany, saveCompanyMemory as writeHivemindMemory, type GatewayEnv } from "./gateway";
import { ensureCompanyTables, type StoredArtifact } from "./company-store";
import { companyWorkComplete } from "./completion";
import { CompanyGovernor } from "./governor";
import { parseGovernanceVerdict, type GovernanceVerdict } from "./governor-verdict";
import { partialToolText } from "./draft-stream";
import { updatePlanTask } from "./operating-plan";
import { HYPERAGENT_INSTRUCTION } from "./employee";
import type { ContextConfig } from "agents/context";
import { companyFacts } from "./profile";
import { globalCatalog, globalPlaybookBody, localCatalog, localPlaybook } from "./playbooks";
import { toolkitSkillSource } from "./skill-catalog";
import { toolsForGroups } from "./tool-groups";
import type { LocalCompany, RunSource, SpecialistRole, TaskAgentState, TaskEnvelope, TraceEvent } from "./types";

const EMPTY: TaskAgentState = { envelope: null, role: null, tools: [], events: [], places: [], sources: [], toolGroups: [], catalogStage: "action", selectedGlobals: [], workflowId: "", awaiting: "", operatingPlan: null };

export function reportTitle(body: string, fallback: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const candidate = heading || fallback;
  return candidate.replace(/\s+report\s*\.pdf$/i, " report").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Company report";
}

export class HivemindTaskAgent extends Think<Env, TaskAgentState> {
  initialState: TaskAgentState = EMPTY;
  private draftCalls = new Map<string, { field: "report" | "message"; raw: string; text: string }>();
  private textDraft = "";
  override includeMcpTools = false;
  override workspaceBash = false;
  override storeMessages = true;
  override storeTools = true;

  shouldConnectionBeReadonly(connection: { url?: string }): boolean {
    return String(connection.url ?? "").includes("dashboard");
  }

  getModel(): string {
    return "@cf/zai-org/glm-5.3-flash";
  }

  getSystemPrompt(): string {
    return HYPERAGENT_INSTRUCTION;
  }

  configureContext(): ContextConfig[] {
    return [{ label: "hyperagent-persona", provider: { get: async () => HYPERAGENT_INSTRUCTION } }];
  }

  async day1Research(orgId: string, userId: string, supplied: { company?: string; website?: string; market?: string } = {}): Promise<{ status: string; text: string; error: string; company: string }> {
    this.note("day1", `started for ${supplied.company || orgId}`);
    const profile = await getControl(
      this.gatewayEnv(),
      `/internal/hyper/org-profile?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`,
    );
    const organization = profile && typeof profile === "object" && "organization" in profile
      ? (profile as { organization?: { name?: string; company_profile?: Record<string, unknown> } }).organization
      : undefined;
    const facts = organization?.company_profile ?? {};
    const company = String(supplied.company || facts.company || organization?.name || facts.name || "").trim();
    const website = String(supplied.website || facts["company:website"] || facts.website || "").trim();
    const market = String(supplied.market || facts["company:location"] || facts.location || facts.location_city || facts.location_country || "").trim();
    if (!company || !website || !market) {
      this.note("day1", "blocked: company, website, or market is missing");
      return { status: "error", text: "", error: "profile_missing_company_website_or_market", company };
    }
    const decision = `Decide who competes with ${company} in ${market} for the offer stored in HIVEMIND.`;
    this.note("day1", decision);
    await this.bindTask(
      {
        runId: `day1-${orgId}`,
        orgId,
        userId,
        taskType: "day4_position",
        phase: "day1",
        inputRefs: [website],
        outputSchemaId: "competitor_market_brief_v1",
      },
      "research",
      toolsForGroups([]),
    );
    const prompt = `${decision} You are the HyperAgent employee for ${company} (${website}, ${market}). A small request gets a short reply with no tools. Company work recalls HIVEMIND, loads one local task blueprint, and returns the finished work in your voice without narrating the tools.`;
    const turned = await this.testPrompt(prompt);
    const text = turned.text || `Places saved: ${JSON.stringify(this.state.places)}`;
    const recalled = (this.state.events ?? []).some((event) => event.step === "hivemind_recall");
    const verdict = companyWorkComplete({ report: text, recalled, marketResearch: true });
    this.note("completion", verdict.complete ? "complete" : verdict.reason);
    this.note("day1", text.slice(0, 8000));
    return { status: verdict.complete ? "ok" : "incomplete", text, error: verdict.complete ? turned.error : verdict.reason, company };
  }

  async testPrompt(prompt: string): Promise<{ status: string; text: string; error: string }> {
    try {
      const result = await this.runTurn({ input: prompt });
      const message = result.message as { parts?: Array<{ type?: string; text?: string }> } | undefined;
      const text = (message?.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      const failure = (result as { error?: unknown }).error;
      const error = failure instanceof Error ? failure.message : failure ? JSON.stringify(failure).slice(0, 1000) : "";
      return { status: String(result.status ?? "unknown"), text, error };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "test_prompt_failed";
      return { status: "error", text: "", error };
    }
  }

  async startCompanyWork(work: { runId: string; orgId: string; userId: string; taskType: string; phase: string; inputRefs: string[]; outputSchemaId: string; company: string; website: string; market: string; task: string }): Promise<string> {
    const workflowId = await this.runWorkflow("TASK_LIFECYCLE", work);
    this.setState({ ...this.state, workflowId });
    this.note("workrun", "queued");
    return workflowId;
  }

  markAwaiting(awaiting: "" | "input" | "memory"): void {
    this.setState({ ...this.state, awaiting });
  }

  async askOperator(question: string, options: string[]): Promise<void> {
    this.markAwaiting("input");
    this.note("question", JSON.stringify({ question, options }));
  }

  private async resumePaused(answer: string): Promise<boolean> {
    const workflowId = this.state.workflowId;
    if (this.state.awaiting !== "input" || !workflowId) return false;
    this.markAwaiting("");
    if (answer) this.note("user", answer);
    try {
      await this.approveWorkflow(workflowId, { reason: "operator", metadata: { answer } });
    } catch (error) {
      this.note("question", error instanceof Error ? error.message : "resume_failed");
    }
    return true;
  }

  async onMessage(_connection: unknown, message: unknown): Promise<void> {
    const text = typeof message === "string" ? message : "";
    let parsed: { type?: unknown; id?: unknown; decision?: unknown; answer?: unknown; userId?: unknown; task?: unknown; company?: unknown; website?: unknown; market?: unknown } | null = null;
    try {
      parsed = JSON.parse(text) as { type?: unknown; id?: unknown; decision?: unknown; answer?: unknown; userId?: unknown; task?: unknown; company?: unknown; website?: unknown; market?: unknown };
    } catch {
      return;
    }
    const connection = _connection as { send(data: string): void };
    if (parsed?.type === "artifact-list") {
      const artifacts = await this.listArtifactMetadata();
      connection.send(JSON.stringify({ type: "artifact-list-result", artifacts }));
      return;
    }
    if (parsed?.type === "artifact-get") {
      const id = typeof parsed.id === "string" ? parsed.id : "";
      const artifact = /^[0-9a-f-]{36}$/i.test(id) ? await this.getCompanyArtifact(id) : null;
      connection.send(JSON.stringify({ type: "artifact-get-result", artifact: artifact ?? null }));
      return;
    }
    if (parsed?.type === "artifact-create-pdf") {
      const id = typeof parsed.id === "string" ? parsed.id : "";
      try {
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("artifact_not_found");
        const artifact = await this.createPdfArtifact(id);
        connection.send(JSON.stringify({ type: "artifact-create-pdf-result", artifact }));
      } catch (error) {
        connection.send(JSON.stringify({ type: "artifact-create-pdf-result", error: error instanceof Error ? error.message : "pdf_generation_failed" }));
      }
      return;
    }
    if (parsed?.type === "human-answer" || (parsed?.type === "room-start" && this.state.awaiting === "input")) {
      const answer = typeof parsed.answer === "string" ? parsed.answer : typeof parsed.task === "string" ? parsed.task : "";
      await this.resumePaused(answer.slice(0, 2000));
      return;
    }
    if (parsed?.type === "memory-decision") {
      const workflowId = this.state.workflowId;
      if (!workflowId) {
        this.note("approval", "Nothing is waiting for approval.");
        return;
      }
      try {
        if (parsed.decision === "approve") await this.approveWorkflow(workflowId, { reason: "operator" });
        else await this.rejectWorkflow(workflowId, { reason: "operator declined" });
      } catch (error) {
        this.note("approval", error instanceof Error ? error.message : "approval_failed");
      }
      return;
    }
    if (parsed?.type !== "room-start") return;
    const named = String((this as { name?: string }).name ?? "");
    const match = /^session-([0-9a-f-]{36})-[0-9a-f-]{36}$/i.exec(named) || /^day1-([0-9a-f-]{36})-flow$/i.exec(named);
    const userId = typeof parsed.userId === "string" ? parsed.userId : "";
    if (!match || !/^[0-9a-f-]{36}$/i.test(userId)) {
      this.note("workrun", "room start rejected");
      return;
    }
    const orgId = match[1];
    const task = typeof parsed.task === "string" ? parsed.task.slice(0, 2000) : "";
    if (this.state.operatingPlan?.tasks.length) {
      const latestTurn = [...(this.state.events ?? [])].reverse();
      const lastUser = latestTurn.findIndex((event) => event.step === "user");
      if (!latestTurn.slice(0, lastUser < 0 ? latestTurn.length : lastUser).some((event) => event.step === "operating-plan-state")) {
        this.note("operating-plan-state", JSON.stringify(this.state.operatingPlan));
      }
    }
    this.setState({ ...this.state, operatingPlan: null });
    if (task) this.note("user", task);
    const supplied = {
      company: typeof parsed.company === "string" ? parsed.company.slice(0, 200) : "",
      website: typeof parsed.website === "string" ? parsed.website.slice(0, 300) : "",
      market: typeof parsed.market === "string" ? parsed.market.slice(0, 200) : "",
    };
    try {
      const profile = await readCompanyProfile(this.gatewayEnv(), orgId, userId).catch(() => null);
      const facts = companyFacts(profile, supplied);
      await this.startCompanyWork({
        runId: named,
        orgId,
        userId,
        taskType: "room_task",
        phase: "room",
        inputRefs: facts.website ? [facts.website] : [],
        outputSchemaId: "room_report_v1",
        ...facts,
        task,
      });
    } catch (error) {
      this.note("report", `I could not start this turn: ${error instanceof Error ? error.message : "unknown error"}.`);
      this.note("completion", "start_failed");
    }
  }

  async saveCompanyArtifact(input: { kind: string; title: string; contentType: string; body?: string; storageLocation?: string }): Promise<StoredArtifact> {
    ensureCompanyTables(this.sql.bind(this));
    const row: StoredArtifact = {
      id: crypto.randomUUID(),
      kind: input.kind,
      title: input.title.slice(0, 200),
      contentType: input.contentType.slice(0, 120),
      body: (input.body ?? "").slice(0, input.contentType === "application/pdf" || input.contentType.startsWith("image/") ? 2800000 : 100000),
      storageLocation: input.storageLocation ?? "",
      createdAt: new Date().toISOString(),
    };
    this.sql`INSERT INTO company_artifacts (id, kind, title, content_type, body, storage_location, created_at) VALUES (${row.id}, ${row.kind}, ${row.title}, ${row.contentType}, ${row.body}, ${row.storageLocation}, ${row.createdAt})`;
    this.note("artifact", JSON.stringify({ id: row.id, kind: row.kind, title: row.title, contentType: row.contentType }));
    return row;
  }

  async listCompanyArtifacts(): Promise<StoredArtifact[]> {
    ensureCompanyTables(this.sql.bind(this));
    return this.sql`SELECT id, kind, title, content_type, body, storage_location, created_at FROM company_artifacts ORDER BY created_at DESC LIMIT 40`.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      title: String(row.title),
      contentType: String(row.content_type),
      body: String(row.body ?? ""),
      storageLocation: String(row.storage_location ?? ""),
      createdAt: String(row.created_at),
    }));
  }

  async listArtifactMetadata(): Promise<Omit<StoredArtifact, "body">[]> {
    ensureCompanyTables(this.sql.bind(this));
    return this.sql`SELECT id, kind, title, content_type, storage_location, created_at FROM company_artifacts ORDER BY created_at DESC LIMIT 40`.map((row) => ({
      id: String(row.id), kind: String(row.kind), title: String(row.title),
      contentType: String(row.content_type), storageLocation: String(row.storage_location ?? ""), createdAt: String(row.created_at),
    }));
  }

  async getCompanyArtifact(id: string): Promise<StoredArtifact | null> {
    ensureCompanyTables(this.sql.bind(this));
    const row = this.sql`SELECT id, kind, title, content_type, body, storage_location, created_at FROM company_artifacts WHERE id = ${id} LIMIT 1`[0];
    return row ? { id: String(row.id), kind: String(row.kind), title: String(row.title), contentType: String(row.content_type), body: String(row.body ?? ""), storageLocation: String(row.storage_location ?? ""), createdAt: String(row.created_at) } : null;
  }

  async createPdfArtifact(id: string): Promise<StoredArtifact> {
    const source = await this.getCompanyArtifact(id);
    if (!source || source.contentType !== "text/markdown") throw new Error("markdown_report_required");
    const reportName = reportTitle(source.body, source.title);
    if (source.title !== reportName) this.sql`UPDATE company_artifacts SET title = ${reportName} WHERE id = ${id}`;
    const title = `${reportName}.pdf`;
    const existing = this.sql`SELECT id FROM company_artifacts WHERE storage_location = ${`pdf-of:${id}`} LIMIT 1`[0];
    if (existing) {
      this.sql`UPDATE company_artifacts SET title = ${title} WHERE id = ${String(existing.id)}`;
      return (await this.getCompanyArtifact(String(existing.id)))!;
    }
    const browser = this.gatewayEnv().BROWSER as { quickAction(type: string, options: unknown): Promise<Response> } | undefined;
    if (!browser?.quickAction) throw new Error("browser_binding_missing");
    const markdown = new MarkdownIt({ html: false, linkify: true });
    markdown.renderer.rules.image = () => "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:12pt/1.55 Arial,sans-serif;color:#171717;max-width:760px;margin:48px auto}h1,h2,h3{break-after:avoid}h1{font-size:22pt}h2{font-size:16pt;margin-top:25px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px;text-align:left}a{color:#2563a6}pre{white-space:pre-wrap}p,li{break-inside:avoid}</style></head><body>${markdown.render(source.body)}</body></html>`;
    const response = await browser.quickAction("pdf", { html, pdfOptions: { format: "a4", printBackground: true } });
    if (!response.ok) throw new Error(`pdf_generation_failed_${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" || bytes.length > 2000000) throw new Error("pdf_invalid_or_too_large");
    let body = "";
    for (let at = 0; at < bytes.length; at += 8190) body += btoa(String.fromCharCode(...bytes.subarray(at, at + 8190)));
    return this.saveCompanyArtifact({ kind: "pdf", title, contentType: "application/pdf", body, storageLocation: `pdf-of:${id}` });
  }

  resolvePlaybook(id: string): string | null {
    const task = localPlaybook(id);
    if (task) {
      const parent = globalPlaybookBody(task.globalId);
      ensureCompanyTables(this.sql.bind(this));
      const notes = this.sql`SELECT note FROM company_playbook_notes WHERE playbook_id = ${id} ORDER BY created_at ASC`.map((row) => String(row.note));
      const extra = notes.length ? notes.map((note) => `- ${note}`).join("\n") : "- No company special cases yet.";
      return `${task.body}\n\nParent field: ${task.globalId}${parent ? ` version ${parent.version}` : ""}.\nCompany special cases:\n${extra}`;
    }
    const global = globalPlaybookBody(id);
    return global ? global.body : null;
  }

  refineLocalPlaybook(id: string, instruction: string): { saved: true; id: string } | { error: string } {
    const target = localPlaybook(id) ? id : "";
    if (!target) return { error: "playbook_not_found" };
    ensureCompanyTables(this.sql.bind(this));
    const createdAt = new Date().toISOString();
    this.sql`INSERT INTO company_playbook_notes (id, playbook_id, note, created_at) VALUES (${crypto.randomUUID()}, ${target}, ${instruction.slice(0, 2000)}, ${createdAt})`;
    this.note("refine_local_playbook", target);
    return { saved: true, id: target };
  }

  async saveCompanyMemory(title: string, content: string): Promise<unknown> {
    const envelope = this.state.envelope;
    if (!envelope) return { error: "task_not_bound" };
    this.note("save_memory", title);
    return writeHivemindMemory(this.gatewayEnv(), envelope.orgId, envelope.userId, title, content);
  }

  async applyGroups(groups: readonly string[], prospect = false, action = false): Promise<string[]> {
    const tools = prospect
      ? ["hivemind_recall", "parallel_search", "browser_markdown"]
      : toolsForGroups(groups);
    this.setState({ ...this.state, toolGroups: [...groups], tools, catalogStage: action ? "action" : this.state.catalogStage, companyContextRequired: true });
    this.note("reset_tools", groups.join(", "));
    return tools;
  }

  async bindTask(envelope: TaskEnvelope, role: SpecialistRole, tools: readonly string[]): Promise<void> {
    this.draftCalls.clear();
    this.setState({ ...this.state, envelope, role, tools: [...tools], catalogStage: "global", selectedGlobals: [], companyContextLoaded: false, companyContextRequired: false });
    await this.context.refreshSystemPrompt();
  }

  setOperatingPlan(runId: string, summary: string, titles: string[]): void {
    const operatingPlan = {
      runId,
      summary: summary.slice(0, 2000),
      tasks: titles.slice(0, 6).map((title, index) => ({ id: index + 1, title: title.slice(0, 160), status: "pending" as const })),
    };
    this.setState({
      ...this.state,
      operatingPlan,
    });
    this.note("operating-plan-state", JSON.stringify(operatingPlan));
  }

  updateOperatingTask(id: number, status: "active" | "completed" | "blocked", verified = false): { updated: boolean; awaitingReport?: boolean } {
    const plan = updatePlanTask(this.state.operatingPlan, this.state.envelope?.runId, id, status, verified);
    if (!plan) return { updated: false };
    this.setState({ ...this.state, operatingPlan: plan });
    this.note("operating-plan-state", JSON.stringify(plan));
    const awaitingReport = status === "completed" && plan.tasks.find((task) => task.id === id)?.status !== "completed";
    this.note("task_updated", `${id}: ${awaitingReport ? "active" : status}`);
    return awaitingReport ? { updated: true, awaitingReport: true } : { updated: true };
  }

  async getSkills(): Promise<SkillSource[]> {
    return [await toolkitSkillSource()];
  }

  beforeTurn(): { activeTools: string[]; maxSteps: number; maxOutputTokens: number; providerOptions: Record<string, unknown> } {
    this.textDraft = "";
    const granted = this.state.tools;
    const catalogTools = new Set(["playbook_list", "playbook_list_local", "playbook_get", "refine_local_playbook", "reset_tools"]);
    return {
      activeTools: [...granted.filter((name) => this.state.catalogStage !== "action" ? name !== "reset_tools" : !catalogTools.has(name)), ...(this.state.operatingPlan?.tasks.length ? ["update_plan_task"] : []), "share_progress", "activate_skill", "read_skill_resource", "think_final_answer"],
      maxSteps: this.state.catalogStage === "action" ? 14 : 10,
      maxOutputTokens: 4096,
      providerOptions: { "workers-ai": { reasoning_effort: "low" } },
    };
  }

  beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    if (this.state.companyContextRequired && !this.state.companyContextLoaded
      && /^(browser_|parallel_search$|maps_search$|composio_)/.test(ctx.toolName)) {
      return { action: "block", reason: "Load HIVEMIND company context before external tools." };
    }
  }

  async onChunk({ chunk }: ChunkContext): Promise<void> {
    if (chunk.type === "text-delta") {
      if (!chunk.text || this.textDraft.length > 4000) return;
      if (!this.textDraft) this.broadcast(JSON.stringify({ type: "progress-draft", delta: "", reset: true }));
      this.textDraft += chunk.text;
      this.broadcast(JSON.stringify({ type: "progress-draft", delta: chunk.text }));
      return;
    }
    if (chunk.type === "tool-input-start") {
      this.textDraft = "";
      const field = chunk.toolName.startsWith("think_final_answer") ? "report" : chunk.toolName === "share_progress" ? "message" : null;
      if (field) {
        this.draftCalls.set(chunk.id, { field, raw: "", text: "" });
        if (field === "report") this.broadcast(JSON.stringify({ type: "progress-draft", delta: "", reset: true }));
        this.broadcast(JSON.stringify({ type: field === "report" ? "report-draft" : "progress-draft", delta: "", reset: true }));
      }
      return;
    }
    if (chunk.type === "tool-input-end") {
      this.draftCalls.delete(chunk.id);
      return;
    }
    if (chunk.type !== "tool-input-delta") return;
    const draft = this.draftCalls.get(chunk.id);
    if (!draft) return;
    draft.raw += chunk.delta;
    if (draft.raw.length > 50000) { this.draftCalls.delete(chunk.id); return; }
    const next = await partialToolText(draft.raw, draft.field);
    if (!next || next === draft.text) return;
    const reset = !next.startsWith(draft.text);
    const delta = reset ? next : next.slice(draft.text.length);
    draft.text = next;
    this.broadcast(JSON.stringify({ type: draft.field === "report" ? "report-draft" : "progress-draft", delta, reset }));
  }

  getTools(): ToolSet {
    const progress = tool({
      description: "Share a brief first-person work update with the operator when choosing a next step or changing approach. State actual evidence or uncertainty. Do not reveal private reasoning, repeat earlier updates, or claim an unverified result.",
      inputSchema: z.object({ message: z.string().min(12).max(400) }),
      execute: async ({ message }): Promise<{ shared: true }> => {
        this.note("progress", message);
        return { shared: true };
      },
    });
    const capture = tool({
      description: "Capture a public HTTPS webpage with Cloudflare Browser Run and save the PNG as an artifact in this turn.",
      inputSchema: z.object({ url: z.url(), title: z.string().min(3).max(120).optional() }),
      execute: async ({ url, title }): Promise<{ id: string; title: string; contentType: string }> => {
        this.assertTool("browser_capture");
        const target = new URL(url);
        if (target.protocol !== "https:" || target.username || target.password || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i.test(target.hostname)) throw new Error("public_https_url_required");
        const browser = this.gatewayEnv().BROWSER as { quickAction(type: string, options: unknown): Promise<Response> } | undefined;
        if (!browser?.quickAction) throw new Error("browser_binding_missing");
        const response = await browser.quickAction("screenshot", { url: target.href, screenshotOptions: { fullPage: true } });
        if (!response.ok) throw new Error(`capture_failed_${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 8 || bytes.length > 2000000 || ![137, 80, 78, 71].every((byte, index) => bytes[index] === byte)) throw new Error("capture_invalid_or_too_large");
        let body = "";
        for (let at = 0; at < bytes.length; at += 8190) body += btoa(String.fromCharCode(...bytes.subarray(at, at + 8190)));
        const artifact = await this.saveCompanyArtifact({ kind: "image", title: `${(title || `${target.hostname} screenshot`).replace(/\.png$/i, "")}.png`, contentType: "image/png", body });
        return { id: artifact.id, title: artifact.title, contentType: artifact.contentType };
      },
    });
    const updatePlanTask = tool({
      description: "Update one task in the operator-visible operating plan when work starts, finishes, or becomes blocked.",
      inputSchema: z.object({ id: z.number().int().min(1).max(6), status: z.enum(["active", "completed", "blocked"]) }),
      execute: async ({ id, status }): Promise<{ updated: boolean }> => this.updateOperatingTask(id, status),
    });
    const packet = tool({
      description: "Load the sealed company packet for this task.",
      inputSchema: z.object({}),
      execute: async (): Promise<{ refs: string[] }> => {
        this.assertTool("load_company_packet");
        return { refs: this.state.envelope?.inputRefs ?? [] };
      },
    });
    const evidence = tool({
      description: "Record an evidence reference discovered for this task.",
      inputSchema: z.object({ ref: z.string().min(1).max(300) }),
      execute: async ({ ref }): Promise<{ accepted: true; ref: string }> => {
        this.assertTool("record_evidence");
        return { accepted: true, ref };
      },
    });
    const draft = tool({
      description: "Draft a recommendation grounded in the loaded packet.",
      inputSchema: z.object({ summary: z.string().min(1).max(2000) }),
      execute: async ({ summary }): Promise<{ accepted: true; summary: string }> => {
        this.assertTool("draft_recommendation");
        return { accepted: true, summary };
      },
    });
    const check = tool({
      description: "Check a candidate receipt against the output contract.",
      inputSchema: z.object({ complete: z.boolean() }),
      execute: async ({ complete }): Promise<{ accepted: boolean }> => {
        this.assertTool("check_receipt");
        return { accepted: complete };
      },
    });
    const recall = tool({
      description: "Recall the sealed tenant's HIVEMIND company memory.",
      inputSchema: z.object({ query: z.string().min(1).max(1200) }),
      execute: async ({ query }): Promise<unknown> => {
        const identity = this.assertTool("hivemind_recall");
        this.note("hivemind_recall", query);
        const result = await recallCompany(this.gatewayEnv(), identity.orgId, identity.userId, query);
        const count = result && typeof result === "object" && "count" in result ? String(result.count) : "0";
        this.note("hivemind_recall", `${count} memories`);
        return result;
      },
    });
    const memory = tool({
      description: "Read one HIVEMIND memory by id.",
      inputSchema: z.object({ memoryId: z.string().min(1).max(80) }),
      execute: async ({ memoryId }): Promise<unknown> => {
        const identity = this.assertTool("hivemind_get_memory");
        return postMeta(this.gatewayEnv(), "hivemind_get_memory", { org_id: identity.orgId, user_id: identity.userId, memory_id: memoryId });
      },
    });
    const memories = tool({
      description: "List HIVEMIND memories for a topic.",
      inputSchema: z.object({ query: z.string().min(1).max(300) }),
      execute: async ({ query }): Promise<unknown> => {
        const identity = this.assertTool("hivemind_list_memories");
        return postMeta(this.gatewayEnv(), "hivemind_list_memories", { org_id: identity.orgId, user_id: identity.userId, query });
      },
    });
    const projects = tool({
      description: "List HIVEMIND projects the sealed user can access.",
      inputSchema: z.object({}),
      execute: async (): Promise<unknown> => {
        const identity = this.assertTool("hivemind_list_projects");
        return postMeta(this.gatewayEnv(), "hivemind_list_projects", { org_id: identity.orgId, user_id: identity.userId });
      },
    });
    const profile = tool({
      description: "Read the sealed user's company profile.",
      inputSchema: z.object({}),
      execute: async (): Promise<unknown> => {
        const identity = this.assertTool("get_user_profile");
        return readCompanyProfile(this.gatewayEnv(), identity.orgId, identity.userId);
      },
    });
    const discover = tool({
      description: "Discover read-only Composio tools for one connected toolkit.",
      inputSchema: z.object({ toolkit: z.string().min(1).max(80), useCase: z.string().min(1).max(1200) }),
      execute: async ({ toolkit: toolkitName, useCase }): Promise<unknown> => {
        const identity = this.assertTool("composio_discover_reads");
        return postControl(this.gatewayEnv(), "/internal/hyper/composio-read-tools", {
          org_id: identity.orgId, user_id: identity.userId, toolkit: toolkitName, use_case: useCase,
        });
      },
    });
    const readApp = tool({
      description: "Execute one granted read-only Composio tool.",
      inputSchema: z.object({
        grantId: z.string().min(1).max(200),
        toolSlug: z.string().min(1).max(160),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ grantId, toolSlug, arguments: args }): Promise<unknown> => {
        const identity = this.assertTool("composio_read");
        return postControl(this.gatewayEnv(), "/internal/hyper/composio-read-exec", {
          org_id: identity.orgId, user_id: identity.userId, grant_id: grantId, tool_slug: toolSlug, arguments: args ?? {},
        });
      },
    });
    const playbooks = tool({
      description: "List playbook names and one-line descriptions. Does not return the method.",
      inputSchema: z.object({}),
      execute: async (): Promise<{ playbooks: ReturnType<typeof globalCatalog> }> => {
        this.assertTool("playbook_list");
        const playbooks = globalCatalog();
        this.note("playbook_list", `${playbooks.length} global playbooks`);
        return { playbooks };
      },
    });
    const localPlaybooks = tool({
      description: "List local playbooks inside the global ids already chosen. Names and one line only.",
      inputSchema: z.object({ globalIds: z.array(z.string().min(3).max(120)).min(1).max(6) }),
      execute: async ({ globalIds }): Promise<{ playbooks: ReturnType<typeof localCatalog> }> => {
        this.assertTool("playbook_list_local");
        const playbooks = localCatalog(globalIds);
        this.setState({ ...this.state, selectedGlobals: [...globalIds], catalogStage: "local" });
        this.note("playbook_list_local", playbooks.map((item) => item.id).join(", "));
        return { playbooks };
      },
    });
    const playbook = tool({
      description: "Load one playbook method by id.",
      inputSchema: z.object({ id: z.string().min(3).max(80) }),
      execute: async ({ id }): Promise<{ id: string; body: string } | { error: string }> => {
        this.assertTool("playbook_get");
        const resolved = this.resolvePlaybook(id);
        if (!resolved) return { error: "playbook_not_found" };
        if (id.startsWith("local:")) this.setState({ ...this.state, catalogStage: "action" });
        this.note("playbook_get", id);
        return { id, body: resolved };
      },
    });
    const refine = tool({
      description: "Add a company-specific special case to a local playbook. The global method stays unchanged.",
      inputSchema: z.object({ id: z.string().min(3).max(120), instruction: z.string().min(8).max(2000) }),
      execute: async ({ id, instruction }): Promise<{ saved: true; id: string } | { error: string }> => {
        this.assertTool("refine_local_playbook");
        return this.refineLocalPlaybook(id, instruction);
      },
    });
    const reset = tool({
      description: "Enable tool families for the rest of this run. Pass only the families the playbook needs.",
      inputSchema: z.object({
        groups: z.array(z.enum(["company", "web_research", "browser", "connected_apps", "records"])).max(5),
      }),
      execute: async ({ groups }): Promise<{ tools: string[] }> => {
        this.assertTool("reset_tools");
        const tools = toolsForGroups(groups);
        this.setState({ ...this.state, toolGroups: [...groups], tools, companyContextRequired: true });
        this.note("reset_tools", groups.join(", "));
        return { tools };
      },
    });
    const saveMemory = tool({
      description: "Do not call this. Company memory is saved only after the operator approves it.",
      inputSchema: z.object({ title: z.string().min(1).max(180), content: z.string().min(1).max(8000) }),
      execute: async ({ title }): Promise<{ saved: false; status: "waiting_for_operator"; title: string }> => {
        this.assertTool("save_memory");
        this.note("save_memory", `${title} is waiting for the operator`);
        return { saved: false, status: "waiting_for_operator", title };
      },
    });
    const loadArtifact = tool({
      description: "Read one artifact this company already stored in Cloudflare.",
      inputSchema: z.object({ id: z.string().min(8).max(80).optional() }),
      execute: async ({ id }): Promise<unknown> => {
        this.assertTool("load_artifact");
        const artifacts = await this.listCompanyArtifacts();
        const chosen = id ? artifacts.find((item) => item.id === id) : artifacts[0];
        this.note("load_artifact", chosen ? chosen.title : "none");
        return chosen ?? { error: "artifact_not_found" };
      },
    });
    const mapsTool = tool({
      description: "Search Google Maps for one specific offer in one city.",
      inputSchema: z.object({ query: z.string().min(8).max(200) }),
      execute: async ({ query }): Promise<unknown> => {
        this.assertTool("maps_search");
        this.note("maps_search", query);
        const places = await mapsPlaces(this.gatewayEnv(), query);
        this.rememberSources(places);
        return places;
      },
    });
    const savePlaces = tool({
      description: "Save 5 to 10 local companies on this run.",
      inputSchema: z.object({
        companies: z.array(z.object({
          name: z.string().min(1).max(200),
          address: z.string().max(300).optional(),
          website: z.string().max(300).optional(),
          phone: z.string().max(80).optional(),
          mapsUrl: z.string().max(400).optional(),
        })).max(10),
      }),
      execute: async ({ companies }): Promise<{ saved: number }> => {
        this.assertTool("save_local_companies");
        const places: LocalCompany[] = companies.slice(0, 10).map((company) => ({
          name: company.name,
          address: company.address ?? "",
          website: company.website ?? "",
          phone: company.phone ?? "",
          mapsUrl: company.mapsUrl ?? "",
        }));
        this.setState({ ...this.state, places });
        this.rememberSources(places);
        this.note("save_local_companies", places.map((place) => place.name).join(", "));
        return { saved: places.length };
      },
    });
    const composioWeb = tool({
      description: "Search the web through Composio and return URL citations.",
      inputSchema: z.object({ query: z.string().min(3).max(1200) }),
      execute: async ({ query }): Promise<unknown> => {
        const identity = this.assertTool("composio_web_search");
        this.note("composio_web_search", query);
        const result = await postControl(this.gatewayEnv(), "/internal/hyper/web-search", {
          org_id: identity.orgId, user_id: identity.userId, query, provider: "composio",
        });
        this.rememberSources(result);
        const provider = result && typeof result === "object" && "provider" in result ? String(result.provider) : "unknown";
        this.note("composio_web_search", provider);
        return result;
      },
    });
    const search = tool({
      description: "Search the web through Parallel AI Gateway and return URL citations.",
      inputSchema: z.object({ query: z.string().min(3).max(1200) }),
      execute: async ({ query }): Promise<unknown> => {
        this.assertTool("parallel_search");
        this.note("parallel_search", query);
        const result = await parallelSearch(this.gatewayEnv(), query);
        this.rememberSources(result);
        const provider = result && typeof result === "object" && "provider" in result ? String(result.provider) : "unknown";
        this.note("parallel_search", provider);
        return result;
      },
    });
    return {
      load_company_packet: packet,
      record_evidence: evidence,
      draft_recommendation: draft,
      check_receipt: check,
      hivemind_recall: recall,
      hivemind_get_memory: memory,
      hivemind_list_memories: memories,
      hivemind_list_projects: projects,
      get_user_profile: profile,
      composio_discover_reads: discover,
      composio_read: readApp,
      parallel_search: search,
      composio_web_search: composioWeb,
      maps_search: mapsTool,
      save_memory: saveMemory,
      load_artifact: loadArtifact,
      playbook_list: playbooks,
      playbook_list_local: localPlaybooks,
      playbook_get: playbook,
      refine_local_playbook: refine,
      reset_tools: reset,
      update_plan_task: updatePlanTask,
      share_progress: progress,
      save_local_companies: savePlaces,
      browser_capture: capture,
      ...(this.gatewayEnv().BROWSER
        ? createQuickActionTools({ browser: this.gatewayEnv().BROWSER as never })
        : {}),
    };
  }

  trace(): TraceEvent[] {
    return this.state.events ?? [];
  }

  sourceUrls(): string[] {
    return (this.state.sources ?? []).map((source) => source.url);
  }

  hasCompanyContext(): boolean {
    return this.state.companyContextLoaded === true;
  }

  hasArtifactThisTurn(kind: string): boolean {
    const events = this.state.events ?? [];
    let start = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.step === "user") { start = index; break; }
    }
    return events.slice(start + 1).some((event) => {
      if (event.step !== "artifact") return false;
      try { return (JSON.parse(event.detail) as { kind?: string }).kind === kind; } catch { return false; }
    });
  }

  async recallTaskContext(orgId: string, userId: string, query: string): Promise<unknown> {
    const [result, profile] = await Promise.all([
      recallCompany(this.gatewayEnv(), orgId, userId, query),
      readCompanyProfile(this.gatewayEnv(), orgId, userId).catch(() => null),
    ]);
    if (result && typeof result === "object" && "ok" in result && result.ok === true) {
      const count = "count" in result ? Number(result.count) || 0 : 0;
      this.setState({ ...this.state, companyContextLoaded: true });
      this.note("hivemind_recall", `${count} company memories recalled`);
      const facts = profile && typeof profile === "object" && "facts" in profile && Array.isArray(profile.facts)
        ? profile.facts.filter((fact): fact is { key: string; value: string } =>
          !!fact && typeof fact === "object" && typeof fact.key === "string" && typeof fact.value === "string"
          && /^(company|product|mission|icp|industry|market)/i.test(fact.key))
          .slice(0, 20).map((fact) => ({ key: fact.key.slice(0, 100), value: fact.value.slice(0, 300) }))
        : [];
      this.note("get_user_profile", `${facts.length} company profile facts loaded`);
      return { ...result, profileFacts: facts };
    }
    return result;
  }

  async reviewCompanyReport(input: { task: string; plan: string[]; report: string; companyContext: unknown; sources: string[] }): Promise<GovernanceVerdict> {
    const workflowId = this.state.workflowId || this.state.envelope?.runId || crypto.randomUUID();
    try {
      const result = await this.runAgentTool(CompanyGovernor, {
        runId: `govern-${workflowId}`,
        input: {
          task: input.task.slice(0, 2000),
          plan: input.plan,
          report: input.report.slice(0, 30000),
          companyContext: input.companyContext,
          sourceReceipts: input.sources.slice(0, 30),
        },
        display: { name: "Company review" },
      });
      const verdict = result.status === "completed"
        ? parseGovernanceVerdict(result.summary)
        : { verdict: "unavailable" as const, note: "Review unavailable; report delivered without model review." };
      this.note("governance", `${verdict.verdict}: ${verdict.note}`);
      return verdict;
    } catch {
      const verdict = { verdict: "unavailable" as const, note: "Review unavailable; report delivered without model review." };
      this.note("governance", `${verdict.verdict}: ${verdict.note}`);
      return verdict;
    }
  }

  async snapshot(): Promise<{ events: TraceEvent[]; places: LocalCompany[]; transcript: string }> {
    let transcript = "";
    try {
      const messages = await this.getMessages();
      transcript = messages.map((message) => {
        const parts = (message as { parts?: Array<{ type?: string; text?: string; toolName?: string }> }).parts ?? [];
        return parts.map((part) => part.text || (part.toolName ? `tool ${part.toolName}` : "")).filter(Boolean).join("\n");
      }).filter(Boolean).join("\n\n").slice(0, 20000);
    } catch (error) {
      transcript = error instanceof Error ? error.message : "transcript_unavailable";
    }
    return { events: this.state.events ?? [], places: this.state.places ?? [], transcript };
  }

  rememberSources(payload: unknown): void {
    const found = collectSourceLinks(payload);
    if (!found.length) return;
    const current = this.state.sources ?? [];
    const seen = new Set(current.map((item) => item.url));
    const next = [...current];
    for (const item of found) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      next.push(item);
    }
    this.setState({ ...this.state, sources: next.slice(-40) });
  }

  note(step: string, detail: string): void {
    if (step === "progress") {
      const last = [...(this.state.events ?? [])].reverse().find((event) => event.step === "progress" || event.step === "user");
      if (last?.step === "progress" && last.detail === detail) return;
    }
    const events = [...(this.state.events ?? []), { at: new Date().toISOString(), step, detail: detail.slice(0, step === "report" ? 30000 : 8000) }].slice(-300);
    this.setState({ ...this.state, events });
  }

  async checkToolkit(name: string, orgId: string, userId: string, input: { query?: string; url?: string } = {}): Promise<unknown> {
    this.note(name, "started");
    const env = this.gatewayEnv();
    const query = input.query || "SINGULANCE Hannover competitors";
    const url = input.url || "https://singulancelabs.com";
    if (name === "parallel_search") {
      return parallelSearch(env, query);
    }
    if (name === "hivemind_profile") {
      return getControl(env, `/internal/hyper/org-profile?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`);
    }
    if (name === "hivemind_recall") {
      return recallCompany(env, orgId, userId, query);
    }
    if (name === "save_memory") {
      return writeHivemindMemory(env, orgId, userId, "SINGULANCE competitor judgment", query || "Hannover local market research is stored as a Cloudflare artifact.");
    }
    if (name === "composio_discover_reads") {
      return postControl(env, "/internal/hyper/composio-read-tools", {
        org_id: orgId, user_id: userId, toolkit: "gmail", use_case: "list the latest messages",
      });
    }
    if (name === "browser_markdown") {
      if (!env.BROWSER) return { error: "browser_binding_missing" };
      const tools = createQuickActionTools({ browser: env.BROWSER as never });
      const browserTool = tools.browser_markdown as { execute?: (input: { url: string }) => Promise<unknown> } | undefined;
      if (!browserTool?.execute) return { error: "browser_markdown_missing" };
      const page = await browserTool.execute({ url });
      const serialized = JSON.stringify(page);
      return { ok: true, bytes: serialized.length, preview: serialized.slice(0, 400) };
    }
    return { error: "unknown_toolkit" };
  }

  private async workersBrief(prompt: string): Promise<{ status: string; text: string; error: string }> {
    const ai = this.gatewayEnv().AI as { run?: (model: string, input: unknown) => Promise<unknown> } | undefined;
    if (!ai?.run) return { status: "error", text: "", error: "workers_ai_binding_missing" };
    const result = await ai.run("@cf/zai-org/glm-5.3-flash", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1400,
      reasoning_effort: "low",
    });
    const choice = result && typeof result === "object" && "choices" in result
      ? (result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content
      : undefined;
    const response = result && typeof result === "object" && "response" in result ? String((result as { response?: unknown }).response ?? "") : "";
    const text = choice || response;
    if (!text) return { status: "error", text: "", error: "empty_model_content" };
    return { status: "ok", text, error: "" };
  }

  private async pageMarkdown(url: string): Promise<string> {
    const env = this.gatewayEnv();
    if (!env.BROWSER) return "browser binding missing";
    const tools = createQuickActionTools({ browser: env.BROWSER as never });
    const browserTool = tools.browser_markdown as { execute?: (input: { url: string }) => Promise<unknown> } | undefined;
    if (!browserTool?.execute) return "browser markdown missing";
    return JSON.stringify(await browserTool.execute({ url })).slice(0, 2000);
  }

  private gatewayEnv(): GatewayEnv {
    return (this as unknown as { env: GatewayEnv }).env;
  }

  private assertTool(name: string): { orgId: string; userId: string } {
    const envelope = this.state.envelope;
    const role = this.state.role;
    if (!envelope || !role) throw new Error("task_not_bound");
    authorizeCall(
      { orgId: envelope.orgId, userId: envelope.userId, taskType: envelope.taskType, role, tools: this.state.tools },
      name,
      envelope.orgId,
    );
    return { orgId: envelope.orgId, userId: envelope.userId };
  }
}

function collectSourceLinks(payload: unknown): RunSource[] {
  const found: RunSource[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, title: string, depth: number): void => {
    if (depth > 5 || found.length >= 20) return;
    if (typeof value === "string") {
      const matches = value.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
      for (const raw of matches) {
        const url = raw.replace(/[.,]$/, "");
        if (seen.has(url)) continue;
        seen.add(url);
        let host = url;
        try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep the raw url */ }
        found.push({ url, title: title && !title.startsWith("http") ? title : host });
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, title, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const name = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : title;
    for (const item of Object.values(record)) visit(item, name, depth + 1);
  };
  visit(payload, "", 0);
  return found;
}
