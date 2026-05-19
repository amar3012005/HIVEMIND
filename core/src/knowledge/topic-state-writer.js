/**
 * TopicStateWriter — maintains rolling "what's happening with X" summaries
 * per entity. Updated on every memory promotion that mentions the entity.
 *
 * Strategy:
 *   - One TopicState row per (orgId, topicKey) where topicKey = `${type}:${name}`
 *   - Each ingest tick: increment counters + LLM-refresh summary every Nth tick
 *     (configurable via TOPIC_SUMMARY_INTERVAL, default 5 new memories)
 *
 * Wired into DocumentFirstIngestionService._linkEntitiesToMemoryAsync.
 */

import { chatCompletion, getDefaultModel } from './enterprise/litellm-client.js';

const SUMMARY_REFRESH_EVERY = Number(process.env.TOPIC_SUMMARY_INTERVAL || 5);

const SYSTEM_PROMPT = `You write a 1-2 sentence rolling status for a topic.
Input: existing summary (may be empty) + a list of recent memory excerpts.
Output: a single, current-tense JSON object: { "summary": "string" }.
Rules:
- Focus on the latest state, not historical narration.
- 200 chars max.
- Skip filler ("Currently", "Recently").
- If contradiction exists between new and old, prefer newer.
- If only one memory and old summary empty: paraphrase that memory.`;

export class TopicStateWriter {
  constructor({ prisma, logger = console, model = null }) {
    this.prisma = prisma;
    this.logger = logger;
    this.model = model || getDefaultModel();
  }

  /**
   * Update topic states for an entity mention's memory.
   * Called fire-and-forget from ingestion pipeline.
   */
  async recordMemoryForEntity({ orgId, entityId, memoryId, documentId, memoryContent }) {
    if (!entityId || !memoryId) return;
    try {
      const entity = await this.prisma.entity.findUnique({
        where: { id: entityId },
        select: { id: true, entityType: true, canonicalName: true },
      });
      if (!entity) return;
      const topicKey = `${entity.entityType}:${entity.canonicalName.toLowerCase()}`;

      const existing = await this.prisma.topicState.findUnique({
        where: { orgId_topicKey: { orgId, topicKey } },
      });

      const newCount = (existing?.memoryCount || 0) + 1;
      const shouldRefresh =
        !existing?.summary ||
        existing.summary.length < 10 ||
        newCount % SUMMARY_REFRESH_EVERY === 0;

      let summary = existing?.summary || '';
      if (shouldRefresh) {
        summary = await this._refreshSummary({
          entity, existingSummary: existing?.summary || '', newMemoryContent: memoryContent || '',
        });
      }

      await this.prisma.topicState.upsert({
        where: { orgId_topicKey: { orgId, topicKey } },
        create: {
          orgId, entityId, topicKey, summary,
          lastMemoryId: memoryId, lastDocumentId: documentId || null,
          memoryCount: 1, documentCount: documentId ? 1 : 0,
          confidence: 0.7,
        },
        update: {
          summary,
          lastMemoryId: memoryId,
          lastDocumentId: documentId || existing?.lastDocumentId || null,
          memoryCount: { increment: 1 },
          documentCount: documentId ? { increment: 1 } : undefined,
          lastUpdatedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn?.(`[topic-state] failed for entity ${entityId}: ${err.message}`);
    }
  }

  async _refreshSummary({ entity, existingSummary, newMemoryContent }) {
    try {
      const raw = await chatCompletion({
        model: this.model,
        json_mode: true,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Topic: ${entity.canonicalName} (${entity.entityType})\n\nPrevious summary: ${existingSummary || '(none)'}\n\nNew memory excerpt: ${String(newMemoryContent).slice(0, 800)}`,
          },
        ],
      });
      let parsed;
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
      const s = parsed?.summary || existingSummary || '';
      return String(s).slice(0, 500);
    } catch {
      return existingSummary || '';
    }
  }
}
