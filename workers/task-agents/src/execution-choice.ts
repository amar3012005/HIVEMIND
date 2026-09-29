/** An agent may choose between already-authorized read tools without operator input. */
export function isNonblockingExecutionChoice(question: string, options: readonly string[]): boolean {
  const choice = `${question} ${options.join(" ")}`;
  if (/\b(?:approval|permission|consent|recipient|send|publish|post|contact|delete|purchase|pay|memory write|save memory)\b/i.test(choice)) return false;
  // An optionless "which/what/how" method question gives the operator no
  // actionable choice. Resolve authorized read methods inside the harness.
  if (!options.length && (!question.trim() || /^\s*(?:which|what|how|should i)\b/i.test(question))) return true;
  return /\b(?:browser_(?:markdown|extract|links|scrape)|which (?:read|browser|research|fetch) tool|which (?:fetch|browser|research) method|fall back to (?:browser|another read tool)|fetch the pages using|(?:should I|do you want me to|would you like me to) (?:continue|proceed|retry|try|use|fetch|search|read|draft|prepare)\b)/i.test(choice);
}

export const READ_TOOL_FALLBACK = "The operator already authorized this task. Choose routine read-only tools and methods yourself; continue the requested research or draft without asking whether to proceed. Use browser_markdown with the exact public HTTPS URL first for quotable page text; if it fails or omits the needed passage, try browser_extract with its required URL parameter or another authorized read path. Keep source receipts and state a concrete evidence gap only if those paths fail. ";
