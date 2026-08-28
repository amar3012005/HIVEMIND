/**
 * ContradictionScanner — finds memory pairs whose facts conflict.
 *
 * Strategy:
 *   1. For each entity with >1 recent memory, cluster their content.
 *   2. LLM pairwise check: "do these contradict?"
 *   3. If yes + confidence >threshold → emit Contradicts relationship
 *
 * Conservative by default — only flags HIGH-confidence conflicts. Generates
 * proposals only; nothing auto-executes.
 */

import { chatCompletion, getDefaultModel } from '../knowledge/enterprise/litellm-client.js';
import { orgIsRemote } from '../vector/mneme/driver.js';

const SYSTEM_PROMPT = `You compare two short knowledge memories about the same topic and decide if they CONTRADICT.

Return ONLY: { "contradicts": boolean, "confidence": 0..1, "explanation": string }

A contradicts B if: stating both as TRUE is logically impossible OR factually inconsistent.

NOT contradiction:
- Different aspects of same topic
- Older fact superseded by newer fact (this is "update" not "contradict")
- Different precision levels
- Different sources confirming same point

YES contradiction:
- Conflicting state values (e.g. "in production" vs "still in staging" same date)
- Conflicting counts/figures within same scope
- Logical negation (X is broken / X works)`;

const CONFIDENCE_THRESHOLD = 0.75;
const MAX_ENTITIES_PER_SCAN = 20;
const MAX_MEMORIES_PER_ENTITY = 5;

export class ContradictionScanner {
  constructor({ prisma, memoryGraphEngine = null, memoryStore = null, logger = console, model = null }) {
    this.prisma = prisma;
    this.logger = logger;
    this.model = model || getDefaultModel();
    this.memoryGraphEngine = memoryGraphEngine;
    this.memoryStore = memoryStore;
  }

  async scanForOrg(orgId) {
    const proposals = [];
    // Remote (self-host): entity/memory tables are central-empty — the agent-routed cognition loop covers contradiction handling; skip this central-batch job.
    if (orgIsRemote(orgId)) {
      this.logger.log?.(`[contradiction-scanner] skip remote org=${String(orgId).slice(0, 8)} — central-batch scan not applicable`);
      return proposals;
    }
    try {
      // Find entities with most mentions in last 30 days
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const entities = await this.prisma.entity.findMany({
        where: { orgId, lastSeenAt: { gte: since }, mentionCount: { gte: 2 } },
        orderBy: { mentionCount: 'desc' },
        take: MAX_ENTITIES_PER_SCAN,
        select: { id: true, canonicalName: true, entityType: true },
      });

      for (const entity of entities) {
        const mentions = await this.prisma.entityMention.findMany({
          where: { entityId: entity.id, memoryId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: MAX_MEMORIES_PER_ENTITY,
          select: { memoryId: true, memory: { select: { id: true, content: true, createdAt: true } } },
        });
        const memories = mentions.map(m => m.memory).filter(Boolean);
        if (memories.length < 2) continue;

        // Pairwise compare each adjacent pair (chronologically)
        memories.sort((a, b) => a.createdAt - b.createdAt);
        for (let i = 0; i < memories.length - 1; i++) {
          const a = memories[i];
          const b = memories[i + 1];
          if (!a?.content || !b?.content) continue;

          const verdict = await this._compare(a.content, b.content, entity.canonicalName);
          if (verdict?.contradicts && verdict.confidence >= CONFIDENCE_THRESHOLD) {
            proposals.push({
              type: 'contradiction',
              entityId: entity.id,
              entityName: entity.canonicalName,
              memoryAId: a.id,
              memoryBId: b.id,
              confidence: verdict.confidence,
              explanation: verdict.explanation,
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn?.(`[contradiction-scanner] org ${orgId} failed: ${err.message}`);
    }
    return proposals;
  }

  async _compare(contentA, contentB, entityName) {
    try {
      const raw = await chatCompletion({
        model: this.model,
        json_mode: true,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Topic: ${entityName}\n\nMemory A:\n${String(contentA).slice(0, 600)}\n\nMemory B:\n${String(contentB).slice(0, 600)}`,
          },
        ],
      });
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Emit Contradicts edges into relationships table for accepted proposals. */
  async emitProposals(proposals) {
    let written = 0;
    for (const p of proposals) {
      try {
        const source = await this.memoryStore?.getMemory(p.memoryBId);
        if (!source || !this.memoryGraphEngine?.applyValidatedRelationship) continue;
        const applied = await this.memoryGraphEngine.applyValidatedRelationship({
          from_id: p.memoryBId,
          to_id: p.memoryAId,
          type: 'Contradicts',
          confidence: p.confidence,
          created_by: 'contradiction_scanner_v1',
          metadata: { entity: p.entityName, explanation: p.explanation, inference_model: this.model },
        }, { store: this.memoryStore, user_id: source.user_id, org_id: source.org_id });
        written += applied.edgesCreated?.length || 0;
      } catch (err) {
        this.logger.warn?.(`[contradiction-scanner] emit failed: ${err.message}`);
      }
    }
    return written;
  }
}
