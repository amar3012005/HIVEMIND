/**
 * Query → tag inference.
 *
 * "Talk to HIVE" benefits hugely when the recall layer knows that a question
 * about "decisions about auth" should preferentially surface memories tagged
 * `decision`, or that "bug in delete" should preferentially surface
 * `bug` / `fix` tags.
 *
 * This module returns an array of tags to pass as `preferred_tags` to
 * recallPersistedMemories. Soft-boost only — never hard-filter — because the
 * user's intent might be paraphrased and we don't want to hide relevant
 * untagged memories.
 *
 * Pattern: simple deterministic regex inference. No LLM call. Sub-millisecond.
 */

const PATTERNS = [
  // Decisions / choices
  { re: /\b(decision|decide|decided|chose|chosen|picked|select(?:ed)?|why (?:did|do|use|prefer)|why (?:is|are) we|trade-?off|tradeoff)\b/i, tags: ['decision'] },

  // Bugs / fixes / gotchas
  { re: /\b(bug|broken|fix(?:ed)?|error|crash(?:ed)?|fail(?:ed|ing)?|exception|stack trace|gotcha|regression)\b/i, tags: ['bug', 'fix'] },

  // Refactors / renames
  { re: /\b(refactor(?:ed|ing)?|renam(?:ed|ing)|moved|extract(?:ed)?|split|merged|restructur)\b/i, tags: ['refactor'] },

  // Tests / coverage
  { re: /\b(test(?:s|ed)?|coverage|spec(?:s)?|test case|unit test|integration test)\b/i, tags: ['test-coverage'] },

  // Code in general
  { re: /\b(code|function|class|method|implementation|module)\b/i, tags: ['code'] },

  // Documents
  { re: /\b(document|doc|pdf|spec|whitepaper)\b/i, tags: ['document', 'document-summary'] },

  // Meetings / calls
  { re: /\b(meeting|call|standup|sync|1:1|weekly|all-hands)\b/i, tags: ['meeting', 'calendar'] },

  // Email
  { re: /\b(email|inbox|message|mail|sent|received|reply)\b/i, tags: ['email', 'gmail'] },

  // Slack / chat
  { re: /\b(slack|chat|dm|direct message|channel)\b/i, tags: ['slack'] },

  // Tickets / issues
  { re: /\b(ticket|issue|jira|linear|github issue|pr|pull request)\b/i, tags: ['github', 'linear', 'jira'] },

  // Deployment / infra
  { re: /\b(deploy(?:ed|ment)?|release|rollback|incident|outage|downtime)\b/i, tags: ['deploy', 'incident'] },

  // Security
  { re: /\b(security|vulnerability|cve|exploit|leak|breach)\b/i, tags: ['security'] },

  // Performance
  { re: /\b(performance|slow|latency|timeout|optimi[sz]e)\b/i, tags: ['performance'] },

  // Decisions / preferences (personal)
  { re: /\b(prefer|preference|favourite|favorite|i (?:like|love|hate))\b/i, tags: ['preference'] },

  // Customer / sales
  { re: /\b(customer|client|account|deal|opportunity|pipeline)\b/i, tags: ['salesforce', 'crm', 'customer'] },
];

const FILE_PATH_RE = /\b(?:file[:\s]+)?(?:src|core|frontend|backend|tests?|docs?)\/[\w./_\-]+\.\w{1,8}\b/g;
const FN_RE = /\b(?:function|fn|method)[:\s]+([A-Za-z_][\w]+)\b/gi;

/**
 * Infer preferred tags from a free-text user query.
 *
 * @param {string} query
 * @returns {string[]} unique tags
 */
export function inferQueryTags(query) {
  if (!query || typeof query !== 'string') return [];
  const out = new Set();

  for (const { re, tags } of PATTERNS) {
    if (re.test(query)) {
      for (const t of tags) out.add(t);
    }
  }

  // Extract explicit file paths → file:<path> tags
  const fileMatches = query.match(FILE_PATH_RE) || [];
  for (const m of fileMatches) {
    const clean = m.replace(/^file[:\s]+/i, '').trim();
    out.add(`file:${clean}`);
  }

  // Extract explicit function names → fn:<name> tags
  let fnMatch;
  while ((fnMatch = FN_RE.exec(query)) !== null) {
    out.add(`fn:${fnMatch[1]}`);
  }

  return [...out];
}

/**
 * Memory-type bias derived from the query — recall layer uses this to
 * push specific memory_types higher.
 *
 * @returns {string|null} 'decision' | 'fact' | 'event' | null
 */
export function inferMemoryType(query) {
  if (!query) return null;
  if (/\b(decision|decided|chose|picked|why)\b/i.test(query)) return 'decision';
  if (/\b(meeting|call|standup|happened|when did)\b/i.test(query)) return 'event';
  return null;
}
