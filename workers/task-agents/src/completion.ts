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

export function requestsMemorySave(task: string): boolean {
  if (/\b(do not|don't|never|without|no)\b[^.!?]{0,80}\b(save|store|remember|memorize)\b/i.test(task)) return false;
  return /\b(remember|memorize)\b/i.test(task)
    || /\b(save|store)\b[^.!?]{0,100}\b(memory|hivemind|name|preference|decision|fact|profile)\b/i.test(task);
}

export function requestsArtifact(task: string): boolean {
  return /\b(create|generate|make|save|export|draft|write|give me)\b[^.!?]{0,100}\b(report|document|artifact|pdf)\b/i.test(task)
    && !/\b(do not|don't|never|without|no)\b[^.!?]{0,100}\b(create|generate|make|save|export|draft|write|give me)\b[^.!?]{0,100}\b(report|document|artifact|pdf)\b/i.test(task);
}

export function companyWorkComplete(input: CompletionInput): CompletionResult {
  const report = input.report.trim();
  if (!report) return { complete: false, reason: "report_missing" };
  if (!input.recalled) return { complete: false, reason: "company_context_missing" };
  if (input.prospectSources) {
    const hosts = new Set(input.prospectSources.map(hostname).filter(Boolean));
    const companyHost = hostname(input.companyWebsite || "");
    const cited = [...report.matchAll(/https?:\/\/[^\s<>)\]]+/g)].map((match) => hostname(match[0])).filter((host) => host && host !== companyHost);
    if (!cited.length || cited.some((host) => !hosts.has(host))) return { complete: false, reason: "prospect_sources_missing" };
  }
  return { complete: true, reason: "company_context_used" };
}

function hostname(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
