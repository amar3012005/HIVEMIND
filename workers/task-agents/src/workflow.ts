import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { z } from "zod";
import { HivemindTaskAgent, reportTitle } from "./agent";
import { companyWorkComplete, directReplyComplete, isArtifactPlanTask, pdfReportReady, planRequestsArtifact, requestsArtifact, requestsMemorySave, requestsPdf, requestsSlideDeck, slideDeckReady } from "./completion";
import { currentTurnTasks, missingPlanTaskIds } from "./operating-plan";
import { globalCatalog, localCatalog, localPlaybook } from "./playbooks";
import type { TaskEnvelope } from "./types";

export interface CompanyWork extends TaskEnvelope {
  startedAt?: string;
  company: string;
  website: string;
  market: string;
  task: string;
  previousRequest?: string;
  modePreference?: "auto" | "company" | "direct";
}

const planSchema = z.object({
  mode: z.enum(["direct", "action", "company"]),
  decision: z.string().default(""),
  plan: z.string().default(""),
  tasks: z.array(z.string().min(4).max(160)).max(6).default([]),
  reply: z.string().default(""),
  groups: z.array(z.enum(["company", "web_research", "browser", "connected_apps", "records"])).default([]),
  localPlaybookId: z.string().default(""),
  resolvedRequest: z.string().max(2000).default(""),
  outputKind: z.enum(["none", "document", "slide_deck", "image"]).default("none"),
});

const reportSchema = z.object({
  needsInput: z.boolean().default(false),
  question: z.string().default(""),
  options: z.array(z.string()).max(5).default([]),
  report: z.string().default(""),
  completedTaskIds: z.array(z.number().int().min(1).max(6)).max(6).default([]),
});

export interface CompanyWorkResult {
  runId: string;
  orgId: string;
  complete: boolean;
  reason: string;
  report: string;
}

export class TaskLifecycleWorkflow extends ThinkWorkflow<HivemindTaskAgent, CompanyWork> {
  async run(event: AgentWorkflowEvent<CompanyWork>, step: ThinkWorkflowStep): Promise<CompanyWorkResult> {
    try {
      return await this.runWork(event, step);
    } catch (error) {
      await this.agent.markAwaiting("");
      await this.agent.note("completion", error instanceof Error ? `workflow_failed: ${error.message}` : "workflow_failed");
      await this.agent.note("report", "I could not finish this run. You can continue in this room.");
      throw error;
    }
  }

  private async runWork(event: AgentWorkflowEvent<CompanyWork>, step: ThinkWorkflowStep): Promise<CompanyWorkResult> {
    const durable = step as ThinkWorkflowStep & {
      do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    };
    const work = event.payload;
    await durable.do("bind-employee", async () => {
      await this.agent.bindTask(work, "research", ["playbook_list", "playbook_list_local", "playbook_get", "refine_local_playbook"]);
      await this.agent.note("workrun", `starting ${work.company}`);
    });

    let asked = work.task || "Map competitors and the local market.";
    const playbookNames = localCatalog(globalCatalog().map((item) => item.id));
    const plan = await step.prompt("operating-plan", {
      prompt: `Authenticated organization brief: ${work.company}; website: ${work.website}; profile location (not externally verified): ${work.market}. Current operator request: ${asked}. New-session mode preference: ${work.modePreference || "auto"}. Previous request in this same room, for reference only: ${work.previousRequest || "none"}. If current request refers to earlier work (for example, "do it"), set resolvedRequest to the concrete requested task, preserving current instruction. Otherwise set resolvedRequest to current request. Current request wins if it changes scope. Choose outputKind by requested deliverable, understanding ordinary spelling mistakes; a fundraising pitch deck is slide_deck, not document.\n\nUse the system prompt and action skill catalog to choose direct, action, or company work. Direct is for a small reply with no new deliverable or tool-dependent facts. Action handles bounded tool work. Company mode is for substantive company positioning, strategy, research, decisions, plans, reports, fundraising materials, and investor deliverables. Choose only tool families needed. For company work, choose the most specific local playbook whose named output matches the requested deliverable, set localPlaybookId to its id, and return a concise operator-visible plan with up to six tasks. A request for a finished file needs a plan step for creating that file and checking its receipt; drafting text alone is not completion. For action work, return no formal plan or tasks. Local playbook names (methods load after selection): ${JSON.stringify(playbookNames)}. Do not present private chain of thought as tasks.`,
      output: planSchema,
      timeout: "30 minutes",
    });
    asked = plan.resolvedRequest.trim() || asked;
    const deckRequested = plan.outputKind === "slide_deck" || requestsSlideDeck(asked);
    const artifactForbidden = /\b(?:do not|don't|never|without|no)\b[^.!?]{0,80}\b(?:artifact|file)\b/i.test(work.task ?? "");
    const pdfForbidden = /\b(?:do not|don't|never|without|no)\b[^.!?]{0,80}\bpdf\b/i.test(work.task ?? "");
    if (work.modePreference === "company" || deckRequested) plan.mode = "company";
    else if (/\b(screenshot|capture)\b/i.test(asked) || (plan.mode === "direct" && requestsArtifact(asked))) plan.mode = "action";
    plan.tasks = plan.mode === "company" ? currentTurnTasks(plan.tasks) : [];
    if (plan.mode === "company" && !plan.tasks.length) {
      const revised = await step.prompt("complete-company-plan", {
        prompt: `Operator request: ${asked}. Write three to six observable company-work tasks that end with the requested deliverable and actual file receipt. No private reasoning or approval-only task.`,
        output: z.object({ tasks: z.array(z.string().min(4).max(160)).min(3).max(6) }),
        timeout: "30 minutes",
      });
      plan.tasks = currentTurnTasks(revised.tasks);
    }
    // A named output wins over a broad topic playbook: deck work must not
    // silently become a strategy note even when the planner picks one.
    if (plan.mode === "company" && deckRequested) plan.localPlaybookId = "local:fundraising.pitch-deck";
    if (plan.mode === "company" && !localPlaybook(plan.localPlaybookId)) {
      const playbookIds = playbookNames.map((item) => item.id) as [string, ...string[]];
      const choice = await step.prompt("select-local-playbook", {
        prompt: `Choose exactly one id from this list for the requested final deliverable: ${asked}. Available: ${JSON.stringify(playbookNames)}.`,
        output: z.object({ id: z.enum(playbookIds) }),
        timeout: "30 minutes",
      });
      plan.localPlaybookId = choice.id;
    }
    const selectedPlaybook = plan.mode === "company" ? localPlaybook(plan.localPlaybookId) : null;
    if (plan.mode === "company" && !selectedPlaybook) throw new Error("company_playbook_not_selected");
    const artifactRequested = !artifactForbidden && planRequestsArtifact(work.task, plan.outputKind, plan.tasks);
    if (plan.mode === "company" && deckRequested && artifactRequested && !plan.tasks.some(isArtifactPlanTask)) {
      plan.tasks = [...plan.tasks.slice(0, 5), "Render and verify the finished pitch deck PDF artifact"];
    }
    const artifactTaskIds = artifactRequested
      ? plan.tasks.flatMap((task, index) => isArtifactPlanTask(task) ? [index + 1] : [])
      : [];
    const missingContentTasks = (completed: readonly number[]) =>
      missingPlanTaskIds(plan.tasks.length, [...completed, ...artifactTaskIds]);

    if (plan.mode === "direct") {
      const reply = plan.reply.trim() || plan.decision.trim();
      return durable.do("complete", async () => {
        const verdict = directReplyComplete(reply);
        await this.agent.note("completion", verdict.complete ? "complete" : verdict.reason);
        await this.agent.note("report", reply);
        return { runId: work.runId, orgId: work.orgId, complete: verdict.complete, reason: verdict.reason, report: reply };
      });
    }

    if (plan.mode === "action") {
      await durable.do("enable-action-tools", async () => {
        await this.agent.applyGroups(plan.groups, true);
        this.agent.setOperatingPlan(work.runId, "", []);
        if (plan.decision.trim()) await this.agent.note("progress", plan.decision.trim());
      });
      let result: z.infer<typeof reportSchema> = reportSchema.parse({});
      let actionGuidance = "";
      for (let round = 0; round < 3; round += 1) {
        result = await step.prompt(round === 0 ? "action-execute" : `action-continue-${round}`, {
          prompt: `Current operator request: ${asked}. Decision: ${plan.decision}. The authenticated profile brief is already injected. ${actionGuidance}${round === 0 ? "First share_progress with your immediate next action in your own words." : "Share a new progress update only if a receipt changes your next step."} Use hivemind_meta for missing internal evidence. For a public webpage screenshot, call native browser_capture in this turn; prior room artifacts do not complete a new request. It saves a full-page image artifact without connected-app discovery or grant. Capture the requested page, not an adjacent path; do not guess URL variants or save a fallback page as the requested screenshot. If capture fails, report that error once. For a requested PDF, provide the finished Markdown report; the room runtime renders and attaches its PDF after this response. Do not use browser_capture or memory save for PDF generation. Use hivemind_connected_task for connected-app status or account-specific work. For status-only requests, call connection_status and stop after its receipt; do not search or read app content. Load a detailed skill only when needed. Use relevant facts from receipts and activate relevant action skills from the catalog. If the next step needs another tool family, open it with reset_tools. If context is unavailable, proceed with independent work and identify any fact you cannot verify. Finish requested output. Return finished answer in report; set needsInput only for a genuinely missing required choice.`,
          output: reportSchema,
          timeout: "30 minutes",
        });
        if (result.needsInput) break;
        if (requestsPdf(asked) && !pdfReportReady(result.report)) {
          actionGuidance = "The room has a native PDF renderer. Remove PDF-tool failure/status text, finish the requested report as Markdown, and let runtime attach the PDF. Do not search other PDF tools. ";
          continue;
        }
        if (/\b(screenshot|capture)\b/i.test(asked) && !this.agent.hasArtifactSince("image", work.startedAt ?? "")) {
          actionGuidance = "No image artifact was saved in this turn. A prior room artifact cannot satisfy this request. Call browser_capture for the requested page now, or report its concrete error without claiming success. ";
          continue;
        }
        if (!missingPlanTaskIds(plan.tasks.length, result.completedTaskIds).length) break;
        actionGuidance = `Previous response left planned tasks ${missingPlanTaskIds(plan.tasks.length, result.completedTaskIds).join(", ")} unaccounted for. Continue unfinished work, or explain a concrete blocker. Preserve completed results and return all completed task ids. `;
      }
      if (result.needsInput) {
        await this.agent.note("report", result.question || "I need one detail to finish this task.");
        await this.agent.note("completion", "input_required");
        return { runId: work.runId, orgId: work.orgId, complete: false, reason: "input_required", report: result.question };
      }
      const reply = result.report.trim();
      return durable.do("complete-action", async () => {
        const verdict = directReplyComplete(reply);
        const imageMissing = /\b(screenshot|capture)\b/i.test(asked) && !this.agent.hasArtifactSince("image", work.startedAt ?? "");
        const output = imageMissing ? "I could not save the requested screenshot artifact." : reply;
        const missingTasks = missingPlanTaskIds(plan.tasks.length, result.completedTaskIds);
        const pdfSourceInvalid = requestsPdf(asked) && !pdfReportReady(reply);
        const complete = verdict.complete && !imageMissing && !missingTasks.length && !pdfSourceInvalid;
        if (complete && artifactRequested && !/\b(screenshot|capture)\b/i.test(asked)) {
          const saved = await this.agent.saveCompanyArtifact({ kind: "report", title: reportTitle(reply, "Generated report"), contentType: "text/markdown", body: reply });
          if (!pdfForbidden && (requestsPdf(asked) || deckRequested)) await this.agent.createPdfArtifact(saved.id);
        }
        if (complete) for (const id of result.completedTaskIds) this.agent.updateOperatingTask(id, "completed", true);
        await this.agent.note("report", output);
        const reason = imageMissing ? "artifact_missing" : pdfSourceInvalid ? "pdf_report_incomplete" : missingTasks.length ? "plan_incomplete" : verdict.reason;
        await this.agent.note("completion", complete ? "complete" : reason);
        return { runId: work.runId, orgId: work.orgId, complete, reason: complete ? "action_complete" : reason, report: output };
      });
    }

    await durable.do("enable-tools", async () => {
      const groups = plan.groups.length > 0 ? [...plan.groups] : ["company", "web_research", "browser", "records"];
      if (!groups.includes("company")) groups.push("company");
      await this.agent.applyGroups(groups);
      this.agent.setOperatingPlan(work.runId, plan.plan || asked, plan.tasks);
      await this.agent.note("operating-plan", (plan.plan || asked).slice(0, 2000));
      if (plan.decision.trim()) await this.agent.note("progress", plan.decision.trim());
    });
    const playbookBody = await durable.do("load-local-playbook", async () => this.agent.loadTaskPlaybook(selectedPlaybook!.id));

    const companyContext = await durable.do("recall-company-context", async () =>
      this.agent.recallTaskContext(work.orgId, work.userId, asked.slice(0, 1200)));
    const recallSucceeded = Boolean(companyContext && typeof companyContext === "object" && "ok" in companyContext && companyContext.ok === true);
    if (!recallSucceeded && !this.agent.hasCompanyContext()) {
      const reply = "Company memory is unavailable. I cannot finish company research until it is reachable.";
      await durable.do("context-unavailable", async () => {
        await this.agent.note("report", reply);
        await this.agent.note("completion", "company_context_unavailable");
      });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason: "company_context_unavailable", report: reply };
    }

    let guidance = "";
    let written = { report: "", completedTaskIds: [] as number[] };
    const isProspect = /\bprospects?\b/i.test(asked);
    for (let round = 0; round < 3; round += 1) {
      const result = await step.prompt(round === 0 ? "execute" : `continue-${round}`, {
        prompt: `Decision: ${plan.decision || asked}. Plan: ${plan.plan || "Recall company context and verify external evidence before answering."}. Tasks: ${plan.tasks.map((title, index) => `${index + 1}. ${title}`).join(" ")}. Selected local playbook ${selectedPlaybook!.id}: ${playbookBody}. The operator asked: ${asked} Company ${work.company}. Profile location (not externally verified): ${work.market}. ${recallSucceeded ? `Company memory recall succeeded: ${JSON.stringify(companyContext).slice(0, 5000)}. Use only relevant, scoped items; a retrieved snippet is not proof that its claims were independently verified.` : "Company memory recall failed. Use the authenticated compact profile already injected, verify other evidence, and do not claim memory facts you could not retrieve."} ${guidance}Continue this same job. Do not reload the playbook catalog. Use injected profile and relevant recall first. Fetch external evidence only when a material claim needs verification; do not routinely capture the website. For a requested PDF, put the finished Markdown in report; runtime renders PDF after this response. Do not call browser_capture or HIVEMIND memory save to create a PDF. For a requested pitch deck, write finished numbered slides, not a generic report or outline. Do not claim an artifact exists before its receipt. If profile and memory conflict, name the conflict and leave the fact unresolved. Missing recall is not proof that the company's offer, revenue, or customers do not exist. Do not label dates, metrics, headquarters, or regulatory claims verified without a supporting primary source receipt. Before external work, use share_progress to tell the operator your next decision in your own words; update it only when evidence changes your approach. Use update_plan_task when starting, finishing, or blocking a task. Return completedTaskIds only for tasks whose deliverables are present in report or whose tool receipts prove completion. Do not finish until every planned task is done; stopping at an approval boundary counts as done when the deliverable is ready and nothing was launched. Treat numeric targets without baselines as proposals, not established facts. If one missing fact blocks the job, set needsInput true with one short question and 2 to 5 options. Otherwise set needsInput false and put the final result in report. Start report with a descriptive Markdown H1 title, then short sections and linked citations.`,
        output: reportSchema,
        timeout: "30 minutes",
      });
      if (!result.needsInput) {
        written = result;
        if (deckRequested && !slideDeckReady(result.report)) {
          guidance += "The requested pitch deck is not finished: provide at least eight consecutive, numbered slide sections with substantive content. An outline or generic report does not count. ";
          continue;
        }
        if (requestsPdf(asked) && !pdfReportReady(result.report)) {
          guidance += "The room has a native PDF renderer. Remove PDF-tool failure/status text, finish the requested report as Markdown, and let runtime attach the PDF. Do not search other PDF tools. ";
          continue;
        }
        const missingPlanIds = missingContentTasks(result.completedTaskIds);
        if (missingPlanIds.length) {
          guidance += `The report did not account for planned tasks ${missingPlanIds.join(", ")}. Complete each remaining task with visible output or evidence, then return every completed task id. Do not present an unfinished plan as final. `;
          continue;
        }
        if (!isProspect || companyWorkComplete({ report: result.report, recalled: true, prospectSources: await this.agent.sourceUrls(), companyWebsite: work.website }).reason !== "prospect_sources_missing") break;
        guidance += "No verified external source supports the proposed prospect list. Search buyer accounts in the requested location with parallel_search, inspect each accepted account when needed, and cite only URLs returned by those tools. Do not claim a source was checked if it was not. ";
        continue;
      }
      const options = result.options.map((option) => option.trim()).filter(Boolean).slice(0, 5);
      await durable.do(`ask-${round}`, async () => {
        await this.agent.askOperator(result.question || "Which should I use?", options);
      });
      let answer = "";
      try {
        const metadata = await this.waitForApproval(step, { timeout: "7 days", stepName: `operator-${round}` }) as { answer?: string } | undefined;
        answer = metadata?.answer?.trim() ?? "";
      } catch {
        answer = "";
      }
      await durable.do(`heard-${round}`, async () => {
        await this.agent.markAwaiting("");
      });
      if (!answer) {
        written = { report: result.question || "I still need a choice to continue.", completedTaskIds: result.completedTaskIds };
        break;
      }
      guidance += `The operator chose: ${answer}. `;
    }

    const prospectSources = isProspect ? await this.agent.sourceUrls() : undefined;
    if (deckRequested && !slideDeckReady(written.report)) {
      const reply = "I could not finish the requested pitch deck. The plan remains open; no deck artifact was created.";
      await durable.do("deck-incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", "deck_incomplete"); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason: "deck_incomplete", report: reply };
    }
    if (requestsPdf(asked) && !pdfReportReady(written.report)) {
      const reply = "I could not prepare a finished report for PDF rendering. The plan remains open.";
      await durable.do("pdf-source-incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", "pdf_report_incomplete"); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason: "pdf_report_incomplete", report: reply };
    }
    const missingPlanIds = missingContentTasks(written.completedTaskIds);
    if (missingPlanIds.length) {
      const reply = `${written.report.trim()}\n\nI could not finish planned tasks ${missingPlanIds.join(", ")}. The plan remains open.`.trim();
      await durable.do("plan-incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", "plan_incomplete"); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason: "plan_incomplete", report: reply };
    }
    const finalVerdict = companyWorkComplete({ report: written.report, recalled: this.agent.hasCompanyContext(), prospectSources, companyWebsite: work.website });
    if (!finalVerdict.complete) {
      const reason = finalVerdict.reason;
      const reply = `${reason === "prospect_sources_missing" ? "Prospect citations lack matching external tool receipts. Draft below is unverified; no artifact was saved. Plan remains open." : `I could not complete this work: ${reason}.`}\n\n${written.report.trim()}`.trim();
      await durable.do("incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", reason); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason, report: reply };
    }

    const review = await durable.do("govern-report", async () => this.agent.reviewCompanyReport({
      task: asked,
      plan: plan.tasks,
      report: written.report,
      companyContext,
      sources: await this.agent.sourceUrls(),
    }));
    if (review.verdict === "caution" && review.note) {
      written.report += `\n\n## Review note\n${review.note}`;
    }

    const prepared = await durable.do("complete", async () => {
      const recalled = this.agent.hasCompanyContext();
      const verdict = companyWorkComplete({ report: written.report, recalled, prospectSources, companyWebsite: work.website });
      if (artifactRequested) {
        const saved = await this.agent.saveCompanyArtifact({
          kind: "report",
          title: reportTitle(written.report, `${work.company} report`),
          contentType: "text/markdown",
          body: written.report,
        });
        if (!pdfForbidden && (requestsPdf(asked) || deckRequested)) await this.agent.createPdfArtifact(saved.id);
      }
      for (const id of new Set([...written.completedTaskIds, ...artifactTaskIds])) this.agent.updateOperatingTask(id, "completed", true);
      await this.agent.note("report", written.report);
      this.agent.rememberSources(written.report);
      if (!requestsMemorySave(asked)) {
        await this.agent.note("completion", "deliverable_ready");
        return { title: "", content: "", report: written.report, verdict };
      }
      const title = `${work.company}: ${asked.slice(0, 120)}`;
      const preview = written.report.slice(0, 700);
      await this.agent.note("approval", `Save this to company memory?\n${title}\n${preview}`);
      this.agent.markAwaiting("memory");
      return { title, content: written.report.slice(0, 4000), report: written.report, verdict };
    });

    const scoreCompletedWork = () => durable.do("score-completed-company-work", async () => this.agent.scoreCompletedCompanyWork({
      task: asked,
      plan: plan.tasks,
      completedTaskIds: written.completedTaskIds,
      report: prepared.report,
      sourceUrls: await this.agent.sourceUrls(),
    }));

    if (!prepared.title) {
      await scoreCompletedWork();
      return { runId: work.runId, orgId: work.orgId, complete: prepared.verdict.complete, reason: "deliverable_ready", report: prepared.report };
    }

    let approved = false;
    try {
      const approval = await this.waitForApproval(step, { timeout: "7 days", stepName: "memory-approval" });
      approved = approval != null;
    } catch {
      approved = false;
    }

    const result = await durable.do("store-memory", async () => {
      this.agent.markAwaiting("");
      if (!approved) {
        await this.agent.note("completion", "memory_declined");
        return { runId: work.runId, orgId: work.orgId, complete: prepared.verdict.complete, reason: "memory_declined", report: prepared.report };
      }
      const memory = await this.agent.saveCompanyMemory(prepared.title, prepared.content);
      const memorySaved = Boolean(memory && typeof memory === "object" && "ok" in memory && memory.ok === true);
      await this.agent.note("completion", memorySaved ? "memory_saved" : "memory_write_failed");
      return {
        runId: work.runId,
        orgId: work.orgId,
        complete: prepared.verdict.complete && memorySaved,
        reason: memorySaved ? prepared.verdict.reason : "memory_write_failed",
        report: prepared.report,
      };
    });
    await scoreCompletedWork();
    return result;
  }
}
