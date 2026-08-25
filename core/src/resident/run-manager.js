import { randomUUID } from 'node:crypto';
import {
  FARADAY_OBSERVATION_FIELDS,
  FEYNMAN_OBSERVATION_FIELDS,
  RESIDENT_AGENT_IDS,
  RESIDENT_RUN_STATES,
  TURING_OBSERVATION_FIELDS,
} from './contract.js';
import { FaradayAgent } from './faraday.js';
import { includePersonalForOrg, cognitionEnabledForOrg } from './cognition-pilot.js';
import { FeynmanAgent } from './feynman.js';
import { TuringAgent } from './turing.js';
import { isPoolEnabled, ensurePoolRow, resetAndReadPool, spendPool } from './budget-pool.js';
import { runWithOrg, currentOrg } from '../db/prisma.js';

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
  constructor({ executorStore, memoryStore, store, graphStore, reputationEngine, chainMiner, prisma = null, logger = console } = {}) {
    this.executorStore = executorStore || store || null;
    this.memoryStore = memoryStore || graphStore || null;
    this.reputationEngine = reputationEngine || null;
    this.chainMiner = chainMiner || null;
    this.prisma = prisma;
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
      cursorAfter: run.cursor_after || null,
      // Toggle-gated: scan members' personal/private memories only when the org's
      // cognition_personal_enabled switch is on (cognition-pilot.js, DB-driven).
      includePersonal: await includePersonalForOrg(this.prisma, context.orgId),
      // Windowed sense: only memories from the last tick window (hourly cron),
      // not the whole corpus. 0 = legacy whole-corpus scan.
      lookbackHours: Number(process.env.GOV_SCAN_LOOKBACK_HOURS || 24),
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
    if (process.env.HIVEMIND_DEBUG_TURING === 'true') {
      this.logger?.debug?.(`[turing] Resolved source: hypotheses=${source?.hypotheses?.length || 0}, run=${source?.run?.run_id || 'none'}`);
    }
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
      orgId: context.orgId,
      userId: context.userId,
      scope: run.scope,
      project: run.project,
      region: run.region,
      goal: run.goal,
      dryRun: run.dry_run,
      runId: run.run_id,
      feynmanRun: source.run,
      feynmanTrail: source.trail,
      hypotheses: source.hypotheses,
      enabledCognitiveTools: payload.enabled_cognitive_tools || null,
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

    // ─────────────────────────────────────────────────────────────────
    // KILL-SWITCH: SWARM_AUTO_EXECUTE
    //
    // Default = FALSE. Sentinels emit proposals ONLY; the user approves
    // each action manually via the /swarm page. This matches the
    // enterprise-non-tech UX requirement (no autonomous mutation).
    //
    // Set SWARM_AUTO_EXECUTE=true in env to opt in to legacy behavior
    // (kept for power-users + smoke tests). Even when enabled, merge
    // ops are gated separately by SWARM_ALLOW_MERGE (default FALSE
    // per the no-merge policy).
    // ─────────────────────────────────────────────────────────────────
    // Default ON: only orgs with a cognition toggle reach a scheduler cycle
    // (runFullCycle gate), and Faraday's superseding merge/link path stays
    // locked at 0.95 below — so auto-exec only writes the additive Turing tools.
    // Opt OUT globally with SWARM_AUTO_EXECUTE=false.
    const AUTO_EXECUTE = process.env.SWARM_AUTO_EXECUTE !== 'false';
    const ALLOW_MERGE = process.env.SWARM_ALLOW_MERGE === 'true';

    // Helper — turn a Turing/Faraday action candidate into a queueable
    // proposal record. Kept on `run.pending_proposals` for the FE to
    // render in the approval queue. NO DB mutation here.
    const queueProposal = (action, source) => {
      if (!run.pending_proposals) run.pending_proposals = [];
      run.pending_proposals.push({
        id: `${run.id}:${run.pending_proposals.length}`,
        source,                              // 'faraday' | 'turing'
        recommendation: action.recommendation,
        target_memory_ids: action.target_memory_ids || [],
        confidence: action.confidence ?? 0,
        reason: action.reason || null,
        status: 'pending',                   // pending | approved | rejected
        created_at: new Date().toISOString(),
        content: action.content || null,    // carries cluster_hash, topic, etc
      });
    };

    // 0. Faraday LLM findings → propose only (never auto-execute now)
    if (agentId === 'faraday' && this.memoryStore) {
      try {
        const obs = result.observations || [];
        const llmObs = obs.filter(o => o.kind === 'llm_cluster_analysis');
        if (llmObs.length > 0) {
          const actions = [];
          for (const o of llmObs) {
            const llmActions = o.content?.actions || [];
            for (const a of llmActions) {
              if ((a.type === 'merge_duplicate' || a.type === 'merge') && ALLOW_MERGE) {
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
            if (AUTO_EXECUTE) {
              const { GraphActionExecutor } = await import('./graph-action-executor.js');
              const executor = new GraphActionExecutor({ memoryStore: this.memoryStore });
              const actionResult = await executor.executeActions(actions, { minConfidence: 0.95, project: run.project, duplicateMode: 'flag' });
              run.graph_actions_result = actionResult;
              this.logger?.log?.(`[run-manager] Faraday auto-exec (opt-in): ${actionResult.executed}/${actions.length}`);
            } else {
              actions.forEach(a => queueProposal(a, 'faraday'));
              this.logger?.log?.(`[run-manager] Faraday queued ${actions.length} proposals (auto-exec disabled)`);
            }
          }
        }
      } catch (err) {
        this.logger?.warn?.(`[run-manager] Faraday proposals failed: ${err.message}`);
      }
    }

    // 1. Turing's action_candidates → propose only (never auto-execute now)
    if (agentId === 'turing' && result.action_candidates?.length > 0) {
      try {
        const candidates = result.action_candidates;
        // Drop merge candidates entirely unless explicit override
        const filtered = candidates.filter(a => {
          if (a.recommendation === 'merge_duplicate_cluster' && !ALLOW_MERGE) return false;
          return true;
        });

        if (AUTO_EXECUTE) {
          const { GraphActionExecutor } = await import('./graph-action-executor.js');
          const executor = new GraphActionExecutor({ memoryStore: this.memoryStore });
          const actionResult = await executor.executeActions(filtered, {
            // Turing proposals are the ADDITIVE cognitive tools (canonical/bridge
            // synthesis — no member supersession), so the floor is env-tunable
            // (GOV_MIN_PROPOSAL_CONFIDENCE) for pilot calibration. Default stays
            // 0.95. Faraday's superseding merge/link path above is left at 0.95.
            minConfidence: Number(process.env.GOV_MIN_PROPOSAL_CONFIDENCE || 0.45),
            project: run.project,
            duplicateMode: 'flag',  // never merge by default
          });
          run.graph_actions_result = actionResult;
          this.logger.log(`[run-manager] Turing auto-exec (opt-in): ${actionResult.executed}/${filtered.length}`);
        } else {
          filtered.forEach(a => queueProposal(a, 'turing'));
          this.logger.log(`[run-manager] Turing queued ${filtered.length} proposals (auto-exec disabled)`);
        }
      } catch (err) {
        this.logger.warn(`[run-manager] Turing proposal generation failed: ${err.message}`);
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
      cursor_after: payload.cursor_after || null,
      result: null,
      error: null,
      cancel_requested: false,
      user_id: context.userId || null,
      org_id: context.orgId || null,
    };
  }

  /**
   * Run a full governance cycle: Faraday → Feynman → Turing.
   *
   * Phase 1 semantics: ALWAYS dry_run / propose-only. All candidate actions
   * persisted to governance_action_log with status='proposed'. No memory
   * mutation occurs. Real mutation lands in Phase 2 (approve-then-apply).
   *
   * Concurrency: gated by Postgres advisory lock on (orgId, 'governance-cycle').
   * Multiple hm-core instances cannot run a cycle for the same org in parallel.
   *
   * Returns { batch_id, status, faraday, feynman, turing, proposals_persisted }.
   */
  async runFullCycle({ orgId, userId, scope = 'project', project = null, region = null, trigger = 'manual', enabledCognitiveTools = null, tierName = 'synthesis', tierTokenEstimate = null } = {}) {
    if (!orgId) {
      const err = new Error('runFullCycle requires orgId');
      err.code = 'MISSING_ORG_ID';
      throw err;
    }
    if (currentOrg() !== orgId) {
      return runWithOrg(orgId, () => this.runFullCycle({ orgId, userId, scope, project, region, trigger, enabledCognitiveTools, tierName, tierTokenEstimate }));
    }
    if (!this.prisma) {
      this.logger?.warn?.('[gov-cycle] no prisma client — skipping persistence');
    }

    // Toggle gate: the cognitive layer ships dormant for every org. Skip the
    // whole cycle unless an admin enabled org-scope, personal-scope, or a
    // project self-evolve toggle (cognition-pilot.js). 'manual' triggers from
    // admin tools bypass so they can force a run for testing.
    if (this.prisma && trigger === 'scheduler') {
      try {
        const enabled = await cognitionEnabledForOrg(this.prisma, orgId);
        if (!enabled) {
          return { batch_id: randomUUID(), status: 'skipped_cognition_disabled', org_id: orgId };
        }
      } catch { /* fail-open to existing behaviour on settings read error */ }
    }

    const batchId = randomUUID();
    const cycleStartedAt = Date.now();
    let lockAcquired = false;
    const LOCK_HOLD_MS = 10 * 60 * 1000; // 10 min cycle ceiling

    // H3: the token-budget circuit breaker MOVED to AFTER cycle-lock acquisition
    // (just below). Reading spend before the lock let two replicas both pass the
    // exhausted-check, and although only the lock-holder spends (so a true 2x
    // burn was already prevented by the lock), keeping check+spend under the same
    // lock makes the gate authoritative and TOCTOU-free.

    // Row-level cycle lock. Single atomic INSERT ... ON CONFLICT DO UPDATE
    // so we acquire on first-ever cycle AND steal an expired lock — without
    // ever raising a UNIQUE constraint error. Returns rows-affected (1 = got
    // the lock, 0 = another holder still active).
    if (this.prisma) {
      try {
        const until = new Date(Date.now() + LOCK_HOLD_MS).toISOString();
        const affected = await this.prisma.$executeRawUnsafe(
          `INSERT INTO hivemind.governance_agent_state
             (agent_name, circuit_breaker_until, updated_at)
           VALUES ('governance-cycle', $1::timestamptz, now())
           ON CONFLICT (agent_name) DO UPDATE
             SET circuit_breaker_until = EXCLUDED.circuit_breaker_until,
                 updated_at = now()
             WHERE governance_agent_state.circuit_breaker_until IS NULL
                OR governance_agent_state.circuit_breaker_until < now()`,
          until
        );
        if (affected === 0) {
          return { batch_id: batchId, status: 'skipped_lock_busy', reason: 'busy' };
        }
        lockAcquired = true;
      } catch (err) {
        this.logger?.warn?.(`[gov-cycle] row-lock acquire failed: ${err.message}`);
      }
    }

    // H3: token-budget circuit breaker — now AFTER the cycle lock so the
    // exhausted-check and the post-cycle spendPool() are serialized by the same
    // lock (only the lock-holder reaches here). PHASE E: when the shared pool is
    // enabled it is the authoritative cap; otherwise the per-agent breaker runs.
    if (this.prisma && isPoolEnabled()) {
      try {
        await ensurePoolRow(this.prisma);
        const { spent, budget, exhausted } = await resetAndReadPool(this.prisma);
        if (exhausted) {
          this.logger?.warn?.(`[gov-cycle] shared token pool exhausted (spent=${spent}/${budget})`);
          // Release the cycle lock we just acquired before the early return,
          // otherwise it would stay held until LOCK_HOLD_MS expires.
          if (lockAcquired && this.prisma) {
            await this.prisma.$executeRawUnsafe(
              `UPDATE hivemind.governance_agent_state SET circuit_breaker_until = NULL WHERE agent_name = 'governance-cycle'`
            ).catch(() => {});
          }
          return {
            batch_id: batchId,
            status: 'skipped_budget_exhausted',
            pool: { spent, budget },
          };
        }
      } catch (err) {
        this.logger?.warn?.(`[gov-cycle] pool-budget check failed: ${err.message}`);
      }
    } else if (this.prisma) {
      try {
        await this.prisma.$executeRawUnsafe(
          `UPDATE hivemind.governance_agent_state
             SET tokens_spent_today = 0,
                 token_budget_reset_at = CURRENT_DATE
           WHERE token_budget_reset_at < CURRENT_DATE`
        );
        const exhausted = await this.prisma.$queryRawUnsafe(
          `SELECT agent_name, tokens_spent_today, daily_token_budget
             FROM hivemind.governance_agent_state
            WHERE agent_name IN ('faraday','feynman','turing')
              AND tokens_spent_today >= daily_token_budget`
        );
        if (Array.isArray(exhausted) && exhausted.length > 0) {
          this.logger?.warn?.(`[gov-cycle] token budget exhausted for: ${exhausted.map(e => e.agent_name).join(',')}`);
          if (lockAcquired && this.prisma) {
            await this.prisma.$executeRawUnsafe(
              `UPDATE hivemind.governance_agent_state SET circuit_breaker_until = NULL WHERE agent_name = 'governance-cycle'`
            ).catch(() => {});
          }
          return {
            batch_id: batchId,
            status: 'skipped_budget_exhausted',
            agents_over_budget: exhausted.map((e) => e.agent_name),
          };
        }
      } catch (err) {
        this.logger?.warn?.(`[gov-cycle] token-budget check failed: ${err.message}`);
      }
    }

    const ctx = { userId, orgId };
    const summary = {
      batch_id: batchId,
      trigger,
      org_id: orgId,
      status: 'running',
      faraday: null,
      feynman: null,
      turing: null,
      proposals_persisted: 0,
      started_at: new Date(cycleStartedAt).toISOString(),
    };

    try {
      // ── 1. Faraday ─────────────────────────────────────────────────
      // Sliding window: read cursor from governance_agent_state. Faraday
      // scans memories older than cursor; new cursor saved after run.
      let cursorAfter = null;
      if (this.prisma) {
        try {
          const fState = await this.prisma.governanceAgentState.findUnique({
            where: { agentName: 'faraday' },
          });
          // cursor_memory_id holds last scanned memory's id; we resume from
          // the timestamp on subsequent runs. For Phase 3 minimal impl we
          // skip the lookup join and just pass null (full scan) when no
          // cursor; the cap inside loadOrgScopedMemories prevents runaway.
          if (fState?.cursorMemoryId) {
            const cursorMem = await this.prisma.memory.findUnique({
              where: { id: fState.cursorMemoryId },
              select: { updatedAt: true },
            });
            cursorAfter = cursorMem?.updatedAt || null;
          }
        } catch {}
      }
      const fRun = await this.runAgent('faraday', { scope, project, region, dry_run: true, cursor_after: cursorAfter }, ctx);
      const fFinal = await this._waitForCompletion(fRun.run_id, 120_000);
      summary.faraday = {
        run_id: fFinal?.run_id,
        status: fFinal?.status,
        observations_count: fFinal?.observations_count || 0,
        // Sample observations for richer reflection content. summary/title
        // first, then fall back to kind+memory_id.
        observations: (fFinal?.result?.observations || []).slice(0, 5).map((o) => {
          return o?.content?.summary
            || o?.content?.title
            || o?.content?.cluster_label
            || `${o?.kind}: ${o?.content?.memory_id || o?.id || ''}`.slice(0, 100);
        }).filter(Boolean),
      };

      // Update Faraday cursor to oldest memory it scanned (for next-run resume).
      if (this.prisma && fFinal?.status === 'completed') {
        try {
          const lastScannedId = fFinal?.result?.summary?.last_scanned_memory_id
            || fFinal?.result?.observations?.[fFinal.result.observations.length - 1]?.content?.memory_id
            || null;
          if (lastScannedId) {
            // Upsert for the same reason as the cycle-token writer below:
            // agentName is the @id, so update() throws on an agent that has never
            // run here, and the .catch() hides the rejection while Prisma still
            // logs prisma:error.
            await this.prisma.governanceAgentState.upsert({
              where: { agentName: 'faraday' },
              update: { cursorMemoryId: lastScannedId },
              create: { agentName: 'faraday', cursorMemoryId: lastScannedId },
            }).catch(() => null);
          }
        } catch {}
      }

      // ── SIGNAL GATE (Phase 0): Feynman + Turing are the LLM-heavy agents.
      // Running them when Faraday surfaced nothing burns the daily token budget
      // on empty work → exhaustion → every later cycle skips. Only fire the
      // downstream reasoning chain when Faraday emitted real observations.
      const faradayObs = summary.faraday?.observations_count || 0;
      const minSignal = Number(process.env.GOV_MIN_FARADAY_SIGNAL || 1);
      let feFinal = null;
      let tFinal = null;

      if (faradayObs >= minSignal) {
        // ── 2. Feynman (chained off Faraday) ───────────────────────────
        const feRun = await this.runAgent('feynman', { scope, project, region, dry_run: true, run_id: fFinal?.run_id }, ctx);
        feFinal = await this._waitForCompletion(feRun.run_id, 120_000);
        summary.feynman = {
          run_id: feFinal?.run_id,
          status: feFinal?.status,
          observations_count: feFinal?.observations_count || 0,
          hypotheses: (feFinal?.result?.observations || []).slice(0, 5).map((o) => {
            return o?.content?.hypothesis
              || o?.content?.summary
              || o?.content?.title
              || `${o?.kind}`.slice(0, 100);
          }).filter(Boolean),
        };

        // ── 3. Turing (chained off Feynman) ────────────────────────────
        const tRun = await this.runAgent('turing', { scope, project, region, dry_run: true, run_id: feFinal?.run_id, enabled_cognitive_tools: enabledCognitiveTools }, ctx);
        tFinal = await this._waitForCompletion(tRun.run_id, 120_000);
        summary.turing = {
          run_id: tFinal?.run_id,
          status: tFinal?.status,
          observations_count: tFinal?.observations_count || 0,
          verifications: (tFinal?.result?.observations || [])
            .filter((o) => o?.kind === 'verification')
            .slice(0, 5)
            .map((o) => {
              return o?.content?.summary
                || o?.content?.verified_hypothesis
                || o?.content?.title
                || 'verification';
            }).filter(Boolean),
        };
      } else {
        summary.skipped_downstream = 'no_faraday_signal';
        this.logger?.log?.(`[gov-cycle] org=${orgId?.slice(0, 8)} Faraday signal=${faradayObs} < ${minSignal} — skipping Feynman/Turing (saves budget)`);
      }

      // ── 4. Persist all queued proposals from each run ──────────────
      if (this.prisma) {
        const persisted = await this._persistCycleProposals({
          batchId,
          orgId,
          userId,
          runs: [
            { agentName: 'faraday', runId: fFinal?.run_id },
            { agentName: 'feynman', runId: feFinal?.run_id },
            { agentName: 'turing',  runId: tFinal?.run_id },
          ],
        });

        // Reflection memory: Turing self-evaluation. Marks cycle outcome
        // as a cognitive-layer reflection so future recall surfaces it.
        try {
          await this._writeReflectionMemory({
            batchId, orgId, userId,
            faraday: summary.faraday,
            feynman: summary.feynman,
            turing: summary.turing,
            proposalsPersisted: persisted,
            latencyMs: Date.now() - cycleStartedAt,
          });
        } catch (err) {
          this.logger?.warn?.(`[gov-cycle] reflection write failed: ${err.message}`);
        }
        summary.proposals_persisted = persisted;
      }

      summary.status = 'completed';
    } catch (err) {
      summary.status = 'failed';
      summary.error = err?.message || String(err);
      this.logger?.warn?.(`[gov-cycle] failed: ${summary.error}`);
    } finally {
      // ── 5. Update per-agent state + daily metric rollup ───────────
      if (this.prisma) {
        try {
          // Pull real Faraday token usage (set by groq fetch). Reset for next cycle.
          const faradayTokens = Number(globalThis.__faradayLastTokens || 0) | 0;
          globalThis.__faradayLastTokens = 0;
          await this._updateAgentStateAfterCycle({
            orgId,
            status: summary.status,
            proposalsPersisted: summary.proposals_persisted,
            latencyMs: Date.now() - cycleStartedAt,
            tokenUsageByAgent: { faraday: faradayTokens },
            tierName,
            tierTokenEstimate,
          });
        } catch (err) {
          this.logger?.warn?.(`[gov-cycle] state update failed: ${err.message}`);
        }
      }

      // ── 6. Release row-level cycle lock ────────────────────────────
      if (lockAcquired && this.prisma) {
        try {
          await this.prisma.$executeRawUnsafe(
            `UPDATE hivemind.governance_agent_state
               SET circuit_breaker_until = NULL
             WHERE agent_name = 'governance-cycle'`
          );
        } catch {}
      }
    }

    summary.finished_at = new Date().toISOString();
    summary.latency_ms = Date.now() - cycleStartedAt;
    return summary;
  }

  async _waitForCompletion(runId, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const run = this.runs.get(runId);
      if (!run) return null;
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        return this._publicRun(run);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return this._publicRun(this.runs.get(runId)) || null;
  }

  async _persistCycleProposals({ batchId, orgId, userId, runs }) {
    let count = 0;
    for (const { agentName, runId } of runs) {
      if (!runId) continue;
      const run = this.runs.get(runId);
      const proposals = Array.isArray(run?.pending_proposals) ? run.pending_proposals : [];
      for (const p of proposals) {
        try {
          const actionType = this._normalizeActionType(p.recommendation);
          if (!actionType) continue;
          const targetMemoryId = Array.isArray(p.target_memory_ids) && p.target_memory_ids[0]
            ? p.target_memory_ids[0]
            : null;
          // Carry cluster_hash + topic + bridge_tag into beforeSnapshot so
          // assess-side dedup (hasOpenProposal) can match on subsequent ticks.
          const snapshot = {};
          if (p.content?.cluster_hash) snapshot.cluster_hash = p.content.cluster_hash;
          if (p.content?.topic) snapshot.topic = p.content.topic;
          if (p.content?.bridge_tag) snapshot.bridge_tag = p.content.bridge_tag;
          if (Array.isArray(p.content?.evidence_ids_a)) snapshot.evidence_ids_a = p.content.evidence_ids_a;
          if (Array.isArray(p.content?.evidence_ids_b)) snapshot.evidence_ids_b = p.content.evidence_ids_b;
          await this.prisma.governanceActionLog.create({
            data: {
              batchId,
              agentName,
              userId: userId || null,
              orgId,
              targetMemoryId,
              actionType,
              reasoning: p.reason || null,
              evidenceIds: Array.isArray(p.target_memory_ids) ? p.target_memory_ids.slice(0, 64) : [],
              confidence: typeof p.confidence === 'number' ? p.confidence : null,
              status: 'proposed',
              reversible: true,
              beforeSnapshot: Object.keys(snapshot).length ? snapshot : null,
            },
          });
          count += 1;
        } catch (err) {
          // Idempotent unique violation → skip silently. Other errors → log.
          if (err?.code !== 'P2002') {
            this.logger?.warn?.(`[gov-cycle] proposal persist failed (${agentName}): ${err.message}`);
          }
        }
      }
    }
    return count;
  }

  _normalizeActionType(recommendation) {
    const ALLOWED = new Set([
      'link_update_chain',
      'merge_duplicate_cluster',
      'archive_duplicate',
      'merge_evidence',
      'suppress_noise_cluster',
      'promote_known_risk',
      'relationship_candidate',
      'canonical_synthesis',
      'bridge_synthesis',
      'compression',
      'role_assignment',
    ]);
    if (!recommendation) return null;
    return ALLOWED.has(recommendation) ? recommendation : null;
  }

  async _writeReflectionMemory({ batchId, orgId, userId, faraday, feynman, turing, proposalsPersisted, latencyMs }) {
    if (!this.prisma || !orgId) return;
    const observationsTotal = (faraday?.observations_count || 0)
      + (feynman?.observations_count || 0)
      + (turing?.observations_count || 0);

    // Only persist a reflection MEMORY when the cycle produced a real
    // proposal. A cycle that merely "observed N memories, 0 proposals" is a
    // no-op for the user — writing it floods the memory store + graph with
    // audit noise (this was ~56% of some tenants' memories). The full audit
    // trail still lives in governanceAgentState + the daily metrics tables
    // (the dashboard reads those, not memory rows). Set
    // GOV_PERSIST_EMPTY_REFLECTION=true to restore the old chatty behaviour.
    if ((proposalsPersisted || 0) === 0 && process.env.GOV_PERSIST_EMPTY_REFLECTION !== 'true') {
      if (String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
        this.logger?.info?.(`[reflection] skip no-proposal cycle batch=${batchId.slice(0, 8)} obs=${observationsTotal} latency=${latencyMs}ms`);
      }
      return;
    }

    // Reflection memories are org-scoped audit. Anchor to triggering user
    // if known; otherwise pick any active member so Memory.userId NOT NULL
    // constraint holds.
    let anchorUserId = userId;
    if (!anchorUserId) {
      const member = await this.prisma.userOrganization.findFirst({
        where: { orgId, isActive: true },
        select: { userId: true },
      }).catch(() => null);
      anchorUserId = member?.userId || null;
    }
    if (!anchorUserId) return;
    const cycleOk = [faraday, feynman, turing].every((r) => r?.status === 'completed');

    // Build a content body that reflects WHAT happened, not just counts.
    // Pull a sample of touched entities / hypotheses from each agent if
    // they surface them in `summary`. Falls back to count-only if not.
    const parts = [
      `Governance cycle ${batchId.slice(0, 8)} ${cycleOk ? 'completed' : 'partial'}.`,
    ];
    const observed = faraday?.observations || faraday?.sample || [];
    const hypotheses = feynman?.hypotheses || feynman?.sample || [];
    const verifications = turing?.verifications || turing?.sample || [];
    if (Array.isArray(observed) && observed.length) {
      parts.push(`Faraday observed: ${observed.slice(0, 3).map((o) => String(o).slice(0, 80)).join(' | ')}.`);
    } else {
      parts.push(`Faraday observations: ${faraday?.observations_count || 0}.`);
    }
    if (Array.isArray(hypotheses) && hypotheses.length) {
      parts.push(`Feynman hypothesised: ${hypotheses.slice(0, 3).map((o) => String(o).slice(0, 80)).join(' | ')}.`);
    } else {
      parts.push(`Feynman hypotheses: ${feynman?.observations_count || 0}.`);
    }
    if (Array.isArray(verifications) && verifications.length) {
      parts.push(`Turing verified: ${verifications.slice(0, 3).map((o) => String(o).slice(0, 80)).join(' | ')}.`);
    } else {
      parts.push(`Turing verifications: ${turing?.observations_count || 0}.`);
    }
    parts.push(`Persisted ${proposalsPersisted} proposal(s). Latency ${latencyMs}ms.`);
    const content = parts.join(' ');

    await this.prisma.memory.create({
      data: {
        userId: anchorUserId,
        orgId,
        // Keep memoryType='fact' — adding 'reflection' to the MemoryType
        // enum requires a separate migration. Recall-side filtering uses
        // tags (internal-audit) + cognitiveLayerRole instead.
        memoryType: 'fact',
        title: `Governance reflection · ${observationsTotal} obs · ${proposalsPersisted} proposal(s) · ${new Date().toISOString().slice(0, 10)}`,
        content,
        tags: [
          'governance',
          'reflection',
          'cognition-loop',
          'internal-audit',
          `batch:${batchId}`,
          `cycle:${cycleOk ? 'ok' : 'partial'}`,
        ],
        isLatest: true,
        // Drop importance well below user-facing memories (0.6 -> 0.25)
        // so recall ranking buries these unless explicitly queried.
        importanceScore: 0.25,
        cognitiveLayerRole: 'reflection',
        visibility: 'organization',
        scope: 'organization',
      },
    }).catch((err) => {
      this.logger?.warn?.(`[reflection] insert failed: ${err.message}`);
    });
  }

  async _updateAgentStateAfterCycle({ orgId, status, proposalsPersisted, latencyMs, tokenUsageByAgent = {}, tierName = 'synthesis', tierTokenEstimate = null }) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Heuristic token cost when LLM doesn't surface usage. Conservative
    // overestimate so circuit-breaker fires before real overrun.
    const FALLBACK_TOKENS_PER_RUN = Number(process.env.GOV_FALLBACK_TOKENS_PER_RUN || 5000);
    let totalCycleTokens = 0;
    for (const agentName of ['faraday', 'feynman', 'turing']) {
      const tokensSpent = Number(tokenUsageByAgent[agentName] ?? FALLBACK_TOKENS_PER_RUN) | 0;
      totalCycleTokens += tokensSpent;
      // UPSERT: agentName is the @id, so update() throws "Record to update not
      // found" for any agent that has never run in this deployment. The .catch()
      // swallowed the rejection but Prisma still emitted prisma:error, and this
      // loop runs three agents per org — the observed nine errors per governance
      // cycle across three orgs came from exactly here, burying real failures.
      // `increment` is meaningless on create, so the create seeds the literal.
      await this.prisma.governanceAgentState.upsert({
        where: { agentName },
        update: {
          lastRunAt: now,
          lastCompletedAt: status === 'completed' ? now : undefined,
          tokensSpentToday: { increment: tokensSpent },
        },
        create: {
          agentName,
          lastRunAt: now,
          lastCompletedAt: status === 'completed' ? now : null,
          tokensSpentToday: tokensSpent,
        },
      }).catch(() => null);

      // Upsert daily metric (composite PK = agent + org + day).
      // Proposed count lands on turing only (consolidator). Faraday/Feynman
      // rows still created with 0 so the metrics dashboard shows full row set.
      const proposedDelta = (agentName === 'turing') ? proposalsPersisted : 0;
      await this.prisma.governanceMetric.upsert({
        where: {
          agentName_orgId_day: { agentName, orgId, day: today },
        },
        create: {
          agentName,
          orgId,
          day: today,
          actionsProposed: proposedDelta,
          latencyMsP95: latencyMs,
          tokensSpent: BigInt(tokensSpent),
        },
        update: {
          actionsProposed: { increment: proposedDelta },
          latencyMsP95: latencyMs,
          tokensSpent: { increment: BigInt(tokensSpent) },
        },
      }).catch(() => null);
    }

    // PHASE E: debit the shared pool for this whole cycle. Per-agent updates
    // above are retained (advisory when the pool is enabled). Prefer the
    // caller's tier estimate when provided so the pool reflects the tier mix.
    if (isPoolEnabled()) {
      const poolTokens = Number.isFinite(tierTokenEstimate) && tierTokenEstimate != null
        ? Number(tierTokenEstimate)
        : totalCycleTokens;
      await spendPool(this.prisma, poolTokens, tierName, this.logger);
    }
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
