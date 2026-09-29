export interface CompletionInput {
  report: string;
  recalled: boolean;
  prospectSources?: string[];
  companyWebsite?: string;
}

export function previousReport(events: readonly { step: string; detail: string }[]): string | null {
  const currentTurn = events.map((event) => event.step).lastIndexOf("user");
  if (currentTurn < 0) return null;
  const previousUser = events.slice(0, currentTurn).map((event) => event.step).lastIndexOf("user");
  const report = events.slice(previousUser + 1, currentTurn).reverse().find((event) =>
    event.step === "report" && event.detail.length > 100
    && !/^(?:I could not finish|The report artifact is preserved|I need one detail)/i.test(event.detail))?.detail.trim();
  return report || null;
}

/** Export an existing room answer without sending it back through a model. */
export function requestsPreviousReportPdf(task: string): boolean {
  const request = task.trim().replace(/[.!?]+$/, "").trim();
  return request.length <= 180 && !artifactCreationForbidden(request)
    && /^(?:(?:please|now|can you|could you)\s+)*(?:save|render|export|convert|turn|make|give me|download)\s+(?:(?:the|this|that|it|above|previous|prior|last)\s+)*(?:(?:report|document|artifact|answer|response|text|brief)\s+)?(?:as|to|into|in)\s+(?:a\s+)?pdf(?:\s+(?:file|report|artifact))?$/i.test(request);
}

export interface CompletionResult {
  complete: boolean;
  reason: string;
}

export interface ProspectEvidence {
  name: string;
  locationUrl: string;
  sectorUrl: string;
  locationEvidence: string;
  sectorEvidence: string;
  caveat: string;
}

/** Keep the operator's geographic constraint when the planner abbreviates it. */
export function requestedLocationHint(original: string, resolved = ""): string {
  const scope = `${original}\n${resolved}`;
  return scope.match(/\b([\p{L}-]+)-based\b/iu)?.[1]
    ?? scope.match(/\b([\p{L}-]+)\s+(?:insurers?|insurance|banks?|prospects?|companies|addresses?)\b/iu)?.[1]
    ?? scope.match(/\b(?:in|near|around)\s+([\p{L}-]+)/iu)?.[1]
    ?? "";
}

export function requestedProspectCount(task: string): number {
  const match = task.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:(?:qualified|prospective|potential|Berlin|German|regulated|bank|insurance|healthcare)\s+){0,4}(?:prospects?|companies|accounts?|leads?|clients?|organizations?|banks?|insurers?|hospitals?)\b/i);
  if (!match) return 1;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return Math.min(30, words[match[1].toLowerCase()] ?? Number(match[1]));
}

// This is a deliverable validation rule, not a route selector. An operator who
// asks for target accounts with fit and approach needs per-account evidence even
// if the planning model picked a broader research playbook.
export function requestsVerifiedProspectRows(task: string): boolean {
  return /\b(?:prospects?|leads?|target accounts?|candidates?|insurers?|banks?)\b/i.test(task)
    && /\b(?:fit|qualif\w*|approach|ICP)\b/i.test(task)
    && /\b(?:location|headquarters?|HQ|source passages?|source quotes?)\b/i.test(task);
}

export function prospectEvidenceComplete(report: string, prospects: readonly ProspectEvidence[], sourceUrls: readonly string[], minimumCount = 1): CompletionResult {
  if (!prospects.length) return { complete: false, reason: "prospect_rows_missing" };
  if (prospects.length < minimumCount) return { complete: false, reason: "prospect_count_short" };
  const receipts = new Set(sourceUrls.map(sourceKey).filter(Boolean));
  for (const row of prospects) {
    if (!row.name.trim() || !report.toLowerCase().includes(row.name.trim().toLowerCase())) return { complete: false, reason: "prospect_row_not_in_report" };
    if (row.locationEvidence.trim().length < 10 || row.sectorEvidence.trim().length < 10) return { complete: false, reason: "prospect_evidence_quote_missing" };
    for (const url of [row.locationUrl, row.sectorUrl]) {
      const key = sourceKey(url);
      if (!key || !receipts.has(key) || !report.includes(url)) return { complete: false, reason: "prospect_evidence_missing" };
    }
  }
  return { complete: true, reason: "prospect_evidence_verified" };
}

export function prospectQuotesVerified(prospects: readonly ProspectEvidence[], pages: readonly { url: string; excerpt: string }[]): CompletionResult {
  const content = new Map(pages.map((page) => [sourceKey(page.url), canonicalPassage(page.excerpt)]));
  for (const row of prospects) {
    for (const [url, quote] of [[row.locationUrl, row.locationEvidence], [row.sectorUrl, row.sectorEvidence]]) {
      if (!content.get(sourceKey(url))?.includes(canonicalPassage(quote))) return { complete: false, reason: "prospect_source_quote_mismatch" };
    }
  }
  return { complete: true, reason: "prospect_quotes_verified" };
}

/** Bind a prospect's evidence to immutable text from the fetched pages.
 * The model may identify a source and paraphrase it, but only the runtime may
 * place a quotation in a deliverable. A missing supporting passage fails closed.
 */
export function bindProspectSourcePassages(
  report: string,
  prospects: readonly ProspectEvidence[],
  pages: readonly { url: string; excerpt: string }[],
  locationHint = "",
  onFailure?: (reason: string) => void,
): { report: string; prospects: ProspectEvidence[] } | null {
  const byUrl = new Map(pages.map((page) => [sourceKey(page.url), page.excerpt]));
  const bound: ProspectEvidence[] = [];
  let verifiedReport = report;
  for (const row of prospects) {
    const locationPage = byUrl.get(sourceKey(row.locationUrl));
    const sectorPage = byUrl.get(sourceKey(row.sectorUrl));
    if (!locationPage || !sectorPage) {
      onFailure?.(`${row.name}: source page missing`);
      return null;
    }
    const location = selectSourcePassage(locationPage, row.locationEvidence, "location", locationHint, row.name);
    const sector = selectSourcePassage(sectorPage, row.sectorEvidence, "sector", "", row.name);
    if (!location || !sector) {
      onFailure?.(`${row.name}: ${!location ? "location" : "sector"} passage missing from fetched page`);
      return null;
    }
    for (const [draft, verified] of [[row.locationEvidence, location], [row.sectorEvidence, sector]]) {
      if (draft.trim() && draft !== verified) verifiedReport = verifiedReport.replaceAll(draft, verified);
    }
    bound.push({ ...row, locationEvidence: location, sectorEvidence: sector });
  }
  const evidence = bound.map((row) =>
    `### ${row.name}\n\n- Location: “${row.locationEvidence}” ([official source](${row.locationUrl}))\n- Insurance business: “${row.sectorEvidence}” ([official source](${row.sectorUrl}))`).join("\n\n");
  verifiedReport += `\n\n## Verified primary-source passages\n\n${evidence}\n`;
  return { report: verifiedReport, prospects: bound };
}

function selectSourcePassage(page: string, draft: string, kind: "location" | "sector", locationHint = "", companyName = ""): string | null {
  const legalName = kind === "location" ? companyName.match(/\(([^)]+)\)/)?.[1]?.trim() : undefined;
  const legalNames = kind === "location" ? [legalName, companyName.split(/\s*\(/, 1)[0]?.trim()].filter((name): name is string => !!name) : [];
  // A group imprint can contain several subsidiaries at the same address.
  // Look for a short span from the named entity to its own postal address,
  // skipping navigation/metadata mentions of the same name.
  for (const name of legalNames) {
    const lower = page.toLocaleLowerCase();
    let at = lower.indexOf(name.toLocaleLowerCase());
    for (let count = 0; at >= 0 && count < 50; count += 1) {
      const tail = page.slice(at, Math.min(page.length, at + 340));
      const address = tail.match(/\b\d{5}\s+[\p{L}-]+/u);
      const passage = address?.index === undefined ? "" : tail.slice(0, address.index + address[0].length).trim();
      if (passage.length <= 300 && supportsClaim(passage, kind, locationHint)
        && sourceReceiptCoversQuotes(page, [passage])) return passage;
      at = lower.indexOf(name.toLocaleLowerCase(), at + name.length);
    }
  }
  if (sourceReceiptCoversQuotes(page, [draft]) && supportsClaim(draft, kind, locationHint)) return draft.trim();
  const candidates = sourceQuoteCandidates(page, draft, 12);
  const lines = page.split(/\n+|(?<=[.!?])\s+(?=[A-Z\p{Lu}])/u)
    .map((part) => part.trim()).filter((part) => part.length >= 12 && part.length <= 350);
  const needles = kind === "location" ? [locationHint] : ["insurance", "reinsurance", "versicherung", "rückversicherung"];
  const windows = needles.flatMap((needle) => {
    if (!needle) return [];
    const result: string[] = [];
    const lower = page.toLocaleLowerCase();
    let at = lower.indexOf(needle.toLocaleLowerCase());
    for (let count = 0; at >= 0 && count < 120; count += 1) {
      result.push(page.slice(Math.max(0, at - 100), Math.min(page.length, at + needle.length + 100)).trim());
      at = lower.indexOf(needle.toLocaleLowerCase(), at + needle.length);
    }
    return result;
  });
  const brands = canonicalPassage(companyName).split(" ").filter((token) =>
    token.length >= 3 && token !== canonicalPassage(locationHint) && !["gruppe", "group", "insurance", "insurer", "ag", "se"].includes(token));
  const ranked = [...new Set([...candidates, ...lines, ...windows])].sort((a, b) =>
    brandScore(b, brands) - brandScore(a, brands) || a.length - b.length);
  const selected = ranked.find((part) => part.length <= 300
    && supportsClaim(part, kind, locationHint) && sourceReceiptCoversQuotes(page, [part]));
  return selected ?? null;
}

function brandScore(passage: string, brands: readonly string[]): number {
  if (!brands.length) return 0;
  const words = canonicalPassage(passage).split(" ");
  return Math.max(0, ...brands.map((brand) => {
    const at = words.indexOf(brand);
    return at < 0 ? 0 : at <= 2 ? 2 : 1;
  }));
}

function supportsClaim(passage: string, kind: "location" | "sector", locationHint: string): boolean {
  if (kind === "sector") {
    // A brand heading or copyright footer proves the page's identity, not
    // what the company does. Require an activity, license, or business form
    // in the same short passage as the insurance term.
    const text = passage.replace(/<[^>]*>/g, " ").trim();
    if (/^(?:#{1,6}\s*|©\s*\d{4}\s*)/u.test(text)) return false;
    return /\b(?:insur\w*|reinsur\w*|versicher\w*|rückversicher\w*)\b/i.test(text)
      && /\b(?:is|are|as|offers?|provides?|operates?|underwrites?|licensed?|licen[sc]e|business|provider|company|group|industry|market|for|für|ist|sind|bietet|betreibt|unternehmen|gesellschaft|branche|geschäft|experten|expertise|speciali[sz]\w*)\b/i.test(text);
  }
  const hint = canonicalPassage(locationHint);
  if (!hint || !canonicalPassage(passage).split(" ").some((word) => samePlaceSpelling(word, hint))) return false;
  // A city mention alone can be a brand or navigation item. Require a street,
  // postal address, or explicit registered-office statement on that same line.
  return /\b\d{5}\b/.test(passage)
    || /\b(?:headquarters?|headquartered|registered office|registered address|adresse|address|sitz|hauptsitz)\b/i.test(passage);
}

// Official pages may use a localized spelling of the requested city. Keep
// the postal-address/registered-office requirement above, and allow only a
// single-character spelling difference for a substantial city name.
function samePlaceSpelling(found: string, requested: string): boolean {
  if (found === requested) return true;
  if (Math.min(found.length, requested.length) < 7 || Math.abs(found.length - requested.length) > 1) return false;
  let left = 0;
  let right = 0;
  let edits = 0;
  while (left < found.length && right < requested.length) {
    if (found[left] === requested[right]) { left++; right++; continue; }
    if (++edits > 1) return false;
    if (found.length > requested.length) left++;
    else if (requested.length > found.length) right++;
    else { left++; right++; }
  }
  return edits + Number(left < found.length || right < requested.length) <= 1;
}

/** A prior page read is reusable only when it contains every requested quote. */
export function sourceReceiptCoversQuotes(excerpt: string, quotes: readonly string[]): boolean {
  const page = canonicalPassage(excerpt);
  return excerpt.length >= 80 && quotes.length > 0 && quotes.every((quote) =>
    canonicalPassage(quote).length >= 10 && page.includes(canonicalPassage(quote)));
}

/** Give quote repair the relevant parts of a fetched page, including its footer. */
export function sourceExcerptForQuoteRepair(page: string, quotes: readonly string[]): string {
  if (page.length <= 12000) return page;
  const windows: Array<[number, number]> = [[0, 1500], [Math.max(0, page.length - 3500), page.length]];
  const lower = page.toLocaleLowerCase();
  for (const quote of quotes) {
    const tokens = [...new Set(quote.toLocaleLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? [])]
      .sort((a, b) => b.length - a.length).slice(0, 10);
    const candidates: Array<{ at: number; score: number }> = [];
    for (const token of tokens) {
      let at = lower.indexOf(token);
      for (let count = 0; at >= 0 && count < 30; count += 1) {
        const start = Math.max(0, at - 900);
        const end = Math.min(page.length, at + 1600);
        const nearby = lower.slice(start, end);
        candidates.push({ at, score: tokens.filter((word) => nearby.includes(word)).length });
        at = lower.indexOf(token, at + token.length);
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const candidate of candidates.slice(0, 2)) {
      windows.push([Math.max(0, candidate.at - 900), Math.min(page.length, candidate.at + 1600)]);
    }
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of windows) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  const relevant = merged.map(([start, end]) => page.slice(start, end)).join("\n\n[... page section omitted ...]\n\n");
  return relevant.length > 12000
    ? `${relevant.slice(0, 6000)}\n\n[... page section omitted ...]\n\n${relevant.slice(-6000)}`
    : relevant;
}

/** Compact exact page text for evidence-led recovery without sending the full
 * browser result back through another model turn. Include both early and late
 * matches because legal addresses often live in the footer. */
export function sourceEvidenceWindows(page: string, maxChars = 2600): string {
  const windows = [page.slice(0, 250)];
  const lower = page.toLocaleLowerCase();
  const positions = new Set<number>();
  for (const term of ["hannover", "insurance", "reinsurance", "versicherung", "rückversicherung", "digital", "artificial intelligence", " k.i."]) {
    const first = lower.indexOf(term);
    const last = lower.lastIndexOf(term);
    if (first >= 0) positions.add(first);
    if (last >= 0) positions.add(last);
  }
  for (const at of positions) windows.push(page.slice(Math.max(0, at - 160), Math.min(page.length, at + 340)));
  return [...new Set(windows)].join("\n…\n").slice(0, maxChars);
}

/** Exact page passages near a proposed quote, for a bounded model repair. */
export function sourceQuoteCandidates(page: string, quote: string, limit = 4): string[] {
  const wanted = new Set(canonicalPassage(quote).split(" ").filter((word) => word.length >= 4));
  if (!wanted.size) return [];
  const passages = page.split(/\n+|(?<=[.!?])\s+(?=[A-Z\p{Lu}])/u)
    .map((part) => part.trim()).filter((part) => part.length >= 12 && part.length <= 350);
  return passages.map((text) => {
    const found = new Set(canonicalPassage(text).split(" "));
    const overlap = [...wanted].filter((word) => found.has(word)).length;
    return { text, score: overlap / wanted.size, overlap };
  }).filter((item) => item.overlap >= Math.min(2, wanted.size) && item.score >= 0.3)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.text.length - b.text.length)
    .slice(0, limit).map((item) => item.text);
}

function canonicalPassage(text: string): string {
  return text.normalize("NFKD").toLocaleLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sourceKey(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch { return ""; }
}

export function directReplyComplete(report: string): CompletionResult {
  if (report.trim().length < 2) return { complete: false, reason: "reply_missing" };
  return { complete: true, reason: "direct_reply" };
}

export function requestsMemorySave(task: string): boolean {
  if (/\b(do not|don't|never|without|no)\b[^.!?]{0,80}\b(sav(?:e|ing)|stor(?:e|ing)|remember|memorize)\b/i.test(task)) return false;
  return /\b(remember|memorize)\b/i.test(task)
    || /\b(sav(?:e|ing)|stor(?:e|ing))\b[^.!?]{0,100}\b(memory|hivemind|name|preference|decision|fact|profile)\b/i.test(task);
}

export function requestsImageCapture(task: string): boolean {
  if (/\b(?:do not|don't|never|without|no)\b[^.!?]{0,80}\b(?:screenshot|capture|image|visual)\b/i.test(task)) return false;
  return /\b(?:screenshot|screen\s*shot|capture|visual\s+(?:audit|inspection|review)|image\s+of\s+(?:the\s+)?(?:page|site))\b/i.test(task);
}

/** A single explicit screenshot URL is a deterministic artifact operation. */
export function singlePageCaptureUrl(task: string): string | null {
  if (!requestsImageCapture(task) || /\b(?:all|every|multiple)\s+(?:of\s+(?:my|the)\s+)?pages\b/i.test(task)) return null;
  const matches = [...task.matchAll(/https:\/\/[^\s<>"']+/gi)].map(([raw]) => raw.replace(/[.,;!?)]*$/, ""));
  if (matches.length !== 1) return null;
  try {
    const target = new URL(matches[0]);
    return target.protocol === "https:" ? target.href : null;
  } catch { return null; }
}

export function claimsArtifactApprovalPending(report: string): boolean {
  return /\b(?:artifact|report)\b[^.!?\n]{0,100}\b(?:pending|awaiting|requires?)\b[^.!?\n]{0,60}\bapproval\b/i.test(report);
}

export function requestsArtifact(task: string): boolean {
  if (artifactCreationForbidden(task)) return false;
  return (/\b(create|generate|make|save|export|render|draft|write|give me)\b[^.!?]{0,100}\b(report|document|artifact|pdf)\b/i.test(task)
    || requestsSlideDeck(task))
    && !/\b(do not|don't|never|without|no)\b[^.!?]{0,100}\b(create|generate|make|save|export|render|draft|write|give me)\b[^.!?]{0,100}\b(report|document|artifact)\b/i.test(task);
}

export function artifactCreationForbidden(task: string): boolean {
  return /\b(?:do not|don't|never|without|no)\b[^.!?]{0,40}\b(?:create|generate|make|save|export|render)\b[^.!?]{0,80}\b(?:artifact|report|document|file)\b/i.test(task)
    || /\b(?:no|without)\b[^.!?]{0,80}\bartifacts?\b(?!\s+(?:approval|permission)\b)/i.test(task);
}

export function planRequestsArtifact(task: string, outputKind: string, tasks: readonly string[]): boolean {
  if (artifactCreationForbidden(task)) return false;
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

/** A saved company report must be a document, not the last progress utterance
 * from an agent's tool turn. This checks document structure, independent of
 * the task's subject or wording. */
export function reportDocumentReady(report: string): boolean {
  const lines = report.trim().split(/\r?\n/).map((line) => line.trim());
  const title = lines.findIndex((line) => /^#\s+\S/.test(line));
  const sections = lines.filter((line) => /^##\s+\S/.test(line)).length;
  const body = lines.filter((line) => line && !/^#{1,6}\s/.test(line)).join(" ");
  return title === 0 && sections >= 2 && body.length >= 200;
}

/** Keep the complete document when a model prefaces it with conversation. */
export function extractReportDocument(output: string): string | null {
  const heading = /^#\s+\S/m.exec(output);
  if (!heading || heading.index === undefined) return null;
  const document = output.slice(heading.index).trim();
  if (/\<｜DSML｜tool_calls\>/.test(document)) return null;
  return reportDocumentReady(document) ? document : null;
}

export function companyWorkComplete(input: CompletionInput): CompletionResult {
  const report = input.report.trim();
  if (!report) return { complete: false, reason: "report_missing" };
  if (!input.recalled) return { complete: false, reason: "company_context_missing" };
  if (input.prospectSources) {
    const receipts = new Set(input.prospectSources.map(sourceKey).filter(Boolean));
    const companyHost = hostname(input.companyWebsite || "");
    const cited = [...report.matchAll(/https?:\/\/[^\s<>)\]]+/g)].map((match) => match[0]).filter((url) => hostname(url) && hostname(url) !== companyHost);
    if (!cited.length || cited.some((url) => !receipts.has(sourceKey(url)))) return { complete: false, reason: "prospect_sources_missing" };
  }
  return { complete: true, reason: "company_context_used" };
}

function hostname(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
