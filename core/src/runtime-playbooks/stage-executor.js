import crypto, { randomUUID } from 'node:crypto';
import { deriveStageArtifactContract } from './artifact-schema.js';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'TERMINATED']);
// A run that exhausted max_attempts is parked in NEEDS_INTERVENTION — by name and by
// contract it waits for a human/HQ decision. It was NOT in TERMINAL_STATUSES, so every
// automatic re-entry (onRunState schedules an HQ wake keyed by run.version, which the
// failure itself just incremented) walked straight back into the stage and re-ran it.
// max_attempts was honoured inside a single execute(); nothing stopped execute() being
// called again. Measured: form_strategy reached attempt 10 / checkpoint 15, each
// iteration burning a full Room turn with live web searches. Halt automatic re-entry;
// an operator/HQ can still retry deliberately via { allowInterventionRetry: true }.
const HALTED_STATUSES = new Set(['NEEDS_INTERVENTION']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getPath(value, path) {
  if (!path) return value;
  return String(path).split('.').reduce((current, part) => current == null ? undefined : current[part], value);
}

function artifactMap(artifacts) {
  // Append-only audit history may contain an UNCERTAIN outcome followed by a
  // reconciled READY/REJECTED outcome for the same input. Predicates operate on
  // the effective outcome set while the full history remains on the run.
  const resolvedInputRefs = new Set((artifacts || [])
    .filter((artifact) => String(artifact?.status || '').toUpperCase() !== 'UNCERTAIN')
    .map((artifact) => getPath(artifact, 'data.input_ref'))
    .filter(Boolean));
  const grouped = {};
  for (const artifact of artifacts || []) {
    const inputRef = getPath(artifact, 'data.input_ref');
    if (String(artifact?.status || '').toUpperCase() === 'UNCERTAIN'
        && inputRef && resolvedInputRefs.has(inputRef)) continue;
    const key = artifact.key || artifact.artifactKey;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(artifact);
  }
  return grouped;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function stageAuthorityHash(run, stage) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(resolveInputs(run, stage)))).digest('hex');
}

export function authorityGranted(run, stage) {
  if (!stage.authority_gate) return true;
  const grant = (run.authorityRecords || []).find((record) => record.gate === stage.authority_gate);
  if (!grant) return stage.authority_binding !== 'stage_inputs' && (run.authorityGates || []).includes(stage.authority_gate);
  return stage.authority_binding !== 'stage_inputs' || grant.payload?.input_hash === stageAuthorityHash(run, stage);
}

// On a REPAIR retry the stage must see its OWN rejected draft, not just its upstream
// inputs. Without this every attempt rewrote the artifact from scratch, so the shape
// churned instead of converging: form_strategy attempt 2 produced a full channel_mix,
// attempt 3 dropped it again, attempt 4 lost niche_wedge too. Seven attempts, no
// monotonic progress. The artifacts ARE already persisted on the run — the stage simply
// never asked for them. Expose the last draft of each expected artifact under a
// `prior_attempt.<key>` namespace so the Room can carry forward what already passed and
// spend the retry only on the unmet fields.
function priorAttemptInputs(run, stage, attempt) {
  if (!(attempt > 1)) return {};
  const grouped = artifactMap(run.artifacts);
  const resolved = {};
  for (const key of stage.expected_artifacts || []) {
    const rows = grouped[key];
    if (Array.isArray(rows) && rows.length) {
      resolved[`prior_attempt.${key}`] = rows[rows.length - 1];
      resolved[`prior_attempt_all.${key}`] = rows;
    }
  }
  return resolved;
}

function resolveInputs(run, stage, activeEvent = null) {
  const grouped = artifactMap(run.artifacts);
  const resolved = {};
  const event = activeEvent || asObject(run.context).latest_event || null;
  for (const ref of stage.input_refs) {
    if (ref === 'trigger.payload') resolved[ref] = run.trigger;
    else if (ref.startsWith('trigger.')) resolved[ref] = getPath(run.trigger, ref.slice(8));
    else if (ref.startsWith('context.')) resolved[ref] = getPath(run.context, ref.slice(8));
    else if (ref.startsWith('artifacts.')) resolved[ref] = grouped[ref.slice(10)] || [];
    else if (ref === 'event') resolved[ref] = event;
    else if (ref.startsWith('event.')) resolved[ref] = getPath(event, ref.slice(6));
    else resolved[ref] = undefined;
  }
  return resolved;
}

function withoutLatestEvent(context) {
  const next = { ...asObject(context) };
  delete next.latest_event;
  return next;
}

function stageCounter(context, key, stageId) {
  return Math.max(0, Number(asObject(asObject(context)[key])[stageId] || 0));
}

function withStageCounters(context, { stageId, repairAttempt, visitCount }) {
  const current = asObject(context);
  return {
    ...current,
    runtime_repair_attempts: { ...asObject(current.runtime_repair_attempts), [stageId]: repairAttempt },
    runtime_stage_visits: { ...asObject(current.runtime_stage_visits), [stageId]: visitCount },
  };
}

function clearStageRepairAttempt(context, stageId) {
  const current = withoutLatestEvent(context);
  const repairs = { ...asObject(current.runtime_repair_attempts) };
  delete repairs[stageId];
  const next = { ...current, runtime_repair_attempts: repairs };
  if (next.runtime_intervention_resume_stage === stageId) delete next.runtime_intervention_resume_stage;
  return next;
}

function normalizeDirectorArtifacts(result) {
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  return artifacts.map((artifact) => ({
    ...artifact,
    id: String(artifact?.id || '').trim(),
    key: String(artifact?.key || '').trim(),
  }));
}

function executionErrorVerdict(error) {
  return {
    passed: false,
    unmet: [{
      predicate: 'execution_succeeded',
      reason: String(error?.message || error || 'runtime_stage_execution_failed').slice(0, 1000),
      ambiguous: error?.ambiguous === true,
    }],
  };
}

export function projectContractRejections({ stage, verdict, producer, attempt }) {
  const unmet = Array.isArray(verdict?.unmet) ? verdict.unmet : [];
  if (!unmet.length) return [];
  const checks = Array.isArray(stage?.completion_checks) ? stage.completion_checks : [];
  const contract = deriveStageArtifactContract(stage).artifacts;
  return unmet.map((result) => {
    const check = checks.find((candidate, index) => (
      (candidate.id || `${candidate.predicate}:${candidate.select || '*'}:${index}`) === result.id
    )) || checks.find((candidate) => candidate.predicate === result.predicate) || {};
    const selectors = (Array.isArray(check.select) ? check.select : [check.select]).filter(Boolean).map(String);
    return {
      rejected_field: check.path || null,
      artifact_select: selectors,
      producer,
      predicate: result.predicate || check.predicate || null,
      attempt,
      expected: {
        ...(check.value !== undefined ? { value: check.value } : {}),
        ...(check.values !== undefined ? { values: check.values } : {}),
        ...(check.pattern !== undefined ? { pattern: check.pattern } : {}),
      },
      expected_schema: Object.fromEntries(selectors.map((key) => [key, contract[key]?.schema || null])),
    };
  });
}

function combineVerdicts(primary, verifications) {
  const unmet = [
    ...(Array.isArray(primary?.unmet) ? primary.unmet : []),
    ...verifications.flatMap((result) => Array.isArray(result?.unmet) ? result.unmet : []),
  ];
  return {
    ...primary,
    passed: primary?.passed === true && verifications.every((result) => result?.passed === true),
    unmet,
    verifications: verifications.map((result) => ({
      adapter_id: result.adapter_id,
      select: result.select,
      passed: result.passed === true,
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
    })),
  };
}

function selectTransition(stage, artifacts, predicates) {
  const conditional = stage.transitions.filter((transition) => transition.default !== true);
  for (const transition of conditional) {
    if (predicates.evaluate(transition.when, artifacts)) return transition;
  }
  return stage.transitions.find((transition) => transition.default === true);
}

function eventWait(stage, producedArtifacts) {
  if (!stage.waits_for_event) return null;
  const correlationPath = stage.waits_for_event.correlation_path || null;
  const correlationValues = [];
  if (correlationPath) {
    for (const artifact of producedArtifacts) {
      const candidate = getPath(artifact, correlationPath);
      if (candidate != null) {
        correlationValues.push(candidate);
      }
    }
  }
  return {
    ...stage.waits_for_event,
    presentation: asObject(stage.presentation?.waiting),
    types: stage.waits_for_event.types || [stage.waits_for_event.type],
    correlation_values: [...new Set(correlationValues)],
    correlation_value: correlationValues[0] ?? null,
    deadline: stage.waits_for_event.timeout_after_seconds
      ? new Date(Date.now() + stage.waits_for_event.timeout_after_seconds * 1000).toISOString()
      : null,
    after_stage_id: stage.id,
  };
}

function eventMatches(waitingFor, event) {
  const accepted = waitingFor.types || [waitingFor.type];
  if (!event || !accepted.includes(event.type)) return false;
  const correlations = waitingFor.correlation_values || (waitingFor.correlation_value == null ? [] : [waitingFor.correlation_value]);
  if (!waitingFor.correlation_path || correlations.length === 0 || event.type === 'wait.timeout') return true;
  return correlations.includes(getPath(event, waitingFor.correlation_path));
}

async function notifyStage(listener, payload) {
  if (typeof listener !== 'function') return;
  try {
    await listener(payload);
  } catch {
    // User-facing progress is observability. It must not alter durable execution.
  }
}

export class GenericStageExecutor {
  constructor({ registry, predicates, store, director, selector = null, adapters = null, onStageState = null, executionPolicy = {}, workerId = `runtime-${randomUUID()}`, maxSteps = 100 } = {}) {
    if (!registry || !predicates || !store || !director?.execute) {
      throw new Error('runtime_executor_dependencies_required');
    }
    this.registry = registry;
    this.predicates = predicates;
    this.store = store;
    this.director = director;
    this.selector = selector;
    this.adapters = adapters;
    this.onStageState = onStageState;
    this.executionPolicy = asObject(executionPolicy);
    this.workerId = workerId;
    this.maxSteps = maxSteps;
  }

  async createRun(input) {
    const playbook = this.registry.get(input.playbookId, input.playbookVersion, { scopeKey: input.scopeKey || 'global' });
    return this.store.createRun({
      ...input,
      playbookVersion: playbook.version,
      currentStageId: playbook.initial_stage_id,
    });
  }

  async selectAndCreateRun(input) {
    if (!this.selector) throw new Error('runtime_executor_selector_required');
    const selected = await this.selector.select({
      objective: input.objective,
      context: input.context,
      scopeKey: input.scopeKey || 'global',
    });
    return this.createRun({
      ...input,
      playbookId: selected.playbook_id,
      playbookVersion: selected.version,
      context: { ...asObject(input.context), playbook_selection: selected },
    });
  }

  async grantAuthority(runId, orgId, gate, grant = {}) {
    return this.store.grantAuthority(runId, orgId, gate, grant);
  }

  async resumeIntervention(runId, orgId, input = {}) {
    if (typeof this.store.resumeIntervention !== 'function') {
      throw new Error('runtime_intervention_resume_store_required');
    }
    return this.store.resumeIntervention(runId, orgId, input);
  }

  async monitorDeadlines() {
    const rows = await this.store.prisma.runtimePlaybookRun.findMany({
      where: { status: 'ACTIVE' }, orderBy: { updatedAt: 'asc' }, take: 200,
    });
    const now = Date.now();
    const changed = [];
    for (const row of rows) {
      let playbook;
      try {
        playbook = this.registry.get(row.playbookId, row.playbookVersion, { scopeKey: row.scopeKey });
      } catch {
        continue;
      }
      const stage = playbook.stages.find((candidate) => candidate.id === row.currentStageId);
      const deadlinePolicy = {
        ...this.executionPolicy,
        ...asObject(playbook.execution_policy),
        ...asObject(stage?.deadlines),
      };
      const softMs = Math.max(60_000, Number(deadlinePolicy.soft_progress_after_seconds || 0) * 1000);
      const hardMs = Math.max(softMs, Number(deadlinePolicy.hard_execution_after_seconds || 0) * 1000);
      if (!Number.isFinite(softMs) || !Number.isFinite(hardMs)) continue;
      const context = asObject(row.context);
      const deadlines = asObject(context.runtime_deadlines);
      const current = asObject(deadlines[row.currentStageId]);
      if (!current.started_at) continue;
      const elapsed = now - new Date(current.started_at).getTime();
      if (elapsed >= softMs && !current.soft_emitted_at) {
        const next = { ...current, soft_emitted_at: new Date(now).toISOString() };
        await this.store.updateRun(row.id, row.orgId, { context: { ...context, runtime_deadlines: { ...deadlines, [row.currentStageId]: next } } });
        await this.store.appendCheckpoint(row.id, row.orgId, { stageId: row.currentStageId, phase: 'SOFT_DEADLINE', status: 'ACTIVE', state: { elapsed_ms: elapsed, policy: deadlinePolicy.policy_id, policy_version: deadlinePolicy.version } });
        changed.push({ run_id: row.id, stage_id: row.currentStageId, deadline: 'soft' });
      }
      if (elapsed >= hardMs && !current.hard_emitted_at) {
        const latest = await this.store.loadRun(row.id, row.orgId);
        const latestContext = asObject(latest.context);
        const latestDeadlines = asObject(latestContext.runtime_deadlines);
        const next = { ...asObject(latestDeadlines[row.currentStageId]), hard_emitted_at: new Date(now).toISOString() };
        const verdict = { passed: false, unmet: [{ predicate: 'execution_deadline', reason: 'hard_execution_deadline_exceeded' }] };
        await this.store.updateRun(row.id, row.orgId, { context: { ...latestContext, runtime_deadlines: { ...latestDeadlines, [row.currentStageId]: next } }, lastVerdict: verdict });
        await this.store.appendCheckpoint(row.id, row.orgId, { stageId: row.currentStageId, phase: 'HARD_DEADLINE', status: 'NEEDS_INTERVENTION', state: { elapsed_ms: elapsed, reconcile_before_retry: true, policy: deadlinePolicy.policy_id, policy_version: deadlinePolicy.version }, verdict });
        changed.push({ run_id: row.id, stage_id: row.currentStageId, deadline: 'hard' });
      }
    }
    return changed;
  }

  async run(runId, { orgId, event = null, allowInterventionRetry = false } = {}) {
    if (!orgId) throw new Error('runtime_executor_org_required');
    // The executor instance is shared by scheduler, callbacks and API requests.
    // A unique invocation owner prevents two calls in the same process from
    // treating the shared worker ID as permission to execute the run twice.
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    if (!await this.store.claimRun(runId, orgId, leaseOwner)) {
      return { status: 'ALREADY_CLAIMED', runId };
    }
    const heartbeat = typeof this.store.renewRun === 'function'
      ? setInterval(() => {
        this.store.renewRun(runId, orgId, leaseOwner).catch(() => {});
      }, 20_000)
      : null;
    heartbeat?.unref?.();
    try {
      for (let stepCount = 0; stepCount < this.maxSteps; stepCount += 1) {
        let run = await this.store.loadRun(runId, orgId);
        if (TERMINAL_STATUSES.has(run.status)) return run;
        // Parked for intervention: never re-enter automatically. Without this the
        // failure's own version bump scheduled a wake that re-ran the stage, so a
        // stage could retry indefinitely past max_attempts.
        if (HALTED_STATUSES.has(run.status) && !allowInterventionRetry) return run;
        const playbook = this.registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });

        const resumedFromEventWait = run.status === 'WAITING_EVENT';
        if (resumedFromEventWait) {
          const eventId = String(event?.id || event?.event_id || '').trim();
          if (eventId && (asObject(run.context).consumed_event_ids || []).includes(eventId)) return run;
          if (!eventMatches(run.waitingFor, event)) return run;
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: run.currentStageId,
            phase: 'EVENT_RECEIVED',
            status: 'ACTIVE',
            state: { event_type: event.type },
          });
          run = await this.store.updateRun(runId, orgId, {
            status: 'ACTIVE',
            waitingFor: null,
            context: {
              ...asObject(run.context), latest_event: event,
              consumed_event_ids: [...new Set([...(asObject(run.context).consumed_event_ids || []), eventId].filter(Boolean))].slice(-500),
            },
          });
        }

        const stage = playbook.stages.find((candidate) => candidate.id === run.currentStageId);
        if (!stage) throw new Error(`runtime_stage_not_found:${run.currentStageId}`);

        if (asObject(asObject(run.context).runtime_deadlines)[stage.id]?.hard_emitted_at) {
          const verdict = { passed: false, unmet: [{ predicate: 'execution_deadline', reason: 'hard_execution_deadline_exceeded_before_reentry' }] };
          await this.store.updateRun(runId, orgId, { status: 'NEEDS_INTERVENTION', lastVerdict: verdict });
          return this.store.loadRun(runId, orgId);
        }

        const deadlineContext = asObject(run.context);
        const deadlineStates = asObject(deadlineContext.runtime_deadlines);
        if (!asObject(deadlineStates[stage.id]).started_at) {
          run = await this.store.updateRun(runId, orgId, { context: {
            ...deadlineContext,
            runtime_deadlines: { ...deadlineStates, [stage.id]: { started_at: new Date().toISOString() } },
          } });
        }

        if (run.status === 'WAITING_AUTHORITY') {
          if (!authorityGranted(run, stage)) return run;
          // The stage's deadline clock (started_at, set above BEFORE the
          // authority-gate check further down) must not count how long a
          // human took to grant authority. Real production incident
          // (2026-08-18, an outreach delivery stage): a ~22min authority
          // wait alone exceeded hard_execution_after_seconds, so the stage
          // failed via HARD_DEADLINE the instant it resumed, before any
          // actual work. Reset the clock here, when real execution begins.
          const priorDeadlines = asObject(asObject(run.context).runtime_deadlines);
          run = await this.store.updateRun(runId, orgId, {
            status: 'ACTIVE',
            context: { ...asObject(run.context), runtime_deadlines: { ...priorDeadlines, [stage.id]: { started_at: new Date().toISOString() } } },
          });
        }

        await this.store.appendCheckpoint(runId, orgId, {
          stageId: stage.id,
          phase: 'BEFORE_EXECUTION',
          status: 'ACTIVE',
          state: { completed_stage_ids: run.completedStageIds },
        });
        run = await this.store.loadRun(runId, orgId);
        await notifyStage(this.onStageState, { phase: 'STARTED', run, stage, artifacts: [], verdict: null });

        if (stage.authority_gate && !authorityGranted(run, stage)) {
          await this.store.updateRun(runId, orgId, { status: 'WAITING_AUTHORITY' });
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: stage.id,
            phase: 'AUTHORITY_REQUIRED',
            status: 'WAITING_AUTHORITY',
            state: { gate: stage.authority_gate },
          });
          return this.store.loadRun(runId, orgId);
        }

        const priorAttempt = Number(asObject(run.stageAttempts)[stage.id] || 0);
        const stageAttempt = resumedFromEventWait && priorAttempt > 0 ? priorAttempt : priorAttempt + 1;
        const priorRepairAttempt = stageCounter(run.context, 'runtime_repair_attempts', stage.id);
        const repairAttempt = resumedFromEventWait && priorRepairAttempt > 0
          ? priorRepairAttempt : priorRepairAttempt + 1;
        const priorVisitCount = stageCounter(run.context, 'runtime_stage_visits', stage.id);
        const visitCount = priorRepairAttempt === 0 && !resumedFromEventWait
          ? priorVisitCount + 1 : Math.max(1, priorVisitCount);
        const maxStageVisits = Math.max(1, Number(this.executionPolicy.max_stage_visits || 50));
        if (visitCount > maxStageVisits) {
          const verdict = { passed: false, unmet: [{ predicate: 'stage_visit_limit', reason: 'maximum_stage_visits_exceeded' }] };
          await this.store.updateRun(runId, orgId, { status: 'NEEDS_INTERVENTION', lastVerdict: verdict });
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: stage.id, phase: 'STAGE_VISIT_LIMIT', status: 'NEEDS_INTERVENTION',
            state: { visit_count: visitCount, max_stage_visits: maxStageVisits }, verdict,
          });
          return this.store.loadRun(runId, orgId);
        }
        const attempts = { ...asObject(run.stageAttempts), [stage.id]: stageAttempt };
        run = await this.store.updateRun(runId, orgId, {
          stageAttempts: attempts,
          context: withStageCounters(run.context, { stageId: stage.id, repairAttempt, visitCount }),
        });
        const executionRequest = {
          run_id: run.id,
          org_id: run.orgId,
          room_id: run.roomId,
          playbook_id: playbook.playbook_id,
          playbook_version: playbook.version,
          stage_id: stage.id,
          instruction: String(asObject(run.context).request?.instruction || asObject(run.context).request?.objective || stage.objective),
          objective: run.completedStageIds.length
            ? `${stage.objective}\n\nContinue the same execution for: ${String(asObject(run.context).request?.instruction || asObject(run.context).request?.objective || '').trim()}`.trim()
            : String(asObject(run.context).request?.instruction || asObject(run.context).request?.objective || stage.objective),
          stage_guidance: stage.objective,
          runtime_context: asObject(run.context),
          expected_artifacts: stage.expected_artifacts,
          authority_granted: authorityGranted(run, stage),
          inputs: { ...resolveInputs(run, stage, event), ...priorAttemptInputs(run, stage, repairAttempt) },
          checks: stage.completion_checks,
          unmet: asObject(run.lastVerdict).unmet || [],
          stage_attempts: attempts,
          max_attempts: Number(stage.max_attempts || 1),
          retry_policy: {
            owner: 'playbook',
            stage_attempt: repairAttempt,
            execution_attempt: attempts[stage.id],
            stage_visit: visitCount,
            max_stage_attempts: Number(stage.max_attempts || 1),
            room_outer_replays: 0,
            local_artifact_repair: true,
          },
          checkpoint_sequence: run.checkpointSequence,
          adapter_descriptors: this.adapters?.descriptors?.() || [],
          execution_config: asObject(stage.execution?.config),
          invoke_adapter: this.adapters ? (adapterId, operation, input, context = {}) => this.adapters.invoke(
            adapterId,
            operation,
            input,
            { ...context, orgId: run.orgId, runId: run.id, stageId: stage.id, roomId: run.roomId },
          ) : null,
        };
        let result;
        try {
          const execution = stage.execution || { mode: 'room' };
          result = execution.mode === 'adapter'
            ? await this.adapters?.invoke(execution.adapter_id, execution.operation, {
              inputs: executionRequest.inputs,
              expected_artifacts: stage.expected_artifacts,
              checks: stage.completion_checks,
              config: asObject(execution.config),
            }, {
              orgId: run.orgId, runId: run.id, stageId: stage.id, roomId: run.roomId,
              attempt: repairAttempt, maxAttempts: Number(stage.max_attempts || 1),
            })
            : await this.director.execute(executionRequest);
          if (execution.mode === 'adapter' && !this.adapters) {
            throw new Error('runtime_stage_adapter_registry_required');
          }
        } catch (error) {
          const verdict = executionErrorVerdict(error);
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: stage.id,
            phase: 'EXECUTION_ERROR',
            status: 'FAILED',
            verdict,
          });
          const attempt = repairAttempt;
          if (stage.on_failure === 'REPAIR' && attempt < stage.max_attempts
            && error?.ambiguous !== true && error?.retryable !== false) {
            await this.store.updateRun(runId, orgId, { lastVerdict: verdict, status: 'ACTIVE' });
            continue;
          }
          const status = stage.on_failure === 'TERMINATE' ? 'TERMINATED' : 'NEEDS_INTERVENTION';
          await this.store.updateRun(runId, orgId, {
            status,
            lastVerdict: verdict,
            ...(status === 'TERMINATED' ? { completedAt: new Date() } : {}),
          });
          return this.store.loadRun(runId, orgId);
        }
        const produced = normalizeDirectorArtifacts(result);
        let persisted;
        try {
          persisted = await this.store.persistArtifacts(runId, orgId, stage.id, produced, {
            replaceStageKeys: repairAttempt > 1
              || asObject(run.context).runtime_intervention_resume_stage === stage.id,
          });
        } catch (error) {
          const verdict = executionErrorVerdict(error);
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: stage.id,
            phase: 'ARTIFACT_PERSISTENCE_ERROR',
            status: 'FAILED',
            verdict,
          });
          const attempt = repairAttempt;
          if (stage.on_failure === 'REPAIR' && attempt < stage.max_attempts
            && error?.ambiguous !== true && error?.retryable !== false) {
            await this.store.updateRun(runId, orgId, { lastVerdict: verdict, status: 'ACTIVE' });
            continue;
          }
          const status = stage.on_failure === 'TERMINATE' ? 'TERMINATED' : 'NEEDS_INTERVENTION';
          await this.store.updateRun(runId, orgId, {
            status,
            lastVerdict: verdict,
            ...(status === 'TERMINATED' ? { completedAt: new Date() } : {}),
          });
          return this.store.loadRun(runId, orgId);
        }
        run = await this.store.loadRun(runId, orgId);
        if (result?.waiting_for && typeof result.waiting_for === 'object') {
          const declared = asObject(result.waiting_for);
          const waitingFor = {
            ...declared,
            types: Array.isArray(declared.types) ? declared.types : [declared.type].filter(Boolean),
            presentation: asObject(declared.presentation || stage.presentation?.waiting),
            after_stage_id: stage.id,
          };
          await this.store.updateRun(runId, orgId, {
            status: 'WAITING_EVENT',
            currentStageId: stage.id,
            waitingFor,
            lastVerdict: { passed: false, unmet: [], waiting: true },
            context: withoutLatestEvent(run.context),
          });
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: stage.id,
            phase: 'EVENT_REQUIRED',
            status: 'WAITING_EVENT',
            state: { next_stage_id: stage.id, waiting_for: waitingFor },
            artifactRefs: persisted.map((artifact) => artifact.id),
          });
          return this.store.loadRun(runId, orgId);
        }
        if (asObject(asObject(run.context).runtime_deadlines)[stage.id]?.hard_emitted_at) {
          const verdict = { passed: false, unmet: [{ predicate: 'execution_deadline', reason: 'hard_execution_deadline_exceeded_after_reconciliation' }] };
          await this.store.updateRun(runId, orgId, { status: 'NEEDS_INTERVENTION', lastVerdict: verdict });
          return this.store.loadRun(runId, orgId);
        }
        const grouped = artifactMap(run.artifacts);
        const predicateVerdict = this.predicates.validateChecks(stage.completion_checks, grouped, { run, stage });
        const verificationResults = [];
        for (const verification of stage.verifications || []) {
          try {
            const verified = await this.adapters?.invoke(
              verification.adapter_id,
              verification.operation || 'verify',
              {
                artifacts: grouped[verification.select] || [],
                inputs: { ...resolveInputs(run, stage, event), ...priorAttemptInputs(run, stage, repairAttempt) },
                checks: stage.completion_checks.filter((check) => check.select === verification.select),
                config: asObject(verification.config),
              },
              { orgId: run.orgId, runId: run.id, stageId: stage.id, roomId: run.roomId },
            );
            verificationResults.push({ ...verified, adapter_id: verification.adapter_id, select: verification.select });
          } catch (error) {
            verificationResults.push({
              adapter_id: verification.adapter_id,
              select: verification.select,
              passed: false,
              unmet: [{ predicate: 'adapter_verified', reason: String(error?.message || error).slice(0, 1000) }],
            });
          }
        }
        const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
        // A stage may pass on its REQUIRED checks while a 'preferred' one is unmet.
        // Surface those as warnings/gaps so the outcome is honest ("done, but this is
        // thin") instead of either a silent pass or a dead-end.
        const verdict = {
          ...combineVerdicts(predicateVerdict, verificationResults),
          warnings: [...warnings, ...(predicateVerdict.gaps || [])],
          ...(predicateVerdict.advisory_unmet?.length ? { advisory_unmet: predicateVerdict.advisory_unmet } : {}),
        };
        verdict.contract_rejections = projectContractRejections({
          stage,
          verdict,
          producer: stage.execution?.mode === 'adapter' ? `adapter:${stage.execution.adapter_id}` : 'room',
          attempt: repairAttempt,
        });

        await this.store.appendCheckpoint(runId, orgId, {
          stageId: stage.id,
          phase: 'AFTER_EXECUTION',
          status: verdict.passed ? (warnings.length ? 'PASSED_WITH_WARNINGS' : 'PASSED') : 'FAILED',
          verdict,
          artifactRefs: persisted.map((artifact) => artifact.id),
          state: { attempt: repairAttempt, execution_attempt: attempts[stage.id], stage_visit: visitCount, rounds_used: Math.max(1, Number(result?.rounds_used || 1)) },
        });
        await notifyStage(this.onStageState, { phase: verdict.passed ? 'ACCEPTED' : 'REJECTED', run, stage, artifacts: persisted, verdict });

        if (!verdict.passed) {
          const attempt = repairAttempt;
          if (stage.on_failure === 'REPAIR' && attempt < stage.max_attempts) {
            await this.store.updateRun(runId, orgId, { lastVerdict: verdict, status: 'ACTIVE' });
            continue;
          }
          const status = stage.on_failure === 'TERMINATE' ? 'TERMINATED' : 'NEEDS_INTERVENTION';
          await this.store.updateRun(runId, orgId, { status, lastVerdict: verdict, ...(status === 'TERMINATED' ? { completedAt: new Date() } : {}) });
          return this.store.loadRun(runId, orgId);
        }

        const transition = selectTransition(stage, grouped, this.predicates);
        const completedStageIds = [...new Set([...run.completedStageIds, stage.id])];
        if (transition.to_terminal) {
          await this.store.updateRun(runId, orgId, {
            status: 'COMPLETED',
            completedStageIds,
            terminalState: transition.to_terminal,
            lastVerdict: verdict,
            context: clearStageRepairAttempt(run.context, stage.id),
            completedAt: new Date(),
          });
          await this.store.appendCheckpoint(runId, orgId, {
            stageId: stage.id,
            phase: 'TERMINAL',
            status: 'COMPLETED',
            state: { terminal_state: transition.to_terminal },
            verdict,
          });
          return this.store.loadRun(runId, orgId);
        }

        const waitingFor = eventWait(stage, persisted);
        await this.store.updateRun(runId, orgId, {
          status: waitingFor ? 'WAITING_EVENT' : 'ACTIVE',
          currentStageId: transition.to_stage,
          completedStageIds,
          waitingFor,
          lastVerdict: verdict,
          context: clearStageRepairAttempt(run.context, stage.id),
        });
        await this.store.appendCheckpoint(runId, orgId, {
          stageId: stage.id,
          phase: waitingFor ? 'EVENT_REQUIRED' : 'STAGE_ADVANCED',
          status: waitingFor ? 'WAITING_EVENT' : 'ACTIVE',
          state: { next_stage_id: transition.to_stage, waiting_for: waitingFor },
          verdict,
        });
        if (waitingFor) return this.store.loadRun(runId, orgId);
      }
      throw new Error('runtime_executor_step_limit_exceeded');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await this.store.releaseRun(runId, orgId, leaseOwner);
    }
  }
}
