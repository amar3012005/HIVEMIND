/**
 * MemorySynthesizer — for each topic with many memories, produce a higher-order
 * synthesis memory ("rolling brief") and link it via Derives to source memories.
 *
 * Strategy:
 *   1. Find TopicState rows with memoryCount >= N (default 8) that haven't been
 *      synthesized in last D days.
 *   2. Pull recent memories linked to that entity.
 *   3. LLM: write 3-4 sentence brief.
 *   4. Insert into memories table with memory_type='synthesis'.
 *   5. Create Derives edges from synthesis -> each source memory.
 */

import crypto from 'node:crypto';
import { chatCompletion, getDefaultModel } from '../knowledge/enterprise/litellm-client.js';
import { orgIsRemote } from '../vector/mneme/driver.js';

const MIN_MEMORIES_FOR_SYNTHESIS = Number(process.env.SYNTHESIS_MIN_MEMORIES || 8);
const SYNTHESIS_REFRESH_DAYS = Number(process.env.SYNTHESIS_REFRESH_DAYS || 7);

const SYSTEM_PROMPT = `You write a concise 3-4 sentence brief that synthesizes multiple memories about a topic into a single durable summary.

Return ONLY JSON: { "title": string, "content": string }

Rules:
- Present-tense. Current state, not history.
- 200 chars max for title.
- 800 chars max for content.
- Skip filler. Lead with most important fact.
- Reconcile contradictions: prefer newer + higher-confidence.
- Mention key entities by name.`;

export class MemorySynthesizer {
  constructor({ prisma, memoryGraphEngine, logger = console, model = null }) {
    this.prisma = prisma;
    this.memoryGraphEngine = memoryGraphEngine;
    this.logger = logger;
    this.model = model || getDefaultModel();
  }

  async synthesizeForOrg(orgId, { limit = 10 } = {}) {
    // Remote (self-host): topicState/entityMention/memory tables are central-empty — the agent-routed cognition loop already covers self-host synthesis; skip this central-batch job.
    if (orgIsRemote(orgId)) {
      this.logger.log?.(`[synthesizer] skip remote org=${String(orgId).slice(0, 8)} — central-batch synthesis not applicable`);
      return 0;
    }
    const cutoff = new Date(Date.now() - SYNTHESIS_REFRESH_DAYS * 86400000);
    const topics = await this.prisma.topicState.findMany({
      where: {
        orgId,
        memoryCount: { gte: MIN_MEMORIES_FOR_SYNTHESIS },
        OR: [
          { metadata: { path: ['lastSynthesizedAt'], equals: null } },
          { lastUpdatedAt: { gt: cutoff } },
        ],
      },
      orderBy: { memoryCount: 'desc' },
      take: limit,
      include: { entity: true },
    });
    let synthesizedCount = 0;
    for (const topic of topics) {
      try {
        const ok = await this._synthesizeOne(topic, orgId);
        if (ok) synthesizedCount++;
      } catch (err) {
        this.logger.warn?.(`[synthesizer] topic ${topic.topicKey} failed: ${err.message}`);
      }
    }
    return synthesizedCount;
  }

  async _synthesizeOne(topic, orgId) {
    if (!topic.entityId) return false;
    const mentions = await this.prisma.entityMention.findMany({
      where: { entityId: topic.entityId, memoryId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { memoryId: true, memory: { select: { id: true, content: true, userId: true, orgId: true } } },
    });
    const sourceMemories = mentions.map(m => m.memory).filter(Boolean);
    if (sourceMemories.length < MIN_MEMORIES_FOR_SYNTHESIS) return false;

    const userId = sourceMemories[0].userId;
    const corpus = sourceMemories.slice(0, 15).map((m, i) => `[${i + 1}] ${String(m.content).slice(0, 400)}`).join('\n\n');

    const raw = await chatCompletion({
      model: this.model,
      json_mode: true,
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Topic: ${topic.entity?.canonicalName || topic.topicKey}\n\nSource memories:\n${corpus}` },
      ],
    });
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const title = String(parsed?.title || `${topic.entity?.canonicalName || topic.topicKey} — brief`).slice(0, 500);
    const content = String(parsed?.content || '').slice(0, 2000);
    if (!content) return false;

    // Create synthesis memory via graph engine
    const synthesisId = crypto.randomUUID();
    const result = await this.memoryGraphEngine.ingestMemory({
      id: synthesisId,
      user_id: userId,
      org_id: orgId,
      content,
      title,
      memory_type: 'synthesis',
      tags: ['synthesis', `entity:${topic.entity?.canonicalName || topic.topicKey}`, 'auto-generated'],
      skip_relationship_classification: true,
      skipPredictCalibrate: true,
      source_type: 'memory_synthesis',
      source_metadata: {
        source_type: 'memory_synthesis',
        topic_key: topic.topicKey,
        derived_from: sourceMemories.map(m => m.id),
      },
    });
    const realId = result?.memoryId || synthesisId;

    await this.memoryGraphEngine.applyDerivesFromSources(
      sourceMemories.map(src => src.id),
      realId,
      { user_id: userId, org_id: orgId, confidence: 0.85, reason: 'memory_synthesizer_v1' },
    );

    // Mark topic synthesized
    await this.prisma.topicState.update({
      where: { id: topic.id },
      data: {
        metadata: { ...(topic.metadata || {}), lastSynthesizedAt: new Date().toISOString(), lastSynthesisMemoryId: realId },
      },
    });
    return true;
  }
}
