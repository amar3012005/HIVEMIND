/**
 * TrailStore - Persistent research trail storage for CSI graph.
 *
 * Stores complete research processes including:
 * - Step-by-step actions taken by each agent
 * - Contradictions detected between sources
 * - Blueprint usage and formation metadata
 * - Agent states and observations
 *
 * Uses CSI memory types:
 * - op/research-trail: Main trail node with all steps
 * - op/research-contradiction: Contradiction records (linked)
 * - kg/research-{agent}: Agent state snapshots
 */

import { randomUUID } from 'node:crypto';

const AGENT_TYPES = ['explorer', 'analyst', 'verifier', 'synthesizer'];
const ACTION_TYPES = ['search_web', 'search_memory', 'read_url', 'extract_claims', 'synthesize'];

export class TrailStore {
  /**
   * @param {Object} deps
   * @param {import('../memory/prisma-graph-store.js').PrismaGraphStore} deps.memoryStore
   * @param {string} deps.userId
   * @param {string} deps.orgId
   */
  constructor({ memoryStore, userId, orgId }) {
    this.memoryStore = memoryStore;
    this.userId = userId;
    this.orgId = orgId;

    // In-memory buffer for building trail before persistence
    this.trails = new Map();
    this.contradictions = new Map();

    // Thread-safe step recording for parallel task execution
    this._stepCounter = 0;
    this._persistTimers = new Map(); // sessionId → debounce timer
  }

  _normalizeRefs(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value === undefined || value === null || value === '') return [];
    return [value];
  }

  _cloneStep(step) {
    return {
      ...step,
      claimIds: this._normalizeRefs(step?.claimIds),
      sourceIds: this._normalizeRefs(step?.sourceIds),
      observationIds: this._normalizeRefs(step?.observationIds),
      relatedNodeIds: this._normalizeRefs(step?.relatedNodeIds),
      parentStepId: step?.parentStepId || null,
      relationType: step?.relationType || null,
      reportId: step?.reportId || null,
    };
  }

  _buildTrailMetadataSnapshot(trail) {
    const steps = trail.steps.map(step => this._cloneStep(step));
    const contradictions = trail.contradictions.map(contradiction => ({
      ...contradiction,
      claimA: contradiction.claimA ? { ...contradiction.claimA } : contradiction.claimA,
      claimB: contradiction.claimB ? { ...contradiction.claimB } : contradiction.claimB,
    }));
    const reportProvenance = trail.metadata.reportProvenance || null;
    const goldenLine = trail.metadata.goldenLine || reportProvenance?.goldenLine || null;

    return {
      ...trail.metadata,
      steps,
      stepIds: steps.map(step => step.id).filter(Boolean),
      contradictionCount: contradictions.length,
      trailType: 'op/research-trail',
      reportProvenance,
      goldenLine,
      trail: {
        id: trail.id,
        sessionId: trail.sessionId,
        projectId: trail.projectId,
        query: trail.query,
        steps,
        stepIds: steps.map(step => step.id).filter(Boolean),
        contradictions,
        reportProvenance,
        goldenLine,
      },
    };
  }

  _inferStepRelationType(step) {
    if (step?.relationType) return step.relationType;
    if (step?.action === 'verify_findings') return 'Update';
    if (step?.action === 'synthesize') return 'Derive';
    if (step?.rejected) return 'Update';
    return 'Derive';
  }

  /**
   * Initialize a new research trail.
   * @param {string} sessionId
   * @param {string} query
   * @param {string} projectId
   * @param {Object} options
   * @param {string} options.blueprintUsed - blueprint ID if used
   * @param {boolean} options.blueprintCandidate - is this forming a new pattern?
   * @param {Object} options.agentStates - initial agent states
   */
  async initTrail(sessionId, query, projectId, options = {}) {
    const trail = {
      id: randomUUID(),
      type: 'op/research-trail',
      sessionId,
      projectId,
      query,
      tags: ['research-trail', `session:${sessionId}`, `project:${projectId}`],
      metadata: {
        query,
        blueprintUsed: options.blueprintUsed || null,
        blueprintCandidate: options.blueprintCandidate || false,
        agentStates: options.agentStates || {
          explorer: 'active',
          analyst: 'idle',
          verifier: 'idle',
          synthesizer: 'idle',
        },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reportProvenance: null,
        goldenLine: null,
        trail: {
          id: null,
          sessionId,
          projectId,
          query,
          steps: [],
          stepIds: [],
          contradictions: [],
          reportProvenance: null,
          goldenLine: null,
        },
      },
      steps: [],
      contradictions: [],
    };

    this.trails.set(sessionId, trail);
    this.contradictions.set(sessionId, []);
    trail.metadata.trail.id = trail.id;
    trail.metadata.trail.trailId = trail.id;

    // Persist initial trail state
    await this._persistTrail(sessionId);

    return trail.id;
  }

  /**
   * Record a research step.
   * @param {string} sessionId
   * @param {Object} step
   * @param {number} step.stepIndex
   * @param {string} step.agent - explorer | analyst | verifier | synthesizer
   * @param {string} step.action - search_web | search_memory | read_url | extract_claims | synthesize
   * @param {string} step.input - input to the action
   * @param {string} step.output - output from the action
   * @param {number} step.confidence - confidence score 0-1
   * @param {boolean} step.rejected - was this branch abandoned?
   * @param {string} step.reason - why rejected (if applicable)
   * @param {string} step.thought - reasoning/thought behind the action
   * @param {string} step.why - why this action was chosen
   * @param {string|null} step.alternativeConsidered - alternative action that was considered
   */
  async recordStep(sessionId, step) {
    const trail = this.trails.get(sessionId);
    if (!trail) {
      await this.initTrail(sessionId, 'Unknown', `research/unknown`);
    }

    const trailBuffer = this.trails.get(sessionId);
    const stepId = step.id || randomUUID();
    const stepIndex = typeof step.stepIndex === 'number' ? step.stepIndex : this._stepCounter++;
    const stepRecord = {
      id: stepId,
      stepIndex,
      sessionId,
      trailId: trailBuffer.id,
      agent: step.agent || 'explorer',
      action: step.action || 'search_web',
      input: step.input || '',
      output: step.output || '',
      confidence: step.confidence ?? 0.5,
      rejected: step.rejected || false,
      reason: step.reason || '',
      thought: step.thought || '',
      why: step.why || '',
      alternativeConsidered: step.alternativeConsidered || null,
      claimIds: this._normalizeRefs(step.claimIds),
      sourceIds: this._normalizeRefs(step.sourceIds),
      observationIds: this._normalizeRefs(step.observationIds),
      relatedNodeIds: this._normalizeRefs(step.relatedNodeIds),
      parentStepId: step.parentStepId || null,
      relationType: this._inferStepRelationType(step),
      reportId: step.reportId || null,
      timestamp: new Date().toISOString(),
    };

    trailBuffer.steps.push(stepRecord);
    trailBuffer.metadata.updatedAt = new Date().toISOString();

    if (step.agent && trailBuffer.metadata.agentStates) {
      trailBuffer.metadata.agentStates[step.agent] = step.rejected ? 'blocked' : 'active';
    }

    // Debounced persist — coalesces concurrent writes within 500ms
    if (this._persistTimers.has(sessionId)) {
      clearTimeout(this._persistTimers.get(sessionId));
    }
    this._persistTimers.set(sessionId, setTimeout(async () => {
      this._persistTimers.delete(sessionId);
      try {
        await this._persistTrail(sessionId);
      } catch (err) {
        console.error('[TrailStore] Debounced persist failed:', err.message);
      }
    }, 500));

    return stepRecord;
  }

  /**
   * Record a contradiction between two claims.
   * @param {string} sessionId
   * @param {Object} contradiction
   * @param {Object} contradiction.claimA - { source, content, memoryId }
   * @param {Object} contradiction.claimB - { source, content, memoryId }
   * @param {string} contradiction.dimension - what dimension they conflict on
   * @param {boolean} contradiction.unresolved - is this still debated?
   */
  async recordContradiction(sessionId, contradiction) {
    const trail = this.trails.get(sessionId);
    if (!trail) return null;

    const contradictionRecord = {
      id: randomUUID(),
      claimA: {
        source: contradiction.claimA?.source || 'unknown',
        content: contradiction.claimA?.content || '',
        memoryId: contradiction.claimA?.memoryId || null,
      },
      claimB: {
        source: contradiction.claimB?.source || 'unknown',
        content: contradiction.claimB?.content || '',
        memoryId: contradiction.claimB?.memoryId || null,
      },
      dimension: contradiction.dimension || 'factual',
      unresolved: contradiction.unresolved ?? true,
      detectedAt: new Date().toISOString(),
    };

    trail.contradictions.push(contradictionRecord);

    // Also persist as separate CSI node for queryability
    await this._persistContradiction(contradictionRecord, trail.projectId);

    // Update main trail
    await this._persistTrail(sessionId);

    return contradictionRecord.id;
  }

  /**
   * Get trail for a session.
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getTrail(sessionId) {
    return this.trails.get(sessionId) || null;
  }

  /**
   * Get contradictions for a session.
   * @param {string} sessionId
   * @returns {Array}
   */
  getContradictions(sessionId) {
    return this.contradictions.get(sessionId) || [];
  }

  /**
   * Finalize and persist complete trail.
   * @param {string} sessionId
   * @param {Object} report - final research report
   */
  async finalizeTrail(sessionId, report, provenance = null) {
    const trail = this.trails.get(sessionId);
    if (!trail) return null;

    // Flush any pending debounced persist
    if (this._persistTimers.has(sessionId)) {
      clearTimeout(this._persistTimers.get(sessionId));
      this._persistTimers.delete(sessionId);
    }

    trail.metadata.completedAt = new Date().toISOString();
    trail.metadata.report = report;
    trail.metadata.reportProvenance = provenance ? {
      ...provenance,
      claimIds: this._normalizeRefs(provenance.claimIds),
      sourceIds: this._normalizeRefs(provenance.sourceIds),
      trailStepIds: this._normalizeRefs(provenance.trailStepIds),
      recalledMemoryIds: this._normalizeRefs(provenance.recalledMemoryIds),
      nodeIds: this._normalizeRefs(provenance.nodeIds),
      edgeIds: this._normalizeRefs(provenance.edgeIds),
      trails: this._normalizeRefs(provenance.trails),
      sources: this._normalizeRefs(provenance.sources),
    } : trail.metadata.reportProvenance || null;
    trail.metadata.goldenLine = provenance?.goldenLine || trail.metadata.goldenLine || null;
    trail.metadata.reportId = provenance?.reportId || trail.metadata.reportId || null;
    trail.metadata.reportBlueprintId = provenance?.blueprintId || trail.metadata.reportBlueprintId || null;
    trail.metadata.reportSchema = provenance?.sectionSchema || trail.metadata.reportSchema || null;
    trail.metadata.status = 'completed';
    trail.metadata.trail = {
      id: trail.id,
      sessionId: trail.sessionId,
      projectId: trail.projectId,
      query: trail.query,
      steps: trail.steps.map(step => this._cloneStep(step)),
      stepIds: trail.steps.map(step => step.id).filter(Boolean),
      contradictions: trail.contradictions.map(contradiction => ({
        ...contradiction,
        claimA: contradiction.claimA ? { ...contradiction.claimA } : contradiction.claimA,
        claimB: contradiction.claimB ? { ...contradiction.claimB } : contradiction.claimB,
      })),
      reportProvenance: trail.metadata.reportProvenance,
      goldenLine: trail.metadata.goldenLine,
    };

    await this._persistTrail(sessionId);

    // Clean up in-memory buffer after persistence
    setTimeout(() => this.trails.delete(sessionId), 60000);

    return trail;
  }

  /**
   * Detect contradictions between findings.
   * Compares new finding against existing findings for same session.
   * @param {string} sessionId
   * @param {Object} newFinding - { content, source, memoryId }
   * @param {string} dimension - optional dimension to check
   * @returns {Promise<Object|null>} detected contradiction or null
   */
  async detectContradiction(sessionId, newFinding, dimension = null) {
    const trail = this.trails.get(sessionId);
    if (!trail) return null;

    // Get existing findings from steps
    const existingClaims = trail.steps
      .filter(s => s.action === 'search_web' || s.action === 'search_memory')
      .map(s => ({
        content: s.output,
        source: s.action === 'search_web' ? 'web' : 'memory',
        memoryId: s.memoryId,
      }));

    // Check for contradictions with existing claims
    for (const existing of existingClaims) {
      const contradiction = this._analyzeContradiction(existing, newFinding, dimension);
      if (contradiction) {
        await this.recordContradiction(sessionId, contradiction);
        return contradiction;
      }
    }

    return null;
  }

  /**
   * Analyze if two claims contradict.
   * Simple heuristic: check for opposing language patterns.
   * @private
   */
  _analyzeContradiction(claimA, claimB, dimension) {
    const textA = (claimA.content || '').toLowerCase();
    const textB = (claimB.content || '').toLowerCase();

    // Opposition patterns
    const oppositionPairs = [
      ['increases', 'decreases'],
      ['supports', 'contradicts'],
      ['proves', 'disproves'],
      ['confirms', 'denies'],
      ['shows', 'refutes'],
      ['effective', 'ineffective'],
      ['safe', 'unsafe'],
      ['recommended', 'not recommended'],
    ];

    for (const [posA, negA] of oppositionPairs) {
      const aHasPos = textA.includes(posA);
      const aHasNeg = textA.includes(negA);
      const bHasPos = textB.includes(posA);
      const bHasNeg = textB.includes(negA);

      // Check if they oppose
      if ((aHasPos && bHasNeg) || (aHasNeg && bHasPos)) {
        return {
          claimA,
          claimB,
          dimension: dimension || `semantic:${posA}/${negA}`,
          unresolved: true,
        };
      }
    }

    return null;
  }

  /**
   * Persist trail to CSI as memory node.
   * Uses upsert pattern - creates if new, updates if exists.
   * @private
   */
  async _persistTrail(sessionId) {
    const trail = this.trails.get(sessionId);
    if (!trail) return;
    const metadata = this._buildTrailMetadataSnapshot(trail);

    try {
      // Try to create first
      await this.memoryStore.createMemory({
        id: trail.id,
        user_id: this.userId,
        org_id: this.orgId,
        project: trail.projectId,
        content: this._serializeTrail(trail),
        title: `Research Trail: ${trail.query.slice(0, 80)}`,
        memory_type: 'decision',
        tags: trail.tags,
        is_latest: true,
        importance_score: 0.95,
        metadata: {
          ...metadata,
          stepCount: trail.steps.length,
        },
        created_at: trail.metadata.startedAt,
        updated_at: trail.metadata.updatedAt,
      });
    } catch (err) {
      // If unique constraint violation, update instead
      if (err.message?.includes('Unique constraint') || err.code === 'P2002') {
        try {
          await this.memoryStore.updateMemory(trail.id, {
            content: this._serializeTrail(trail),
            updated_at: new Date().toISOString(),
            metadata: {
              ...metadata,
              stepCount: trail.steps.length,
            },
          });
        } catch (updateErr) {
          console.error('[TrailStore] Failed to update trail:', updateErr.message);
        }
      } else {
        // Non-failing: trail persistence should not block research
        console.error('[TrailStore] Failed to persist trail:', err.message);
      }
    }
  }

  /**
   * Persist contradiction as separate CSI node.
   * Uses upsert pattern - creates if new, updates if exists.
   * @private
   */
  async _persistContradiction(contradiction, projectId) {
    try {
      // Try to create first
      await this.memoryStore.createMemory({
        id: contradiction.id,
        user_id: this.userId,
        org_id: this.orgId,
        project: projectId,
        content: this._serializeContradiction(contradiction),
        title: `Contradiction: ${contradiction.dimension}`,
        memory_type: 'fact',
        tags: ['research-contradiction', `session:${this._sessionIdFromTrail(contradiction)}`, `dimension:${contradiction.dimension}`],
        is_latest: true,
        importance_score: 0.8,
        metadata: {
          contradictionType: 'op/research-contradiction',
          claimA: contradiction.claimA,
          claimB: contradiction.claimB,
          unresolved: contradiction.unresolved,
        },
        created_at: contradiction.detectedAt,
        updated_at: contradiction.detectedAt,
      });
    } catch (err) {
      // If unique constraint violation, update instead
      if (err.message?.includes('Unique constraint') || err.code === 'P2002') {
        try {
          await this.memoryStore.updateMemory(contradiction.id, {
            content: this._serializeContradiction(contradiction),
            updated_at: new Date().toISOString(),
            metadata: {
              contradictionType: 'op/research-contradiction',
              claimA: contradiction.claimA,
              claimB: contradiction.claimB,
              unresolved: contradiction.unresolved,
            },
          });
        } catch (updateErr) {
          console.error('[TrailStore] Failed to update contradiction:', updateErr.message);
        }
      } else {
        console.error('[TrailStore] Failed to persist contradiction:', err.message);
      }
    }
  }

  /**
   * Serialize trail for storage.
   * @private
   */
  _serializeTrail(trail) {
    const provenance = trail.metadata.reportProvenance || null;
    const trailSnapshot = trail.metadata.trail || {
      id: trail.id,
      sessionId: trail.sessionId,
      projectId: trail.projectId,
      query: trail.query,
      steps: trail.steps,
      stepIds: trail.steps.map(step => step.id).filter(Boolean),
      contradictions: trail.contradictions,
      reportProvenance: provenance,
      goldenLine: trail.metadata.goldenLine || null,
    };
    const lines = [
      `# Research Trail: ${trail.query}`,
      ``,
      `**Session:** ${trail.sessionId}`,
      `**Project:** ${trail.projectId}`,
      `**Started:** ${trail.metadata.startedAt}`,
      `**Blueprint:** ${trail.metadata.blueprintUsed || 'none'}`,
      `**Blueprint Candidate:** ${trail.metadata.blueprintCandidate}`,
      `**Report ID:** ${trail.metadata.reportId || provenance?.reportId || 'none'}`,
      ``,
      `## Steps (${trail.steps.length})`,
      ``,
    ];

    for (const step of trail.steps.slice(0, 20)) {
      lines.push(
        `### Step ${step.stepIndex}: ${step.agent}/${step.action}`,
        `- Confidence: ${step.confidence}`,
        `- Rejected: ${step.rejected}${step.reason ? ` (${step.reason})` : ''}`,
        `- Input: ${step.input.slice(0, 200)}`,
        `- Output: ${step.output.slice(0, 200)}`,
        step.thought ? `- Thought: ${step.thought}` : '',
        step.why ? `- Why: ${step.why}` : '',
        step.alternativeConsidered ? `- Alternative Considered: ${step.alternativeConsidered}` : '',
        ``,
      );
    }

    if (trail.contradictions.length > 0) {
      lines.push(`## Contradictions (${trail.contradictions.length})`, ``);
      for (const c of trail.contradictions) {
        lines.push(
          `### ${c.dimension}`,
          `- Claim A (${c.claimA.source}): ${c.claimA.content.slice(0, 150)}`,
          `- Claim B (${c.claimB.source}): ${c.claimB.content.slice(0, 150)}`,
          `- Unresolved: ${c.unresolved}`,
          ``,
        );
      }
    }

    if (provenance) {
      lines.push(`## Report Provenance`, ``);
      lines.push(`- Report: ${provenance.reportId || 'none'}`);
      lines.push(`- Blueprint: ${provenance.blueprintId || 'none'}`);
      lines.push(`- Trail: ${provenance.trailId || trail.id}`);
      lines.push(`- Claims: ${(provenance.claimIds || []).join(', ') || 'none'}`);
      lines.push(`- Sources: ${(provenance.sourceIds || []).join(', ') || 'none'}`);
      lines.push(`- Recalled Memories: ${(provenance.recalledMemoryIds || []).join(', ') || 'none'}`);
      lines.push(`- Golden Line: ${provenance.goldenLine || 'none'}`);
      lines.push(``, `## Trail Snapshot`, `- Steps: ${(trailSnapshot.stepIds || []).length}`, `- Contradictions: ${(trailSnapshot.contradictions || []).length}`, ``);
    }

    return lines.join('\n');
  }

  /**
   * Serialize contradiction for storage.
   * @private
   */
  _serializeContradiction(contradiction) {
    return [
      `# Research Contradiction`,
      ``,
      `**Dimension:** ${contradiction.dimension}`,
      `**Unresolved:** ${contradiction.unresolved}`,
      ``,
      `## Claim A`,
      `- Source: ${contradiction.claimA.source}`,
      `- Content: ${contradiction.claimA.content.slice(0, 300)}`,
      ``,
      `## Claim B`,
      `- Source: ${contradiction.claimB.source}`,
      `- Content: ${contradiction.claimB.content.slice(0, 300)}`,
      ``,
    ].join('\n');
  }

  /**
   * Extract sessionId from trail (helper).
   * @private
   */
  _sessionIdFromTrail(contradiction) {
    // Try to get from in-memory trail
    for (const [sessionId, trail] of this.trails) {
      if (trail.contradictions.includes(contradiction)) {
        return sessionId;
      }
    }
    return 'unknown';
  }

  /**
   * Query trails by project.
   * @param {string} projectId
   * @returns {Promise<Array>}
   */
  async queryByProject(projectId) {
    try {
      // Query database for research trails in this project
      const { memories } = await this.memoryStore.listMemories({
        user_id: this.userId,
        org_id: this.orgId,
        tags: ['research-trail', `project:${projectId}`],
        limit: 100,
      });

      if (memories?.length > 0) {
        return memories.map(m => ({
          id: m.id,
          sessionId: m.metadata?.sessionId || m.id,
          projectId: m.metadata?.projectId || projectId,
          query: m.metadata?.query || m.content,
          status: m.metadata?.status || 'completed',
          startedAt: m.created_at,
          completedAt: m.metadata?.completedAt,
          steps: m.metadata?.trail?.steps || m.metadata?.steps || [],
          contradictions: m.metadata?.contradictions || [],
          reportProvenance: m.metadata?.reportProvenance || m.metadata?.trail?.reportProvenance || null,
          goldenLine: m.metadata?.goldenLine || m.metadata?.trail?.goldenLine || null,
          trail: m.metadata?.trail || null,
          metadata: m.metadata,
        }));
      }

      // Fallback to in-memory if no DB results
      return [...this.trails.values()].filter(t => t.projectId === projectId);
    } catch (err) {
      console.error('[TrailStore] Failed to query trails by project:', err.message);
      return [...this.trails.values()].filter(t => t.projectId === projectId);
    }
  }

  /**
   * Query trails by session.
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  async queryBySession(sessionId) {
    return this.getTrail(sessionId);
  }
}

export { AGENT_TYPES, ACTION_TYPES };
