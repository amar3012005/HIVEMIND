/**
 * Persistent User Profile Store
 * Manages durable user context facts separate from episodic memory.
 */

const PROFILE_PATTERNS = [
  { key: 'name', patterns: [/my name is ([\w]+(?:\s[\w]+)?)(?:\s+and\b|\.|,|$)/i, /call me ([\w]+)/i] },
  { key: 'company', patterns: [/i work (?:at|for) ([\w\s&.]{2,30}?)(?:\.|,|\s+as|\s+and|\s+I|$)/i, /my company is ([\w\s&.]{2,30}?)(?:\.|,|$)/i] },
  { key: 'role', patterns: [/(?:as (?:a|an|the) |my (?:role|job|title) is )([\w\s]{2,30}?)(?:\.|,|\s+at|\s+for|\s+and|$)/i] },
  { key: 'location', patterns: [/i (?:live|am based|reside) in ([\w\s,]{2,30}?)(?:\.|,|\s+and|\s+my|$)/i, /i'?m from ([\w\s,]{2,30}?)(?:\.|,|$)/i] },
  { key: 'language', patterns: [/i (?:speak|prefer|use) (\w+) (?:language|as)/i] },
  { key: 'timezone', patterns: [/my timezone is ([\w/+\-]{2,15})/i, /i'?m in ([\w/+\-]{2,15}) (?:time|timezone)/i] },
];

const PREFERENCE_PATTERNS = [
  { key: null, patterns: [/i (?:prefer|like|love|enjoy|always use|favor) ([\w\s]{3,40}?)(?:\.|,|\s+and|\s+but|\s+for|$)/i, /my (?:favorite|preferred|go-to) (\w+) is ([\w\s]{3,30}?)(?:\.|,|$)/i] },
];

// A chat save may state an authenticated person's fact in third person
// ("Amar Sai lives in India"). That is still a user-profile fact when — and
// only when — the saved subject resolves to the caller's already-maintained
// name. This deliberately does not promote facts about other people into the
// caller profile.
const SELF_REFERENCED_PROFILE_PATTERNS = [
  { key: 'location', patterns: [
    /^\s*(.+?)\s+(?:lives|is based|resides)\s+in\s+([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+is\s+from\s+([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+(?:lebt|wohnt)\s+in\s+([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+(?:vive|habite)\s+(?:à|en)\s+([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+vive\s+en\s+([^.!?]{2,100})[.!?]?\s*$/i,
  ] },
  { key: 'company', patterns: [
    /^\s*(.+?)\s+works\s+(?:at|for)\s+([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+arbeitet\s+(?:bei|für)\s+([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+travaille\s+(?:chez|pour)\s+([^.!?]{2,100})[.!?]?\s*$/i,
  ] },
  { key: 'role', patterns: [
    /^\s*(.+?)\s+works\s+as\s+(?:an?\s+|the\s+)?([^.!?]{2,100})[.!?]?\s*$/i,
    /^\s*(.+?)\s+ist\s+(?:ein(?:e)?\s+)?([^.!?]{2,100})[.!?]?\s*$/i,
  ] },
];

function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isKnownSelfAlias(subject, profileFacts) {
  const normalizedSubject = normalizeIdentity(subject);
  // A one-word match is too ambiguous for a durable identity write. A caller
  // can still use the explicit update-profile route for it.
  if (normalizedSubject.split(' ').filter(Boolean).length < 2) return false;
  const aliases = (profileFacts || [])
    .filter((fact) => fact?.key === 'name' && fact?.value)
    .map((fact) => normalizeIdentity(fact.value))
    .filter(Boolean);
  return aliases.some((alias) => (
    normalizedSubject === alias
    || alias.startsWith(`${normalizedSubject} `)
    || normalizedSubject.startsWith(`${alias} `)
  ));
}

// Process-wide singleton so every caller (server.js /api/profiles, the chat
// get_user_profile tool, onboarding company-fact writes) SHARES one 60s cache.
// Constructing throwaway instances means a write on one never invalidates
// another's cache → up-to-60s stale reads. Callers outside server.js's own
// singleton should use this accessor. Keyed by nothing — the prisma client is
// the same process-wide singleton (getPrismaClient).
let _sharedProfileStore = null;
export function getSharedProfileStore(prisma) {
  if (!_sharedProfileStore && prisma) _sharedProfileStore = new ProfileStore(prisma);
  return _sharedProfileStore;
}

export class ProfileStore {
  constructor(prisma) {
    this.prisma = prisma;
    this._cache = new Map(); // userId -> { facts, ts }
    this._cacheTTL = 60_000; // 1 minute
  }

  invalidateOrg(orgId) {
    const marker = `:${orgId || ''}:`;
    for (const key of this._cache.keys()) {
      if (key.includes(marker)) this._cache.delete(key);
    }
  }

  /**
   * Get all profile facts for a user, with caching.
   */
  async getProfile(userId, orgId = null, projectId = null) {
    const cacheKey = `${userId}:${orgId || ''}:${projectId || ''}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._cacheTTL) {
      return cached.facts;
    }

    const where = { userId, deletedAt: null };
    if (orgId) where.orgId = orgId;
    // M7: project-scoped read — org-level identity facts (project_id NULL) PLUS
    // this project's facts; never another project's. projectId omitted = all facts
    // (backward-compatible; the org-wide view is unchanged).
    if (projectId) where.OR = [{ projectId: null }, { projectId }];

    const rows = await this.prisma.userProfile.findMany({ where, orderBy: { lastConfirmedAt: 'desc' } });
    const facts = rows.map(r => ({
      id: r.id,
      category: r.category,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      confirmedCount: r.confirmedCount,
      lastConfirmedAt: r.lastConfirmedAt,
      // WS5: dreamer provenance — used to render-gate ungrounded dreamed facts.
      lastDreamedAt: r.lastDreamedAt,
      evidenceMemoryIds: r.evidenceMemoryIds || [],
    }));
    this._cache.set(cacheKey, { facts, ts: Date.now() });
    return facts;
  }

  /**
   * Upsert a profile fact (insert or update if same key exists).
   * Detects value changes and contradictions, returning version metadata.
   */
  async upsertFact({ userId, orgId, category, key, value, confidence, sourceMemoryId, projectId = null }) {
    const normalizedKey = key.toLowerCase().trim();

    // WS5 step-2: serialize the read-modify-write PER USER. Profile writes race —
    // ingest fires extractAndStore fire-and-forget on every save, and the dream
    // pass (later) + manual triggers can hit the same (userId,key) concurrently.
    // Two interleaved upserts both read the same `existing`, both decide
    // "reset confirmedCount=1", and clobber each other. A transaction-scoped
    // advisory lock (auto-released on commit, same connection — mirrors
    // prisma-graph-store.advisoryLock) makes read→decide→upsert atomic per user.
    // Logic is otherwise byte-identical to before (no behavior change).
    const { result, isUpdate, isContradiction, previousValue } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', `profile:${orgId}:${userId}`);

      const existing = await tx.userProfile.findUnique({
        where: { userId_orgId_key: { userId, orgId: orgId || null, key: normalizedKey } },
      });

      const _isUpdate = existing && existing.value !== value && existing.deletedAt === null;
      const _isContradiction = _isUpdate && this._isContradiction(existing.value, value);

      const _result = await tx.userProfile.upsert({
        where: { userId_orgId_key: { userId, orgId: orgId || null, key: normalizedKey } },
        update: {
          value,
          category: category || existing?.category || 'static',
          confidence: confidence || 1.0,
          sourceMemoryId: sourceMemoryId || null,
          confirmedCount: _isUpdate ? 1 : { increment: 1 }, // reset count on value change
          lastConfirmedAt: new Date(),
          deletedAt: null, // un-delete if previously deleted
          // M7: refresh provenance only when the caller supplies one (don't wipe a
          // known project on a generic re-confirm).
          ...(projectId !== null ? { projectId } : {}),
        },
        create: {
          userId,
          orgId: orgId || null,
          category: category || 'static',
          key: normalizedKey,
          value,
          confidence: confidence || 1.0,
          sourceMemoryId: sourceMemoryId || null,
          projectId: projectId || null,
        },
      });
      return {
        result: _result,
        isUpdate: !!_isUpdate,
        isContradiction: !!_isContradiction,
        previousValue: _isUpdate ? existing.value : null,
      };
    }, { timeout: Number(process.env.PROFILE_TXN_TIMEOUT_MS || 15000), maxWait: 8000 });

    // Invalidate cache — keys are now `${userId}:${orgId}:${projectId}`, so clear
    // every cached projection for this user (prefix match).
    for (const k of this._cache.keys()) {
      if (k.startsWith(`${userId}:`)) this._cache.delete(k);
    }
    return {
      ...result,
      _previousValue: previousValue,
      _wasUpdate: isUpdate,
      _wasContradiction: isContradiction,
    };
  }

  /**
   * Detect whether two values for the same key represent a contradiction.
   * Uses word-overlap heuristic: < 30% overlap = likely contradiction.
   */
  _isContradiction(oldValue, newValue) {
    if (!oldValue || !newValue) return false;
    const old = oldValue.toLowerCase();
    const nw = newValue.toLowerCase();
    if (old === nw) return false;
    const oldWords = new Set(old.split(/\s+/).filter(w => w.length > 1));
    const newWords = new Set(nw.split(/\s+/).filter(w => w.length > 1));
    if (!oldWords.size || !newWords.size) return true;
    const overlap = [...oldWords].filter(w => newWords.has(w)).length;
    const maxLen = Math.max(oldWords.size, newWords.size);
    return overlap / maxLen < 0.3;
  }

  /**
   * Get version history for a fact by querying audit logs.
   * Returns previous values from profile.upsert audit events.
   */
  async getFactHistory(userId, key) {
    const normalizedKey = key.toLowerCase().trim();
    try {
      const events = await this.prisma.auditLog.findMany({
        where: {
          userId,
          eventType: 'profile.upsert',
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      // Filter to matching key and extract values
      return events
        .filter(e => {
          try {
            const nv = typeof e.newValue === 'string' ? JSON.parse(e.newValue) : e.newValue;
            return nv && nv.key && nv.key.toLowerCase().trim() === normalizedKey;
          } catch { return false; }
        })
        .map(e => {
          const nv = typeof e.newValue === 'string' ? JSON.parse(e.newValue) : e.newValue;
          return {
            value: nv.value,
            category: nv.category,
            timestamp: e.createdAt,
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Soft-delete a profile fact.
   */
  async deleteFact(factId, userId) {
    await this.prisma.userProfile.updateMany({
      where: { id: factId, userId },
      data: { deletedAt: new Date() },
    });
    // Invalidate all caches for this user
    for (const [k] of this._cache) {
      if (k.startsWith(userId)) this._cache.delete(k);
    }
  }

  /**
   * Auto-extract profile facts from memory content.
   * Called automatically during memory ingestion.
   */
  async extractAndStore(content, { userId, orgId, memoryId }) {
    const extracted = [];
    const text = typeof content === 'string' ? content : '';
    if (!text || text.length < 5) return extracted;

    // Only extract from user-side content (not assistant responses)
    // Split by role markers if present
    const userParts = text.split(/\bassistant:/i)[0] || text;

    for (const { key, patterns } of PROFILE_PATTERNS) {
      for (const pattern of patterns) {
        const match = userParts.match(pattern);
        if (match && match[1]) {
          const value = match[1].trim().replace(/[.,!?]+$/, '');
          if (value.length >= 2 && value.length <= 100) {
            await this.upsertFact({ userId, orgId, category: 'static', key, value, confidence: 0.8, sourceMemoryId: memoryId });
            extracted.push({ key, value });
            break; // first match per key
          }
        }
      }
    }

    // A caller may refer to themselves by their maintained name rather than
    // first person. Resolve that name before extracting; never infer identity
    // from the saved statement alone, otherwise a fact about any third party
    // could contaminate the authenticated user's profile.
    const existingFacts = await this.getProfile(userId, orgId);
    for (const { key, patterns } of SELF_REFERENCED_PROFILE_PATTERNS) {
      if (extracted.some((fact) => fact.key === key)) continue;
      for (const pattern of patterns) {
        const match = userParts.match(pattern);
        if (!match || !isKnownSelfAlias(match[1], existingFacts)) continue;
        const value = String(match[2] || '').trim().replace(/[.,!?]+$/, '');
        if (value.length >= 2 && value.length <= 100) {
          await this.upsertFact({
            userId,
            orgId,
            category: 'static',
            key,
            value,
            confidence: 0.9,
            sourceMemoryId: memoryId,
          });
          extracted.push({ key, value, source: 'self_referenced_memory' });
          break;
        }
      }
    }

    // Extract preferences
    for (const { patterns } of PREFERENCE_PATTERNS) {
      for (const pattern of patterns) {
        const match = userParts.match(pattern);
        if (match) {
          const value = (match[2] || match[1] || '').trim().replace(/[.,!?]+$/, '');
          if (value.length >= 3 && value.length <= 100) {
            // Use content hash as key to avoid duplicates
            const prefKey = `preference:${value.slice(0, 30).toLowerCase().replace(/\s+/g, '_')}`;
            await this.upsertFact({ userId, orgId, category: 'preference', key: prefKey, value, confidence: 0.7, sourceMemoryId: memoryId });
            extracted.push({ key: prefKey, value });
            break;
          }
        }
      }
    }

    return extracted;
  }

  /**
   * Build a context string for injection into LLM prompts / recall results.
   */
  async buildProfileContext(userId, orgId = null, projectId = null) {
    const allFacts = await this.getProfile(userId, orgId, projectId);
    if (!allFacts.length) return '';

    // WS5 render-gate: a DREAMED fact (lastDreamedAt set) with NO evidence lineage
    // is ungrounded → must NOT render (anti-hallucination). User-entered / regex
    // facts (lastDreamedAt null) are unaffected.
    const facts = allFacts.filter(f => !f.lastDreamedAt || (Array.isArray(f.evidenceMemoryIds) && f.evidenceMemoryIds.length > 0));

    const staticFacts = facts.filter(f => f.category === 'static' && f.confidence >= 0.5);
    const preferences = facts.filter(f => f.category === 'preference' && f.confidence >= 0.5);
    const goals = facts.filter(f => f.category === 'goal');
    const dynamic = facts.filter(f => f.category === 'dynamic');

    const lines = [];
    if (staticFacts.length) {
      lines.push('User Profile:');
      for (const f of staticFacts) {
        const conf = f.confirmedCount > 1 ? ` (confirmed ${f.confirmedCount}x)` : '';
        lines.push(`  ${f.key}: ${f.value}${conf}`);
      }
    }
    if (preferences.length) {
      lines.push('Preferences:');
      for (const f of preferences) {
        const conf = f.confirmedCount > 1 ? ` (confirmed ${f.confirmedCount}x)` : '';
        lines.push(`  - ${f.value}${conf}`);
      }
    }
    if (goals.length) {
      lines.push('Current Goals:');
      for (const f of goals) lines.push(`  - ${f.value}`);
    }
    if (dynamic.length) {
      lines.push('Dynamic Context:');
      for (const f of dynamic) lines.push(`  - ${f.value}`);
    }
    return lines.join('\n');
  }

  /**
   * A bounded persona packet for chat routing and answer synthesis.
   *
   * The full profile remains available to profile-management routes. Chat does
   * not need an ever-growing fact dump on every request: identity and durable
   * preferences are enough to personalize direct/profile answers without
   * crowding out retrieved evidence.
   */
  async buildCompactProfileContext(userId, orgId = null, projectId = null, {
    maxFacts = 8,
    maxChars = 900,
  } = {}) {
    const allFacts = await this.getProfile(userId, orgId, projectId);
    const facts = allFacts.filter((fact) => (
      !fact.lastDreamedAt
      || (Array.isArray(fact.evidenceMemoryIds) && fact.evidenceMemoryIds.length > 0)
    ));
    if (!facts.length) return '';

    const staticPriority = new Map([
      ['name', 0], ['role', 1], ['company', 2], ['location', 3],
      ['timezone', 4], ['language', 5],
    ]);
    const staticFacts = facts
      // `company:*` briefing fields are intentionally excluded here. They can
      // be long, stale and numerous; corpus recall is the right lane for an
      // organization overview. This packet is only the compact caller persona.
      .filter((fact) => fact.category === 'static' && fact.confidence >= 0.5 && staticPriority.has(fact.key))
      .sort((a, b) => {
        const priority = (staticPriority.get(a.key) ?? 50) - (staticPriority.get(b.key) ?? 50);
        if (priority) return priority;
        return new Date(b.lastConfirmedAt || 0) - new Date(a.lastConfirmedAt || 0);
      });
    const otherFacts = facts
      .filter((fact) => ['preference', 'goal', 'dynamic'].includes(fact.category) && fact.confidence >= 0.5)
      .sort((a, b) => new Date(b.lastConfirmedAt || 0) - new Date(a.lastConfirmedAt || 0));

    const seen = new Set();
    const selected = [];
    for (const fact of [...staticFacts, ...otherFacts]) {
      const dedupeKey = `${fact.category}:${fact.key}:${String(fact.value).toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      selected.push(fact);
      if (selected.length >= Math.max(1, maxFacts)) break;
    }
    if (!selected.length) return '';

    const lines = ['Authenticated user profile (authoritative; values describe the caller unless marked organization):'];
    for (const fact of selected) {
      const label = fact.category === 'preference'
        ? 'user preference'
        : fact.key === 'company'
          ? 'organization'
          : fact.key === 'location'
            ? 'user location'
            : fact.key;
      const line = `- ${label}: ${fact.value}`;
      if (`${lines.join('\n')}\n${line}`.length > Math.max(80, maxChars)) break;
      lines.push(line);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }
}
