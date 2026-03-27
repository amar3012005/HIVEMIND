/**
 * Trail Executor — MetaEvaluator
 * HIVE-MIND Cognitive Runtime
 *
 * Batch analysis service that reads runtime data, detects issues,
 * and produces actionable recommendations. Recommends only — never auto-applies.
 *
 * @module executor/meta-evaluator
 */

import { randomUUID } from 'node:crypto';

const MIN_SAMPLES = {
  high_failure_rate: 10,
  exploration_too_low: 20,
  exploration_too_high: 20,
  blueprint_underperforming: 10,
  blueprint_stagnation: 20,
  cost_trending_up: 20,
  social_convergence: 20,
  agent_role_mismatch: 10,
};

export class MetaEvaluator {
  constructor(store, parameterRegistry) {
    this.store = store;
    this.registry = parameterRegistry;
  }

  async evaluate({ lookbackRuns = 50, goalFilter, agentFilter } = {}) {
    // Gather data
    const chainRuns = this.store.chainRuns
      ? this.store.chainRuns.slice(-lookbackRuns)
      : (this.store.getChainRuns ? await this.store.getChainRuns(goalFilter || '', lookbackRuns) : []);

    const events = (this.store.events || []).slice(-lookbackRuns * 5);
    const filteredRuns = goalFilter ? chainRuns.filter(r => r.goalId === goalFilter) : chainRuns;
    const filteredEvents = agentFilter ? events.filter(e => e.agent_id === agentFilter) : events;

    // Summary
    const totalRuns = filteredRuns.length;
    const successfulRuns = filteredRuns.filter(r => r.doneReason === 'tool_signaled_completion').length;
    const overallSuccessRate = totalRuns ? successfulRuns / totalRuns : 0;
    const blueprintRuns = filteredRuns.filter(r => r.toolSequence?.length > 1).length;
    const blueprintUsageRate = totalRuns ? blueprintRuns / totalRuns : 0;
    const avgLatencyMs = totalRuns ? Math.round(filteredRuns.reduce((s, r) => s + (r.totalLatencyMs || 0), 0) / totalRuns) : 0;

    // Route diversity
    const uniqueTrails = new Set(filteredEvents.map(e => e.routing?.selectedTrailId).filter(Boolean));
    const routeDiversity = filteredEvents.length ? uniqueTrails.size / Math.min(filteredEvents.length, 20) : 1;

    const summary = {
      totalRuns,
      overallSuccessRate: +overallSuccessRate.toFixed(3),
      blueprintUsageRate: +blueprintUsageRate.toFixed(3),
      routeDiversity: +Math.min(routeDiversity, 1).toFixed(3),
      avgLatencyMs,
      avgCostUsd: 0,
    };

    // Run detection rules
    const issues = [];
    const parameterRecommendations = [];

    // Rule 1: High failure rate
    if (totalRuns >= MIN_SAMPLES.high_failure_rate && overallSuccessRate < 0.7) {
      issues.push({
        type: 'high_failure_rate',
        severity: 'alert',
        actionable: false,
        description: `Overall success rate (${(overallSuccessRate * 100).toFixed(0)}%) below 70% threshold`,
        evidence: { successRate: overallSuccessRate, sampleSize: totalRuns },
        recommendation: { action: 'review_required', confidence: this._confidence(totalRuns, MIN_SAMPLES.high_failure_rate) },
      });
    }

    // Rule 2: Exploration too low
    if (filteredEvents.length >= MIN_SAMPLES.exploration_too_low && routeDiversity < 0.3) {
      const currentTemp = await this.registry.get('routing.temperature');
      issues.push({
        type: 'exploration_too_low',
        severity: 'info',
        actionable: true,
        description: `Route diversity (${routeDiversity.toFixed(2)}) below 0.3 — system may be over-exploiting`,
        evidence: { routeDiversity, sampleSize: filteredEvents.length },
        recommendation: { action: 'adjust_parameter', param: 'routing.temperature', from: currentTemp, to: Math.min(currentTemp + 0.3, 3.0), confidence: this._confidence(filteredEvents.length, MIN_SAMPLES.exploration_too_low) },
      });
      parameterRecommendations.push({
        param: 'routing.temperature',
        currentValue: currentTemp,
        recommendedValue: Math.min(currentTemp + 0.3, 3.0),
        reason: 'Route diversity too low, increase temperature for more exploration',
        confidence: this._confidence(filteredEvents.length, MIN_SAMPLES.exploration_too_low),
        evidenceSampleSize: filteredEvents.length,
        expectedTradeoff: 'More exploration, slightly lower average success rate',
      });
    }

    // Rule 3: Exploration too high
    if (filteredEvents.length >= MIN_SAMPLES.exploration_too_high && routeDiversity > 0.9 && overallSuccessRate < 0.7) {
      const currentTemp = await this.registry.get('routing.temperature');
      issues.push({
        type: 'exploration_too_high',
        severity: 'warning',
        actionable: true,
        description: `Route diversity (${routeDiversity.toFixed(2)}) very high with low success — system may be under-exploiting`,
        evidence: { routeDiversity, successRate: overallSuccessRate, sampleSize: filteredEvents.length },
        recommendation: { action: 'adjust_parameter', param: 'routing.temperature', from: currentTemp, to: Math.max(currentTemp - 0.3, 0.1), confidence: this._confidence(filteredEvents.length, MIN_SAMPLES.exploration_too_high) },
      });
    }

    // Rule 4: Blueprint stagnation
    const allTrails = [...(this.store.trails?.values() || [])];
    const activeBps = allTrails.filter(t => t.kind === 'blueprint' && t.blueprintMeta?.state === 'active');
    for (const bp of activeBps) {
      const bpEvents = filteredEvents.filter(e => e.trail_id === bp.id);
      if (filteredEvents.length >= MIN_SAMPLES.blueprint_stagnation && bpEvents.length === 0) {
        issues.push({
          type: 'blueprint_stagnation',
          severity: 'info',
          actionable: true,
          description: `Blueprint '${bp.blueprintMeta.chainSignature}' is active but never selected in ${filteredEvents.length} recent executions`,
          evidence: { chainSignature: bp.blueprintMeta.chainSignature, eligibleRuns: filteredEvents.length, selections: 0 },
          recommendation: { action: 'deprecate_blueprint', target: bp.id, confidence: 'medium' },
        });
      }
    }

    // Rule 5: Social convergence
    if (filteredEvents.length >= MIN_SAMPLES.social_convergence) {
      const agentCounts = {};
      for (const e of filteredEvents) {
        const tid = e.routing?.selectedTrailId;
        if (tid) {
          const trail = this.store.trails?.get(tid);
          if (trail?.agentId) {
            agentCounts[trail.agentId] = (agentCounts[trail.agentId] || 0) + 1;
          }
        }
      }
      for (const [aid, count] of Object.entries(agentCounts)) {
        if (count / filteredEvents.length > 0.6) {
          issues.push({
            type: 'social_convergence',
            severity: 'warning',
            actionable: true,
            description: `Agent '${aid}' trails dominate ${((count / filteredEvents.length) * 100).toFixed(0)}% of selections`,
            evidence: { agentId: aid, selectionRate: count / filteredEvents.length, sampleSize: filteredEvents.length },
            recommendation: { action: 'adjust_parameter', param: 'routing.forceWeights.social', to: 0.1, confidence: 'medium' },
          });
        }
      }
    }

    const systemStable = issues.length === 0;

    const report = {
      evaluatedAt: new Date().toISOString(),
      window: { runs: lookbackRuns, goalFilter: goalFilter || null, agentFilter: agentFilter || null },
      summary,
      systemStable,
      issues,
      parameterRecommendations,
      agentInsights: [],
    };

    // Log evaluation
    if (this.store.writeObservation) {
      try {
        await this.store.writeObservation({
          id: randomUUID(),
          agent_id: 'meta_evaluator',
          kind: 'meta_evaluation',
          content: { window: { runs: lookbackRuns }, issuesFound: issues.length, recommendationsProduced: parameterRecommendations.length, systemStable },
          certainty: 0.8,
        });
      } catch { /* best effort */ }
    }

    return report;
  }

  _confidence(sampleSize, minRequired) {
    if (sampleSize < minRequired * 2) return 'low';
    if (sampleSize >= minRequired * 3) return 'high';
    return 'medium';
  }
}
