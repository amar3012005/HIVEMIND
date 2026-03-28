/**
 * Context Autopilot — Preemptive Compaction
 *
 * Monitors context usage and triggers compaction before the "context cliff"
 * where LLMs randomly drop early instructions. Archives session state to
 * the database with SHA-256 dedup, scores entries by recency × frequency × richness,
 * and reinjects critical memories into fresh context.
 *
 * Architecture (per NotebookLM research):
 *   - Trigger on TOKEN COUNT (not message count) at 80% threshold
 *   - Archive every turn proactively with SHA-256 dedup
 *   - Produce a session summary memory node in the knowledge graph
 *   - Score retention: recency × frequency × richness
 *   - Reinject via CognitiveOperator frame assembly
 *   - Increment access_count for relevance feedback loop
 *
 * @module memory/context-autopilot
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate (chars / 4). Good enough for threshold checks.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Compute SHA-256 hash for dedup.
 * @param {string} content
 * @returns {string}
 */
function contentHash(content) {
  return crypto
    .createHash('sha256')
    .update((content || '').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Retention Scoring
// ---------------------------------------------------------------------------

/**
 * Calculate retention score: recency × frequency × richness.
 *
 * - Recency: exponential decay from last access/update
 * - Frequency: log-scaled access/recall count (relevance feedback loop)
 * - Richness: semantic density based on content length and importance
 *
 * @param {object} memory — memory record
 * @param {object} [options]
 * @param {number} [options.recencyDecayRate=0.05] — hourly decay rate
 * @param {number} [options.maxRichnessTokens=500] — content length for max richness
 * @returns {{ score: number, recency: number, frequency: number, richness: number }}
 */
export function scoreForRetention(memory, options = {}) {
  const { recencyDecayRate = 0.05, maxRichnessTokens = 500 } = options;
  const now = Date.now();

  // Recency: exponential decay from last access
  const lastAccess = memory.updated_at || memory.created_at || new Date().toISOString();
  const hoursSinceAccess = (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60);
  const recency = Math.exp(-recencyDecayRate * Math.max(hoursSinceAccess, 0));

  // Frequency: log-scaled recall/access count (creates relevance feedback loop)
  const accessCount = (memory.recall_count || 0) + (memory.version || 1);
  const frequency = Math.log(1 + accessCount);

  // Richness: semantic density — longer, more important content scores higher
  const contentTokens = estimateTokens(memory.content);
  const lengthRichness = Math.min(contentTokens / maxRichnessTokens, 1.5);
  const importanceBoost = (memory.importance_score || 0.5) > 0.7 ? 1.3 : 1.0;
  const richness = lengthRichness * importanceBoost;

  const score = recency * frequency * richness;

  return { score, recency, frequency, richness };
}

// ---------------------------------------------------------------------------
// Session Archive
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ArchivedTurn
 * @property {string} role — 'user' | 'assistant' | 'system'
 * @property {string} content
 * @property {string} hash — SHA-256 of normalized content
 * @property {number} tokens — estimated token count
 * @property {string} timestamp
 */

/**
 * Deduplicate and archive session turns.
 *
 * @param {Array<{ role: string, content: string }>} turns — conversation turns
 * @param {Set<string>} existingHashes — hashes already archived
 * @returns {{ archived: ArchivedTurn[], duplicatesSkipped: number, totalTokens: number }}
 */
export function archiveSessionTurns(turns, existingHashes = new Set()) {
  const archived = [];
  let duplicatesSkipped = 0;
  let totalTokens = 0;

  for (const turn of turns) {
    const hash = contentHash(turn.content);
    if (existingHashes.has(hash)) {
      duplicatesSkipped++;
      continue;
    }

    existingHashes.add(hash);
    const tokens = estimateTokens(turn.content);
    totalTokens += tokens;

    archived.push({
      role: turn.role || 'user',
      content: turn.content,
      hash,
      tokens,
      timestamp: turn.timestamp || new Date().toISOString()
    });
  }

  return { archived, duplicatesSkipped, totalTokens };
}

// ---------------------------------------------------------------------------
// Context Autopilot
// ---------------------------------------------------------------------------

/**
 * ContextAutopilot — preemptive context management.
 *
 * Monitors context usage, triggers compaction at 80% capacity,
 * archives session state, scores retention, and builds reinject payload.
 */
export class ContextAutopilot {
  /**
   * @param {object} opts
   * @param {object} opts.store — PrismaGraphStore or InMemoryGraphStore
   * @param {number} [opts.maxContextTokens=128000] — model context window size
   * @param {number} [opts.compactionThreshold=0.80] — trigger at this % of capacity
   * @param {number} [opts.criticalMemoryCount=15] — max memories to reinject
   * @param {number} [opts.summaryMaxTokens=500] — max tokens for session summary
   */
  constructor({
    store,
    maxContextTokens = 128_000,
    compactionThreshold = 0.80,
    criticalMemoryCount = 15,
    summaryMaxTokens = 500
  } = {}) {
    if (!store) throw new Error('ContextAutopilot requires a store');
    this.store = store;
    this.maxContextTokens = maxContextTokens;
    this.compactionThreshold = compactionThreshold;
    this.criticalMemoryCount = criticalMemoryCount;
    this.summaryMaxTokens = summaryMaxTokens;

    /** @type {Map<string, Set<string>>} session → archived content hashes */
    this._sessionHashes = new Map();
    /** @type {Map<string, ArchivedTurn[]>} session → archived turns */
    this._sessionArchive = new Map();
  }

  /**
   * Check if compaction is needed based on current token usage.
   *
   * @param {string} sessionId
   * @param {number} currentTokenCount — actual tokens used (input + cache)
   * @returns {{ shouldCompact: boolean, usagePercent: number, tokensUsed: number, tokensRemaining: number, threshold: number }}
   */
  monitorContext(sessionId, currentTokenCount) {
    const usagePercent = currentTokenCount / this.maxContextTokens;
    const tokensRemaining = this.maxContextTokens - currentTokenCount;

    return {
      shouldCompact: usagePercent >= this.compactionThreshold,
      usagePercent: Math.round(usagePercent * 10000) / 100, // 2 decimal places
      tokensUsed: currentTokenCount,
      tokensRemaining: Math.max(tokensRemaining, 0),
      threshold: this.compactionThreshold
    };
  }

  /**
   * Proactively archive new turns (call on every UserPromptSubmit).
   *
   * @param {string} sessionId
   * @param {Array<{ role: string, content: string }>} newTurns
   * @returns {{ archivedCount: number, duplicatesSkipped: number, totalArchived: number }}
   */
  archiveTurns(sessionId, newTurns) {
    if (!this._sessionHashes.has(sessionId)) {
      this._sessionHashes.set(sessionId, new Set());
    }
    if (!this._sessionArchive.has(sessionId)) {
      this._sessionArchive.set(sessionId, []);
    }

    const hashes = this._sessionHashes.get(sessionId);
    const archive = this._sessionArchive.get(sessionId);
    const { archived, duplicatesSkipped } = archiveSessionTurns(newTurns, hashes);

    archive.push(...archived);

    return {
      archivedCount: archived.length,
      duplicatesSkipped,
      totalArchived: archive.length
    };
  }

  /**
   * Execute preemptive compaction.
   *
   * 1. Generates a session summary from archived turns
   * 2. Scores all user memories by retention (recency × frequency × richness)
   * 3. Selects top-N critical memories for reinjection
   * 4. Builds the reinject payload with summary + critical memories
   *
   * @param {string} sessionId
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.orgId
   * @param {string} [opts.project]
   * @param {Array<{ role: string, content: string }>} [opts.recentMessages] — current conversation (for summary)
   * @returns {Promise<{ summary: string, summaryTokens: number, criticalMemories: Array, injectionPayload: string, archivedCount: number, totalRetentionScore: number }>}
   */
  async compactSession(sessionId, { userId, orgId, project, recentMessages = [] } = {}) {
    // Archive any remaining messages
    if (recentMessages.length > 0) {
      this.archiveTurns(sessionId, recentMessages);
    }

    const archive = this._sessionArchive.get(sessionId) || [];

    // 1. Generate session summary
    const summary = this._generateSummary(archive);
    const summaryTokens = estimateTokens(summary);

    // 2. Fetch and score all user memories for retention
    const allMemories = await this.store.listLatestMemories({
      user_id: userId,
      org_id: orgId,
      project: project || null
    });

    const scored = allMemories
      .map(m => {
        const retention = scoreForRetention(m);
        return { ...m, _retention: retention };
      })
      .sort((a, b) => b._retention.score - a._retention.score);

    // 3. Select critical memories (top-N)
    const critical = scored.slice(0, this.criticalMemoryCount);
    const totalRetentionScore = critical.reduce((s, m) => s + m._retention.score, 0);

    const summaryMemoryId = await this._persistSessionSummary({
      sessionId,
      userId,
      orgId,
      project,
      summary
    });

    // 4. Build injection payload
    const injectionPayload = this._buildInjectionPayload(summary, critical);

    return {
      summaryMemoryId,
      summary,
      summaryTokens,
      criticalMemories: critical.map(m => ({
        id: m.id,
        memory_type: m.memory_type,
        content: (m.content || '').slice(0, 200),
        retention_score: m._retention.score,
        retention_breakdown: m._retention
      })),
      injectionPayload,
      archivedCount: archive.length,
      totalRetentionScore
    };
  }

  /**
   * Generate a concise session summary from archived turns.
   * Pure heuristic — no LLM call needed.
   *
   * @param {ArchivedTurn[]} archive
   * @returns {string}
   */
  _generateSummary(archive) {
    if (!archive || archive.length === 0) {
      return 'No session activity to summarize.';
    }

    // Extract key topics from user messages
    const userMessages = archive.filter(t => t.role === 'user');
    const assistantMessages = archive.filter(t => t.role === 'assistant');

    // Extract top keywords from user messages (frequency-based)
    const wordFreq = new Map();
    const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but',
      'not', 'this', 'that', 'it', 'i', 'you', 'we', 'me', 'my', 'your', 'do', 'does',
      'did', 'have', 'has', 'had', 'can', 'will', 'would', 'should', 'could', 'just']);

    for (const msg of userMessages) {
      const words = (msg.content || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    const topKeywords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    // Build summary
    const parts = [];
    parts.push(`Session: ${userMessages.length} user messages, ${assistantMessages.length} assistant responses.`);

    if (topKeywords.length > 0) {
      parts.push(`Key topics: ${topKeywords.join(', ')}.`);
    }

    // Include the most recent user message as "current focus"
    if (userMessages.length > 0) {
      const lastMsg = userMessages[userMessages.length - 1];
      const truncated = (lastMsg.content || '').slice(0, 200);
      parts.push(`Last user focus: "${truncated}"`);
    }

    // Trim to max summary tokens
    let summary = parts.join(' ');
    const maxChars = this.summaryMaxTokens * 4;
    if (summary.length > maxChars) {
      summary = summary.slice(0, maxChars) + '...';
    }

    return summary;
  }

  /**
   * Build the injection payload for post-compaction context.
   *
   * @param {string} summary
   * @param {Array} criticalMemories
   * @returns {string}
   */
  _buildInjectionPayload(summary, criticalMemories) {
    const lines = ['<compacted-context>'];
    lines.push(`  <session-summary>${summary}</session-summary>`);

    if (criticalMemories.length > 0) {
      lines.push('  <critical-memories>');
      for (const m of criticalMemories) {
        const type = m.memory_type || 'fact';
        const score = (m._retention?.score || 0).toFixed(3);
        lines.push(`    <memory type="${type}" retention="${score}">${m.content}</memory>`);
      }
      lines.push('  </critical-memories>');
    }

    lines.push('</compacted-context>');
    return lines.join('\n');
  }

  /**
   * Get session stats.
   *
   * @param {string} sessionId
   * @returns {{ archivedTurns: number, uniqueHashes: number }}
   */
  getSessionStats(sessionId) {
    return {
      archivedTurns: (this._sessionArchive.get(sessionId) || []).length,
      uniqueHashes: (this._sessionHashes.get(sessionId) || new Set()).size
    };
  }

  /**
   * Clear session archive (after successful compaction or session end).
   *
   * @param {string} sessionId
   */
  clearSession(sessionId) {
    this._sessionHashes.delete(sessionId);
    this._sessionArchive.delete(sessionId);
  }

  async _persistSessionSummary({ sessionId, userId, orgId, project, summary }) {
    if (!summary || summary === 'No session activity to summarize.') {
      return null;
    }

    const summaryHash = contentHash(summary);
    const allMemories = await this.store.listLatestMemories({
      user_id: userId,
      org_id: orgId,
      project: project || null
    });

    const existing = allMemories.find(memory =>
      (memory.tags || []).includes('session-summary')
      && (memory.tags || []).includes(`session:${sessionId}`)
      && contentHash(memory.content || '') === summaryHash
    );

    if (existing) {
      return existing.id;
    }

    const now = new Date().toISOString();
    const payload = {
      id: uuidv4(),
      user_id: userId,
      org_id: orgId,
      project: project || null,
      content: summary,
      title: `Session Summary: ${sessionId}`,
      memory_type: 'fact',
      tags: ['session-summary', `session:${sessionId}`],
      is_latest: true,
      version: 1,
      created_at: now,
      updated_at: now,
      document_date: now,
      metadata: {
        session_id: sessionId,
        summary_hash: summaryHash,
        source: 'context-autopilot'
      },
      source_metadata: {
        source_type: 'context_autopilot',
        source_id: sessionId,
        source_platform: 'context-autopilot',
        source_url: null
      }
    };

    const created = await this.store.createMemory(payload);
    if (typeof this.store.createMemoryVersion === 'function') {
      await this.store.createMemoryVersion({
        id: uuidv4(),
        memory_id: payload.id,
        version: 1,
        content_hash: summaryHash,
        is_latest: true,
        reason: 'session_summary',
        related_memory_id: null,
        metadata: payload.metadata,
        created_at: now
      });
    }
    if (typeof this.store.createSourceMetadata === 'function') {
      await this.store.createSourceMetadata({
        id: uuidv4(),
        memory_id: payload.id,
        source_type: payload.source_metadata.source_type,
        source_id: payload.source_metadata.source_id,
        source_platform: payload.source_metadata.source_platform,
        source_url: payload.source_metadata.source_url,
        thread_id: sessionId,
        parent_message_id: null,
        ingested_at: now,
        metadata: payload.metadata
      });
    }

    return created?.id || payload.id;
  }
}
