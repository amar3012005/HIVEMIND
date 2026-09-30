/** Keep the complete fetched page in the WorkRun receipt while returning a
 * small, verbatim view to the model. Later steps can ask for another view of
 * the same receipt without another browser request. */
export function sourceContext(page: string, query = "", maxChars = 3600): string {
  const limit = Math.max(400, Math.min(maxChars, 5000));
  if (page.length <= limit) return page;
  const words = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 18);
  const lower = page.toLocaleLowerCase();
  const positions = new Set<number>();
  for (const word of words) {
    const first = lower.indexOf(word);
    const last = lower.lastIndexOf(word);
    if (first >= 0) positions.add(first);
    if (last >= 0) positions.add(last);
  }
  const windows = [...positions].map((at) => {
    const start = Math.max(0, page.lastIndexOf("\n", Math.max(0, at - 300)) + 1);
    const nextBreak = page.indexOf("\n", at + 300);
    return { start, end: Math.min(page.length, nextBreak < 0 ? at + 600 : Math.min(nextBreak, at + 600)) };
  }).filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  const head = page.slice(0, Math.min(900, Math.floor(limit / 3)));
  const ranked = merged.map(({ start, end }) => ({ start, text: page.slice(start, end) }))
    .filter(({ text }) => text.trim())
    .sort((a, b) => words.filter((word) => b.text.toLocaleLowerCase().includes(word)).length
      - words.filter((word) => a.text.toLocaleLowerCase().includes(word)).length || a.start - b.start);
  const selected: typeof ranked = [];
  let remaining = limit - head.length - 32;
  for (const passage of ranked) {
    if (remaining < 200) break;
    selected.push({ ...passage, text: passage.text.slice(0, remaining) });
    remaining -= passage.text.length + 32;
  }
  const passages = selected.sort((a, b) => a.start - b.start).map(({ text }) => text);
  const result = [head, ...passages].join("\n\n[page section omitted]\n\n");
  if (result.length >= limit) return result.slice(0, limit);
  if (passages.length) return result;
  const tail = page.slice(-Math.min(900, limit - head.length - 30));
  return `${head}\n\n[page section omitted]\n\n${tail}`;
}
