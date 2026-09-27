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
  if (/\b(?:do not|don't|never|without|no)\b[^.!?]{0,80}\b(?:create|generate|make|save|export|render)\b[^.!?]{0,80}\bartifact\b/i.test(task)
    || /\b(?:no|without)\s+(?:an?\s+)?(?:saved\s+)?artifact\b/i.test(task)) return false;
  return (/\b(create|generate|make|save|export|render|draft|write|give me)\b[^.!?]{0,100}\b(report|document|artifact|pdf)\b/i.test(task)
    || requestsSlideDeck(task))
    && !/\b(do not|don't|never|without|no)\b[^.!?]{0,100}\b(create|generate|make|save|export|render|draft|write|give me)\b[^.!?]{0,100}\b(report|document|artifact)\b/i.test(task);
}

export function planRequestsArtifact(task: string, outputKind: string, tasks: readonly string[]): boolean {
  if (/\b(?:do not|don't|never|without|no)\b[^.!?]{0,80}\b(?:artifact|file)\b/i.test(task)) return false;
  return requestsArtifact(task) || outputKind !== "none" || tasks.some((step) =>
    /\b(?:render|save|create|export|attach|generate|produce)\b[^.!?]{0,100}\b(?:pdf|artifact|file|document)\b/i.test(step));
}

export function isArtifactPlanTask(task: string): boolean {
  return /\b(?:render|save|create|export|attach|generate|produce)\b[^.!?]{0,100}\b(?:pdf|artifact|file|document)\b/i.test(task);
}

export function requestsSlideDeck(task: string): boolean {
  return /\b(?:create|craete|generate|make|build|write|draft|finish|complete|render|export|produce|design|give me)\b[^.!?]{0,140}\b(?:pitch\s+deck|picth\s+deck|slide\s+deck|presentation)\b/i.test(task)
    && !/\b(?:do not|don't|never|without|no)\b[^.!?]{0,80}\b(?:pitch\s+deck|slide\s+deck|presentation)\b/i.test(task);
}

export function slideDeckReady(report: string): boolean {
  const slides = [...report.matchAll(/^##\s+Slide\s+(\d+)\s*[—:–-]\s*\S.+$/gim)];
  return slides.length >= 8 && slides.every((match, index) => Number(match[1]) === index + 1)
    && !/\b(?:deck\s+(?:outline|narrative)|pdf\s+(?:will|should)\s+render|room runtime renders)\b/i.test(report);
}

export function requestsPdf(task: string): boolean {
  return /\b(create|generate|make|save|export|render|draft|write|give me)\b[^.!?]{0,100}\bpdf\b/i.test(task)
    && !/\b(do not|don't|never|without|no)\b[^.!?]{0,100}\b(create|generate|make|save|export|render)\b[^.!?]{0,100}\bpdf\b/i.test(task)
    && !/\b(no|without)\s+(?:a\s+)?pdf\b/i.test(task);
}

export function pdfReportReady(report: string): boolean {
  return !/\b(?:pdf|document|file)[^.!?\n]{0,80}\b(?:blocked|unavailable|cannot|could not|not possible|no (?:tool|render|file|artifact)|print.to.pdf)\b|\b(?:no|without)\s+pdf.capable\b|\bprint.to.pdf\b/i.test(report);
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
