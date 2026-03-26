/**
 * User Profile
 *
 * Maintains a lightweight static profile of user facts.
 * Injected into every prompt in ~50ms without search.
 * Built from high-priority observations.
 */

export class UserProfile {
  constructor(store) {
    this.store = store;
    this._cache = new Map(); // userId → { profile, lastUpdated }
    this._ttl = 5 * 60 * 1000; // 5 min cache
  }

  /**
   * Get or build user profile.
   * @param {string} userId
   * @param {string} orgId
   * @returns {Promise<{profile: string, facts: object}>}
   */
  async getProfile(userId, orgId) {
    const cacheKey = `${userId}:${orgId}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.lastUpdated < this._ttl) {
      return cached;
    }

    const profile = await this._buildProfile(userId, orgId);
    this._cache.set(cacheKey, { ...profile, lastUpdated: Date.now() });
    return profile;
  }

  async _buildProfile(userId, orgId) {
    const allMemories = await this.store.listLatestMemories({ user_id: userId, org_id: orgId });

    // Find high-priority observations
    const observations = allMemories
      .filter(m => (m.tags || []).includes('observation'))
      .map(m => m.content || '')
      .filter(c => c.includes('🔴')); // Only high-priority facts

    // Also scan for explicit user facts from non-observation memories
    const userFacts = allMemories
      .filter(m => m.memory_type === 'preference' || m.memory_type === 'fact')
      .filter(m => /\b(my|I)\s+(name|job|work|live|born|degree|salary|phone|email|address)\b/i.test(m.content || ''))
      .map(m => m.content || '')
      .slice(0, 10);

    const facts = {
      observationCount: observations.length,
      factCount: userFacts.length,
    };

    if (observations.length === 0 && userFacts.length === 0) {
      return { profile: '', facts };
    }

    const profileLines = [
      ...observations.slice(0, 10),
      ...userFacts.slice(0, 5).map(f => f.slice(0, 200)),
    ];

    const profile = `<user-profile>\n${profileLines.join('\n')}\n</user-profile>`;
    return { profile, facts };
  }

  invalidate(userId, orgId) {
    this._cache.delete(`${userId}:${orgId}`);
  }
}
