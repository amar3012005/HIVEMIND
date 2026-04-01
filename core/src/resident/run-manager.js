import { randomUUID } from 'node:crypto';
import {
  FARADAY_OBSERVATION_FIELDS,
  FEYNMAN_OBSERVATION_FIELDS,
  RESIDENT_AGENT_IDS,
  RESIDENT_RUN_STATES,
  TURING_OBSERVATION_FIELDS,
} from './contract.js';
import { FaradayAgent } from './faraday.js';
import { FeynmanAgent } from './feynman.js';
import { TuringAgent } from './turing.js';

function nowIso() {
  return new Date().toISOString();
}

function buildAgentDescriptor(agentId) {
  const base = {
    agent_id: agentId,
    role: 'explorer',
    status: 'active',
    source: 'explicit',
    capabilities: [],
    skills: [],
  };

  if (agentId === 'faraday') {
    return {
      ...base,
      name: 'Faraday',
      capabilities: ['graph_walk', 'anomaly_detect', 'write_observation'],
      skills: ['semantic_probe', 'duplicate_cluster_detection', 'stale_signal_detection', 'trail_marking'],
      default_scope: 'project',
      summary: 'Explorer that scans the graph for semantic anomalies, duplicate clusters, stale assumptions, and weakly connected regions.',
      persona: 'Restless graph scout. High-recall, skeptical of silence, optimized to notice weak signals before they become findings.',
      goal: 'Map suspicious semantic regions, leave trails, and surface evidence-rich anomalies for the next resident agent.',
      reasoning_style: 'heuristic_semantic_scan',
    };
  }

  if (agentId === 'feynman') {
    return {
      ...base,
      name: 'Feynman',
      role: 'analyst',
      capabilities: ['hypothesis_form', 'causal_explain', 'link_evidence'],
      skills: ['causal_reasoning', 'evidence_linking', 'contradiction_spotting', 'hypothesis_structuring'],
      default_scope: 'project',
      summary: 'Analyst that explains Faraday trails, turns evidence into hypotheses, and prepares verification-ready claims.',
      persona: 'Patient explainer. Turns clusters into understandable mechanisms and asks what assumption ties the evidence together.',
      goal: 'Convert raw resident trails into explicit, testable hypotheses with rationale, evidence summaries, and verification checks.',
      reasoning_style: 'causal_synthesis',
    };
  }

  return {
    ...base,
    name: 'Turing',
    role: 'verifier',
    capabilities: ['verify_hypothesis', 'score_confidence', 'promote_finding'],
    skills: ['cross_memory_verification', 'noise_reduction', 'relationship_recommendation', 'promotion_gating'],
    default_scope: 'project',
    summary: 'Verifier that tests Feynman hypotheses, suppresses noise, recommends merges and links, and gates promotion into graph knowledge.',
    persona: 'Adversarial skeptic. Prefers evidence spread over eloquence, rejects weak patterns, and only advances findings that reshape the graph safely.',
    goal: 'Reduce noise, connect related nodes, identify merge and update candidates, and decide which findings deserve promotion.',
    reasoning_style: 'verification_and_graph_shaping',
  };
}

export class ResidentRunManager {
  constructor({ executorStore, memoryStore, store, graphStore, reputationEngine, chainMiner, logger = console } = {}) {
    this.executorStore = executorStore || store || null;
    this.memoryStore = memoryStore || graphStore || null;
    this.reputationEngine = reputationEngine || null;
    this.chainMiner = chainMiner || null;
    this.logger = logger;
    this.runs = new Map();
    this.agentDescriptors = RESIDENT_AGENT_IDS.map(buildAgentDescriptor);
    this.faraday = new FaradayAgent({
      memoryStore: this.memoryStore,
      observationStore: this.executorStore,
      logger,
    });
    this.feynman = new FeynmanAgent({
      observationStore: this.executorStore,
      logger,
    });
    this.turing = new TuringAgent({
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
        skills: descriptor.skills?.length ? descriptor.skills : descriptor.capabilities,
      }).catch(() => null))
    );
  }

  listAgents() {
    return this.agentDescriptors.map((agent) => ({
      ...agent,
      run_states: RESIDENT_RUN_STATES,
      observation_fields: agent.agent_id === 'feynman'
        ? FEYNMAN_OBSERVATION_FIELDS
        : agent.agent_id === 'turing'
          ? TURING_OBSERVATION_FIELDS
          : FARADAY_OBSERVATION_FIELDS,
      active_runs: [...this.runs.values()].filter((run) => run.agent_id === agent.agent_id && run.status === 'running').length,
      last_run_at: [...this.runs.values()]
        .filter((run) => run.agent_id === agent.agent_id && run.started_at)
        .sort((left, right) => new Date(right.started_at) - new Date(left.started_at))[0]?.started_at || null,
    }));
  }

  async runAgent(agentId, payload = {}, context = {}) {
    if (!['faraday', 'feynman', 'turing'].includes(agentId)) {
      const run = this._createRun(agentId, payload, context);
      run.status = 'failed';
      run.error = 'Only Faraday, Feynman, and Turing are implemented in V1';
      run.finished_at = nowIso();
      run.updated_at = run.finished_at;
      this.runs.set(run.run_id, run);
      return this._publicRun(run);
    }

    const run = this._createRun(agentId, payload, context);
    this.runs.set(run.run_id, run);
    const executor = agentId === 'feynman'
      ? this._executeFeynman.bind(this)
      : agentId === 'turing'
        ? this._executeTuring.bind(this)
        : this._executeFaraday.bind(this);
    executor(run, payload, context).catch((error) => {
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

    const trailMark = result?.trail_mark?.id ? result.trail_mark : this._buildTrailMark(run, result);
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

    if (run.status === 'completed') {
      try { await this._onRunCompleted(run, result); } catch {}
    }

    return this._publicRun(run);
  }

  async _executeFeynman(run, payload, context) {
    run.status = 'running';
    run.started_at = run.started_at || nowIso();
    run.updated_at = nowIso();
    this.runs.set(run.run_id, run);

    const source = await this._resolveFeynmanSource(payload, run);
    if (!source) {
      run.status = 'failed';
      run.error = 'No completed Faraday run was available for Feynman to explain.';
      run.updated_at = nowIso();
      run.finished_at = nowIso();
      this.runs.set(run.run_id, run);
      return this._publicRun(run);
    }

    const result = await this.feynman.run({
      agentId: run.agent_id,
      scope: run.scope,
      project: run.project,
      region: run.region,
      goal: run.goal,
      dryRun: run.dry_run,
      runId: run.run_id,
      faradayRun: source.run,
      faradayTrail: source.trail,
      faradayObservations: source.observations,
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

    const trailMark = result?.trail_mark || null;
    if (trailMark && this.executorStore?.putTrail) {
      try {
        await this.executorStore.putTrail(trailMark);
      } catch (error) {
        this.logger?.warn?.('[Resident] Failed to persist Feynman hypothesis mark:', error?.message || error);
      }
    }
    run.trail_mark = trailMark;
    if (run.result && trailMark) {
      run.result = { ...run.result, trail_mark: trailMark };
    }

    run.updated_at = nowIso();
    run.finished_at = run.status === 'running' ? null : (run.finished_at || nowIso());
    this.runs.set(run.run_id, run);

    if (run.status === 'completed') {
      try { await this._onRunCompleted(run, result); } catch {}
    }

    return this._publicRun(run);
  }

  async _executeTuring(run, payload, context) {
    run.status = 'running';
    run.started_at = run.started_at || nowIso();
    run.updated_at = nowIso();
    this.runs.set(run.run_id, run);

    const source = await this._resolveTuringSource(payload, run);
    this.logger?.log?.(`[turing] Resolved source: hypotheses=${source?.hypotheses?.length || 0}, run=${source?.run?.run_id || 'none'}`);
    if (!source) {
      run.status = 'failed';
      run.error = 'No completed Feynman run was available for Turing to verify.';
      run.updated_at = nowIso();
      run.finished_at = nowIso();
      this.runs.set(run.run_id, run);
      return this._publicRun(run);
    }

    const result = await this.turing.run({
      agentId: run.agent_id,
      scope: run.scope,
      project: run.project,
      region: run.region,
      goal: run.goal,
      dryRun: run.dry_run,
      runId: run.run_id,
      feynmanRun: source.run,
      feynmanTrail: source.trail,
      hypotheses: source.hypotheses,
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

    const trailMark = result?.trail_mark || null;
    if (trailMark && this.executorStore?.putTrail) {
      try {
        await this.executorStore.putTrail(trailMark);
      } catch (error) {
        this.logger?.warn?.('[Resident] Failed to persist Turing verification mark:', error?.message || error);
      }
    }
    run.trail_mark = trailMark;
    if (run.result && trailMark) {
      run.result = { ...run.result, trail_mark: trailMark };
    }

    run.updated_at = nowIso();
    run.finished_at = run.status === 'running' ? null : (run.finished_at || nowIso());
    this.runs.set(run.run_id, run);

    if (run.status === 'completed') {
      try { await this._onRunCompleted(run, result); } catch {}
    }

    return this._publicRun(run);
  }

  async _resolveFeynmanSource(payload, run) {
    const explicitRunId = payload.run_id || payload.runId || null;
    const explicitTrailId = payload.trail_id || payload.trailId || null;

    if (explicitRunId) {
      const sourceRun = this.runs.get(explicitRunId) || null;
      if (sourceRun?.agent_id === 'faraday') {
        const observations = await this._loadRunObservations(sourceRun);
        return { run: sourceRun, trail: sourceRun.trail_mark || null, observations };
      }
    }

    if (explicitTrailId && this.executorStore?.getTrail) {
      const trail = await this.executorStore.getTrail(explicitTrailId);
      if (trail) {
        const sourceRunId = trail.blueprintMeta?.run_id || null;
        const sourceRun = sourceRunId ? (this.runs.get(sourceRunId) || null) : null;
        const observations = sourceRun ? await this._loadRunObservations(sourceRun) : [];
        return { run: sourceRun, trail, observations };
      }
    }

    const candidates = [...this.runs.values()]
      .filter((candidate) => candidate.agent_id === 'faraday' && candidate.status === 'completed')
      .filter((candidate) => !run.project || candidate.project === run.project)
      .filter((candidate) => !run.region || candidate.region === run.region)
      .filter((candidate) => !run.scope || candidate.scope === run.scope)
      .sort((left, right) => new Date(right.updated_at || right.started_at || 0) - new Date(left.updated_at || left.started_at || 0));

    const latest = candidates[0] || null;
    if (!latest) return null;
    const observations = await this._loadRunObservations(latest);
    return { run: latest, trail: latest.trail_mark || null, observations };
  }

  async _loadRunObservations(run) {
    if (!run) return [];
    if (Array.isArray(run.observations) && run.observations.length > 0) {
      return run.observations;
    }
    if (this.executorStore?.listObservations) {
      try {
        return await this.executorStore.listObservations({
          agentId: run.agent_id,
          sourceEventId: run.run_id,
          limit: 50,
        });
      } catch {
        return [];
      }
    }
    return [];
  }

  async _resolveTuringSource(payload, run) {
    const explicitRunId = payload.run_id || payload.runId || null;
    const explicitTrailId = payload.trail_id || payload.trailId || null;

    if (explicitRunId) {
      const sourceRun = this.runs.get(explicitRunId) || null;
      if (sourceRun?.agent_id === 'feynman') {
        const a = sourceRun.result?.hypotheses;
        const b = sourceRun.trail_mark?.blueprintMeta?.hypotheses;
        const c = sourceRun.result?.trail_mark?.blueprintMeta?.hypotheses;
        return {
          run: sourceRun,
          trail: sourceRun.trail_mark || sourceRun.result?.trail_mark || null,
          hypotheses: (a?.length ? a : null) || (b?.length ? b : null) || (c?.length ? c : null) || [],
        };
      }
    }

    if (explicitTrailId && this.executorStore?.getTrail) {
      const trail = await this.executorStore.getTrail(explicitTrailId);
      if (trail) {
        const sourceRunId = trail.blueprintMeta?.run_id || null;
        const sourceRun = sourceRunId ? (this.runs.get(sourceRunId) || null) : null;
        const a = sourceRun?.result?.hypotheses;
        const b = sourceRun?.trail_mark?.blueprintMeta?.hypotheses;
        const c = trail.blueprintMeta?.hypotheses;
        return {
          run: sourceRun,
          trail,
          hypotheses: (a?.length ? a : null) || (b?.length ? b : null) || (c?.length ? c : null) || [],
        };
      }
    }

    const candidates = [...this.runs.values()]
      .filter((candidate) => candidate.agent_id === 'feynman' && candidate.status === 'completed')
      .filter((candidate) => !run.project || candidate.project === run.project)
      .filter((candidate) => !run.region || candidate.region === run.region)
      .filter((candidate) => !run.scope || candidate.scope === run.scope)
      .sort((left, right) => new Date(right.updated_at || right.started_at || 0) - new Date(left.updated_at || left.started_at || 0));

    const latest = candidates[0] || null;
    if (!latest) return null;
    // Hypotheses can be in result.hypotheses OR trail_mark.blueprintMeta.hypotheses
    // Use .length check because empty arrays are truthy in JS
    const h1 = latest.result?.hypotheses;
    const h2 = latest.trail_mark?.blueprintMeta?.hypotheses;
    const h3 = latest.result?.trail_mark?.blueprintMeta?.hypotheses;
    const hypotheses = (h1?.length ? h1 : null) || (h2?.length ? h2 : null) || (h3?.length ? h3 : null) || [];
    return {
      run: latest,
      trail: latest.trail_mark || latest.result?.trail_mark || null,
      hypotheses,
    };
  }

  async _onRunCompleted(run, result) {
    const agentId = run.agent_id;

    // 0. Faraday LLM findings → execute directly (skip Feynman/Turing for clear-cut cases)
    if (agentId === 'faraday' && this.memoryStore) {
      try {
        const obs = result.observations || [];
        const llmObs = obs.filter(o => o.kind === 'llm_cluster_analysis');
        if (llmObs.length > 0) {
          const { GraphActionExecutor } = await import('./graph-action-executor.js');
          const executor = new GraphActionExecutor({ memoryStore: this.memoryStore });

          const actions = [];
          for (const o of llmObs) {
            const llmActions = o.content?.actions || [];
            for (const a of llmActions) {
              if (a.type === 'merge_duplicate' || a.type === 'merge') {
                const targetIds = a.memory_ids || (a.canonical_id && a.absorb_ids ? [a.canonical_id, ...a.absorb_ids] : []);
                if (targetIds.length >= 2) {
                  actions.push({ recommendation: 'merge_duplicate_cluster', confidence: 0.88, target_memory_ids: targetIds });
                }
              }
              if (a.type === 'link_update') {
                actions.push({ recommendation: 'link_update_chain', confidence: 0.88, target_memory_ids: [a.old_id, a.new_id].filter(Boolean) });
              }
              if (a.type === 'cross_project_link') {
                const ids = a.memory_ids || [];
                if (ids.length >= 2) {
                  actions.push({ recommendation: 'relationship_candidate', confidence: 0.85, target_memory_ids: ids });
                }
              }
            }
          }

          if (actions.length > 0) {
            const actionResult = await executor.executeActions(actions, { minConfidence: 0.7, project: run.project, duplicateMode: run.duplicate_mode || 'merge' });
            run.graph_actions_result = actionResult;
            this.logger?.log?.(`[run-manager] Faraday direct actions: ${actionResult.executed} executed, ${actionResult.skipped} skipped, ${actionResult.failed} failed`);
          }
        }
      } catch (err) {
        this.logger?.warn?.(`[run-manager] Faraday direct actions failed: ${err.message}`);
      }
    }

    // 1. Execute graph actions (Turing's recommendations)
    if (agentId === 'turing' && result.action_candidates?.length > 0) {
      try {
        const { GraphActionExecutor } = await import('./graph-action-executor.js');
        const executor = new GraphActionExecutor({ memoryStore: this.memoryStore });
        const actionResult = await executor.executeActions(result.action_candidates, {
          minConfidence: 0.65,
          project: run.project,
          duplicateMode: run.duplicate_mode || 'merge',
        });
        run.graph_actions_result = actionResult;
        this.logger.log(`[run-manager] Turing graph actions: ${actionResult.executed} executed, ${actionResult.skipped} skipped`);
      } catch (err) {
        this.logger.warn(`[run-manager] Graph action execution failed: ${err.message}`);
      }
    }

    // 2. Update reputation for this agent
    if (this.reputationEngine) {
      try {
        await this.reputationEngine.updateFromExecution(agentId, {
          chainSummary: {
            successRate: result.status === 'completed' ? 1.0 : 0.0,
            doneReason: result.status === 'completed' ? 'tool_signaled_completion' : 'failed',
            toolSequence: [agentId],
            totalLatencyMs: Date.now() - new Date(run.started_at).getTime(),
          },
        });
      } catch {}
    }

    // 3. Mine for blueprints (non-blocking)
    if (this.chainMiner) {
      this.chainMiner.mine(run.goal || `resident:${agentId}`).catch(() => {});
    }

    // 4. Store chain run for future mining
    if (this.executorStore?.storeChainRun) {
      this.executorStore.storeChainRun({
        goalId: run.goal || `resident:${agentId}`,
        agentId,
        toolSequence: [agentId],
        successRate: result.status === 'completed' ? 1.0 : 0.0,
        doneReason: result.status,
        totalLatencyMs: Date.now() - new Date(run.started_at).getTime(),
      }).catch(() => {});
    }
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
      duplicate_mode: payload.duplicate_mode || 'merge',  // 'merge' (soft) or 'delete' (hard)
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
      graph_actions_result: run.graph_actions_result || null,
      error: run.error,
    };
  }
}
