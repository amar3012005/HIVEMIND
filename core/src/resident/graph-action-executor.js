import { randomUUID } from 'node:crypto';
import { MemoryGraphEngine } from '../memory/graph-engine.js';

/**
 * Graph Action Executor
 * Executes Turing's verified graph actions against the memory store.
 * This closes the CSI feedback loop — verified findings become graph knowledge.
 *
 * Supported action types (from turing.js buildGraphActions):
 *   link_update_chain       — link stale truth to newer truth via Updates relationship
 *   merge_duplicate_cluster — merge duplicate memories into canonical node
 *   suppress_noise_cluster  — mark low-novelty memories as noise (lower importance)
 *   promote_known_risk      — elevate a pattern into a canonical risk observation
 *   relationship_candidate  — create Extends relationship between related memories
 */

export class GraphActionExecutor {
  /**
   * @param {object} deps
   * @param {object} deps.memoryStore — memory store with getMemory / updateMemory / createMemory / createRelationship
   * @param {object} [deps.logger]
   */
  constructor({ memoryStore, logger = console }) {
    this.store = memoryStore;
    this.engine = memoryStore?.engine || new MemoryGraphEngine({ store: memoryStore, predictCalibrate: false });
    this.logger = logger;
  }

  /**
   * Execute a batch of graph actions from a Turing verification run.
   * @param {Array} actions — from turing's action_candidates observations
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]  — preview without mutating
   * @param {number}  [options.minConfidence=0.6] — skip actions below this threshold
   * @param {string}  [options.project]       — optional project scope
   * @param {string}  [options.duplicateMode='merge'] — 'merge' (soft: mark not-latest) or 'delete' (hard: remove from DB)
   * @returns {Promise<{ executed: number, skipped: number, failed: number, results: Array }>}
   */
  async executeActions(actions, options = {}) {
    // Default confidence floor is env-tunable (GOV_MIN_PROPOSAL_CONFIDENCE) so a
    // pilot org can calibrate it while agent confidence scoring is being tuned,
    // without a code change. Falls back to the original 0.6.
    const { dryRun = false, minConfidence = Number(process.env.GOV_MIN_PROPOSAL_CONFIDENCE || 0.6), duplicateMode = 'merge' } = options;
    const results = [];

    for (const action of actions) {
      const confidence = action.certainty || action.confidence || action.content?.confidence || 0;
      if (confidence < minConfidence) {
        results.push({
          action: action.content?.recommendation || action.action,
          status: 'skipped',
          reason: 'below_confidence_threshold',
        });
        continue;
      }

      const recommendation = action.recommendation || action.content?.recommendation || action.action;
      const targetIds = action.target_memory_ids || action.content?.target_memory_ids || [];

      try {
        const result = await this._dispatch(recommendation, targetIds, action.content, confidence, dryRun, duplicateMode);
        results.push({ action: recommendation, ...result });
      } catch (err) {
        this.logger.error(`[graph-actions] ${recommendation} failed:`, err.message);
        results.push({ action: recommendation, status: 'failed', error: err.message });
      }
    }

    const executed = results.filter((r) => r.status === 'executed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    this.logger.log(`[graph-actions] Executed ${executed}, skipped ${skipped}, failed ${failed} of ${actions.length} actions`);

    return { executed, skipped, failed, results };
  }

  // ── internal dispatch ────────────────────────────────────────────

  /** @private */
  async _dispatch(recommendation, targetIds, content, confidence, dryRun, duplicateMode = 'merge') {
    switch (recommendation) {
      case 'link_update_chain':
        return this._linkUpdateChain(targetIds, confidence, dryRun);
      case 'merge_duplicate_cluster':
        return this._mergeDuplicates(targetIds, confidence, dryRun, duplicateMode);
      case 'suppress_noise_cluster':
        return this._suppressNoise(targetIds, confidence, dryRun);
      case 'promote_known_risk':
        return this._promoteRisk(targetIds, content, confidence, dryRun);
      case 'relationship_candidate':
        return this._createRelationship(targetIds, confidence, dryRun, content);
      // Phase 4 — synthesis ownership. Delegates to cognitive-tool registry
      // so cluster_hash + cooldown + LLM rewrite + dedup + derives edges
      // all live in one place.
      case 'canonical_synthesis':
      case 'bridge_synthesis':
      case 'compression':
        return this._runCognitiveTool(recommendation, targetIds, content, confidence, dryRun);
      default:
        return { status: 'skipped', reason: `unknown_action: ${recommendation}` };
    }
  }

  async _getCognitionLoop() {
    if (!this._cognitionLoop) {
      const { CognitionLoop } = await import('../memory/cognition-loop.js');
      // Resolve prisma via multiple paths — memoryStore wraps Prisma, but
      // exposes it under different keys depending on caller. Fall back to
      // the shared singleton in src/db/prisma.js.
      let prisma = this.memoryStore?.client
        || this.memoryStore?.prisma
        || this.memoryStore?._client
        || null;
      if (!prisma) {
        try {
          const { getPrismaClient } = await import('../db/prisma.js');
          prisma = getPrismaClient();
        } catch { /* ignore */ }
      }
      this._cognitionLoop = new CognitionLoop({
        prisma,
        memoryGraphEngine: this.memoryStore?.engine || this.memoryStore || null,
        persistentMemoryStore: this.memoryStore || null,
        logger: this.logger,
      });
    }
    return this._cognitionLoop;
  }

  /**
   * Delegates to cognitive-tool registry. Tool owns cluster_hash + cooldown
   * + LLM rewrite + dedup + derives edges + cognitive_layer_role stamping.
   */
  async _runCognitiveTool(toolName, memoryIds, content, confidence, dryRun) {
    let prisma = this.memoryStore?.client
      || this.memoryStore?.prisma
      || this.memoryStore?._client
      || null;
    if (!prisma) {
      try {
        const { getPrismaClient } = await import('../db/prisma.js');
        prisma = getPrismaClient();
      } catch { /* ignore */ }
    }
    if (!prisma) return { status: 'failed', error: 'prisma_unavailable' };

    const { getCognitiveToolRegistry } = await import('../cognitive-tools/registry.js');
    const registry = getCognitiveToolRegistry({ prisma, memoryStore: this.memoryStore, logger: this.logger });
    const tool = registry.get(toolName);
    if (!tool) return { status: 'failed', error: `unknown_tool: ${toolName}` };

    // Resolve a representative member for orgId/userId fallback. Only hit central Postgres
    // when the payload doesn't already carry org_id — remote (self-host) orgs have no central
    // row, so the lookup returning null must not fail the action when content.org_id exists.
    const sample = memoryIds?.length && !content?.org_id
      ? await prisma.memory.findFirst({ where: { id: { in: memoryIds.slice(0, 1) } }, select: { orgId: true, userId: true } }).catch(() => null)
      : null;
    const orgId = content?.org_id || sample?.orgId;
    const userId = content?.user_id || sample?.userId;
    if (!orgId) return { status: 'failed', error: 'org_id_unresolvable' };

    const args = {
      orgId,
      userId,
      cluster_hash: content?.cluster_hash || null,
      confidence: content?.confidence ?? confidence,
      dryRun,
    };
    if (toolName === 'canonical_synthesis' || toolName === 'compression') {
      args.topic = content?.topic || content?.bridge_tag || null;
      args.evidence_ids = content?.evidence_ids?.length ? content.evidence_ids : memoryIds;
    } else if (toolName === 'bridge_synthesis') {
      args.bridge_tag = content?.bridge_tag || content?.topic;
      // Bridge expects A+B sets — derive heuristically if not given.
      if (content?.evidence_ids_a?.length && content?.evidence_ids_b?.length) {
        args.evidence_ids_a = content.evidence_ids_a;
        args.evidence_ids_b = content.evidence_ids_b;
      } else if (Array.isArray(memoryIds) && memoryIds.length >= 2) {
        const half = Math.ceil(memoryIds.length / 2);
        args.evidence_ids_a = memoryIds.slice(0, half);
        args.evidence_ids_b = memoryIds.slice(half);
      } else {
        return { status: 'failed', error: 'bridge_needs_two_clusters' };
      }
    }

    return tool.execute(args);
  }

  // ── action handlers ──────────────────────────────────────────────

  /**
   * Link memories as an update chain: oldest → newest via Updates relationships.
   * Each newer memory "Updates" the previous one; older nodes are marked not-latest.
   */
  async _linkUpdateChain(memoryIds, confidence, dryRun) {
    if (memoryIds.length < 2) return { status: 'skipped', reason: 'need_at_least_2_memories' };

    const memories = await this._fetchMemories(memoryIds);
    if (memories.length < 2) return { status: 'skipped', reason: 'memories_not_found' };

    memories.sort((a, b) => new Date(a.document_date || a.created_at) - new Date(b.document_date || b.created_at));
    const chain = memories.map((m) => m.id);

    if (dryRun) return { status: 'dry_run', would_create: memories.length - 1, chain };

    let created = 0;
    for (let i = 1; i < memories.length; i++) {
      await this._safeCreateRelationship({
        id: randomUUID(),
        from_id: memories[i].id,
        to_id: memories[i - 1].id,
        type: 'Updates',
        confidence,
        metadata: { source: 'turing_graph_action', action: 'link_update_chain' },
        created_by: 'turing',
      });
      // Mark old memory as superseded — set both Prisma column AND metadata
      await this._safeUpdate(memories[i - 1].id, {
        isLatest: false,               // Prisma camelCase field
        supersedesId: memories[i].id,  // Prisma FK column for chain traversal
        metadata: {
          ...(memories[i - 1].metadata || {}),
          superseded_by: memories[i].id,
          superseded_reason: 'Turing agent detected stale/conflicting truth — newer version exists',
          superseded_at: new Date().toISOString(),
        },
      });
      created++;
    }
    return { status: 'executed', relationships_created: created, chain, latest: memories[memories.length - 1].id };
  }

  /**
   * Merge duplicates: keep the richest memory as canonical, mark others not-latest,
   * and link them to the canonical via Extends relationships.
   */
  async _mergeDuplicates(memoryIds, confidence, dryRun, duplicateMode = 'merge') {
    if (memoryIds.length < 2) return { status: 'skipped', reason: 'need_at_least_2_memories' };

    const memories = await this._fetchMemories(memoryIds);
    if (memories.length < 2) return { status: 'skipped', reason: 'memories_not_found' };

    // Keep the one with the most content as canonical
    memories.sort((a, b) => (b.content || '').length - (a.content || '').length);
    const canonical = memories[0];
    const duplicates = memories.slice(1);

    if (dryRun) {
      return {
        status: 'dry_run',
        mode: duplicateMode,
        canonical: canonical.id,
        canonical_content: (canonical.content || '').slice(0, 100),
        duplicates: duplicates.map((m) => ({
          id: m.id,
          content: (m.content || '').slice(0, 100),
        })),
      };
    }

    let merged = 0;
    let deleted = 0;

    if (duplicateMode === 'delete') {
      // HARD DELETE: remove duplicates entirely from database
      for (const dup of duplicates) {
        try {
          await this.store.deleteMemory(dup.id);
          deleted++;
        } catch (err) {
          this.logger.warn(`[graph-actions] Hard delete ${dup.id} failed:`, err.message);
          // Fallback to soft merge
          await this._safeUpdate(dup.id, { isLatest: false, supersedesId: canonical.id });
          merged++;
        }
      }
    } else {
      // SOFT MERGE: duplicate lineage is lifecycle metadata, not semantic
      // Extends/Derives. Keep it queryable without manufacturing graph edges.
      for (const dup of duplicates) {
        await this._safeUpdate(dup.id, {
          isLatest: false,
          supersedesId: canonical.id,
          metadata: {
            ...(dup.metadata || {}),
            merged_into: canonical.id,
            merge_reason: 'Turing agent identified as duplicate — canonical version preserved',
            merged_at: new Date().toISOString(),
          },
        });
        merged++;
      }
    }

    // Boost canonical memory importance + tag as turing-verified
    const canonicalTags = canonical.tags || [];
    if (!canonicalTags.includes('turing-verified')) canonicalTags.push('turing-verified');
    await this._safeUpdate(canonical.id, {
      importanceScore: Math.min(1.0, (canonical.importanceScore || 0.5) + 0.2),
      tags: canonicalTags,
    });

    return {
      status: 'executed',
      mode: duplicateMode,
      canonical: canonical.id,
      merged,
      deleted,
      duplicates: duplicates.map((m) => m.id),
    };
  }

  /**
   * Suppress noise: lower importance score for low-novelty memories.
   */
  async _suppressNoise(memoryIds, confidence, dryRun) {
    if (dryRun) return { status: 'dry_run', would_suppress: memoryIds.length };

    let suppressed = 0;
    for (const id of memoryIds) {
      const ok = await this._safeUpdate(id, { importanceScore: 0.1 });  // Prisma camelCase field
      if (ok) suppressed++;
    }
    return { status: 'executed', suppressed };
  }

  /**
   * Promote a pattern to a canonical risk observation.
   * Creates a new high-importance memory summarizing the risk, inheriting
   * user/org/project from the first target memory.
   */
  async _promoteRisk(memoryIds, content, confidence, dryRun) {
    const summary = content?.summary || 'Unknown risk pattern';
    if (dryRun) return { status: 'dry_run', would_promote: summary };

    // Inherit scope from the first target memory
    let sourceMemory = null;
    if (memoryIds.length > 0) {
      try {
        sourceMemory = await this.store.getMemory(memoryIds[0]);
      } catch { /* best-effort */ }
    }
    if (!sourceMemory) return { status: 'skipped', reason: 'no_source_memory_for_scope' };

    const riskMemory = {
      id: randomUUID(),
      user_id: sourceMemory.user_id,
      org_id: sourceMemory.org_id,
      project: sourceMemory.project,
      content: `PROMOTED RISK: ${summary}. Rationale: ${content?.rationale || 'Verified by Turing agent.'}`,
      title: `Risk: ${summary.slice(0, 60)}`,
      tags: ['promoted-risk', 'turing-verified'],
      memory_type: 'fact',  // valid Prisma enum value
      isLatest: true,
      version: 1,
      importanceScore: 0.95,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        promoted_by: 'turing',
        promoted_at: new Date().toISOString(),
        source_memory_ids: memoryIds,
        original_summary: summary,
      },
    };

    await this.store.createMemory(riskMemory);

    // Provenance direction is source -> synthesis/risk, never the reverse.
    const evidenceIds = content?.evidence_memory_ids || memoryIds;
    let derivesEdges = 0;
    for (const evidenceId of evidenceIds) {
      if (await this._safeCreateRelationship({
        id: randomUUID(),
        from_id: evidenceId,
        to_id: riskMemory.id,
        type: 'Derives',
        confidence,
        metadata: { source: 'csi-turing', action_type: 'promote_known_risk' },
        created_by: 'csi-turing',
      })) derivesEdges += 1;
    }

    return { status: 'executed', promoted_memory_id: riskMemory.id, summary, derives_edges: derivesEdges };
  }

  /**
   * Create relationships between related memories.
   * The first ID is treated as the anchor; all others connect to it.
   * Uses Extends for standard relationships, Derives for novel inferred connections.
   */
  async _createRelationship(memoryIds, confidence, dryRun, content) {
    if (memoryIds.length < 2) return { status: 'skipped', reason: 'need_at_least_2_memories' };
    if (dryRun) return { status: 'dry_run', would_link: memoryIds.length - 1 };

    const suggestedType = content?.relationship_type;
    const edgeType = suggestedType || 'Extends';
    if (!['Updates', 'Extends', 'Derives', 'Contradicts'].includes(edgeType)) {
      return { status: 'skipped', reason: 'unsupported_relationship_type', suggested_type: suggestedType };
    }

    let created = 0;
    for (let i = 1; i < memoryIds.length; i++) {
      const persisted = await this._safeCreateRelationship({
        id: randomUUID(),
        from_id: memoryIds[i],
        to_id: memoryIds[0],
        type: edgeType,
        confidence,
        metadata: {
          source: edgeType === 'Derives' ? 'csi-turing' : 'turing_graph_action',
          action_type: 'relationship_candidate',
          ...(suggestedType ? { suggested_relationship_type: suggestedType } : {}),
        },
        created_by: edgeType === 'Derives' ? 'csi-turing' : 'turing',
      });
      if (persisted) created++;
    }
    return { status: 'executed', relationships_created: created, edge_type: edgeType };
  }

  // ── helpers ──────────────────────────────────────────────────────

  /** Fetch memories by IDs (supports partial UUID matching), silently dropping any that fail. */
  async _fetchMemories(ids) {
    const memories = [];
    for (const id of ids) {
      if (!id) continue;
      try {
        // Try exact match first
        const mem = await this.store.getMemory(id);
        if (mem) { memories.push(mem); continue; }
      } catch { /* not found by exact ID */ }

      // If ID is partial (< 36 chars), try prefix search via listMemories
      if (id.length < 36) {
        try {
          const { memories: found } = await this.store.listMemories({
            user_id: memories[0]?.user_id, // use scope from first found memory
            limit: 5,
          });
          const match = (found || []).find(m => m.id.startsWith(id));
          if (match) { memories.push(match); continue; }
        } catch { /* skip */ }
      }
    }
    return memories;
  }

  /** Update a memory, returning true on success, false on failure. */
  async _safeUpdate(id, fields) {
    try {
      await this.store.updateMemory(id, fields);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a relationship, skipping if it already exists (unique constraint). */
  async _safeCreateRelationship(edge) {
    try {
      const source = await this.store.getMemory(edge.from_id);
      if (!source) return false;
      const applied = await this.engine.applyValidatedRelationship(edge, {
        store: this.store,
        user_id: source.user_id,
        org_id: source.org_id,
      });
      return Boolean(applied.edgesCreated?.length);
    } catch (err) {
      // Unique constraint = relationship already exists = not an error
      if (err.message?.includes('Unique constraint')) return false;
      throw err;
    }
  }
}
