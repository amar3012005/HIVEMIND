/**
 * Session Manager — Load/Update compact session state by session_id
 *
 * Session state is stored as a HIVEMIND memory:
 *   tags: ['tara-session', `sid:${session_id}`]  (NOT 'tara-turn')
 *   project: `tara/${tenant_id}`
 *
 * In-memory cache ensures rapid turns don't miss each other.
 */

import crypto from 'node:crypto';

const MAX_TURN_HISTORY = 10;

function emptyState(sessionId, tenantId, language) {
  return {
    session_id: sessionId,
    tenant_id: tenantId,
    language: language || 'en',
    turn_count: 0,
    user_profile: {
      name: null,
      preferences: [],
      constraints: [],
    },
    conversation: {
      current_goal: null,
      active_topics: [],
      open_questions: [],
      resolved_points: [],
      commitments: [],
      last_turns: [],
    },
    assistant_state: {
      tone: 'helpful, concise',
      last_commitment: null,
    },
  };
}

export class SessionManager {
  constructor({ memoryStore }) {
    this.store = memoryStore;
    // In-memory session cache — prevents race conditions between rapid turns
    this._cache = new Map();  // session_id → { state, updatedAt }
    this._cacheTTL = 300_000; // 5 minutes — session dies after inactivity
  }

  /**
   * Load session state. Checks in-memory cache first (for rapid turns),
   * then DB, then returns empty state.
   */
  async load(sessionId, { tenantId, userId, orgId, language } = {}) {
    if (!sessionId) return emptyState(sessionId, tenantId, language);

    // 1. Check in-memory cache (handles rapid turns without DB roundtrip)
    const cached = this._cache.get(sessionId);
    if (cached && Date.now() - cached.updatedAt < this._cacheTTL) {
      return { ...cached.state };  // Return a copy
    }

    // 2. Check DB — use BOTH tags to avoid collision with tara-turn memories
    try {
      const { memories } = await this.store.listMemories({
        user_id: userId,
        org_id: orgId,
        tags: ['tara-session', `sid:${sessionId}`],  // Both tags required
        limit: 5,
      });

      // Find the one that's actually a session state (JSON content with session_id)
      for (const mem of (memories || [])) {
        try {
          const state = JSON.parse(mem.content);
          if (state.session_id === sessionId) {
            state._memory_id = mem.id;
            this._cache.set(sessionId, { state: { ...state }, updatedAt: Date.now() });
            return state;
          }
        } catch {
          // Not JSON — skip (might be a turn memory that somehow matched)
        }
      }
    } catch (err) {
      console.warn('[tara/session] Load failed:', err.message);
    }

    return emptyState(sessionId, tenantId, language);
  }

  /**
   * Update session state after a completed turn.
   * Writes to both in-memory cache AND DB.
   */
  async update(sessionId, { userId, orgId, tenantId, state, userSummary, assistantSummary, extractedFacts }) {
    if (!sessionId || !state) return null;

    // Append turn summaries
    state.turn_count = (state.turn_count || 0) + 1;
    if (userSummary) {
      state.conversation.last_turns.push({ role: 'user', summary: userSummary });
    }
    if (assistantSummary) {
      state.conversation.last_turns.push({ role: 'assistant', summary: assistantSummary });
    }

    // Bound turn history
    if (state.conversation.last_turns.length > MAX_TURN_HISTORY) {
      const overflow = state.conversation.last_turns.splice(0, state.conversation.last_turns.length - MAX_TURN_HISTORY);
      for (const t of overflow) {
        if (t.role === 'user' && t.summary) {
          state.conversation.resolved_points.push(t.summary);
        }
      }
      if (state.conversation.resolved_points.length > 20) {
        state.conversation.resolved_points = state.conversation.resolved_points.slice(-20);
      }
    }

    // Update user profile from extracted facts
    if (extractedFacts?.name) state.user_profile.name = extractedFacts.name;
    if (extractedFacts?.preferences?.length) {
      state.user_profile.preferences = [
        ...new Set([...state.user_profile.preferences, ...extractedFacts.preferences])
      ].slice(-10);
    }

    // Write to in-memory cache FIRST (next turn sees this immediately)
    this._cache.set(sessionId, { state: { ...state }, updatedAt: Date.now() });

    // Then persist to DB (async-safe — cache protects rapid turns)
    const content = JSON.stringify(state, null, 0);
    const tags = ['tara-session', `sid:${sessionId}`];

    try {
      if (state._memory_id) {
        await this.store.updateMemory(state._memory_id, { content, tags });
        return state._memory_id;
      } else {
        const id = crypto.randomUUID();
        await this.store.createMemory({
          id,
          content,
          title: `Session: ${sessionId}`,
          tags,
          memory_type: 'event',
          project: `tara/${tenantId || 'default'}`,
          user_id: userId,
          org_id: orgId,
        });
        state._memory_id = id;
        // Update cache with memory ID
        this._cache.set(sessionId, { state: { ...state }, updatedAt: Date.now() });
        return id;
      }
    } catch (err) {
      console.error('[tara/session] Update failed:', err.message);
      return null;
    }
  }

  /**
   * List active sessions for a user/tenant.
   */
  async listSessions({ userId, orgId, tenantId, limit = 20 } = {}) {
    try {
      const { memories } = await this.store.listMemories({
        user_id: userId,
        org_id: orgId,
        tags: ['tara-session'],
        limit,
      });

      return (memories || []).map(m => {
        try {
          const state = JSON.parse(m.content);
          return {
            session_id: state.session_id,
            tenant_id: state.tenant_id,
            turn_count: state.turn_count || 0,
            current_goal: state.conversation?.current_goal,
            language: state.language,
            updated_at: m.updated_at || m.created_at,
          };
        } catch {
          return { session_id: 'unknown', turn_count: 0, updated_at: m.updated_at };
        }
      });
    } catch {
      return [];
    }
  }
}
