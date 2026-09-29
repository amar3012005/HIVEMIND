/** A browser read needs a URL discovered in this turn or supplied by the task. */
export function browserTargetAllowed(url: string, discovered: ReadonlySet<string>, supplied: readonly string[]): boolean {
  const target = canonicalSourceUrl(url);
  if (!target) return false;
  if ([...discovered].some((candidate) => {
    return canonicalSourceUrl(candidate) === target;
  })) return true;
  return supplied.some((text) => {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      if (canonicalSourceUrl(match[0].replace(/[.,]$/, "")) === target) return true;
    }
    return false;
  });
}

function canonicalSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    // Documentation indexes and slash-terminated routes identify the same
    // page. This does not grant neighboring paths or cross-origin URLs.
    url.pathname = url.pathname.replace(/\/(?:index\.md|index\.html)$/i, "").replace(/\/+$/, "") || "/";
    return url.href;
  } catch { return null; }
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
