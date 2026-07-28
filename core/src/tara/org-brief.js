/**
 * Compact org brief for TARA's initial instructions.
 *
 * Every new voice conversation — any tenant, any skill, any language — must open
 * already knowing who it works for. Without this, TARA could only say the org's
 * NAME (the `company` field) and had to guess or recall mid-call what the org
 * actually does, which is how openers ended up generic.
 *
 * Built HERE, in core, at dial/session-mint time rather than inside an adapter:
 *   - it is off the call's critical path (the adapter builds instructions after
 *     the callee answers, so a DB round-trip there delays the first word),
 *   - tara-grok has no route to /api/profiles at all — it only reaches core's
 *     internal events base — so a core-supplied field is the only way both
 *     engines can share one source of truth,
 *   - one implementation means the two providers cannot drift.
 *
 * Deliberately NOT an LLM call: a summarizer here would add a second of latency
 * and a hallucination surface to something that runs on every dial. This is a
 * bounded projection of the org's own highest-signal memories.
 */

const CACHE = new Map(); // `${orgId}:${userId}` → { brief, at }
const TTL_MS = 5 * 60 * 1000;
const MAX_CHARS = 500;

function tidy(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} [opts.userId] the operator TARA is calling on behalf of. Their own
 *        personal-scoped memories are included; nobody else's ever are.
 * @returns {Promise<string>} compact brief, or '' when nothing is known. Never throws —
 *          a missing brief must degrade the opener, never fail the dial.
 */
export async function buildOrgBrief(prisma, orgId, { userId = null, maxChars = MAX_CHARS } = {}) {
  if (!prisma || !orgId) return '';
  const cacheKey = `${orgId}:${userId || '-'}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.brief;

  let brief = '';
  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId }, select: { name: true },
    });
    // Org-visible memories, PLUS the calling operator's own personal-scoped rows.
    // Another user's `personal` memories are their private notes and must never be
    // read out on a call to a third party — hence the userId equality, not a blanket
    // scope. The personal lane matters because in a single-user workspace `personal`
    // is simply the default save scope, not a privacy intent, so excluding it left
    // those orgs with a name and nothing else.
    const visibleScope = userId
      ? [{ scope: { in: ['organization', 'team', 'project'] } }, { scope: 'personal', userId }]
      : [{ scope: { in: ['organization', 'team', 'project'] } }];
    const rows = await prisma.memory.findMany({
      where: {
        orgId,
        OR: visibleScope,
        memoryType: { in: ['fact', 'decision'] },
      },
      orderBy: [{ importanceScore: 'desc' }, { createdAt: 'desc' }],
      take: 12,
      select: { title: true, content: true },
    });

    const bits = [];
    if (org?.name) bits.push(`Organization: ${tidy(org.name)}`);
    const seen = new Set();
    for (const row of rows) {
      // Title when there is one (already a human-written one-liner), else a
      // clipped first sentence of the body.
      const raw = tidy(row.title) || tidy(row.content).split(/(?<=[.!?])\s/)[0];
      const line = raw.slice(0, 120);
      if (!line || seen.has(line.toLowerCase())) continue;
      seen.add(line.toLowerCase());
      bits.push(`- ${line}`);
      if (bits.join('\n').length >= maxChars) break;
    }
    brief = bits.join('\n').slice(0, maxChars);
  } catch (error) {
    console.warn('[tara] org brief unavailable:', error.message);
    brief = '';
  }

  CACHE.set(cacheKey, { brief, at: Date.now() });
  return brief;
}
