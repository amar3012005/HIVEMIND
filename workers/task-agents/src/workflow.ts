import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { z } from "zod";
import { HivemindTaskAgent, reportTitle } from "./agent";
import { companyWorkComplete, directReplyComplete, requestsArtifact, requestsMemorySave } from "./completion";
import { currentTurnTasks, missingPlanTaskIds } from "./operating-plan";
import type { TaskEnvelope } from "./types";

export interface CompanyWork extends TaskEnvelope {
  company: string;
  website: string;
  market: string;
  task: string;
}

const planSchema = z.object({
  mode: z.enum(["direct", "action", "company"]),
  decision: z.string().default(""),
  plan: z.string().default(""),
  tasks: z.array(z.string().min(4).max(160)).max(6).default([]),
  reply: z.string().default(""),
  groups: z.array(z.enum(["company", "web_research", "browser", "connected_apps", "records"])).default([]),
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
      await this.agent.note("report", "I could not finish this work. Please retry in a new room.");
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

    const asked = work.task || "Map competitors and the local market.";
    const plan = await step.prompt("operating-plan", {
      prompt: `Company ${work.company}. Website ${work.website}. City ${work.market}. The operator said: ${asked}\n\nChoose direct for a small answer needing no tools. Choose action for a bounded tool or artifact task that does not need a company operating method. Questions about what is stored or available in HIVEMIND are action requests: enable the company tool family, recall relevant memories and inspect the profile, then answer from receipts without a playbook. Do not claim that a scoped recall is a complete inventory. Choose company only when producing research, strategy, prospecting, or another company deliverable; then call playbook_list for global names, playbook_list_local for chosen fields, and playbook_get for one local task. Return decision, concise operator-visible plan, up to six concrete tasks, and only needed tool families. Plan only work that can finish in this turn; leave future actions requiring operator approval out of tasks. Do not present private chain of thought as tasks.`,
      output: planSchema,
      timeout: "30 minutes",
    });
    if (/\bHIVEMIND\b/i.test(asked) && /\b(what|which|list|inventory|available|stored|personal)\b/i.test(asked)
      && !/\b(how many|prior|previous|earlier)\b/i.test(asked)) {
      plan.mode = "action";
      plan.groups = ["company"];
      plan.plan = "Inspect current scoped HIVEMIND memory and profile, then answer from those receipts.";
      plan.tasks = ["Inspect scoped HIVEMIND recall and profile", "Answer from current receipts"];
    }
    plan.tasks = currentTurnTasks(plan.tasks);

    if (plan.mode === "direct") {
      const reply = plan.reply.trim() || plan.decision.trim();
      return durable.do("complete", async () => {
        const verdict = directReplyComplete(reply);
        await this.agent.saveCompanyArtifact({
          kind: "note",
          title: "Reply",
          contentType: "text/plain",
          body: reply,
        });
        await this.agent.note("completion", verdict.complete ? "complete" : verdict.reason);
        await this.agent.note("report", reply);
        return { runId: work.runId, orgId: work.orgId, complete: verdict.complete, reason: verdict.reason, report: reply };
      });
    }

    if (plan.mode === "action") {
      await durable.do("enable-action-tools", async () => {
        const groups = [...plan.groups];
        if (/\b(screenshot|capture|webpage|website)\b/i.test(asked) && !groups.includes("browser")) groups.push("browser");
        if (/\bHIVEMIND\b/i.test(asked) && !groups.includes("company")) groups.push("company");
        await this.agent.applyGroups(groups, false, true);
        this.agent.setOperatingPlan(work.runId, plan.plan || asked, plan.tasks);
        await this.agent.note("operating-plan", plan.plan || "I’m using the relevant action skill and tools to finish this.");
      });
      const actionContext = await durable.do("recall-action-context", async () =>
        this.agent.recallTaskContext(work.orgId, work.userId, asked.slice(0, 1200)).catch(() => ({ error: "company_context_unavailable" })));
      const needsExternalContext = plan.groups.some((group) => ["web_research", "browser", "connected_apps"].includes(group))
        || /\b(screenshot|capture|webpage|website)\b/i.test(asked);
      if (needsExternalContext && (!actionContext || typeof actionContext !== "object" || !("ok" in actionContext) || actionContext.ok !== true)) {
        const reply = "HIVEMIND company context is unavailable. I could not start external action tools.";
        await durable.do("action-context-unavailable", async () => {
          await this.agent.note("report", reply);
          await this.agent.note("completion", "company_context_unavailable");
        });
        return { runId: work.runId, orgId: work.orgId, complete: false, reason: "company_context_unavailable", report: reply };
      }
      const result = await step.prompt("action-execute", {
        prompt: `Current operator request: ${asked}. Answer this request, not an earlier turn. Decision: ${plan.decision}. Plan: ${plan.plan}. Tasks: ${plan.tasks.map((title, index) => `${index + 1}. ${title}`).join(" ")}. HIVEMIND context preflight for this request: ${JSON.stringify(actionContext).slice(0, 3000)}. For HIVEMIND inventory questions, inspect accessible memory recall and profile with the granted internal tools, distinguish records from general capabilities, and say when a complete inventory is unavailable. If asked about personal information, report only personal facts actually present in the current scoped receipts; do not repeat a prior company-memory count as the answer. Use relevant company facts when applicable; do not invent facts when context is unavailable. Activate only relevant action skills from the catalog. Use share_progress once when choosing the next action, and again only if tool evidence changes your approach. Use granted tools and finish the requested output. For a webpage screenshot, use browser_capture and its saved artifact receipt. Do not load company playbooks. Return the finished answer in report; set needsInput only for a genuinely missing required choice.`,
        output: reportSchema,
        timeout: "30 minutes",
      });
      if (result.needsInput) {
        await this.agent.note("report", result.question || "I need one detail to finish this task.");
        await this.agent.note("completion", "input_required");
        return { runId: work.runId, orgId: work.orgId, complete: false, reason: "input_required", report: result.question };
      }
      const reply = result.report.trim();
      return durable.do("complete-action", async () => {
        const verdict = directReplyComplete(reply);
        if (requestsArtifact(asked) && !/\b(screenshot|capture)\b/i.test(asked) && verdict.complete) {
          const saved = await this.agent.saveCompanyArtifact({ kind: "report", title: reportTitle(reply, "Generated report"), contentType: "text/markdown", body: reply });
          if (/\bpdf\b/i.test(asked)) await this.agent.createPdfArtifact(saved.id);
        }
        const imageMissing = /\b(screenshot|capture)\b/i.test(asked) && !this.agent.hasArtifactThisTurn("image");
        const output = imageMissing ? "I could not save the requested screenshot artifact." : reply;
        const complete = verdict.complete && !imageMissing;
        if (complete) for (let index = 0; index < plan.tasks.length; index += 1) this.agent.updateOperatingTask(index + 1, "completed", true);
        await this.agent.note("report", output);
        await this.agent.note("completion", complete ? "complete" : imageMissing ? "artifact_missing" : verdict.reason);
        return { runId: work.runId, orgId: work.orgId, complete, reason: complete ? "action_complete" : imageMissing ? "artifact_missing" : verdict.reason, report: output };
      });
    }

    await durable.do("enable-tools", async () => {
      const groups = plan.groups.length > 0 ? [...plan.groups] : ["company", "web_research", "browser", "records"];
      if (!groups.includes("company")) groups.push("company");
      if (/\bprospects?\b/i.test(asked) && !groups.includes("web_research")) groups.push("web_research");
      await this.agent.applyGroups(groups, /\bprospects?\b/i.test(asked));
      this.agent.setOperatingPlan(work.runId, plan.plan || asked, plan.tasks);
      await this.agent.note("operating-plan", (plan.plan || asked).slice(0, 2000));
    });

    const companyContext = await durable.do("recall-company-context", async () =>
      this.agent.recallTaskContext(work.orgId, work.userId, `${work.company} ${work.task}`.slice(0, 1200)));
    if (!companyContext || typeof companyContext !== "object" || !("ok" in companyContext) || companyContext.ok !== true) {
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
    const marketResearch = /\b(competitor|market research)\b/i.test(asked);
    for (let round = 0; round < 3; round += 1) {
      const result = await step.prompt(round === 0 ? "execute" : `continue-${round}`, {
        prompt: `Decision: ${plan.decision || asked}. Plan: ${plan.plan || "Recall company context and verify external evidence before answering."}. Tasks: ${plan.tasks.map((title, index) => `${index + 1}. ${title}`).join(" ")}. The operator asked: ${asked} Company ${work.company}. City ${work.market}. Company memory recall succeeded: ${JSON.stringify(companyContext).slice(0, 5000)}. Do not claim company memory is unavailable when this receipt succeeded. ${guidance}Continue this same job. Do not reload the playbook catalog. Before external work, use share_progress to tell the operator your next decision in your own words; update it only when evidence changes your approach. Use update_plan_task when starting, finishing, or blocking a task. Return completedTaskIds only for tasks whose deliverables are present in report or whose tool receipts prove completion. Do not finish until every planned task is done; stopping at an approval boundary counts as done when the deliverable is ready and nothing was launched. Treat numeric targets without baselines as proposals, not established facts. If one missing fact blocks the job, set needsInput true with one short question and 2 to 5 options. Otherwise set needsInput false and put the final result in report. Start report with a descriptive Markdown H1 title, then short sections and linked citations.`,
        output: reportSchema,
        timeout: "30 minutes",
      });
      if (!result.needsInput) {
        written = result;
        const missingPlanIds = missingPlanTaskIds(plan.tasks.length, result.completedTaskIds);
        if (missingPlanIds.length) {
          guidance += `The report did not account for planned tasks ${missingPlanIds.join(", ")}. Complete each remaining task with visible output or evidence, then return every completed task id. Do not present an unfinished plan as final. `;
          continue;
        }
        if (marketResearch && !companyWorkComplete({ report: result.report, recalled: true, marketResearch }).complete) {
          guidance += "The previous output was only progress, not the requested deliverable. Continue reading official vendor sites and finish the market map. Cite at least three official URLs, distinguish direct competitors from adjacent platforms, and give concrete recommendations. Do not ask whether to continue or summarize unfinished work. ";
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
    const missingPlanIds = missingPlanTaskIds(plan.tasks.length, written.completedTaskIds);
    if (missingPlanIds.length) {
      const reply = `I could not finish planned tasks ${missingPlanIds.join(", ")}. I have kept the plan open.`;
      await durable.do("plan-incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", "plan_incomplete"); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason: "plan_incomplete", report: reply };
    }
    const finalVerdict = companyWorkComplete({ report: written.report, recalled: this.agent.hasCompanyContext(), prospectSources, companyWebsite: work.website, marketResearch });
    if (!finalVerdict.complete) {
      const reason = finalVerdict.reason;
      const reply = reason === "prospect_sources_missing" ? "I could not verify the prospect list against external sources. I have not saved it. Please retry the research." : `I could not complete this work: ${reason}.`;
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
      const verdict = companyWorkComplete({ report: written.report, recalled, prospectSources, companyWebsite: work.website, marketResearch });
      const saved = await this.agent.saveCompanyArtifact({
        kind: "report",
        title: reportTitle(written.report, `${work.company} report`),
        contentType: "text/markdown",
        body: written.report,
      });
      if (/\bpdf\b/i.test(asked)) await this.agent.createPdfArtifact(saved.id);
      for (const id of written.completedTaskIds) this.agent.updateOperatingTask(id, "completed", true);
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

    if (!prepared.title) return { runId: work.runId, orgId: work.orgId, complete: prepared.verdict.complete, reason: "deliverable_ready", report: prepared.report };

    let approved = false;
    try {
      const approval = await this.waitForApproval(step, { timeout: "7 days", stepName: "memory-approval" });
      approved = approval != null;
    } catch {
      approved = false;
    }

    return durable.do("store-memory", async () => {
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
  }
}
