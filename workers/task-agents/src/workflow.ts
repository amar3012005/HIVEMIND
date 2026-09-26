import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { z } from "zod";
import { HivemindTaskAgent, reportTitle } from "./agent";
import { companyWorkComplete, directReplyComplete } from "./completion";
import type { TaskEnvelope } from "./types";

export interface CompanyWork extends TaskEnvelope {
  company: string;
  website: string;
  market: string;
  task: string;
}

const planSchema = z.object({
  mode: z.enum(["direct", "company"]),
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
      prompt: `Company ${work.company}. Website ${work.website}. City ${work.market}. The operator said: ${asked}\n\nIf this is not real company work, set mode to direct, leave groups and tasks empty, and put the message you would say in reply. If it is company work, set mode to company. Call playbook_list for global names only, then playbook_list_local for the fields you chose, then playbook_get for the one local task. Return the decision, a short operator-visible plan summary, 3 to 6 concrete tasks in execution order, and only the tool families that method needs. Do not present private chain of thought as tasks.`,
      output: planSchema,
      timeout: "30 minutes",
    });

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

    await durable.do("enable-tools", async () => {
      const groups = plan.groups.length > 0 ? [...plan.groups] : ["company", "web_research", "browser", "records"];
      if (!groups.includes("company")) groups.push("company");
      if (/\bprospects?\b/i.test(asked) && !groups.includes("web_research")) groups.push("web_research");
      await this.agent.applyGroups(groups, /\bprospects?\b/i.test(asked));
      this.agent.setOperatingPlan(work.runId, plan.plan || asked, plan.tasks);
      await this.agent.note("operating-plan", (plan.plan || asked).slice(0, 2000));
    });

    await this.agent.note("operating-plan", "I’m recalling the company context, then I’ll work through the plan.");
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
    let written = { report: "" };
    const isProspect = /\bprospects?\b/i.test(asked);
    const marketResearch = /\b(competitor|market research)\b/i.test(asked);
    for (let round = 0; round < 3; round += 1) {
      await this.agent.note("operating-plan", round === 0 ? "I have the company context. I’m checking evidence and writing the result." : "I’m resolving a gap in the result before I finish.");
      const result = await step.prompt(round === 0 ? "execute" : `continue-${round}`, {
        prompt: `Decision: ${plan.decision || asked}. Plan: ${plan.plan || "Recall company context and verify external evidence before answering."}. Tasks: ${plan.tasks.map((title, index) => `${index + 1}. ${title}`).join(" ")}. The operator asked: ${asked} Company ${work.company}. City ${work.market}. Company memory: ${JSON.stringify(companyContext).slice(0, 5000)}. ${guidance}Continue this same job. Do not reload the playbook catalog. Use update_plan_task when starting, finishing, or blocking a task so the operator sees real progress. If one missing fact blocks the job, set needsInput true, put one short question in question, and put 2 to 5 choices in options. Leave report empty. If you can finish, set needsInput false and put the result in report. Format finished report with Markdown headings, short paragraphs, and linked citations so it reads cleanly in chat.`,
        output: reportSchema,
        timeout: "30 minutes",
      });
      if (!result.needsInput) {
        written = result;
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
        written = { report: result.question || "I still need a choice to continue." };
        break;
      }
      guidance += `The operator chose: ${answer}. `;
    }

    const prospectSources = isProspect ? await this.agent.sourceUrls() : undefined;
    const finalVerdict = companyWorkComplete({ report: written.report, recalled: this.agent.hasCompanyContext(), prospectSources, companyWebsite: work.website, marketResearch });
    if (!finalVerdict.complete) {
      const reason = finalVerdict.reason;
      const reply = reason === "prospect_sources_missing" ? "I could not verify the prospect list against external sources. I have not saved it. Please retry the research." : `I could not complete this work: ${reason}.`;
      await durable.do("incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", reason); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason, report: reply };
    }

    const prepared = await durable.do("complete", async () => {
      const recalled = this.agent.hasCompanyContext();
      const verdict = companyWorkComplete({ report: written.report, recalled, prospectSources, companyWebsite: work.website, marketResearch });
      await this.agent.saveCompanyArtifact({
        kind: "report",
        title: reportTitle(written.report, `${work.company} report`),
        contentType: "text/markdown",
        body: written.report,
      });
      await this.agent.note("report", written.report);
      this.agent.rememberSources(written.report);
      const title = `${work.company}: ${asked.slice(0, 120)}`;
      const preview = written.report.slice(0, 700);
      await this.agent.note("approval", `Save this to company memory?\n${title}\n${preview}`);
      this.agent.markAwaiting("memory");
      return { title, content: written.report.slice(0, 4000), report: written.report, verdict };
    });

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
