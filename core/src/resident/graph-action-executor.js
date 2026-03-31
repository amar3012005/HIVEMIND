import { randomUUID } from 'node:crypto';

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
    this.logger = logger;
  }

  /**
   * Execute a batch of graph actions from a Turing verification run.
   * @param {Array} actions — from turing's action_candidates observations
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]  — preview without mutating
   * @param {number}  [options.minConfidence=0.6] — skip actions below this threshold
   * @param {string}  [options.project]       — optional project scope
   * @returns {Promise<{ executed: number, skipped: number, failed: number, results: Array }>}
   */
  async executeActions(actions, options = {}) {
    const { dryRun = false, minConfidence = 0.6 } = options;
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
        const result = await this._dispatch(recommendation, targetIds, action.content, confidence, dryRun);
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
  async _dispatch(recommendation, targetIds, content, confidence, dryRun) {
    switch (recommendation) {
      case 'link_update_chain':
        return this._linkUpdateChain(targetIds, confidence, dryRun);
      case 'merge_duplicate_cluster':
        return this._mergeDuplicates(targetIds, confidence, dryRun);
      case 'suppress_noise_cluster':
        return this._suppressNoise(targetIds, confidence, dryRun);
      case 'promote_known_risk':
        return this._promoteRisk(targetIds, content, confidence, dryRun);
      case 'relationship_candidate':
        return this._createRelationship(targetIds, confidence, dryRun);
      default:
        return { status: 'skipped', reason: `unknown_action: ${recommendation}` };
    }
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
  async _mergeDuplicates(memoryIds, confidence, dryRun) {
    if (memoryIds.length < 2) return { status: 'skipped', reason: 'need_at_least_2_memories' };

    const memories = await this._fetchMemories(memoryIds);
    if (memories.length < 2) return { status: 'skipped', reason: 'memories_not_found' };

    // Keep the one with the most content as canonical
    memories.sort((a, b) => (b.content || '').length - (a.content || '').length);
    const canonical = memories[0];
    const duplicates = memories.slice(1);

    if (dryRun) {
      return { status: 'dry_run', canonical: canonical.id, duplicates: duplicates.map((m) => m.id) };
    }

    let merged = 0;
    for (const dup of duplicates) {
      await this._safeCreateRelationship({
        id: randomUUID(),
        from_id: dup.id,
        to_id: canonical.id,
        type: 'Extends',
        confidence,
        metadata: { source: 'turing_graph_action', action: 'merge_duplicate_cluster' },
        created_by: 'turing',
      });
      await this._safeUpdate(dup.id, {
        isLatest: false,               // Prisma camelCase field
        supersedesId: canonical.id,  // Prisma FK column for chain traversal
        metadata: {
          ...(dup.metadata || {}),
          merged_into: canonical.id,
          merge_reason: 'Turing agent identified as duplicate — canonical version preserved',
          merged_at: new Date().toISOString(),
        },
      });
      merged++;
    }
    // Boost canonical memory importance + tag as turing-verified
    const canonicalTags = canonical.tags || [];
    if (!canonicalTags.includes('turing-verified')) canonicalTags.push('turing-verified');
    await this._safeUpdate(canonical.id, {
      importanceScore: Math.min(1.0, (canonical.importanceScore || 0.5) + 0.2),
      tags: canonicalTags,
    });
    return { status: 'executed', canonical: canonical.id, merged, duplicates: duplicates.map((m) => m.id) };
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
    return { status: 'executed', promoted_memory_id: riskMemory.id, summary };
  }

  /**
   * Create Extends relationships between related memories.
   * The first ID is treated as the anchor; all others extend it.
   */
  async _createRelationship(memoryIds, confidence, dryRun) {
    if (memoryIds.length < 2) return { status: 'skipped', reason: 'need_at_least_2_memories' };
    if (dryRun) return { status: 'dry_run', would_link: memoryIds.length - 1 };

    let created = 0;
    for (let i = 1; i < memoryIds.length; i++) {
      await this._safeCreateRelationship({
        id: randomUUID(),
        from_id: memoryIds[i],
        to_id: memoryIds[0],
        type: 'Extends',
        confidence,
        metadata: { source: 'turing_graph_action', action: 'relationship_candidate' },
        created_by: 'turing',
      });
      created++;
    }
    return { status: 'executed', relationships_created: created };
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
      await this.store.createRelationship(edge);
      return true;
    } catch (err) {
      // Unique constraint = relationship already exists = not an error
      if (err.message?.includes('Unique constraint')) return false;
      throw err;
    }
  }
}
