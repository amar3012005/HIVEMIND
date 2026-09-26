import { GLOBAL_PLAYBOOKS } from "./playbook-catalog";

export interface PlaybookSummary {
  id: string;
  name: string;
  description: string;
  scope: "global" | "organization";
  base?: string;
}

const EXTRA_GLOBALS: readonly { id: string; name: string; description: string; version: number; skill: string; body: string }[] = [
  { id: "seo.audit-to-priorities", name: "SEO audit to priorities", description: "Turn a site and its market into a sourced list of search priorities.", version: 1, skill: "seo-audit", body: "Understand the offer and the audience before crawling. Record evidence for each priority. Load skill seo-audit when judging pages." },
  { id: "brand.audit-to-expression", name: "Brand audit to expression", description: "Describe how this company should look and sound from its existing evidence.", version: 1, skill: "brand-expression", body: "Recall the company voice before proposing changes. Load skill brand-expression when writing or reviewing brand language." },
  { id: "fundraising.narrative-to-materials", name: "Fundraising narrative to materials", description: "Prepare a sourced fundraising narrative and the materials it needs.", version: 1, skill: "fundraising-narrative", body: "Separate facts, assumptions, and asks. Load skill fundraising-narrative when drafting the narrative." },
  { id: "product.research-to-brief", name: "Product research to brief", description: "Turn user and market evidence into one product brief.", version: 1, skill: "product-brief", body: "Start from company context and existing feedback. Load skill product-brief when writing the brief." },
  { id: "design.brief-to-artifact", name: "Design brief to artifact", description: "Produce a design artifact from a brief and the company brand.", version: 1, skill: "design-artifact", body: "Load the brand playbook notes before generating. Load skill design-artifact when specifying the artifact." },
  { id: "legal.question-to-memo", name: "Legal question to memo", description: "Prepare a sourced memo. Do not file, sign, or send.", version: 1, skill: "legal-memo", body: "Name the jurisdiction and separate law from judgment. Load skill legal-memo when writing the memo. Approval is required before any external commitment." },
  { id: "finance.review-to-brief", name: "Finance review to brief", description: "Explain the numbers the company already has and what is missing.", version: 1, skill: "finance-brief", body: "Separate figures, assumptions, and recommendations. Load skill finance-brief when writing the brief." },
  { id: "social.draft-to-approval", name: "Social draft to approval", description: "Research, draft, and stop for approval before anything is published.", version: 1, skill: "social-draft", body: "Draft from company evidence. Publishing is a separate approved action. Load skill social-draft while writing the post." },
  { id: "engineering.change-to-verification", name: "Engineering change to verification", description: "Investigate, change, and verify with a test. Use the computer only when the browser cannot do it.", version: 1, skill: "engineering-change", body: "State the change and the check that proves it. Load skill engineering-change while planning the change. Open computer only for a screen the browser cannot read." },
  { id: "customer-success.ticket-to-report", name: "Ticket to report", description: "Turn support evidence into a sourced status report. Do not reply to the customer unless the task says so.", version: 1, skill: "customer-report", body: "Recall the account and the open issue. Separate what the customer said from what the company knows. Load skill customer-report while writing." },
  { id: "strategy.evidence-to-scenarios", name: "Evidence to scenarios", description: "Turn company evidence into a small set of sourced scenarios and a recommendation.", version: 1, skill: "strategy-scenarios", body: "Name the decision. Recall the company position. Write two or three scenarios and one recommendation. Load skill strategy-scenarios while writing." },
];

function allGlobals(): { id: string; name: string; description: string; version: number; body: string }[] {
  return [
    ...GLOBAL_PLAYBOOKS.map((item) => ({ id: item.id, name: item.name, description: item.description, version: item.version, body: item.body })),
    ...EXTRA_GLOBALS.map((item) => ({ id: item.id, name: item.name, description: item.description, version: item.version, body: `${item.body}\nLoad skill ${item.skill} only when this playbook reaches the step that needs it.` })),
  ];
}

export function globalCatalog(): PlaybookSummary[] {
  return allGlobals().map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    scope: "global" as const,
  }));
}

export interface LocalPlaybook {
  id: string;
  globalId: string;
  name: string;
  description: string;
  body: string;
}

export const LOCAL_PLAYBOOKS: readonly LocalPlaybook[] = [
  { id: "local:research.competitor-market", globalId: "research.evidence-to-decision", name: "Local market and competitor report", description: "Name the offer and city, find local companies, and judge who sells the same offer.", body: "Finish the task in this order. Recall the offer and city. Search Maps with that offer and that city. Save 5 to 10 companies with websites. Read only those sites. A company is a competitor only when its page shows the same offer.\nSkills to load only at that step: hivemind-meta while recalling, report-render while writing the final report.\nTools to open only at that step: company, then web_research, then browser, then records." },
  { id: "local:research.evidence-decision", globalId: "research.evidence-to-decision", name: "Evidence to one decision", description: "Answer one company question with sources and an explicit decision.", body: "State the decision. Recall company context. Gather primary sources. Separate facts, assumptions, and gaps. Load skill source-verification before the decision." },
  { id: "local:marketing.growth-brief", globalId: "marketing.strategy-to-growth-brief", name: "Strategy to growth brief", description: "Turn company evidence into one growth brief and the first actions.", body: "Recall the offer, the buyer, and the city. Choose one growth constraint. Write the brief and the first actions. Load skill growth-brief when writing." },
  { id: "local:marketing.positioning", globalId: "marketing.strategy-to-growth-brief", name: "Positioning check", description: "Say how this company is different from the closest alternatives.", body: "Recall the current positioning. Compare it with the closest sourced alternatives. Load skill positioning when writing the difference." },
  { id: "local:campaign.awareness-plan", globalId: "campaign.awareness-to-learning", name: "Awareness campaign plan", description: "Plan one campaign from the audience to what the company should learn.", body: "Name the audience, the channel, and the learning goal. Do not launch. Load skill campaign-plan when writing the plan." },
  { id: "local:outreach.prospect-list", globalId: "outreach.prospect-to-conversation", name: "Prospect list", description: "Find and qualify accounts that match this company's ICP.", body: "Recall the offer and ICP before searching. Search for buyer accounts in the requested city, not only this company's name. Load skill prospect-qualification while qualifying. Inspect each accepted account's page or a search result that supports its location and ICP fit. Keep that source URL beside every accepted account. Reject unsupported candidates.\nSkills: hivemind-meta while recalling, prospect-qualification while qualifying, report-render while writing.\nTools: company, then web_research, then browser when a result needs checking." },
  { id: "local:outreach.one-message", globalId: "outreach.direct-message", name: "One direct message", description: "Draft one message to a named recipient. Do not send it.", body: "Draft one message to the named recipient. Use only verified facts. Stop before send.\nSkills to load only at that step: hivemind-meta while checking the recipient, outreach-email while drafting.\nTools to open only at that step: company, then connected_apps if a mailbox is required." },
  { id: "local:seo.site-priorities", globalId: "seo.audit-to-priorities", name: "Site priorities", description: "List the search priorities for this site and market.", body: "Read the company site first. Record a source for each priority. Load skill seo-audit while judging pages." },
  { id: "local:brand.voice-check", globalId: "brand.audit-to-expression", name: "Voice check", description: "Describe the company voice from existing evidence.", body: "Recall current brand language before proposing changes. Load skill brand-expression when writing." },
  { id: "local:fundraising.narrative", globalId: "fundraising.narrative-to-materials", name: "Fundraising narrative", description: "Draft the narrative from sourced company facts.", body: "Separate facts, assumptions, and the ask. Load skill fundraising-narrative when drafting." },
  { id: "local:product.one-brief", globalId: "product.research-to-brief", name: "Product brief", description: "Write one product brief from company and market evidence.", body: "Start from existing feedback in memory. Load skill product-brief when writing." },
  { id: "local:design.one-artifact", globalId: "design.brief-to-artifact", name: "One design artifact", description: "Specify one design artifact from the brief and the brand.", body: "Read the brand notes before generating. Load skill design-artifact when specifying the artifact." },
  { id: "local:legal.memo", globalId: "legal.question-to-memo", name: "Legal memo", description: "Prepare a sourced memo. Do not file or send.", body: "Name the jurisdiction. Approval is required before any commitment. Load skill legal-memo when writing." },
  { id: "local:finance.brief", globalId: "finance.review-to-brief", name: "Finance brief", description: "Explain the figures the company has and what is missing.", body: "Separate figures, assumptions, and recommendations. Load skill finance-brief when writing." },
  { id: "local:operations.admin-decision", globalId: "operations.admin-call-to-decision", name: "Admin decision record", description: "Record one administrator decision. Do not change the system.", body: "State the decision, the owner, and the evidence. Load skill admin-decision when recording." },
  { id: "local:operations.browser-status", globalId: "operations.browser-admin-checkin-to-status", name: "Browser status check-in", description: "Read the current company status from the product and record it.", body: "Open only the company status surface. Record what is visible. Do not change settings. Load skill status-checkin while recording." },
  { id: "local:social.one-post", globalId: "social.draft-to-approval", name: "One social draft", description: "Draft one post for this company. Do not publish it.", body: "Recall the offer and the audience. Draft one post. Stop before publish.\nSkills: hivemind-meta while recalling, social-draft while writing.\nTools: company, then web_research if a source is required." },
  { id: "local:engineering.one-change", globalId: "engineering.change-to-verification", name: "One verified change", description: "Plan one change and the test that proves it.", body: "State the change, the test, and what must not break. Do not use the computer unless the browser cannot see the surface.\nSkills: engineering-change while planning.\nTools: company, then browser, then computer only if the playbook step says the browser failed." },
  { id: "local:customer-success.account-report", globalId: "customer-success.ticket-to-report", name: "Account status report", description: "Write a sourced status report for one account.", body: "Recall the account and the open issue. Separate the customer's words from company facts.\nSkills: hivemind-meta while recalling, customer-report while writing, report-render while finishing.\nTools: company, then records." },
  { id: "local:strategy.scenarios", globalId: "strategy.evidence-to-scenarios", name: "Scenarios and one recommendation", description: "Write a few sourced scenarios and one recommendation.", body: "Name the decision. Recall the company position. Write two or three scenarios and one recommendation.\nSkills: hivemind-meta while recalling, strategy-scenarios while writing, report-render while finishing.\nTools: company, then web_research." },
];

export function localCatalog(globalIds: readonly string[]): PlaybookSummary[] {
  const allowed = new Set(globalIds);
  return LOCAL_PLAYBOOKS.filter((item) => allowed.has(item.globalId)).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    scope: "organization" as const,
    base: item.globalId,
  }));
}

export function localPlaybook(id: string): LocalPlaybook | null {
  return LOCAL_PLAYBOOKS.find((item) => item.id === id) ?? null;
}

export function globalPlaybookBody(id: string): { version: number; body: string } | null {
  const found = allGlobals().find((item) => item.id === id);
  if (!found) return null;
  return { version: found.version, body: found.body };
}
