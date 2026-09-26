import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { z } from "zod";
import { HivemindTaskAgent } from "./agent";
import { companyWorkComplete, directReplyComplete } from "./completion";
import { HYPERAGENT_INSTRUCTION } from "./employee";
import type { TaskEnvelope } from "./types";

export interface CompanyWork extends TaskEnvelope {
  company: string;
  website: string;
  market: string;
  task: string;
}

const planSchema = z.object({
  mode: z.enum(["direct", "company"]),
  decision: z.string(),
  plan: z.string(),
  reply: z.string(),
  groups: z.array(z.enum(["company", "web_research", "browser", "connected_apps", "records"])),
});

const reportSchema = z.object({
  needsInput: z.boolean(),
  question: z.string(),
  options: z.array(z.string()).max(5),
  report: z.string(),
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
      prompt: `${HYPERAGENT_INSTRUCTION}\n\nCompany ${work.company}. Website ${work.website}. City ${work.market}. The operator said: ${asked}\n\nIf this is not real company work, set mode to direct, leave groups empty, and put the message you would say in reply. If it is company work, set mode to company. Call playbook_list for global names only, then playbook_list_local for the fields you chose, then playbook_get for the one local task. Return the decision, the plan, and only the tool families that method needs.`,
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
        await this.agent.note("report", reply.slice(0, 8000));
        return { runId: work.runId, orgId: work.orgId, complete: verdict.complete, reason: verdict.reason, report: reply };
      });
    }

    await durable.do("enable-tools", async () => {
      const groups = plan.groups.length > 0 ? [...plan.groups] : ["company", "web_research", "browser", "records"];
      if (!groups.includes("company")) groups.push("company");
      if (/\bprospects?\b/i.test(asked) && !groups.includes("web_research")) groups.push("web_research");
      await this.agent.applyGroups(groups);
      await this.agent.note("operating-plan", plan.plan.slice(0, 2000));
    });

    let guidance = "";
    let written = { report: "" };
    const isProspect = /\bprospects?\b/i.test(asked);
    for (let round = 0; round < 3; round += 1) {
      const result = await step.prompt(round === 0 ? "execute" : `continue-${round}`, {
        prompt: `${HYPERAGENT_INSTRUCTION}\n\nDecision: ${plan.decision}. Plan: ${plan.plan}. The operator asked: ${asked} Company ${work.company}. City ${work.market}. ${guidance}Continue this same job. Do not reload the playbook catalog. If one missing fact blocks the job, set needsInput true, put one short question in question, and put 2 to 5 choices in options. Leave report empty. If you can finish, set needsInput false and put the result in report.`,
        output: reportSchema,
        timeout: "30 minutes",
      });
      if (!result.needsInput) {
        written = result;
        if (!isProspect || companyWorkComplete({ report: result.report, recalled: true, prospectSources: this.agent.sourceUrls(), companyWebsite: work.website }).reason !== "prospect_sources_missing") break;
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

    const prospectSources = isProspect ? this.agent.sourceUrls() : undefined;
    const finalVerdict = companyWorkComplete({ report: written.report, recalled: this.agent.trace().some((item: { step: string }) => item.step === "hivemind_recall"), prospectSources, companyWebsite: work.website });
    if (!finalVerdict.complete) {
      const reason = finalVerdict.reason;
      const reply = reason === "prospect_sources_missing" ? "I could not verify the prospect list against external sources. I have not saved it. Please retry the research." : `I could not complete this work: ${reason}.`;
      await durable.do("incomplete", async () => { await this.agent.note("report", reply); await this.agent.note("completion", reason); });
      return { runId: work.runId, orgId: work.orgId, complete: false, reason, report: reply };
    }

    const prepared = await durable.do("complete", async () => {
      const recalled = (await this.agent.trace()).some((item: { step: string }) => item.step === "hivemind_recall");
      const verdict = companyWorkComplete({ report: written.report, recalled, prospectSources, companyWebsite: work.website });
      await this.agent.saveCompanyArtifact({
        kind: "report",
        title: asked.slice(0, 80) || "Report",
        contentType: "text/markdown",
        body: written.report,
      });
      await this.agent.note("report", written.report.slice(0, 8000));
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
