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
