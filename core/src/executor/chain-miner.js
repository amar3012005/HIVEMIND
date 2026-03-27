/**
 * Trail Executor — Chain Miner
 * HIVE-MIND Cognitive Runtime
 *
 * Scans execution history for repeated successful tool chains
 * and creates blueprint trail candidates.
 *
 * @module executor/chain-miner
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * @typedef {Object} MineConfig
 * @property {number} [minOccurrences=3]
 * @property {number} [minSuccessRate=0.9]
 * @property {number} [maxAvgLatencyMs=5000]
 * @property {number} [lookbackRuns=50]
 * @property {boolean} [autoActivate=true]
 */

/**
 * @typedef {Object} MineResult
 * @property {number} candidatesCreated
 * @property {number} blueprintsActivated
 * @property {number} blueprintsSkippedExisting
 * @property {Array<{chainSignature: string, occurrences: number, successRate: number, avgLatencyMs: number, action: string}>} details
 */

export class ChainMiner {
  /**
   * @param {object} store
   * @param {MineConfig} [config]
   */
  constructor(store, config = {}) {
    this.store = store;
    this.minOccurrences = config.minOccurrences ?? 3;
    this.minSuccessRate = config.minSuccessRate ?? 0.9;
    this.maxAvgLatencyMs = config.maxAvgLatencyMs ?? 5000;
    this.lookbackRuns = config.lookbackRuns ?? 50;
    this.autoActivate = config.autoActivate ?? true;
  }

  /**
   * Canonicalize a tool sequence into a chain signature.
   * @param {string[]} toolSequence
   * @returns {string}
   */
  static canonicalize(toolSequence) {
    return toolSequence
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .join('>');
  }

  /**
   * Hash a chain signature for dedup tracking.
   * @param {string} signature
   * @returns {string}
   */
  static hashChain(signature) {
    return createHash('sha256').update(signature).digest('hex').slice(0, 16);
  }

  /**
   * Mine execution history for repeated successful chains.
   * @param {string} goalId
   * @returns {Promise<MineResult>}
   */
  async mine(goalId) {
    const result = {
      candidatesCreated: 0,
      blueprintsActivated: 0,
      blueprintsSkippedExisting: 0,
      details: [],
    };

    // 1. Gather chain runs — use chainRuns if available, else reconstruct from events
    const chainRuns = await this._getChainRuns(goalId);
    if (!chainRuns.length) return result;

    // 2. Take only recent runs (bounded window)
    const recentRuns = chainRuns.slice(-this.lookbackRuns);

    // 3. Group by chain signature
    /** @type {Map<string, Array<{toolSequence: string[], latencyMs: number, successRate: number}>>} */
    const signatureGroups = new Map();

    for (const run of recentRuns) {
      if (run.doneReason !== 'tool_signaled_completion') continue;
      if (run.successRate < this.minSuccessRate) continue;

      const sig = ChainMiner.canonicalize(run.toolSequence);
      if (!sig) continue;

      if (!signatureGroups.has(sig)) signatureGroups.set(sig, []);
      signatureGroups.get(sig).push({
        toolSequence: run.toolSequence,
        latencyMs: run.totalLatencyMs || 0,
        successRate: run.successRate,
      });
    }

    // 4. Evaluate each signature against thresholds
    for (const [sig, runs] of signatureGroups) {
      const occurrences = runs.length;
      const avgSuccessRate = runs.reduce((s, r) => s + r.successRate, 0) / runs.length;
      const avgLatencyMs = runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length;

      const detail = {
        chainSignature: sig,
        occurrences,
        successRate: avgSuccessRate,
        avgLatencyMs: Math.round(avgLatencyMs),
        action: 'below_threshold',
      };

      if (occurrences < this.minOccurrences) {
        result.details.push(detail);
        continue;
      }
      if (avgSuccessRate < this.minSuccessRate) {
        result.details.push(detail);
        continue;
      }
      if (avgLatencyMs > this.maxAvgLatencyMs) {
        detail.action = 'below_threshold';
        result.details.push(detail);
        continue;
      }

      // 5. Check for existing blueprint with this signature
      const existingBlueprints = await this._findBlueprintBySignature(goalId, sig);
      if (existingBlueprints.length > 0) {
        const active = existingBlueprints.find(b => b.blueprintMeta?.state === 'active');
        if (active) {
          detail.action = 'skipped';
          result.blueprintsSkippedExisting++;
          result.details.push(detail);
          continue;
        }
      }

      // 6. Create blueprint trail
      // Look up existing raw trails to inherit paramsTemplate for each tool
      const existingTrails = await this.store.getCandidateTrails(goalId);
      const toolParamsMap = new Map();
      for (const t of existingTrails) {
        if (t.kind !== 'blueprint' && t.nextAction?.tool && t.nextAction.paramsTemplate) {
          if (!toolParamsMap.has(t.nextAction.tool)) {
            toolParamsMap.set(t.nextAction.tool, t.nextAction.paramsTemplate);
          }
        }
      }

      const toolSequence = runs[0].toolSequence;
      const actionSequence = toolSequence.map(tool => ({
        tool,
        paramsTemplate: toolParamsMap.get(tool) || {},
      }));

      const blueprintTrail = {
        id: randomUUID(),
        goalId,
        agentId: 'chain_miner',
        status: 'active',
        kind: 'blueprint',
        nextAction: actionSequence[0] || null,
        blueprintMeta: {
          chainSignature: sig,
          actionSequence,
          sourceChainHashes: runs.map(() => ChainMiner.hashChain(sig + Math.random())),
          sourceEventCount: occurrences,
          promotionStats: {
            avgSuccessRate,
            avgLatencyMs: Math.round(avgLatencyMs),
            avgSteps: toolSequence.length,
            avgCostUsd: 0,
          },
          preconditions: [],
          expectedDoneReason: 'tool_signaled_completion',
          version: 1,
          state: this.autoActivate ? 'active' : 'candidate',
          promotedAt: new Date().toISOString(),
        },
        steps: [],
        executionEventIds: [],
        successScore: avgSuccessRate,
        confidence: avgSuccessRate,
        weight: 0.7 + (avgSuccessRate * 0.2),
        decayRate: 0.02,
        tags: ['blueprint', sig],
        createdAt: new Date().toISOString(),
      };

      await this.store.putTrail(blueprintTrail);

      if (this.autoActivate) {
        detail.action = 'activated';
        result.blueprintsActivated++;
      } else {
        detail.action = 'created';
        result.candidatesCreated++;
      }
      result.details.push(detail);
    }

    return result;
  }

  /**
   * Get chain runs for a goal from store.
   * Uses chainRuns if available (InMemoryStore), otherwise reconstructs from events.
   * @param {string} goalId
   * @returns {Promise<Array<{goalId: string, toolSequence: string[], successRate: number, doneReason: string, totalLatencyMs: number}>>}
   */
  async _getChainRuns(goalId) {
    // Use store.getChainRuns if available (both InMemoryStore and PrismaStore)
    if (this.store.getChainRuns) {
      return this.store.getChainRuns(goalId, this.lookbackRuns);
    }

    // Legacy fallback: use chainRuns array (InMemoryStore test helper)
    if (this.store.chainRuns) {
      return this.store.chainRuns.filter(r => r.goalId === goalId).slice(-this.lookbackRuns);
    }

    return [];
  }

  /**
   * Find existing blueprints matching a chain signature for a goal.
   * @param {string} goalId
   * @param {string} chainSignature
   * @returns {Promise<Array>}
   */
  async _findBlueprintBySignature(goalId, chainSignature) {
    const allTrails = await this.store.getCandidateTrails(goalId);
    return allTrails.filter(
      t => t.kind === 'blueprint' && t.blueprintMeta?.chainSignature === chainSignature
    );
  }
}
