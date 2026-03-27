/**
 * Trail Executor — Dashboard
 * HIVE-MIND Cognitive Runtime
 *
 * Read-only analytics queries over existing op/* and meta/* tables.
 * Returns stable API contracts that don't leak table structure.
 *
 * @module executor/dashboard
 */

export class Dashboard {
  constructor(store) {
    this.store = store;
  }

  _windowFilter(timestamp, window) {
    if (window === 'all') return true;
    const now = Date.now();
    const ts = new Date(timestamp).getTime();
    const windows = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    const ms = windows[window] || windows['7d'];
    return ts >= now - ms;
  }

  async overview({ window = '7d' } = {}) {
    const allEvents = (this.store.events || []).filter(e => this._windowFilter(e.timestamp || e.created_at, window));
    const total = allEvents.length;
    const successful = allEvents.filter(e => e.success).length;
    const successRate = total ? successful / total : 0;
    const avgLatencyMs = total ? Math.round(allEvents.reduce((s, e) => s + (e.latency_ms || 0), 0) / total) : 0;

    // Done reasons from chain runs
    const chainRuns = (this.store.chainRuns || []);
    const doneReasons = {};
    for (const run of chainRuns) {
      doneReasons[run.doneReason] = (doneReasons[run.doneReason] || 0) + 1;
    }

    // Blueprints
    const allTrails = [...(this.store.trails?.values() || [])];
    const blueprints = allTrails.filter(t => t.kind === 'blueprint');
    const activeBp = blueprints.filter(b => b.blueprintMeta?.state === 'active').length;
    const candidateBp = blueprints.filter(b => b.blueprintMeta?.state === 'candidate').length;
    const deprecatedBp = blueprints.filter(b => b.blueprintMeta?.state === 'deprecated').length;

    const bpEvents = allEvents.filter(e => {
      const trail = this.store.trails?.get(e.trail_id);
      return trail?.kind === 'blueprint';
    });
    const usageRate = total ? bpEvents.length / total : 0;
    const bpSuccess = bpEvents.length ? bpEvents.filter(e => e.success).length / bpEvents.length : 0;

    // Agents
    const agents = this.store._agents ? [...this.store._agents.values()] : [];
    const activeAgents = agents.filter(a => a.status === 'active').length;
    const reps = this.store._reputations ? [...this.store._reputations.values()] : [];
    const avgAgentSuccess = reps.length ? reps.reduce((s, r) => s + (r.success_rate || 0), 0) / reps.length : 0;
    const topAgent = reps.sort((a, b) => (b.success_rate || 0) - (a.success_rate || 0))[0];

    // Routing force contributions (averaged)
    const routingEvents = allEvents.filter(e => e.routing?.forceVector);
    const forceContributions = {};
    const forceKeys = ['goalAttraction', 'affordanceAttraction', 'blueprintBoost', 'socialAttraction', 'momentum', 'conflictRepulsion', 'congestionRepulsion', 'costRepulsion'];
    for (const key of forceKeys) {
      const vals = routingEvents.map(e => e.routing.forceVector[key] || 0);
      forceContributions[key] = vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4) : 0;
    }
    const avgTemperature = routingEvents.length
      ? +(routingEvents.reduce((s, e) => s + (e.routing.temperature || 1), 0) / routingEvents.length).toFixed(2) : 1.0;

    return {
      window,
      executions: { total, successRate: +successRate.toFixed(3), avgLatencyMs, doneReasons },
      blueprints: {
        active: activeBp, candidates: candidateBp, deprecated: deprecatedBp,
        usageRate: +usageRate.toFixed(3),
        rawVsBlueprintSelectionRate: { raw: +(1 - usageRate).toFixed(3), blueprint: +usageRate.toFixed(3) },
        avgBlueprintSuccessRate: +bpSuccess.toFixed(3),
      },
      agents: {
        total: agents.length, active: activeAgents,
        avgSuccessRate: +avgAgentSuccess.toFixed(3),
        topAgent: topAgent ? { agent_id: topAgent.agent_id, success_rate: topAgent.success_rate } : null,
      },
      routing: {
        avgTemperature,
        forceContributions,
        note: 'Force contributions and avgTemperature are computed from effective routing config used in actual executions',
      },
    };
  }

  async executions({ limit = 50, agentId, goal, window = '7d' } = {}) {
    let events = (this.store.events || []).filter(e => this._windowFilter(e.timestamp || e.created_at, window));
    if (agentId) events = events.filter(e => e.agent_id === agentId);
    if (goal) events = events.filter(e => e.trail_id?.includes(goal));
    events = events.slice(-limit);
    return { executions: events, count: events.length };
  }

  async blueprints({ window = '7d' } = {}) {
    const allTrails = [...(this.store.trails?.values() || [])];
    const bps = allTrails.filter(t => t.kind === 'blueprint');
    const allEvents = (this.store.events || []).filter(e => this._windowFilter(e.timestamp || e.created_at, window));

    return {
      blueprints: bps.map(bp => {
        const bpEvents = allEvents.filter(e => e.trail_id === bp.id);
        const totalExec = bpEvents.length;
        const successCount = bpEvents.filter(e => e.success).length;
        return {
          chainSignature: bp.blueprintMeta?.chainSignature,
          state: bp.blueprintMeta?.state,
          totalExecutions: totalExec,
          successRate: totalExec ? +(successCount / totalExec).toFixed(3) : 0,
          avgLatencyMs: totalExec ? Math.round(bpEvents.reduce((s, e) => s + (e.latency_ms || 0), 0) / totalExec) : 0,
          weight: bp.weight,
        };
      }),
    };
  }

  async agents({ window = '7d' } = {}) {
    const agentList = this.store._agents ? [...this.store._agents.values()] : [];
    const reps = this.store._reputations || new Map();

    return {
      agents: agentList.map(a => {
        const rep = reps.get(a.agent_id);
        const topSkills = rep?.skill_scores
          ? Object.entries(rep.skill_scores)
              .sort(([, a], [, b]) => (b.success_rate || 0) - (a.success_rate || 0))
              .slice(0, 3)
              .map(([tool, s]) => ({ tool, success_rate: s.success_rate }))
          : [];
        return {
          agent_id: a.agent_id,
          role: a.role,
          source: a.source,
          status: a.status,
          successRate: rep?.success_rate ?? 0,
          totalExecutions: rep?.recent_attempts ?? 0,
          topSkills,
          specialization: rep?.specialization_confidence ?? {},
          blueprintUsageRate: 0, // computed from events if needed
        };
      }),
    };
  }
}
