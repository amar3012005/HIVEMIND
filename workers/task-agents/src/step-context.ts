import type { ModelMessage } from "ai";

const STOP_WORDS = new Set(["about", "after", "against", "before", "company", "could", "every", "from", "have", "into", "their", "there", "these", "those", "using", "where", "which", "with", "would"]);

/** Keep exact, task-relevant page passages in the model step while the complete
 * page remains in the WorkRun's source-read receipt for later verification. */
export function compactPageForStep(page: string, task: string, limit = 5500): string {
  if (page.length <= limit) return page;
  const terms = [...new Set((task.toLocaleLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? [])
    .filter((term) => !STOP_WORDS.has(term)))].slice(0, 18);
  const lower = page.toLocaleLowerCase();
  const prefixEnd = 1800;
  const suffixStart = page.length - 850;
  const windows: Array<[number, number]> = [];
  for (const term of terms) {
    const first = lower.indexOf(term);
    const last = lower.lastIndexOf(term);
    if (first >= 0) windows.push([Math.max(0, first - 130), Math.min(page.length, first + 290)]);
    if (last > first) windows.push([Math.max(0, last - 130), Math.min(page.length, last + 290)]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of windows) {
    const prior = merged.at(-1);
    if (prior && start <= prior[1]) prior[1] = Math.max(prior[1], end);
    else merged.push([start, end]);
  }
  const separator = "\n\n[page section omitted; complete source saved in WorkRun]\n\n";
  let remaining = limit - prefixEnd - (page.length - suffixStart) - separator.length * 2;
  const excerpts: string[] = [page.slice(0, prefixEnd)];
  for (const [start, end] of merged) {
    if (remaining < 180) break;
    const boundedStart = Math.max(start, prefixEnd);
    const boundedEnd = Math.min(end, suffixStart);
    if (boundedStart >= boundedEnd) continue;
    const excerpt = page.slice(boundedStart, Math.min(boundedEnd, boundedStart + remaining));
    excerpts.push(excerpt);
    remaining -= excerpt.length + separator.length;
  }
  excerpts.push(page.slice(suffixStart));
  return excerpts.join(separator).slice(0, limit);
}

/** AI SDK prepareStep override: preserve tool-call/result IDs and the durable
 * conversation, but stop resending full browser pages on every later model step. */
export function compactStepSourceMessages(messages: ModelMessage[], task: string): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || part.toolName !== "browser_markdown" || part.output.type !== "json") return part;
      const value = part.output.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return part;
      const page = value as Record<string, unknown>;
      if (typeof page.markdown !== "string") return part;
      const markdown = compactPageForStep(page.markdown, task);
      if (markdown === page.markdown) return part;
      changed = true;
      return { ...part, output: { ...part.output, value: { ...page, markdown } } };
    });
    return changed ? { ...message, content } : message;
  });
}
