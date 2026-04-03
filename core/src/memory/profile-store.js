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

export class ProfileStore {
  constructor(prisma) {
    this.prisma = prisma;
    this._cache = new Map(); // userId -> { facts, ts }
    this._cacheTTL = 60_000; // 1 minute
  }

  /**
   * Get all profile facts for a user, with caching.
   */
  async getProfile(userId, orgId = null) {
    const cacheKey = `${userId}:${orgId || ''}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._cacheTTL) {
      return cached.facts;
    }

    const where = { userId, deletedAt: null };
    if (orgId) where.orgId = orgId;

    const rows = await this.prisma.userProfile.findMany({ where, orderBy: { lastConfirmedAt: 'desc' } });
    const facts = rows.map(r => ({
      id: r.id,
      category: r.category,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      confirmedCount: r.confirmedCount,
      lastConfirmedAt: r.lastConfirmedAt,
    }));
    this._cache.set(cacheKey, { facts, ts: Date.now() });
    return facts;
  }

  /**
   * Upsert a profile fact (insert or update if same key exists).
   * Detects value changes and contradictions, returning version metadata.
   */
  async upsertFact({ userId, orgId, category, key, value, confidence, sourceMemoryId }) {
    const normalizedKey = key.toLowerCase().trim();

    // Check for existing fact to detect value change
    const existing = await this.prisma.userProfile.findUnique({
      where: { userId_key: { userId, key: normalizedKey } },
    });

    const isUpdate = existing && existing.value !== value && existing.deletedAt === null;
    const isContradiction = isUpdate && this._isContradiction(existing.value, value);

    const result = await this.prisma.userProfile.upsert({
      where: { userId_key: { userId, key: normalizedKey } },
      update: {
        value,
        category: category || existing?.category || 'static',
        confidence: confidence || 1.0,
        sourceMemoryId: sourceMemoryId || null,
        confirmedCount: isUpdate ? 1 : { increment: 1 }, // reset count on value change
        lastConfirmedAt: new Date(),
        deletedAt: null, // un-delete if previously deleted
      },
      create: {
        userId,
        orgId: orgId || null,
        category: category || 'static',
        key: normalizedKey,
        value,
        confidence: confidence || 1.0,
        sourceMemoryId: sourceMemoryId || null,
      },
    });
    // Invalidate cache
    this._cache.delete(`${userId}:${orgId || ''}`);
    this._cache.delete(`${userId}:`);
    return {
      ...result,
      _previousValue: isUpdate ? existing.value : null,
      _wasUpdate: !!isUpdate,
      _wasContradiction: !!isContradiction,
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
  async buildProfileContext(userId, orgId = null) {
    const facts = await this.getProfile(userId, orgId);
    if (!facts.length) return '';

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
}
