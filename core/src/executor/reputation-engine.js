/**
 * Trail Executor — Reputation Engine
 * HIVE-MIND Cognitive Runtime
 *
 * Updates agent reputation from execution outcomes using exponential
 * moving averages. Computes specialization confidence from behavior.
 *
 * @module executor/reputation-engine
 */

const DEFAULT_REPUTATION = {
  success_rate: 0.5,
  avg_confidence: 0.5,
  skill_scores: {},
  blueprint_scores: {},
  specialization_confidence: { explorer: 0, operator: 0, evaluator: 0 },
  recent_attempts: 0,
};

const EMA_ALPHA = 0.1;
const MIN_EVIDENCE = 10;
const MAX_CONFIDENCE_WITHOUT_EVIDENCE = 0.6;

export class ReputationEngine {
  constructor(store) {
    this.store = store;
  }

  async getReputation(agentId) {
    const stored = await this.store.getReputation(agentId);
    const base = structuredClone(DEFAULT_REPUTATION);
    if (stored) return { ...base, ...stored };
    return { ...base, agent_id: agentId };
  }

  async updateFromExecution(agentId, result) {
    const rep = await this.getReputation(agentId);
    const cs = result.chainSummary;
    if (!cs) return;

    const α = EMA_ALPHA;

    // 1. Agent-level success
    const execSuccess = cs.doneReason === 'tool_signaled_completion' ? 1.0 : 0.0;
    rep.success_rate = rep.success_rate * (1 - α) + execSuccess * α;
    rep.avg_confidence = rep.avg_confidence * (1 - α) + (execSuccess > 0.5 ? 0.9 : 0.3) * α;

    // 2. Per-tool skill scores
    const toolSeq = cs.toolSequence || [];
    const perToolLatency = cs.totalLatencyMs && toolSeq.length ? cs.totalLatencyMs / toolSeq.length : 50;

    for (const tool of toolSeq) {
      const existing = rep.skill_scores[tool] || { success_rate: 0.5, avg_latency_ms: 100, executions: 0 };
      existing.success_rate = existing.success_rate * (1 - α) + execSuccess * α;
      existing.avg_latency_ms = existing.avg_latency_ms * (1 - α) + perToolLatency * α;
      existing.executions++;
      rep.skill_scores[tool] = existing;
    }

    // 3. Blueprint scores
    if (cs.usedBlueprint && cs.blueprintChainSignature) {
      const sig = cs.blueprintChainSignature;
      const existing = rep.blueprint_scores[sig] || { success_rate: 0.5, executions: 0 };
      existing.success_rate = existing.success_rate * (1 - α) + execSuccess * α;
      existing.executions++;
      rep.blueprint_scores[sig] = existing;
    }

    // 4. Specialization confidence
    rep.recent_attempts++;
    rep.specialization_confidence = this._computeSpecialization(rep);

    // 5. Persist
    await this.store.updateReputation(agentId, rep);

    // 6. Update agent last_seen_at
    if (this.store.updateAgentLastSeen) {
      await this.store.updateAgentLastSeen(agentId);
    }
  }

  _computeSpecialization(rep) {
    const cap = rep.recent_attempts >= MIN_EVIDENCE ? 1.0 : MAX_CONFIDENCE_WITHOUT_EVIDENCE;

    const uniqueTools = Object.keys(rep.skill_scores).length;
    const bpScores = Object.values(rep.blueprint_scores);
    const totalBpExecs = bpScores.reduce((s, b) => s + (b.executions || 0), 0);
    const avgBpSuccess = bpScores.length
      ? bpScores.reduce((s, b) => s + b.success_rate, 0) / bpScores.length : 0;

    const explorer = Math.min(
      (uniqueTools > 2 ? 0.3 : 0.1) +
      (rep.recent_attempts > 20 ? 0.2 : 0.0) +
      (totalBpExecs < 3 ? 0.2 : 0.0) +
      (rep.success_rate * 0.3),
      cap,
    );

    const operatorCap = totalBpExecs >= MIN_EVIDENCE ? 1.0 : MAX_CONFIDENCE_WITHOUT_EVIDENCE;
    const operator = Math.min(
      (avgBpSuccess * 0.4) +
      (rep.success_rate * 0.4) +
      (rep.recent_attempts > 10 ? 0.2 : 0.0),
      Math.min(cap, operatorCap),
    );

    const evaluator = 0.0;

    return { explorer, operator, evaluator };
  }
}
