/**
 * Per-user assistant identity (name).
 *
 * On the user's first chat, HIVEMIND introduces itself as
 * "<orgName>'s second brain" and asks for a name. The user's reply is
 * extracted and persisted as a memory tagged `assistant-name` for that user.
 * Every subsequent chat reads that memory and addresses itself by the
 * chosen name in the system prompt.
 *
 * Storage: regular memory with tag `assistant-name`, one per user (Smart
 * Ingest UPDATE relationship handles re-naming).
 *
 * Detection of a "name reply":
 *   1. Direct quoted name:  '"Sage"' / "'Sage'"
 *   2. Lead capitalised word: "Sage" / "Call me Sage"
 *   3. Imperative: "Name yourself X", "I'll call you X", "Your name is X"
 *   4. "skip" / "no" / "default" → fall back to default ("HIVE")
 *   5. Short reply ≤ 40 chars with no command words → treat as name
 */

const ASSISTANT_NAME_TAG = 'assistant-name';
const DEFAULT_NAME = 'HIVE';
const MAX_NAME_LEN = 32;

const STOP_WORDS = new Set([
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your',
  'a', 'an', 'the', 'and', 'or', 'but',
  'call', 'name', 'yourself', 'pick', 'use', 'be', 'are', 'is',
  'how', 'what', 'about', 'lets', "let's", 'okay', 'ok', 'sure',
  'yes', 'no', 'maybe',
]);

/**
 * Read the user's chosen assistant name. Returns null if not set yet.
 *
 * @param {object} store        PrismaGraphStore
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.orgId
 * @returns {Promise<{name: string|null, memoryId: string|null}>}
 */
export async function getAssistantName(store, { userId, orgId }) {
  if (!userId) return { name: null, memoryId: null };
  // Direct prisma path — listMemories applies scope filters
  // (scope=personal, primary_team_id checks) that miss assistant-name rows
  // saved via skipProcessing. Identity is per-user, scope-irrelevant.
  const prisma = store?.client || store?.prisma || null;
  if (!prisma) return { name: null, memoryId: null };
  try {
    const row = await prisma.memory.findFirst({
      where: {
        userId,
        ...(orgId ? { orgId } : {}),
        tags: { has: ASSISTANT_NAME_TAG },
        deletedAt: null,
      },
      orderBy: [{ isLatest: 'desc' }, { createdAt: 'desc' }],
      include: { sourceMetadata: true },
    });
    if (!row) return { name: null, memoryId: null };
    const meta = row.sourceMetadata?.metadata || {};
    const name = (meta.assistant_name || extractNameFromContent(row.content) || '').trim();
    return { name: name || null, memoryId: row.id };
  } catch {
    return { name: null, memoryId: null };
  }
}

/**
 * Has the intro prompt already been shown to this user? Persistent
 * sentinel — survives empty-history sessions so we never re-ask once
 * the first turn has been delivered.
 */
const ONBOARDING_SHOWN_TAG = 'assistant-onboarding-shown';
export async function hasShownOnboardingIntro(store, { userId, orgId }) {
  if (!userId) return false;
  const prisma = store?.client || store?.prisma || null;
  if (!prisma) return false;
  try {
    const row = await prisma.memory.findFirst({
      where: {
        userId,
        ...(orgId ? { orgId } : {}),
        tags: { has: ONBOARDING_SHOWN_TAG },
        deletedAt: null,
      },
      select: { id: true },
    });
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Mark the intro as shown — call right after returning the intro
 * response so the next chat turn knows the user is mid-onboarding.
 */
export async function markOnboardingShown(store, { userId, orgId }) {
  if (!userId) return;
  // Self-host orgs: this sentinel writes a central memory row directly (bypassing the agent-routed
  // createMemory). Skip it for remote orgs — keeps central free of their rows (residency) and avoids
  // planting a row that could wake the central cognition scheduler.
  const { orgIsRemote } = await import('../vector/mneme/driver.js');
  if (orgIsRemote(orgId)) return;
  const prisma = store?.client || store?.prisma || null;
  if (!prisma) return;
  try {
    await prisma.memory.create({
      data: {
        id: (await import('crypto')).randomUUID(),
        userId,
        orgId: orgId || null,
        memoryType: 'fact',
        title: 'Assistant onboarding intro shown',
        content: 'The HIVEMIND intro ("Got a name for me?") has been displayed to this user. Used as a one-shot sentinel.',
        tags: [ONBOARDING_SHOWN_TAG, 'assistant-identity', 'system'],
        isLatest: true,
        importanceScore: 0.1,
      },
      select: { id: true },
    });
  } catch {
    // Race: another concurrent turn may have written it. Idempotent skip.
  }
}

/**
 * Build the save_memory payload for setting an assistant name.
 * Caller is responsible for actually POSTing /api/memories so Smart Ingest
 * runs and version-chains override the previous name.
 */
export function buildAssistantNamePayload({ name, userId, orgId, prevMemoryId }) {
  const cleanName = sanitizeName(name) || DEFAULT_NAME;
  return {
    title: `Assistant name: ${cleanName}`,
    content: `User chose to name their HIVEMIND assistant "${cleanName}".`,
    memory_type: 'fact',
    source_platform: 'assistant-identity',
    tags: [ASSISTANT_NAME_TAG, 'voice-profile'],
    visibility: 'private',
    user_id: userId,
    org_id: orgId,
    metadata: {
      source_type: 'assistant-identity',
      assistant_name: cleanName,
    },
    // Force UPDATE relationship if a previous name memory exists, so the
    // version chain replaces the old name cleanly.
    ...(prevMemoryId ? { relationship: { type: 'Updates', target_id: prevMemoryId, confidence: 1.0 } } : {}),
  };
}

/**
 * Extract a plausible name from a free-text user reply.
 * Returns null if nothing matches.
 */
export function extractNameFromReply(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;

  // 1. Quoted name (single or double quotes)
  const quoted = t.match(/['"`“”‘’]([\w\s\-_.]{1,32})['"`“”‘’]/);
  if (quoted) return sanitizeName(quoted[1]);

  // 2. "Call me X", "Name yourself X", "Your name is X", "I'll call you X"
  const imperative = t.match(/(?:call (?:me|you|yourself)|name (?:you|yourself)|your name is|i(?:'|')?ll call you|let's call you|i want to call you)\s+([A-Za-z][\w\s\-_.]{0,31})/i);
  if (imperative) return sanitizeName(imperative[1]);

  // 3. "skip" / "no" / "default" / "you decide" → caller falls back
  if (/^\s*(skip|no thanks|no|nope|default|you decide|your choice|whatever)\s*\.?\s*$/i.test(t)) {
    return null; // signal: fall back to default
  }

  // 4. Lead capitalised word ≤ 32 chars
  const capLead = t.match(/^([A-Z][\w\-_]{1,31})\b/);
  if (capLead) return sanitizeName(capLead[1]);

  // 5. Short single-word reply (≤ 32 chars), no stop words → assume it's a name
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 4 && t.length <= MAX_NAME_LEN) {
    const candidate = words
      .filter(w => !STOP_WORDS.has(w.toLowerCase()))
      .filter(w => /^[A-Za-z]/.test(w))[0];
    if (candidate) return sanitizeName(candidate);
  }

  return null;
}

// Naming INTENT detector — returns a name ONLY when the user explicitly asks to
// (re)name the assistant. Unlike extractNameFromReply (which also grabs bare
// capitalised / short replies as names — wrong when the reply is a real query),
// this fires solely on explicit naming phrases. Use this on the live chat path
// so a normal first question is never mistaken for a name. Works anytime → the
// user can rename the assistant on any turn (dynamic intent, not a one-shot gate).
const NAMING_INTENT_RE = /\b(?:call (?:you|yourself)|name (?:you|yourself)|your name (?:is|should be|will be)|rename (?:you|yourself)|i(?:'|’)?ll call you|let(?:'|’)?s call you|i want to call you|you(?:'|’)?(?:ll| will) be called|be called|go by)\b/i;
export function hasNamingIntent(text) {
  return typeof text === 'string' && NAMING_INTENT_RE.test(text);
}
export function extractNameIfIntent(text) {
  if (!hasNamingIntent(text)) return null;
  const t = text.trim();
  // Prefer a quoted name when present (highest precision).
  const quoted = t.match(/['"`“”‘’]([\w\s\-_.]{1,32})['"`“”‘’]/);
  if (quoted) return sanitizeName(quoted[1]);
  // Otherwise capture the token(s) right after the intent phrase.
  const m = t.match(/(?:call (?:you|yourself)|name (?:you|yourself)|your name (?:is|should be|will be)|rename (?:you|yourself)|i(?:'|’)?ll call you|let(?:'|’)?s call you|i want to call you|you(?:'|’)?(?:ll| will) be called|be called|go by)\s+(?:to|as)?\s*([A-Za-z][\w\-_.]{0,31})/i);
  return m ? sanitizeName(m[1]) : null;
}

function sanitizeName(raw) {
  if (!raw) return null;
  // Strip surrounding punctuation; keep letters / digits / dash / underscore / space.
  const clean = String(raw)
    .replace(/^[\s.,!?:;'"`“”‘’]+|[\s.,!?:;'"`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
  if (!clean) return null;
  // Capitalise first letter for natural look (unless user passed all caps deliberately).
  if (clean === clean.toLowerCase()) {
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return clean;
}

function extractNameFromContent(content) {
  if (!content) return null;
  const m = content.match(/"([^"]{1,32})"/);
  return m ? sanitizeName(m[1]) : null;
}

export const ASSISTANT_IDENTITY = {
  TAG: ASSISTANT_NAME_TAG,
  DEFAULT_NAME,
  MAX_NAME_LEN,
};
