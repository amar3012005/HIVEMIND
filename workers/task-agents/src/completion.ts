export interface CompletionInput {
  report: string;
  recalled: boolean;
  prospectSources?: string[];
  companyWebsite?: string;
}

export interface CompletionResult {
  complete: boolean;
  reason: string;
}

export function directReplyComplete(report: string): CompletionResult {
  if (report.trim().length < 2) return { complete: false, reason: "reply_missing" };
  return { complete: true, reason: "direct_reply" };
}

export function companyWorkComplete(input: CompletionInput): CompletionResult {
  const report = input.report.trim();
  if (report.length < 40) return { complete: false, reason: "report_missing" };
  if (!input.recalled) return { complete: false, reason: "company_context_missing" };
  if (input.prospectSources) {
    const hosts = new Set(input.prospectSources.map(hostname).filter(Boolean));
    const companyHost = hostname(input.companyWebsite || "");
    const cited = [...report.matchAll(/https?:\/\/[^\s<>)\]]+/g)].map((match) => hostname(match[0])).filter((host) => host && host !== companyHost);
    if (!cited.length || cited.some((host) => !hosts.has(host))) return { complete: false, reason: "prospect_sources_missing" };
  }
  const hasJudgment = /competitor|candidate|gap|offer/i.test(report);
  if (!hasJudgment) return { complete: false, reason: "judgment_missing" };
  return { complete: true, reason: "company_context_used" };
}

function hostname(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
