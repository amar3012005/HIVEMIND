// The complete page stays in the WorkRun source ledger. Model calls receive a
// bounded view and can request an exact passage from that same receipt.
export function sourcePreview(markdown: string, task: string, maxChars = 6000): string {
  if (markdown.length <= maxChars) return markdown;
  const terms = [...new Set(task.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])]
    .filter((term) => !new Set(["about", "with", "from", "that", "this", "report", "source", "official", "company", "research", "their", "each", "three", "verified", "markdown"]).has(term))
    .slice(0, 24);
  const lines = markdown.split("\n");
  const scored = lines.map((line, index) => ({ index, score: terms.reduce((score, term) => score + (line.toLowerCase().includes(term) ? 1 : 0), 0) }));
  const selected = new Set<number>();
  for (let i = 0; i < Math.min(12, lines.length); i++) selected.add(i);
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) selected.add(i);
  for (const { index } of scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 20)) {
    for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i++) selected.add(i);
  }
  const output: string[] = [];
  let used = 0;
  let previous = -2;
  for (const index of [...selected].sort((a, b) => a - b)) {
    const line = lines[index];
    if (used + line.length + 2 > maxChars - 180) continue;
    if (index > previous + 1) output.push("\n[… source lines omitted; use source_excerpt for exact passages …]\n");
    output.push(line);
    used += line.length + 2;
    previous = index;
  }
  return output.join("\n").slice(0, maxChars);
}

export function sourceExcerpt(markdown: string, query: string, maxChars = 3000): string | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const index = markdown.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  return markdown.slice(start, Math.min(markdown.length, start + maxChars));
}
