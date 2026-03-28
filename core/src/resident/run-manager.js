import { randomUUID } from 'node:crypto';
import {
  FARADAY_OBSERVATION_FIELDS,
  RESIDENT_AGENT_IDS,
  RESIDENT_RUN_STATES,
} from './contract.js';
import { FaradayAgent } from './faraday.js';

function nowIso() {
  return new Date().toISOString();
}

function buildAgentDescriptor(agentId) {
  const base = {
    agent_id: agentId,
    role: 'explorer',
    status: agentId === 'faraday' ? 'active' : 'planned',
    source: agentId === 'faraday' ? 'explicit' : 'planned',
    capabilities: [],
  };

  if (agentId === 'faraday') {
    return {
      ...base,
      name: 'Faraday',
      capabilities: ['graph_walk', 'anomaly_detect', 'write_observation'],
      default_scope: 'project',
    };
  }

  if (agentId === 'feynman') {
    return {
      ...base,
      name: 'Feynman',
      role: 'analyst',
      capabilities: ['hypothesis_form', 'causal_explain', 'link_evidence'],
      default_scope: 'project',
    };
  }

  return {
    ...base,
    name: 'Turing',
    role: 'verifier',
    capabilities: ['verify_hypothesis', 'score_confidence', 'promote_finding'],
    default_scope: 'project',
  };
}

export class ResidentRunManager {
  constructor({ executorStore, memoryStore, store, graphStore, logger = console } = {}) {
    this.executorStore = executorStore || store || null;
    this.memoryStore = memoryStore || graphStore || null;
    this.logger = logger;
    this.runs = new Map();
    this.agentDescriptors = RESIDENT_AGENT_IDS.map(buildAgentDescriptor);
    this.faraday = new FaradayAgent({
      memoryStore: this.memoryStore,
      observationStore: this.executorStore,
      logger,
    });
  }

  async seedAgents() {
    if (!this.executorStore?.ensureAgent) return;
    await Promise.all(
      this.agentDescriptors.map((descriptor) => this.executorStore.ensureAgent(descriptor.agent_id, {
        role: descriptor.role,
        source: descriptor.source,
        skills: descriptor.capabilities,
      }).catch(() => null))
    );
  }

  listAgents() {
    return this.agentDescriptors.map((agent) => ({
      ...agent,
      run_states: RESIDENT_RUN_STATES,
      observation_fields: FARADAY_OBSERVATION_FIELDS,
      active_runs: [...this.runs.values()].filter((run) => run.agent_id === agent.agent_id && run.status === 'running').length,
      last_run_at: [...this.runs.values()]
        .filter((run) => run.agent_id === agent.agent_id && run.started_at)
        .sort((left, right) => new Date(right.started_at) - new Date(left.started_at))[0]?.started_at || null,
    }));
  }

  async runAgent(agentId, payload = {}, context = {}) {
    if (agentId !== 'faraday') {
      const run = this._createRun(agentId, payload, context);
      run.status = 'failed';
      run.error = 'Only Faraday is implemented in V1';
      run.finished_at = nowIso();
      run.updated_at = run.finished_at;
      this.runs.set(run.run_id, run);
      return this._publicRun(run);
    }

    const run = this._createRun(agentId, payload, context);
    this.runs.set(run.run_id, run);
    this._executeFaraday(run, payload, context).catch((error) => {
      const current = this.runs.get(run.run_id);
      if (!current || current.status === 'cancelled') return;
      current.status = 'failed';
      current.error = error.message || 'Faraday run failed';
      current.updated_at = nowIso();
      current.finished_at = nowIso();
    });
    return this._publicRun(run);
  }

  async startRun(agentId, payload = {}, context = {}) {
    return this.runAgent(agentId, payload, context);
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    return run ? this._publicRun(run) : null;
  }

  getRunObservations(runId) {
    const run = this.runs.get(runId);
    if (!run) return { observations: [], count: 0 };
    return {
      observations: [...run.observations],
      count: run.observations.length,
    };
  }

  cancelRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.cancel_requested = true;
    run.status = 'cancelled';
    run.cancelled_at = nowIso();
    run.updated_at = run.cancelled_at;
    run.finished_at = run.cancelled_at;
    return this._publicRun(run);
  }

  async _executeFaraday(run, payload, context) {
    run.status = 'running';
    run.started_at = run.started_at || nowIso();
    run.updated_at = nowIso();
    this.runs.set(run.run_id, run);

    const result = await this.faraday.run({
      agentId: run.agent_id,
      userId: context.userId,
      orgId: context.orgId,
      scope: run.scope,
      project: run.project,
      region: run.region,
      goal: run.goal,
      dryRun: run.dry_run,
      runId: run.run_id,
      onProgress: async (progress) => {
        run.current_step = progress.current_step;
        run.progress = progress;
        run.updated_at = nowIso();
        this.runs.set(run.run_id, run);
      },
      isCancelled: () => run.cancel_requested === true,
    });

    if (run.cancel_requested) {
      run.status = 'cancelled';
      run.cancelled_at = run.cancelled_at || nowIso();
    } else {
      run.status = result.status || 'completed';
    }

    run.result = result;
    run.observations = Array.isArray(result.observations) ? result.observations : [];
    run.observations_count = result.observations_count ?? run.observations.length;
    run.current_step = result.current_step || run.current_step;
    run.summary = result.summary || null;

    const trailMark = this._buildTrailMark(run, result);
    if (trailMark && this.executorStore?.putTrail) {
      try {
        await this.executorStore.putTrail(trailMark);
      } catch (error) {
        this.logger?.warn?.('[Resident] Failed to persist Faraday trail mark:', error?.message || error);
      }
    }
    run.trail_mark = trailMark || null;
    if (run.result && trailMark) {
      run.result = { ...run.result, trail_mark: trailMark };
    }

    run.updated_at = nowIso();
    run.finished_at = run.status === 'running' ? null : (run.finished_at || nowIso());
    this.runs.set(run.run_id, run);
    return this._publicRun(run);
  }

  _buildTrailMark(run, result) {
    const semanticClusters = Array.isArray(result?.summary?.semantic_clusters)
      ? result.summary.semantic_clusters
      : [];
    const topCluster = semanticClusters[0] || null;
    const semanticProbes = Array.isArray(result?.summary?.semantic_probes)
      ? result.summary.semantic_probes
      : [];
    const semanticSeedIds = Array.isArray(result?.summary?.semantic_seeds)
      ? result.summary.semantic_seeds
      : [];
    const observationIds = Array.isArray(result?.observations)
      ? result.observations.map((observation) => observation.id).filter(Boolean)
      : [];

    const trailId = randomUUID();
    const markKey = `resident-faraday:${run.run_id}`;
    const goalId = `resident:${run.scope}:${run.project || 'workspace'}`;
    const label = topCluster?.label || 'semantic scan';
    const nextAgentPrompt = topCluster
      ? `Follow the semantic trail mark for "${topCluster.label}" and verify whether it is a real risk cluster.`
      : `Follow the strongest semantic region in this scope and verify whether it contains a genuine anomaly.`;

    return {
      id: trailId,
      trail_id: trailId,
      mark_key: markKey,
      goalId,
      agentId: 'faraday',
      status: 'active',
      kind: 'resident_mark',
      summary: topCluster
        ? `Follow ${topCluster.label} as the leading semantic trail mark.`
        : `Follow the highest-signal semantic cluster for ${run.scope}.`,
      next_agent_prompt: nextAgentPrompt,
      semantic_probes: semanticProbes,
      semantic_seeds: semanticSeedIds,
      semantic_clusters: semanticClusters,
      observation_ids: observationIds,
      blueprintMeta: {
        resident_mark: true,
        mark_key: markKey,
        run_id: run.run_id,
        scope: run.scope,
        project: run.project,
        region: run.region,
        goal: run.goal,
        semantic_probes: semanticProbes,
        semantic_seeds: semanticSeedIds,
        semantic_clusters: semanticClusters,
        observation_ids: observationIds,
        next_agent_prompt: nextAgentPrompt,
      },
      nextAction: {
        toolName: 'resident.follow_mark',
        params: {
          run_id: run.run_id,
          trail_id: trailId,
          mark_key: markKey,
          scope: run.scope,
          project: run.project,
          region: run.region,
          semantic_cluster: label,
        },
        rationale: nextAgentPrompt,
      },
      steps: [
        {
          index: 0,
          status: 'succeeded',
          action: {
            toolName: 'resident.semantic_probe',
            params: {
              probes: semanticProbes,
            },
          },
          resultSummary: topCluster
            ? `Semantic trail mark recorded for ${topCluster.label} (${topCluster.count} memories).`
            : 'Semantic trail mark recorded for the strongest available region.',
          tokensUsed: 0,
          durationMs: 0,
          timestamp: Date.now(),
        },
      ],
      executionEventIds: [],
      successScore: topCluster ? Math.min(1, 0.4 + (topCluster.count * 0.1)) : 0.35,
      confidence: topCluster?.score ? Math.min(1, topCluster.score / 10) : 0.45,
      weight: topCluster ? Math.min(1, 0.6 + (topCluster.count * 0.05)) : 0.5,
      decayRate: 0.02,
      tags: [
        'resident',
        'faraday',
        'semantic_mark',
        `scope:${run.scope}`,
        ...(run.project ? [`project:${run.project}`] : []),
      ],
      createdAt: nowIso(),
    };
  }

  _createRun(agentId, payload, context) {
    const createdAt = nowIso();
    return {
      run_id: randomUUID(),
      agent_id: agentId,
      status: 'queued',
      scope: payload.scope || 'project',
      goal: payload.goal || '',
      project: payload.project || null,
      region: payload.region || null,
      dry_run: payload.dry_run === true,
      started_at: null,
      updated_at: createdAt,
      finished_at: null,
      cancelled_at: null,
      current_step: 'queued',
      observations_count: 0,
      observations: [],
      progress: { step: 0, total_steps: 4, percent: 0 },
      result: null,
      error: null,
      cancel_requested: false,
      user_id: context.userId || null,
      org_id: context.orgId || null,
    };
  }

  _publicRun(run) {
    return {
      run_id: run.run_id,
      agent_id: run.agent_id,
      status: run.status,
      scope: run.scope,
      goal: run.goal,
      project: run.project,
      region: run.region,
      dry_run: run.dry_run,
      started_at: run.started_at,
      updated_at: run.updated_at,
      finished_at: run.finished_at,
      cancelled_at: run.cancelled_at,
      current_step: run.current_step,
      observations_count: run.observations_count,
      progress: run.progress,
      result: run.result,
      trail_mark: run.trail_mark || null,
      error: run.error,
    };
  }
}
