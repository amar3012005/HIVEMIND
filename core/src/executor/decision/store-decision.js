// core/src/executor/decision/store-decision.js

/**
 * Decision Intelligence — Decision Store
 *
 * Writer only — does not judge. Persists decision objects as memories
 * with memory_type "decision". Handles merge-on-decision_key.
 *
 * @module executor/decision/store-decision
 */

import { randomUUID } from 'node:crypto';

/**
 * Compute decision status from promotion rules.
 * @param {number} confidence - LLM classification confidence
 * @param {number} evidenceStrength - cross-platform corroboration
 * @param {number} uniquePlatformCount - number of distinct evidence platforms
 * @returns {{ status: string, state_reason: string }}
 */
export function computeDecisionStatus(confidence, evidenceStrength, uniquePlatformCount) {
  if (confidence >= 0.8 && uniquePlatformCount >= 2) {
    return { status: 'validated', state_reason: 'cross_platform_corroborated' };
  }
  if (confidence >= 0.6) {
    return { status: 'candidate', state_reason: uniquePlatformCount < 2 ? 'single_source_only' : 'moderate_confidence' };
  }
  return { status: 'candidate', state_reason: 'low_classifier_confidence' };
}

/**
 * Store a decision object as a memory. Handles merge-on-decision_key.
 * @param {{ decision_object: object }} input
 * @param {object} memoryStore - PrismaGraphStore with searchMemories, createMemory
 * @returns {Promise<{ decision_id: string, status: string, merged: boolean, stored: boolean, done: boolean }>}
 */
export async function storeDecision({ decision_object }, memoryStore) {
  if (!memoryStore) {
    return { decision_id: null, status: 'error', merged: false, stored: false, done: true };
  }

  const dKey = decision_object.decision_key;

  // Check for existing decision with same key (merge-on-key)
  let merged = false;
  if (dKey && memoryStore.searchMemories) {
    const existing = await memoryStore.searchMemories({
      query: decision_object.decision_statement,
      memory_type: 'decision',
      n_results: 5,
    });

    for (const ex of existing) {
      const exMeta = ex.metadata || {};
      if (exMeta.decision_key === dKey) {
        // Merge: add new evidence to existing
        const existingEvidence = exMeta.evidence || { supporting: [], conflicting: [] };
        const newSupporting = decision_object.evidence?.supporting || [];
        const newConflicting = decision_object.evidence?.conflicting || [];

        existingEvidence.supporting = [...existingEvidence.supporting, ...newSupporting];
        existingEvidence.conflicting = [...existingEvidence.conflicting, ...newConflicting];

        // Re-evaluate status after merge
        const uniquePlatforms = new Set(existingEvidence.supporting.map(e => e.platform));
        const { status, state_reason } = computeDecisionStatus(
          Math.max(exMeta.confidence || 0, decision_object.confidence || 0),
          decision_object.evidence_strength || 0,
          uniquePlatforms.size,
        );

        // Update existing memory (if store supports it)
        if (memoryStore.updateMemory) {
          await memoryStore.updateMemory(ex.id, {
            metadata: {
              ...exMeta,
              evidence: existingEvidence,
              status,
              decision_state_reason: state_reason,
              confidence: Math.max(exMeta.confidence || 0, decision_object.confidence || 0),
            },
          });
        }

        return { decision_id: ex.id, status, merged: true, stored: true, done: true };
      }
    }
  }

  // Create new decision memory
  const id = randomUUID();
  const { status, state_reason } = computeDecisionStatus(
    decision_object.confidence || 0,
    decision_object.evidence_strength || 0,
    new Set((decision_object.evidence?.supporting || []).map(e => e.platform)).size,
  );

  const memory = {
    id,
    content: decision_object.decision_statement,
    memory_type: 'decision',
    tags: decision_object.tags || [],
    source_platform: decision_object.source_platform || 'unknown',
    metadata: {
      ...decision_object,
      status,
      decision_state_reason: state_reason,
      review_status: 'unreviewed',
    },
  };

  if (memoryStore.createMemory) {
    await memoryStore.createMemory(memory);
  }

  return { decision_id: id, status, merged: false, stored: true, done: true };
}
