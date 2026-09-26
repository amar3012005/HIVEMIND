import type { SkillManifest, SkillSource } from "agents/skills";
import { BROWSER_USE_SKILL } from "./skills/browser-use-skill.ts";
import { COMPOSIO_CONNECTED_SKILL } from "./skills/composio-connected-skill.ts";
import { BRAND_EXPRESSION_SKILL, CUSTOMER_REPORT_SKILL, DESIGN_ARTIFACT_SKILL, ENGINEERING_CHANGE_SKILL, FINANCE_BRIEF_SKILL, FUNDRAISING_NARRATIVE_SKILL, LEGAL_MEMO_SKILL, PRODUCT_BRIEF_SKILL, SEO_AUDIT_SKILL, SOCIAL_DRAFT_SKILL, STRATEGY_SCENARIOS_SKILL } from "./skills/field-action-skills.ts";
import { HIVEMIND_META_SKILL } from "./skills/hivemind-meta-skill.ts";
import { OUTREACH_EMAIL_SKILL } from "./skills/outreach-email-skill.ts";
import { PARALLEL_SEARCH_SKILL } from "./skills/parallel-search-skill.ts";
import { PROSPECT_QUALIFICATION_SKILL } from "./skills/prospect-qualification-skill.ts";
import { REPORT_RENDER_SKILL } from "./skills/report-render-skill.ts";

export const TOOLKIT_SKILL_SOURCES = [
  HIVEMIND_META_SKILL,
  REPORT_RENDER_SKILL,
  OUTREACH_EMAIL_SKILL,
  PROSPECT_QUALIFICATION_SKILL,
  SOCIAL_DRAFT_SKILL,
  ENGINEERING_CHANGE_SKILL,
  CUSTOMER_REPORT_SKILL,
  STRATEGY_SCENARIOS_SKILL,
  SEO_AUDIT_SKILL,
  BRAND_EXPRESSION_SKILL,
  FUNDRAISING_NARRATIVE_SKILL,
  PRODUCT_BRIEF_SKILL,
  DESIGN_ARTIFACT_SKILL,
  LEGAL_MEMO_SKILL,
  FINANCE_BRIEF_SKILL,
  COMPOSIO_CONNECTED_SKILL,
  PARALLEL_SEARCH_SKILL,
  BROWSER_USE_SKILL,
] as const;

function readField(frontmatter: string, field: string): string {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function toolkitSkillManifest(): SkillManifest {
  const skills = TOOLKIT_SKILL_SOURCES.map((raw) => {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const name = match ? readField(match[1] ?? "", "name") : "";
    const description = match ? readField(match[1] ?? "", "description") : "";
    const body = match?.[2]?.trim() ?? "";
    if (!name || !description || !body) throw new Error("toolkit_skill_invalid");
    return { name, description, body, rawContent: raw };
  });
  return {
    id: "hivemind-task-toolkits",
    fingerprint: skills.map((skill) => skill.name).join(","),
    skills,
  };
}

export async function toolkitSkillSource(): Promise<SkillSource> {
  const { fromManifest } = await import("agents/skills");
  return fromManifest(toolkitSkillManifest());
}
