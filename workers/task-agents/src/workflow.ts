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

    const asked = work.task || "Map competitors and the local market.";
    const plan = await step.prompt("operating-plan", {
      prompt: `Authenticated organization brief: ${work.company}; website: ${work.website}; profile location (not externally verified): ${work.market}. Operator request: ${asked}\n\nUse the system prompt and action skill catalog to choose direct, action, or company work. Direct is only for a small reply with no new deliverable or tool-dependent facts. Action handles bounded noncompany work. Creating or evaluating company positioning, strategy, research, decisions, plans, or reports is company work, even when the requested output is short. Choose only tool families needed for this request. For company work, load relevant playbooks progressively. Return a concise operator-visible plan and up to six tasks that can finish this turn. Do not present private chain of thought as tasks.`,
      output: planSchema,
      timeout: "30 minutes",
    });
    plan.tasks = currentTurnTasks(plan.tasks);

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
        this.agent.setOperatingPlan(work.runId, plan.plan || asked, plan.tasks);
        await this.agent.note("operating-plan", plan.plan || "I’m using the relevant action skill and tools to finish this.");
        if (plan.decision.trim()) await this.agent.note("progress", plan.decision.trim());
      });
      let result: z.infer<typeof reportSchema> = reportSchema.parse({});
      let actionGuidance = "";
      for (let round = 0; round < 3; round += 1) {
        result = await step.prompt(round === 0 ? "action-execute" : `action-continue-${round}`, {
          prompt: `Current operator request: ${asked}. Decision: ${plan.decision}. Plan: ${plan.plan}. Tasks: ${plan.tasks.map((title, index) => `${index + 1}. ${title}`).join(" ")}. The authenticated profile brief is already injected. ${actionGuidance}${round === 0 ? "First share_progress with your immediate next action in your own words." : "Share a new progress update only if a receipt changes your next step."} Use hivemind_meta for missing internal evidence. For a public webpage screenshot, call native browser_capture; it saves a full-page PNG artifact without connected-app discovery or grant. Use hivemind_connected_task for connected-app status or account-specific work. For status-only requests, call connection_status and stop after its receipt; do not search or read app content. Load a detailed skill only when needed. Use relevant facts from receipts and activate relevant action skills from the catalog. If the next step needs another tool family, open it with reset_tools. If context is unavailable, proceed with independent work and identify any fact you cannot verify. Update plan tasks as their results arrive. Finish requested output. Return finished answer in report with completedTaskIds for tasks supported by the answer or receipts; set needsInput only for a genuinely missing required choice.`,
          output: reportSchema,
          timeout: "30 minutes",
        });
        if (result.needsInput || !missingPlanTaskIds(plan.tasks.length, result.completedTaskIds).length) break;
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
        const imageMissing = /\b(screenshot|capture)\b/i.test(asked) && !this.agent.hasArtifactThisTurn("image");
        const output = imageMissing ? "I could not save the requested screenshot artifact." : reply;
        const missingTasks = missingPlanTaskIds(plan.tasks.length, result.completedTaskIds);
        const complete = verdict.complete && !imageMissing && !missingTasks.length;
        if (complete && requestsArtifact(asked) && !/\b(screenshot|capture)\b/i.test(asked)) {
          const saved = await this.agent.saveCompanyArtifact({ kind: "report", title: reportTitle(reply, "Generated report"), contentType: "text/markdown", body: reply });
          if (/\bpdf\b/i.test(asked)) await this.agent.createPdfArtifact(saved.id);
        }
        if (complete) for (const id of result.completedTaskIds) this.agent.updateOperatingTask(id, "completed", true);
        await this.agent.note("report", output);
        const reason = imageMissing ? "artifact_missing" : missingTasks.length ? "plan_incomplete" : verdict.reason;
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

    const companyContext = await durable.do("recall-company-context", async () =>
      this.agent.recallTaskContext(work.orgId, work.userId, `${work.company} ${work.task}`.slice(0, 1200)));
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
        prompt: `Decision: ${plan.decision || asked}. Plan: ${plan.plan || "Recall company context and verify external evidence before answering."}. Tasks: ${plan.tasks.map((title, index) => `${index + 1}. ${title}`).join(" ")}. The operator asked: ${asked} Company ${work.company}. Profile location (not externally verified): ${work.market}. ${recallSucceeded ? `Company memory recall succeeded: ${JSON.stringify(companyContext).slice(0, 5000)}. Use only relevant, scoped items; a retrieved snippet is not proof that its claims were independently verified.` : "Company memory recall failed. Use the authenticated compact profile already injected, verify other evidence, and do not claim memory facts you could not retrieve."} ${guidance}Continue this same job. Do not reload the playbook catalog. Use injected profile and relevant recall first. Fetch external evidence only when a material claim needs verification; do not routinely capture the website. If profile and memory conflict, name the conflict and leave the fact unresolved. Missing recall is not proof that the company's offer, revenue, or customers do not exist. Do not label dates, metrics, headquarters, or regulatory claims verified without a supporting primary source receipt. Before external work, use share_progress to tell the operator your next decision in your own words; update it only when evidence changes your approach. Use update_plan_task when starting, finishing, or blocking a task. Return completedTaskIds only for tasks whose deliverables are present in report or whose tool receipts prove completion. Do not finish until every planned task is done; stopping at an approval boundary counts as done when the deliverable is ready and nothing was launched. Treat numeric targets without baselines as proposals, not established facts. If one missing fact blocks the job, set needsInput true with one short question and 2 to 5 options. Otherwise set needsInput false and put the final result in report. Start report with a descriptive Markdown H1 title, then short sections and linked citations.`,
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
    const finalVerdict = companyWorkComplete({ report: written.report, recalled: this.agent.hasCompanyContext(), prospectSources, companyWebsite: work.website });
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
      const verdict = companyWorkComplete({ report: written.report, recalled, prospectSources, companyWebsite: work.website });
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
