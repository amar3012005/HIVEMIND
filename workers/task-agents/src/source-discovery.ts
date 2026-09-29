/** A browser read needs a URL discovered in this turn or supplied by the task. */
export function browserTargetAllowed(url: string, discovered: ReadonlySet<string>, supplied: readonly string[]): boolean {
  let target: string;
  try { target = new URL(url).href; } catch { return false; }
  if ([...discovered].some((candidate) => {
    try { return new URL(candidate).href === target; } catch { return false; }
  })) return true;
  return supplied.some((text) => {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      try { if (new URL(match[0].replace(/[.,]$/, "")).href === target) return true; }
      catch { /* Ignore malformed text, not the explicit target. */ }
    }
    return false;
  });
}

/** Same-site links in a fetched page are discovered evidence, not guessed URLs. */
export function linkedPageUrls(pageUrl: string, markdown: string): string[] {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return []; }
  const found = new Set<string>();
  for (const match of markdown.matchAll(/\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)|\bhref=["']([^"']+)["']/gi)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    try {
      const link = new URL(raw, base);
      if (link.protocol !== "https:" || link.origin !== base.origin || link.username || link.password) continue;
      link.hash = "";
      found.add(link.href);
    } catch { /* Ignore malformed page links. */ }
    if (found.size >= 100) break;
  }
  return [...found];
}
