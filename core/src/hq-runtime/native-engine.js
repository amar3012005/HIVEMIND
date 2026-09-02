import { appendHqEvent, scheduleHqWake, transitionHqRuntime } from './repository.js';
import { buildHqContext } from './context.js';
import { HqSkillRegistry, HqToolkitRegistry } from './skill-registry.js';
import { ingestPendingInstructions, reconcileTodoCapabilities } from './instruction-loop.js';
import { narrateAwakening } from './awakening-narrator.js';
import { stageAuthorityHash } from '../runtime-playbooks/stage-executor.js';
import { projectCurrentActivationSprint } from './activation-sprint.js';
import { activateEligibleFirstLifeWork, ensureFirstLifeBootstrapProposal, projectFirstLifeOperatingGate, effectClass } from './first-life-control.js';
import { revokeAuthoritiesForNewInstruction } from './authority-revocation.js';
import { resolveAuthorityPreference } from './contracts.js';
import { publishHqRuntimeTransient } from './event-bus.js';
import { loadFirstLifePolicy } from '../growth/first-life-policy.js';
import { getHyperagentsRuntimeConnectorProvider, runtimeConnectorConnectPath } from '../connectors/runtime-provider-policy.js';
import { bindPlaybookContext } from '../runtime-playbooks/director-selector.js';
import { projectRuntimeLiveness } from './liveness.js';

const DAY = 86400000;

// This internal first-life checkpoint is selected by policy, not by task text.
// The executor still requires the immutable playbook identity at creation time.
export const FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK = Object.freeze({
  id: 'operations.browser-admin-checkin-to-status',
  version: 1,
});

const hasMetric = (source, key) => Object.prototype.hasOwnProperty.call(source || {}, key)
  && source[key] !== null && source[key] !== undefined && Number.isFinite(Number(source[key]));
const metric = (value) => Number(value).toLocaleString('en-US');

export function summarizeBaselineResult(baseline = {}) {
  const social = baseline.social_presence && typeof baseline.social_presence === 'object' ? baseline.social_presence : {};
  const followers = Array.isArray(social.followers) ? social.followers : [];
  const followerSummary = followers.map((row) => {
    const platform = String(row?.platform || 'channel').toLowerCase() === 'twitter' ? 'X' : String(row?.platform || 'channel').replace(/^./, (value) => value.toUpperCase());
    const value = row?.currentFollowers ?? row?.current_followers;
    return value == null ? `${platform}: followers not observed` : `${platform}: ${metric(value)} followers`;
  });
  const totals = social.totals && typeof social.totals === 'object' ? social.totals : {};
  const activity = [['impressions', 'impressions'], ['reach', 'reach'], ['likes', 'likes'], ['clicks', 'clicks']]
    .map(([key, label]) => hasMetric(totals, key) ? `${metric(totals[key])} ${label}` : `${label} not observed`);
  const websiteLimited = Boolean(baseline.website?.limitation)
    || String(baseline.website?.provider || '').toLowerCase() === 'fallback';
  const pagesObserved = !websiteLimited && hasMetric(baseline.website, 'mapped_pages');
  const pages = pagesObserved ? Number(baseline.website.mapped_pages) : null;
  const gaps = Array.isArray(baseline.data_gaps) ? baseline.data_gaps.filter(Boolean) : [];
  return {
    summary: `${pagesObserved ? `I observed ${pages} website page(s).` : 'Website pages were not observed.'} ${followerSummary.length ? `${followerSummary.join('; ')}. ` : 'Follower totals were not observed. '}${activity.join(', ')} across the observed window.${gaps.length ? ` I retained ${gaps.length} evidence gap(s) for planning.` : ''}`,
    details: { website_pages: pages, followers: followers.map((row) => ({ platform: row.platform, username: row.username, current_followers: row.currentFollowers ?? row.current_followers ?? null, growth: row.growth ?? null, growth_percentage: row.growthPercentage ?? row.growth_percentage ?? null })), totals, evidence_gaps: gaps },
  };
}

export function summarizeGrowthPlanResult(result = {}) {
  const constraints = (Array.isArray(result.plan?.constraints) ? result.plan.constraints : []).map((item) => String(item?.type || item?.statement || '')).filter(Boolean);
  const todos = (Array.isArray(result.plan?.operating_queue) ? result.plan.operating_queue : []).map((item, index) => `${index + 1}. ${item.title} -> ${item.room_tag}`);
  return {
    summary: `I ranked ${constraints.length} material constraint(s): ${constraints.join(', ') || 'none'}. I committed ${todos.length} ordered todo(s): ${todos.join('; ') || 'none'}.`,
    details: { constraints: result.plan?.constraints || [], operating_queue: result.plan?.operating_queue || [], todo_ids: result.committed?.todo_ids || [] },
  };
}

// Popup email hook (2026-08-17): the SAME eventTypes the Runtime terminal's
// own POPUP=true classification uses (see runtime-probe-e2e.py, kept in
// sync deliberately) also trigger a persona-voice email into the owner's
// standing thread — best-effort, fire-and-forget, must never affect the
// cycle's own outcome or block on email delivery.
const POPUP_EVENT_TYPES = new Set(['approval_required', 'capability_required', 'decision_required']);

async function event(prisma, runtime, cycle, input) {
  const appended = await appendHqEvent({ prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch, cycleId: cycle.id, ...input });
  if (POPUP_EVENT_TYPES.has(input.eventType)) {
    import('./persona-narrator.js')
      .then(({ notifyOwnerByEmail }) => notifyOwnerByEmail({ prisma, runtime, kind: 'popup', title: input.title, summary: input.summary, details: input.details }))
      .catch(() => {});
  }
  return appended;
}

export function resolveWorkResultTodo({ order, result }) {
  if (!order || !result) return null;
  const resultOutput = result.output && typeof result.output === 'object' ? result.output : {};
  return {
    resultOutput,
    todoId: resultOutput.todo_id || order.inputSnapshot?.todo_id || null,
  };
}

export function playbookRunOwnsCapacity(run) {
  if (!run || !['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY'].includes(run.status)) return false;
  if (run.status !== 'WAITING_EVENT') return true;
  // A run parked on capability.connected is waiting on a HUMAN to connect a tool —
  // that can take days. It must never freeze the rest of the company; independent
  // safe work must keep moving. Every other WAITING_EVENT kind still needs its
  // playbook to explicitly opt in via releases_execution_slot, but a missing-
  // connector wait always releases the slot regardless of that flag. Root-caused
  // 2026-08-14/15: DIOR's X campaign sat WAITING_EVENT for 30+ hours waiting on
  // the X connector, and that alone silently held the company's single execution
  // slot the entire time — a READY, fully independent "Find Clients in New York"
  // todo never got dispatched, despite the design intent (see roomInFlight above)
  // being exactly the opposite.
  if ((run.waitingFor?.types || []).includes('capability.connected')) return false;
  return run.waitingFor?.releases_execution_slot !== true;
}

// Cross-domain parallelism, steady state (2026-08-16): the harder case
// deliberately deferred when the idle-only version shipped (see
// [hq_wake_trigger_dedup_audit] / runtime_envisioned_end_state.md item 8) —
// starting lane B while lane A is already running. A lane is "occupied" by
// whichever effectClass (internal/external) the currently in-flight work
// belongs to: a RUNNING todo, or a capacity-owning RuntimePlaybookRun
// resolved back to its owning todo via run.trigger.todo_id (the same
// linkage `runtime_playbook_result` reconciliation already uses at the top
// of this file). If a capacity-owning run's todo can't be resolved (missing
// from the fetched todo set, or trigger.todo_id absent), this fails SAFE —
// both lanes are reported occupied — rather than risking two same-effect-
// class Rooms running at once, which the original one-at-a-time invariant
// exists to prevent.
export function occupiedLaneEffectClasses({ todos = [], capacityOwningRuns = [] }) {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const classes = new Set();
  let hasUnresolvedOwner = false;
  for (const todo of todos) if (todo.status === 'RUNNING') classes.add(effectClass(todo));
  for (const run of capacityOwningRuns) {
    if (!playbookRunOwnsCapacity(run)) continue;
    const todoId = String(run.trigger?.todo_id || '');
    const linkedTodo = todoId ? byId.get(todoId) : null;
    if (linkedTodo) classes.add(effectClass(linkedTodo));
    else hasUnresolvedOwner = true;
  }
  return hasUnresolvedOwner ? new Set(['internal', 'external']) : classes;
}

// Returns readyTodo itself only when its lane is genuinely free — a Room is
// in flight, but in the OTHER effectClass entirely. Returns null when
// nothing is in flight at all (that's the idle-burst case above, already
// handled), when the lane is occupied, or when occupancy can't be
// attributed (fail-safe, see occupiedLaneEffectClasses).
export function freeLaneReadyTodo({ readyTodo, todos = [], capacityOwningRuns = [] }) {
  if (!readyTodo) return null;
  const occupied = occupiedLaneEffectClasses({ todos, capacityOwningRuns });
  if (occupied.size === 0) return null;
  return occupied.has(effectClass(readyTodo)) ? null : readyTodo;
}

// The first-life browser check-in is OPTIONAL: it may briefly hold planning
// while an administrator adds current context, but it must never freeze the
// company. A run still in progress waits; a run that exhausted verification
// (NEEDS_INTERVENTION) or terminated proceeds without a status; a completed run
// proceeds with the captured status. Returning BLOCKED forever on an optional
// check-in that produced no source-backed `user_current_status` was the cause
// of the wake-loop where first-life planning never ran.
export function adminCheckinDisposition(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'COMPLETED') return 'proceed';
  if (s === 'NEEDS_INTERVENTION' || s === 'TERMINATED' || s === 'FAILED') return 'proceed_unverified';
  return 'wait';
}

export function shouldOfferFirstLifeAdminCheckin({ initialPlanAbsent, optionalAdminCheckin, runtimePlaybooksAvailable }) {
  return initialPlanAbsent === true && optionalAdminCheckin === true && runtimePlaybooksAvailable === true;
}

// Phase 3 of the recurring-operating-cycle build (2026-08-15): before this
// change, an existing latestGrowthPlan permanently disabled replanning for
// BOTH 'initial_full' (correct — bootstrap is genuinely one-time) and
// v7's recurring 'operate' mode (a bug — it meant "operate" could only ever
// fire ONE extra time, right after first-life motions complete, then never
// again; not a real recurring loop). cadenceRequested lets a daily_cadence
// wake re-enter 'operate' mode even with a plan already on file — every
// other caller is unaffected (cadenceRequested defaults false, so every
// existing call site behaves byte-identical to before this change).
export function growthPlanModeForState({ latestGrowthPlan, focusedOutcome, policy, firstLifeGate, cadenceRequested = false }) {
  if (focusedOutcome) return null;
  const bootstrapActive = policy?.initial_lifecycle?.bypass_growth_plan !== true;
  if (bootstrapActive) return latestGrowthPlan ? null : 'initial_full';
  if (policy?.ongoing_operation?.growth_plan_enabled !== true || firstLifeGate?.motions_complete !== true) return null;
  if (latestGrowthPlan && !cadenceRequested) return null;
  return String(policy.ongoing_operation.mode || 'operate');
}

export function shouldAutoStartFirstLifeBootstrap({ activationStatus, policy, todo } = {}) {
  if (!['AWAITING_START', 'READY'].includes(String(activationStatus || ''))) return false;
  if (policy?.auto_start_internal_bootstrap !== true) return false;
  return todo?.context?.effect_class === 'internal'
    && Boolean(todo.context?.planned_playbook_id)
    && Number.isInteger(Number(todo.context?.planned_playbook_version));
}

export function isPolicyBootstrapTodo(todo = {}) {
  return String(todo?.context?.proposal_origin || '') === 'first_life_bootstrap';
}

export function operatingDecisionEvidenceRefs(evidence = {}) {
  return [evidence?.baseline?.id, evidence?.latest_growth_plan?.id].filter(Boolean);
}

export function selectPendingPlaybookRun(runs = []) {
  return runs.find((run) => run.status === 'ACTIVE')
    || runs.find((run) => run.status === 'WAITING_AUTHORITY')
    || runs.find((run) => run.status === 'WAITING_EVENT')
    || null;
}

export function specialistWorkObjective(todo, skillId) {
  return String(todo?.objective || todo?.title || '').trim();
}

export function lifecycleSelectionObjective(todo) {
  const title = String(todo?.title || '').trim();
  const objective = specialistWorkObjective(todo);
  if (!title || title === objective) return objective;
  return `${title}\n\n${objective}`;
}

export function compactCompanyOperatingContext(company = {}) {
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  return {
    name: company.company || company.name || profile.name || null,
    website: company.website || profile.website || null,
    location: company.company_location || profile.location || company.location || null,
    mission: company.mission || profile.mission || null,
    profile: {
      industry: profile.industry || null,
      business_model: profile.business_model || null,
      offer: profile.offer || null,
      icp: profile.icp || null,
      positioning: profile.positioning || null,
      capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.slice(0, 20) : [],
      risks: Array.isArray(profile.risks) ? profile.risks.slice(0, 12) : [],
    },
  };
}
export function verifySpecialistDelivery({ order, result, resultOutput }) {
  const status = String(result?.status || '').toLowerCase();
  const summary = String(result?.summary || '').trim();
  const failures = [];
  if (status !== 'completed') failures.push(`terminal_status:${status || 'missing'}`);
  if (!summary) failures.push('summary_missing');
  if (resultOutput.code === 'company_identity_mismatch') failures.push('company_identity_mismatch');
  const output = resultOutput && typeof resultOutput === 'object' ? resultOutput : {};
  const completionRequirements = Array.isArray(order?.inputSnapshot?.completion_requirements)
    ? order.inputSnapshot.completion_requirements : [];
  const contract = output.work_order_result && typeof output.work_order_result === 'object'
    ? output.work_order_result : null;
  const requirementResults = Array.isArray(contract?.completion_requirements)
    ? contract.completion_requirements : [];
  for (const requirement of completionRequirements) {
    const check = requirementResults.find((row) => row?.type === requirement?.type);
    if (!check || check.met !== true) failures.push(`completion_requirement_unmet:${requirement?.type || 'unknown'}`);
  }
  if (completionRequirements.length && !contract) failures.push('completion_contract_missing');
  if (contract && String(contract.status || '').toLowerCase() !== 'completed') failures.push(`contract_status:${contract.status || 'missing'}`);
  return { accepted: failures.length === 0, failures };
}

// Internal autonomy is NOT outward-write authority. HQ_AUTO_EXECUTE removes the internal
// Start gate so the queue drains unattended — it was never meant to publish. But a single
// historical "Auto" click writes gate_overrides[policy]='auto' on the runtime, which then
// authorised EVERY future external checkpoint: observed live, a campaign launched 5 real
// posts ~2 minutes after activation with no human present. Require an explicit opt-in for
// unattended external writes, defaulting to SAFE. Set
// HQ_ALLOW_UNATTENDED_EXTERNAL=true to restore standing auto authority.
function unattendedExternalAllowed() {
  return String(process.env.HQ_ALLOW_UNATTENDED_EXTERNAL || '').trim().toLowerCase() === 'true';
}

// Phase 1 of the recurring-operating-cycle build (2026-08-15): today, once the
// first Growth Plan's todos are exhausted, HQ has no wake left to fire and
// simply goes quiet forever — purely event-reactive, never revisits the
// company on its own. daily_cadence is the fix: a wake driven by the
// passage of time, not an external event. Default OFF so it cannot affect
// any currently-running org until explicitly enabled. The cadence mode
// branch itself (what a daily_cadence wake actually DOES) is Phase 2 — this
// flag and the first-arm call below only make the trigger exist.
export function dailyCadenceEnabled() {
  return String(process.env.HQ_DAILY_CADENCE_ENABLED || '').trim().toLowerCase() === 'true';
}

export function nextCadenceDueAt(from = new Date()) {
  const hourUtc = Math.min(23, Math.max(0, parseInt(process.env.HQ_DAILY_CADENCE_HOUR_UTC || '13', 10) || 13));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, 0, 0, 0));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function cadenceIdempotencyKey(runtimeId, dueAt) {
  return `daily_cadence:${runtimeId}:${dueAt.toISOString().slice(0, 10)}`;
}

/**
 * The queue-exhausted sleep's declared checkpoint (`dueAt`) can be many days
 * out — a real trace showed 7. daily_cadence, when enabled, already has its
 * own independent ~24h wake armed regardless, so the TRUE next wake can be
 * much sooner than the checkpoint. This resolves what should actually be
 * displayed/narrated as "next wake" (`runtime.nextWakeAt`, the sleep-reason
 * text, the schedule_created event) — never later than the real checkpoint,
 * but reflecting cadence when it fires first. Pulled out as a pure function
 * so it's directly unit-testable — `runCycle` itself needs a live Prisma
 * transaction to exercise.
 */
export function resolveQueueExhaustedDisplayWakeAt({ queueExhausted, dueAt, cadenceEnabled, now = new Date() }) {
  if (!queueExhausted || !cadenceEnabled) return { displayDueAt: dueAt, displayDueAtIsCadence: false };
  const cadenceDueAt = nextCadenceDueAt(now);
  if (!dueAt || cadenceDueAt.getTime() < dueAt.getTime()) return { displayDueAt: cadenceDueAt, displayDueAtIsCadence: true };
  return { displayDueAt: dueAt, displayDueAtIsCadence: false };
}

// Journal-recall (2026-08-15): context.growth.journal is already fetched by
// buildHqContext (last 12 growth_journal rows) and already reaches the FE
// dashboard — but until now nothing fed it back into the one place that
// actually makes strategic decisions. Recon confirmed planner.js never
// queries growthJournal/hqCycle/hqRuntimeEvent itself, so every growth plan
// was built from scratch with no memory of what was already decided or why.
// additionalEvidence is an existing, already-wired pass-through (merges
// straight into the LLM's prompt context, no schema/validation change) —
// this projection feeds through that channel rather than adding a new one.
// Already capped at 12 by buildHqContext; projected to a compact shape so
// raw artifact/goal UUIDs don't bloat the prompt for no benefit.
export function projectRecentDecisions(journal = []) {
  return (Array.isArray(journal) ? journal : []).map((entry) => ({
    event_type: entry?.eventType || entry?.event_type || null,
    summary: entry?.summary || null,
    decision: entry?.decision || null,
    created_at: entry?.createdAt || entry?.created_at || null,
  }));
}

// Phase 4 of the recurring-operating-cycle build (2026-08-15): the
// operating_cycle_brief. Populated ONLY from persisted state (hq_todos,
// hq_runtime_events) — never from the model's own recollection of what it
// did, per the same rule that already governs every other completion claim
// in this file (artifacts/predicates, not prose). Reuses hq_runtime_events
// as the storage — it's already the durable, queryable log of everything
// a runtime has ever done, and adding a dedicated table/migration for one
// more event shape would duplicate that without a real need (HqWorkflowArtifact
// requires a non-nullable workflowId FK to an unrelated subsystem, so it's
// not a natural fit here).
const BRIEF_BLOCKED_STATUSES = ['BLOCKED', 'WAITING_FOR_CONNECTOR', 'WAITING_FOR_AUTHORITY'];
const BRIEF_WAITING_STATUSES = ['READY', 'PROPOSED'];
const BRIEF_DECISION_EVENT_TYPES = ['approval_required', 'capability_required'];

// Traces each shipped todo back to why it exists: the growth stage and
// constraint it was proposed to serve, and the success measure the growth
// plan itself defined for it. All three already live on todo.context at
// creation (core/src/growth/operating-loop.js) — this is a pure projection,
// not a new query or schema field. Deliberately NOT joined to
// RuntimePerformanceMetric: every metric writer (room-director.js,
// tara/outbound-call-service.js) populates stageId from the PLAYBOOK
// EXECUTION stage (e.g. 'deliver_outreach'), never from GrowthStage.id — the
// two are unrelated ID spaces that happen to share a column name. A join on
// that column would silently match nothing and look wired while reporting
// empty forever. There is currently no business-outcome metric recorded
// against a growth stage anywhere in the codebase; only operational metrics
// (latency, connection counts) exist. That half of the graph needs a real
// outcome-metric source before it can be built, not a hollow join.
export function projectStrategyTrace(todo) {
  const context = todo.context && typeof todo.context === 'object' ? todo.context : {};
  return {
    growth_stage_id: context.growth_stage_id || null,
    constraint_id: context.constraint_id || null,
    success_measure: context.success_measure || null,
  };
}

export function projectOperatingCycleBrief({ todos = [], events = [], periodStartedAt, periodEndedAt }) {
  const completed = todos
    .filter((todo) => todo.status === 'COMPLETED' && todo.completedAt && new Date(todo.completedAt) >= periodStartedAt)
    .map((todo) => ({
      todo_id: todo.id, title: todo.title, completed_at: new Date(todo.completedAt).toISOString(),
      ...projectStrategyTrace(todo),
    }));
  const blocked = todos
    .filter((todo) => BRIEF_BLOCKED_STATUSES.includes(todo.status))
    .map((todo) => ({ todo_id: todo.id, title: todo.title, status: todo.status, blocked_reason: todo.blockedReason || null }));
  const waiting = todos
    .filter((todo) => BRIEF_WAITING_STATUSES.includes(todo.status))
    .map((todo) => ({ todo_id: todo.id, title: todo.title, status: todo.status }));
  const decisionsNeeded = events
    .filter((evt) => BRIEF_DECISION_EVENT_TYPES.includes(evt.eventType))
    .map((evt) => ({ event_id: evt.id, event_type: evt.eventType, title: evt.title, summary: evt.summary }));
  return {
    schema: 'operating-cycle-brief.v1',
    period: { started_at: periodStartedAt.toISOString(), ended_at: periodEndedAt.toISOString() },
    completed,
    blocked,
    waiting,
    decisions_needed: decisionsNeeded,
    counts: { completed: completed.length, blocked: blocked.length, waiting: waiting.length, decisions_needed: decisionsNeeded.length },
  };
}

export async function buildOperatingCycleBrief({ prisma, runtime, periodStartedAt }) {
  const periodEndedAt = new Date();
  const [todos, events] = await Promise.all([
    prisma.hqTodo.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId }, orderBy: { updatedAt: 'desc' }, take: 100 }),
    prisma.hqRuntimeEvent.findMany({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, createdAt: { gte: periodStartedAt } },
      orderBy: { createdAt: 'asc' }, take: 200,
    }),
  ]);
  return projectOperatingCycleBrief({ todos, events, periodStartedAt, periodEndedAt });
}

// Root-caused live 2026-08-15 for org DIOR: a legitimate, correctly-deduped
// connector_changed wake (one per minute, exactly as the earlier dedup fix
// intends) still re-narrated the FULL "company in view / checked instructions
// / re-ranked queue / one task at a time / waiting for access" block every
// single time, forever, while a connector stayed disconnected — 191
// near-identical cycles over 2h44m. The scheduling was never the bug; the
// narration never asked "did anything actually change since last time."
export function isRepeatCapabilityWait({ triggerType, lastObservationDetails, openCapabilityId }) {
  if (triggerType !== 'connector_changed') return false;
  if (!openCapabilityId) return false;
  return Boolean(lastObservationDetails) && lastObservationDetails.capability_request_id === openCapabilityId;
}

async function detectNoisyConnectorRepeat({ prisma, runtime, triggerType }) {
  if (triggerType !== 'connector_changed') return false;
  const [openRequest, lastObservation] = await Promise.all([
    prisma.hqCapabilityRequest.findFirst({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'REQUIRED' },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.hqRuntimeEvent.findFirst({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, eventType: { in: ['observation', 'sleep', 'blocked'] } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return isRepeatCapabilityWait({
    triggerType, lastObservationDetails: lastObservation?.details || null, openCapabilityId: openRequest?.id || null,
  });
}

export function resolveAuthorityDecision(stage, authorityPolicy = {}) {
  const gate = String(stage?.authority_gate || '').trim() || null;
  const policyKey = String(stage?.authority_policy_key || '').trim() || null;
  const manualOnly = stage?.authority_policy_mode === 'manual_only';
  const storedAuto = !manualOnly && Boolean(gate) && Boolean(policyKey)
    && resolveAuthorityPreference(authorityPolicy, policyKey) === 'auto';
  const autoGrant = storedAuto && unattendedExternalAllowed();
  return {
    gate,
    policyKey,
    preference: manualOnly ? 'manual' : resolveAuthorityPreference(authorityPolicy, policyKey),
    autoGrant,
    manualOnly,
    // Distinguish "you asked for auto but this deployment requires a human for outward
    // writes" from "no auto was ever granted", so the approval copy can say which.
    autoWithheld: storedAuto && !autoGrant,
  };
}

export class NativeHqEngine {
  constructor({ prisma, logger = console, runtimePlaybooks = null }) {
    this.prisma = prisma;
    this.logger = logger;
    this.runtimePlaybooks = runtimePlaybooks;
    this.skills = new HqSkillRegistry();
    this.toolkits = new HqToolkitRegistry();
  }

  async runCycle({ runtime, cycle, trigger }) {
    const prisma = this.prisma;
    if (!runtime?.epoch || !cycle?.runtimeEpoch || String(runtime.epoch) !== String(cycle.runtimeEpoch)) {
      throw new Error('hq_cycle_runtime_epoch_obsolete');
    }
    let state = runtime.state;
    const move = async (to, data = {}) => {
      runtime = await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch, from: state, to, data });
      state = to;
    };
    if (state === 'WAITING' && ['work_result', 'runtime_playbook_result'].includes(trigger.type)) {
      await move('REVIEWING', { blockedReason: null });
    } else if (state === 'WAITING' || state === 'BLOCKED') {
      await move('OBSERVING', { blockedReason: null });
    }
    const firstAwakening = trigger.type === 'onboarding_complete' || trigger.type === 'user_first_activation';
    const restartAwakening = firstAwakening && Boolean(trigger.payload?.restart);
    // A poller hitting /v1/hq/capabilities/recheck legitimately once a minute,
    // forever, while a connector stays disconnected is CORRECT behavior for the
    // capacity/dedup fixes already shipped this session — but it means an
    // identical "waiting for access" outcome was re-narrated in full every single
    // minute (observed live: 191 near-duplicate cycles for org DIOR over 2h44m,
    // all correctly deduped at the schedule level, none of it a bug in scheduling
    // — just the narration never checking whether anything had actually changed).
    // Suppress the routine boilerplate + repeat wait narration ONLY when this is a
    // connector_changed cycle whose blocking reason is byte-identical to the last
    // one narrated; any real change (different capability, connector resolved, a
    // human-initiated wake) narrates in full exactly as before.
    const isNoisyRepeatCycle = await detectNoisyConnectorRepeat({ prisma, runtime, triggerType: trigger.type }).catch(() => false);
    let context = await buildHqContext({ prisma, runtime, trigger });
    const awakeningStreamId = firstAwakening ? `awakening:${cycle.id}` : null;
    if (awakeningStreamId) await publishHqRuntimeTransient({
      runtimeId: runtime.id, orgId: runtime.orgId,
      event: { type: 'model_stream', phase: 'start', stream_id: awakeningStreamId, event_type: 'wake', title: 'I am here' },
    });
    const awakening = firstAwakening ? await narrateAwakening({
      company: context.company,
      objective: runtime.objective,
      capabilities: [...context.capabilities.connected, ...context.capabilities.platform_managed],
      restart: restartAwakening,
      fallbackApiKey: process.env.GROQ_API_KEY,
      onDelta: async (delta) => publishHqRuntimeTransient({
        runtimeId: runtime.id, orgId: runtime.orgId,
        event: { type: 'model_stream', phase: 'delta', stream_id: awakeningStreamId, event_type: 'wake', delta },
      }),
    }) : null;
    if (awakeningStreamId) await publishHqRuntimeTransient({
      runtimeId: runtime.id, orgId: runtime.orgId,
      event: { type: 'model_stream', phase: 'done', stream_id: awakeningStreamId, event_type: 'wake' },
    });
    if (!isNoisyRepeatCycle) await event(prisma, runtime, cycle, { eventType: 'wake', title: firstAwakening ? 'I am here' : 'I am awake', summary: firstAwakening
      ? awakening.narration
      : `I am awake. ${String(trigger.type || 'An event').replaceAll('_', ' ')} moved, so I am reading the company before I touch anything.`, details: firstAwakening ? { stream_id: awakeningStreamId, model_streamed: !awakening.fallback, narration_model: awakening.model, narration_provider: awakening.provider, narration_fallback: awakening.fallback, usage: awakening.usage } : {} });
    // Day-0 persona email — one continuous thread starts here, best-effort,
    // never blocks the activation cycle it's narrating.
    if (firstAwakening) import('./persona-narrator.js')
      .then(({ notifyOwnerByEmail }) => notifyOwnerByEmail({ prisma, runtime, kind: 'activation' }))
      .catch(() => {});
    // NARRATION GATE. A lifecycle walking its stages produces many internal wakes
    // (runtime_playbook_result / queue_advance). Re-emitting the full "company in view /
    // checked instructions / re-ranked queue" block on each one produced the duplicated
    // console spam and made a [Sleeping] line look like it never slept. Narrate the
    // boilerplate only for the first awakening and for triggers a human would recognise;
    // internal churn stays silent while real decisions, delegations, blocks, approvals and
    // sleeps still always emit. isNoisyRepeatCycle additionally suppresses a
    // connector_changed cycle whose blocking reason is byte-identical to the
    // immediately preceding one — a real, different, or human-initiated wake
    // always narrates in full regardless.
    const narrateRoutine = !isNoisyRepeatCycle && (firstAwakening || ['user_wake', 'instruction_updated', 'connector_changed',
      'onboarding_complete', 'user_first_activation', 'checkpoint', 'material_evidence', 'daily_cadence'].includes(String(trigger.type || '')));
    // Phase 2 of the recurring-operating-cycle build (2026-08-15): daily_cadence is
    // self-perpetuating — it must re-arm tomorrow's wake on every cadence cycle,
    // not just the first time (Phase 1 only arms it once, from initial_plan_ready).
    // Done FIRST, before any other logic this cycle, so tomorrow's wake exists even
    // if something later in this specific cycle throws. Re-checks the flag (not just
    // trigger.type) so disabling HQ_DAILY_CADENCE_ENABLED mid-flight is a real kill
    // switch, not just a no-op for new arms. Everything else this cycle needs — the
    // baseline/growth-plan bootstrap skip — falls out for free: buildingInitialPlan
    // and growthPlanModeForState are already gated on real state (a plan already
    // exists by the time cadence runs), not on trigger type, so no special-casing
    // was needed to keep a cadence wake from re-running Stage 1/2 bootstrap logic.
    if (trigger.type === 'daily_cadence' && dailyCadenceEnabled()) {
      const nextDueAt = nextCadenceDueAt();
      await scheduleHqWake({
        prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
        idempotencyKey: cadenceIdempotencyKey(runtime.id, nextDueAt),
        triggerType: 'daily_cadence', dueAt: nextDueAt,
        payload: { armed_from: 'daily_cadence_self_rearm' },
      });
      // Phase 4: the operating_cycle_brief — wrapped so a brief-building
      // failure can NEVER block the self-rearm above (already run) or crash
      // the cycle; this is observability, not load-bearing logic.
      try {
        const priorCadence = await prisma.hqSchedule.findFirst({
          where: {
            runtimeId: runtime.id, orgId: runtime.orgId, triggerType: 'daily_cadence', status: 'COMPLETED',
            ...(trigger.schedule_id ? { id: { not: trigger.schedule_id } } : {}),
          },
          orderBy: { completedAt: 'desc' },
        });
        const periodStartedAt = priorCadence?.completedAt ? new Date(priorCadence.completedAt) : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const brief = await buildOperatingCycleBrief({ prisma, runtime, periodStartedAt });
        const hadActivity = brief.counts.completed || brief.counts.blocked || brief.counts.waiting || brief.counts.decisions_needed;
        await event(prisma, runtime, cycle, {
          eventType: 'operating_cycle_brief',
          title: hadActivity ? 'Operating cycle brief' : 'No material change detected',
          summary: hadActivity
            ? `${brief.counts.completed} completed, ${brief.counts.blocked} blocked, ${brief.counts.waiting} waiting, ${brief.counts.decisions_needed} decision(s) needed since the last review.`
            : 'No material change since the last review. Existing work remains owned; no new task batch was created.',
          details: brief,
        });
      } catch (briefError) {
        this.logger?.warn?.('[hq-runtime] operating_cycle_brief failed (non-fatal):', briefError?.message || briefError);
      }
    }
    if (narrateRoutine) await event(prisma, runtime, cycle, {
      eventType: 'context_loaded', title: 'I have the company in view',
      summary: `${String(context.company?.company || context.company?.name || context.company?.profile?.name || 'The company')} has ${context.evidence.baseline ? 'a retained baseline' : 'no current baseline yet'}, ${context.pending_work.length} active work order(s), and ${context.capabilities.connected.length} connected ${context.capabilities.connected.length === 1 ? 'capability' : 'capabilities'}. I will use only what is actually present.`,
      evidenceRefs: [context.evidence.baseline?.id, context.evidence.latest_growth_plan?.id].filter(Boolean),
    });

    const baselineMissingBeforeCollection = !context.evidence.baseline;
    const buildingInitialPlan = !context.evidence.latest_growth_plan;
    const appliedInstructions = await ingestPendingInstructions({
      prisma, runtime, company: context.company, deferTodos: buildingInitialPlan,
      onProgress: async ({ instructionId }) => {
        const alreadyShown = await prisma.hqRuntimeEvent.findFirst({
          where: {
            runtimeId: runtime.id,
            eventType: 'observation',
            details: { path: ['interpreting_instruction_id'], equals: instructionId },
          },
        }).catch(() => null);
        if (!alreadyShown) await event(prisma, runtime, cycle, {
          eventType: 'observation',
          title: 'I am reading the operating requirement',
          summary: 'I am preserving the requested outcome, boundaries, and execution mode before I add anything to the operating plan.',
          details: { interpreting_instruction_id: instructionId },
        });
      },
    });
    if (!appliedInstructions.length && !firstAwakening && narrateRoutine) await event(prisma, runtime, cycle, {
      eventType: 'instruction_checked', title: 'I checked for new operating instructions',
      summary: 'No unapplied instruction changed the operating queue. I will use the current priorities rather than replaying old work.',
    });
    for (const applied of appliedInstructions) {
      await event(prisma, runtime, cycle, {
        eventType: 'instruction_received', title: 'I have accepted a new operating instruction',
        summary: applied.instruction.body, details: { instruction_id: applied.instruction.id, interpretation: applied.interpreted },
      });
      // Self-correction v1: a genuinely new instruction is the one
      // unambiguous "something changed" signal available today. Revoke any
      // still-in-flight authority so a prepared-under-the-old-context draft
      // cannot fire on stale approval — this never touches a run that's
      // already COMPLETED/TERMINATED/FAILED (see authority-revocation.js).
      const revocation = await revokeAuthoritiesForNewInstruction({
        prisma, runtime, instructionId: applied.instruction.id, instructionBody: applied.instruction.body,
      }).catch((revokeError) => {
        this.logger?.warn?.('[hq-runtime] authority revocation check failed (non-fatal):', revokeError?.message || revokeError);
        return { revoked: [] };
      });
      for (const revokedAuthority of revocation.revoked) await event(prisma, runtime, cycle, {
        eventType: 'blocked',
        title: `A new instruction invalidated a pending approval: ${revokedAuthority.gate}`,
        summary: 'The new operating instruction changes the context this approval was granted under. I revoked it — the checkpoint will require a fresh review before it can proceed, so nothing fires on stale context.',
        details: { authority_id: revokedAuthority.id, run_id: revokedAuthority.runId, playbook_id: revokedAuthority.playbookId, stage_id: revokedAuthority.stageId, instruction_id: applied.instruction.id },
      });
      if (applied.todo) {
        for (const [index, todo] of (applied.todos || [applied.todo]).entries()) await event(prisma, runtime, cycle, {
          eventType: 'todo_created',
          title: index === 0 ? `Added to my operating queue: ${todo.title}` : `Queued after its dependency: ${todo.title}`,
          summary: todo.objective,
          details: { todo_id: todo.id, status: todo.status, workflow_index: index,
            required_capabilities: todo.requiredCapabilities, depends_on_todo_id: todo.context?.depends_on_todo_id || null },
          skillRef: todo.context?.skill || applied.interpreted.skill,
        });
      }
      else await event(prisma, runtime, cycle, {
        eventType: 'observation', title: 'I retained this requirement for the first operating plan',
        summary: 'I will not turn it into isolated work before the baseline and company-wide constraint ranking are complete.',
        details: { instruction_id: applied.instruction.id, interpretation: applied.interpreted },
      });
    }
    if (appliedInstructions.some((item) => item.todo)) {
      const activation = await activateEligibleFirstLifeWork({
        prisma, runtime, expansionTrigger: 'user_instruction', proposalOrigin: 'user_instruction',
      });
      for (const promoted of activation.promoted) await event(prisma, runtime, cycle, {
        eventType: 'todo_created', title: `Promoted by the new instruction: ${promoted.title}`,
        summary: 'The instruction now owns an available execution slot and is eligible for semantic playbook selection.',
        details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'user_instruction' },
      });
    }
    if (!appliedInstructions.some((item) => item.todo)) {
      const activation = await activateEligibleFirstLifeWork({
        prisma, runtime, expansionTrigger: 'user_instruction', proposalOrigin: 'user_instruction',
      });
      for (const promoted of activation.promoted) await event(prisma, runtime, cycle, {
        eventType: 'todo_created', title: `Resumed retained instruction: ${promoted.title}`,
        summary: 'The retained instruction now owns an available execution slot and is eligible for semantic playbook selection.',
        details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'user_instruction' },
      });
    }
    let capabilityState = await reconcileTodoCapabilities({ prisma, runtime });
    for (const resolved of capabilityState.resolved) {
      await event(prisma, runtime, cycle, {
        eventType: 'capability_resolved', title: 'A required capability is available',
        summary: `${resolved.platform_managed?.length ? `${resolved.platform_managed.join(', ')} is provided by the platform.` : `I verified ${resolved.capabilities.join(', ')} against this organization.`} The blocked todo is ready again, so I am continuing from it instead of rebuilding the plan.`,
        details: resolved,
      });
      const waitingRun = this.runtimePlaybooks ? await prisma.runtimePlaybookRun.findFirst({
        where: { orgId: runtime.orgId, status: 'WAITING_EVENT', trigger: { path: ['todo_id'], equals: resolved.todo_id } },
        orderBy: { updatedAt: 'desc' },
      }) : null;
      if (waitingRun && (waitingRun.waitingFor?.types || []).includes('capability.connected')) {
        let resumedRun = waitingRun;
        for (const capability of resolved.capabilities || []) {
          resumedRun = await this.runtimePlaybooks.resumeEvent(waitingRun.id, runtime.orgId, {
            id: `capability-connected:${waitingRun.id}:${capability}`,
            type: 'capability.connected',
            data: { capability, correlation_ref: capability, todo_id: resolved.todo_id },
          });
        }
        const projectedTodo = capabilityState.todos.find((todo) => todo.id === resolved.todo_id);
        if (projectedTodo && projectedTodo.status === 'READY') projectedTodo.status = resumedRun?.status === 'WAITING_EVENT' ? 'WAITING_FOR_CONNECTOR' : 'RUNNING';
      }
    }
    for (const request of baselineMissingBeforeCollection ? [] : capabilityState.requests) {
      const alreadyShown = await prisma.hqRuntimeEvent.findFirst({ where: { runtimeId: runtime.id, eventType: 'capability_required', details: { path: ['capability_request_id'], equals: request.id } } }).catch(() => null);
      if (!alreadyShown) await event(prisma, runtime, cycle, {
        eventType: 'capability_required', title: `I need ${request.provider} to continue`, summary: request.reason,
        details: { capability_request_id: request.id, todo_id: request.todoId, provider: request.provider, connect_path: request.connectPath },
      });
    }
    let readyTodo = capabilityState.todos.find((todo) => todo.status === 'READY');
    const focusedOutcome = capabilityState.todos.find((todo) => (
      todo.context?.execution_mode === 'single_outcome' && todo.status !== 'COMPLETED'
    ));
    // SEQUENTIAL, single-in-flight: the runtime hands ONE bounded task to a Room, then
    // sleeps; that Room's result wakes it to dispatch the next. It must NEVER open a
    // second Room while one is already working. Auto-execute makes every opportunity
    // READY, so without this guard a burst of wakes could fan out several Rooms at once
    // (parallel, dangerous). A room is in flight when a todo is RUNNING or a playbook run
    // is ACTIVE/WAITING. When in flight we neither dispatch nor re-plan — we wait.
    let roomInFlight = capabilityState.todos.some((todo) => todo.status === 'RUNNING')
      || (this.runtimePlaybooks ? !!(await prisma.runtimePlaybookRun.findFirst({
        where: { orgId: runtime.orgId, status: 'ACTIVE' },
        select: { id: true },
      }).catch(() => null)) : false);
    // Only narrate the queue when it actually has something to say — a real next item,
    // or a human-recognisable trigger. Announcing 'there is no executable todo' on every
    // internal wake was the other half of the duplicated spam. readyTodo alone used to
    // force this through even when isNoisyRepeatCycle was true (a still-READY todo behind
    // an unchanged connector wait re-narrated "next priority" every single minute) — now
    // explicitly excluded too.
    if (!isNoisyRepeatCycle && (readyTodo || narrateRoutine)) await event(prisma, runtime, cycle, {
      eventType: 'queue_checked', title: 'I re-ranked the operating queue',
      summary: readyTodo
        ? `The next executable priority is ${readyTodo.title}. Waiting items remain retained but will not stall safe work behind them.`
        : 'There is no executable todo ahead of the active stage. I will wait only for the evidence or capability that can change the next decision.',
      details: { next_todo_id: readyTodo?.id || null, platform_managed_capabilities: capabilityState.platform_managed || [] },
    });

    const forceBaseline = Boolean(trigger.payload?.restart || trigger.payload?.fresh_start) && !context.evidence.baseline;
    const baselineMissing = forceBaseline || !context.evidence.baseline;
    const baselineStale = !baselineMissing && (!context.evidence.company_identity.matches || !context.evidence.company_identity.current_onboarding);
    if (baselineMissing || baselineStale) {
      const baselineSkill = this.skills.load('baseline-establishment');
      const [baselineToolkit] = this.toolkits.select(['growth_baseline']);
      await event(prisma, runtime, cycle, {
        eventType: 'skill_loaded', title: 'I need an exact starting position',
        summary: baselineSkill.description, skillRef: baselineSkill.id,
        details: { model_policy: baselineSkill.model_policy || { mode: 'deterministic_tools', model: null } },
      });
      await event(prisma, runtime, cycle, {
        eventType: 'tool_started', title: 'I am establishing the company baseline',
        summary: forceBaseline ? 'Runtime restart requested a fresh full source transfer from the post-onboarding boundary.' : baselineStale ? 'The company changed, so I am replacing stale evidence with a full source transfer.' : 'No baseline exists, so I am collecting the first full source transfer.',
        toolRef: 'growth_baseline_collect', details: { toolkit: baselineToolkit.id, depth: 'full_transfer', model: null },
      });
      try {
        const baseline = await this.toolkits.invoke('growth_baseline', 'collect', {
          mode: 'full_all', scheduleRuntimeWake: false,
        }, {
          prisma,
          orgId: runtime.orgId,
          userId: runtime.ownerUserId,
          baselineRunId: cycle.id,
          onObservation: async (observation) => event(prisma, runtime, cycle, {
            eventType: 'baseline_observation',
            title: observation.source_key,
            summary: observation.status,
            evidenceRefs: [observation.artifact_id],
            details: observation,
          }),
        });
        const acknowledged = summarizeBaselineResult(baseline);
        await event(prisma, runtime, cycle, {
          eventType: 'tool_result', title: 'I have established the current position',
          summary: acknowledged.summary,
          toolRef: 'growth_baseline_collect', evidenceRefs: [baseline.resource_id],
          details: { toolkit: baselineToolkit.id, resource_id: baseline.resource_id, model: null, usage: { prompt_tokens: 0, completion_tokens: 0 }, ...acknowledged.details },
        });
        context = await buildHqContext({ prisma, runtime, trigger });
      } catch (error) {
        await move('BLOCKED', { blockedReason: error.message });
        await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'I cannot establish a trustworthy baseline', summary: `The evidence door is closed: ${error.message}. I will not invent a company position to keep the interface moving.`, skillRef: baselineSkill.id, toolRef: 'growth_baseline_collect' });
        return { transition: 'ESCALATE', reason: 'baseline_collection_failed' };
      }
    }

    if (!context.evidence.baseline || !context.evidence.company_identity.matches || !context.evidence.company_identity.current_onboarding) {
      await move('BLOCKED', { blockedReason: 'Fresh baseline did not reconcile with the current company identity.' });
      await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'I stopped before acting on mixed company evidence', summary: 'The evidence still describes more than one company. Motion would look productive and be wrong. I will not delegate from an uncertain identity.' });
      return { transition: 'ESCALATE', reason: 'baseline_company_mismatch' };
    }

    const websitePages = Number(context.evidence.baseline.website_pages || 0);
    const socialAccountCount = Number(context.evidence.baseline.social_accounts || 0);
    const recentPostCount = Number(context.evidence.baseline.recent_posts || 0);
    const missingEvidence = [
      websitePages === 0 ? 'website' : null,
      socialAccountCount === 0 ? 'connected social accounts' : null,
      recentPostCount === 0 ? 'recent social activity' : null,
    ].filter(Boolean);
    if (missingEvidence.length) {
      const alreadyRecorded = await prisma.hqRuntimeEvent.findFirst({
        where: {
          runtimeId: runtime.id,
          eventType: 'observation',
          details: { path: ['baseline_id'], equals: context.evidence.baseline.id },
        },
      }).catch(() => null);
      if (!alreadyRecorded) await event(prisma, runtime, cycle, {
        eventType: 'observation', title: 'I recorded the baseline evidence gaps',
        summary: `The initial position is usable only with limits. I could not observe ${missingEvidence.join(', ')}. I will not present those areas as measured; the next plan must treat them as unknowns and request access when the task depends on them.`,
        details: { missing_evidence: missingEvidence, website_pages: websitePages, social_accounts: socialAccountCount, recent_posts: recentPostCount, baseline_id: context.evidence.baseline.id },
        evidenceRefs: [context.evidence.baseline.id],
      });
    }
    if (baselineMissingBeforeCollection) {
      for (const request of capabilityState.requests) await event(prisma, runtime, cycle, {
        eventType: 'capability_required', title: `I need ${request.provider} to continue`, summary: request.reason,
        details: { capability_request_id: request.id, todo_id: request.todoId, provider: request.provider, connect_path: request.connectPath },
      });
    }

    // First-life check-in follows the baseline and precedes diagnosis. Growth and
    // specialist work must not run ahead of the administrator's Talk/Skip decision.
    const firstLifePolicy = await loadFirstLifePolicy();
    const initialPlanAbsent = !context.evidence.latest_growth_plan;
    if (shouldOfferFirstLifeAdminCheckin({
      initialPlanAbsent,
      optionalAdminCheckin: firstLifePolicy.optional_admin_checkin,
      runtimePlaybooksAvailable: Boolean(this.runtimePlaybooks),
    })) {
      const adminRuns = await prisma.runtimePlaybookRun.findMany({
        where: { orgId: runtime.orgId },
        orderBy: { updatedAt: 'desc' },
        take: 24,
      });
      let adminRun = adminRuns.find((run) => run.playbookId === 'operations.browser-admin-checkin-to-status'
        && Number(run.playbookVersion) === 1
        && String(run.trigger?.runtime_epoch || '') === String(runtime.epoch)
        && run.trigger?.first_life_admin_checkin === true) || null;
      if (!adminRun) {
        const room = await prisma.hyperRoom.findFirst({
          where: { orgId: runtime.orgId, archivedAt: null, roomTag: 'general' },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });
        if (room) {
          adminRun = await this.runtimePlaybooks.executor.createRun({
            orgId: runtime.orgId,
            roomId: room.id,
            playbookId: FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK.id,
            playbookVersion: FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK.version,
            idempotencyKey: `first-life-admin-checkin:${runtime.epoch}`,
            trigger: { runtime_id: runtime.id, runtime_epoch: runtime.epoch, cycle_id: cycle.id, first_life_admin_checkin: true },
            context: {
              company: compactCompanyOperatingContext(context.company),
              baseline: context.evidence.baseline,
              request: { instruction: runtime.objective || '', objective: runtime.objective || '' },
              policy: { first_life_policy_id: firstLifePolicy.policy_id, first_life_policy_version: firstLifePolicy.version },
            },
          });
          adminRun = await this.runtimePlaybooks.execute(adminRun.id, runtime.orgId);
        }
      }
      const adminDisposition = adminRun ? adminCheckinDisposition(adminRun.status) : 'proceed';
      if (adminRun && adminDisposition === 'wait') {
        const alreadyShown = await prisma.hqRuntimeEvent.findFirst({
          // Runtime events are epoch-bounded by their parent Runtime reset. The
          // event table itself intentionally carries no runtimeEpoch column.
          where: { runtimeId: runtime.id, eventType: 'decision_required', details: { path: ['admin_checkin_run_id'], equals: adminRun.id } },
        }).catch(() => null);
        if (!alreadyShown) await event(prisma, runtime, cycle, {
          eventType: 'decision_required',
          title: 'A brief internal check-in is available',
          summary: 'You can speak with Runtime in this browser to correct or enrich the initial diagnosis before strategy work begins, or skip and continue from the retained evidence.',
          details: { admin_checkin_run_id: adminRun.id, first_life_policy: { id: firstLifePolicy.policy_id, version: firstLifePolicy.version } },
        });
        await move('WAITING', { blockedReason: null, currentCycleId: null, nextWakeAt: null });
        return { transition: 'WAIT_FOR_ADMIN_CHECKIN', run_id: adminRun.id };
      }
      if (adminRun && adminDisposition === 'proceed_unverified') {
        // The optional check-in exhausted verification without a source-backed
        // status. It must NOT freeze the company: note it once and continue to
        // first-life planning from the established baseline (planning already
        // treats a missing user_current_status as null evidence).
        const alreadyNoted = await prisma.hqRuntimeEvent.findFirst({
          where: { runtimeId: runtime.id, eventType: 'observation', details: { path: ['admin_checkin_unverified_run_id'], equals: adminRun.id } },
        }).catch(() => null);
        if (!alreadyNoted) await event(prisma, runtime, cycle, {
          eventType: 'observation',
          title: 'Internal check-in did not add a verified status',
          summary: 'Runtime retained the browser conversation but could not verify a source-backed current-status record. The check-in is optional, so I will form the first operating plan from the established baseline and treat this check-in as closed.',
          details: { admin_checkin_unverified_run_id: adminRun.id, admin_checkin_status: String(adminRun.status), first_life_policy: { id: firstLifePolicy.policy_id, version: firstLifePolicy.version } },
        });
        // fall through — do not block, do not return; planning runs below.
      }
    }

    // Versioned first-life policy owns the bootstrap lifecycle. When it declares
    // a direct initial lifecycle, materialize that one internal proposal without
    // asking the Growth Planner to manufacture a queue first.
    if (firstLifePolicy.initial_lifecycle?.bypass_growth_plan === true && this.runtimePlaybooks) {
      const adminStatusRun = await prisma.runtimePlaybookRun.findFirst({
        where: {
          orgId: runtime.orgId,
          playbookId: FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK.id,
          status: 'COMPLETED',
          trigger: { path: ['runtime_epoch'], equals: runtime.epoch },
        },
        include: { artifacts: { orderBy: { createdAt: 'desc' } } },
        orderBy: { updatedAt: 'desc' },
      });
      const adminCurrentStatus = adminStatusRun?.artifacts
        ?.find((artifact) => artifact.artifactKey === 'user_current_status') || null;
      const bootstrap = await ensureFirstLifeBootstrapProposal({
        prisma,
        runtime,
        policy: firstLifePolicy,
        registry: this.runtimePlaybooks.registry,
        company: compactCompanyOperatingContext(context.company),
        baseline: context.evidence.baseline,
        adminCurrentStatus,
        connectedCapabilities: [
          ...(context.capabilities?.connected || []),
          ...(context.capabilities?.platform_managed || []),
        ],
        instruction: runtime.objective || '',
      });
      if (bootstrap.created) await event(prisma, runtime, cycle, {
        eventType: 'todo_created',
        title: `I prepared the first internal lifecycle: ${bootstrap.todo.title}`,
        summary: 'The versioned first-life policy selected this evidence-only lifecycle directly. Growth Planning will begin later, after the first-life program has produced outcomes.',
        details: {
          todo_id: bootstrap.todo.id,
          first_life_policy: { id: firstLifePolicy.policy_id, version: firstLifePolicy.version },
          playbook_id: bootstrap.todo.context?.planned_playbook_id,
          playbook_version: bootstrap.todo.context?.planned_playbook_version,
        },
        evidenceRefs: bootstrap.todo.context?.evidence_refs || [],
      });
    }

    const activationSprint = await projectCurrentActivationSprint({ prisma, orgId: runtime.orgId });
    // A current-policy internal bootstrap starts without a synthetic Start gate.
    // Historical policies still retain their recorded AWAITING_START behavior.
    if (['AWAITING_START', 'READY'].includes(activationSprint?.status)) {
      const recommended = activationSprint.items?.find((item) => item.todo_id === activationSprint.recommended_todo_id)
        || activationSprint.items?.[0];
      const recommendedTodo = recommended?.todo_id ? await prisma.hqTodo.findFirst({
        where: { id: recommended.todo_id, runtimeId: runtime.id, orgId: runtime.orgId },
      }) : null;
      let internalBootstrap = false;
      if (shouldAutoStartFirstLifeBootstrap({
        activationStatus: activationSprint.status,
        policy: firstLifePolicy,
        todo: recommendedTodo,
      })) {
        try {
          const declared = this.runtimePlaybooks.registry.get(
            recommendedTodo.context.planned_playbook_id,
            Number(recommendedTodo.context.planned_playbook_version),
            { scopeKey: 'global' },
          );
          internalBootstrap = declared.metadata?.effect_class === 'internal'
            && !(declared.stages || []).some((stage) => stage.authority_gate);
        } catch { internalBootstrap = false; }
      }
      if (internalBootstrap) {
        const activation = await activateEligibleFirstLifeWork({
          prisma, runtime, expansionTrigger: 'internal_bootstrap',
        });
        if (activation.promoted.length) {
          capabilityState = await reconcileTodoCapabilities({ prisma, runtime });
          readyTodo = capabilityState.todos.find((todo) => todo.status === 'READY');
          roomInFlight = capabilityState.todos.some((todo) => todo.status === 'RUNNING')
            || (this.runtimePlaybooks ? !!(await prisma.runtimePlaybookRun.findFirst({
              where: { orgId: runtime.orgId, status: 'ACTIVE' }, select: { id: true },
            }).catch(() => null)) : false);
          await event(prisma, runtime, cycle, {
            eventType: 'todo_created', title: `I started the evidence-only recommendation: ${activation.promoted[0].title}`,
            summary: 'This internal lifecycle performs strategy preparation only. It has no provider effect and grants no external authority.',
            details: { todo_id: activation.promoted[0].id, expansion_trigger: 'internal_bootstrap' },
          });
        }
      }
      if (!internalBootstrap && activationSprint.status === 'AWAITING_START') {
      const alreadyRequested = await prisma.hqRuntimeEvent.findFirst({
        where: {
          runtimeId: runtime.id,
          eventType: 'approval_required',
          details: { path: ['activation_sprint_id'], equals: activationSprint.id },
        },
      }).catch(() => null);
      if (!alreadyRequested) await event(prisma, runtime, cycle, {
        eventType: 'decision_required',
        title: 'The first operating plan is ready',
        summary: 'I have committed evidence-backed proposals but will not delegate them until you start the recommendation. External authority remains undecided until a real immutable action reaches its gate.',
        details: {
          activation_sprint_id: activationSprint.id,
          policy: activationSprint.policy || null,
          item_count: activationSprint.item_count,
        },
      });
      await move('WAITING', { blockedReason: null, currentCycleId: null, nextWakeAt: null });
      return { transition: 'WAIT_FOR_FIRST_LIFE_START', activation_sprint_id: activationSprint.id };
      }
    }

    let queueContinuationScheduled = false;
    let initialPolicyCommitted = false;
    let adminCheckinScheduled = false;
    let reconciledLifecycleOwnsCapacity = false;
    const firstLifeOperatingGate = firstLifePolicy.initial_lifecycle?.bypass_growth_plan === true
      ? await projectFirstLifeOperatingGate({ prisma, runtime }) : null;
    const growthPlanMode = growthPlanModeForState({
      latestGrowthPlan: context.evidence.latest_growth_plan,
      focusedOutcome,
      policy: firstLifePolicy,
      firstLifeGate: firstLifeOperatingGate,
      cadenceRequested: trigger.type === 'daily_cadence',
    });
    if (trigger.type === 'runtime_playbook_result') {
      const runId = String(trigger.payload?.run_id || '');
      const run = runId ? await prisma.runtimePlaybookRun.findFirst({
        where: { id: runId, orgId: runtime.orgId },
        include: { artifacts: { orderBy: { createdAt: 'asc' } }, checkpoints: { orderBy: { sequence: 'asc' } } },
      }) : null;
      const todoId = String(run?.trigger?.todo_id || trigger.payload?.todo_id || '');
      const todo = todoId ? await prisma.hqTodo.findFirst({ where: { id: todoId, runtimeId: runtime.id, orgId: runtime.orgId } }) : null;
      reconciledLifecycleOwnsCapacity = playbookRunOwnsCapacity(run);
      if (run?.trigger?.first_life_admin_checkin === true) {
        // The check-in has no todo by design. Its persisted terminal artifact is
        // additional planning evidence, never a work-order result.
        context = await buildHqContext({ prisma, runtime, trigger });
      } else if (!run || !todo) {
        await move('BLOCKED', { blockedReason: 'A playbook result arrived without its durable run or owning todo.' });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked', title: 'Playbook result could not be reconciled',
          summary: 'HQ retained the event and stopped rather than guessing which operating item it completed.',
          details: { run_id: runId, todo_id: todoId || null },
        });
        return { transition: 'ESCALATE', reason: 'runtime_playbook_result_missing' };
      }
      if (run?.trigger?.first_life_admin_checkin === true) {
        // Continue below: the regular first-life check sees the terminal run and
        // invokes the initial diagnosis exactly once.
      } else {
      const artifactRefs = run.artifacts.map((artifact) => artifact.artifactId);
      const artifactCounts = run.artifacts.reduce((counts, artifact) => {
        const key = String(artifact.artifactKey || 'artifact');
        counts[key] = Number(counts[key] || 0) + 1;
        return counts;
      }, {});
      const artifactSummary = Object.entries(artifactCounts)
        .map(([key, count]) => `${count} ${key}`)
        .join(', ');
      if (run.status === 'WAITING_AUTHORITY') {
        const playbook = this.runtimePlaybooks?.registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
        const stage = playbook?.stages?.find((candidate) => candidate.id === run.currentStageId);
        const authority = resolveAuthorityDecision(stage, runtime.authorityPolicy);
        if (authority.autoGrant) {
          await this.runtimePlaybooks.grantAuthority(run.id, runtime.orgId, authority.gate, {
            grantedBy: runtime.ownerUserId,
            payload: { source: 'organization_policy', policy_key: authority.policyKey, input_hash: stageAuthorityHash(run, stage) },
          });
          await prisma.hqTodo.update({ where: { id: todo.id }, data: { status: 'RUNNING', blockedReason: null } });
          await event(prisma, runtime, cycle, {
            eventType: 'verification', title: `Authority granted by organization policy: ${todo.title}`,
            summary: `The ${authority.policyKey} policy is Auto. The exact checkpoint is authorized and the lifecycle will continue without broadening its scope.`,
            details: { run_id: run.id, gate: authority.gate, policy_key: authority.policyKey },
          });
        } else {
          await prisma.hqTodo.update({ where: { id: todo.id }, data: {
            status: 'WAITING_FOR_AUTHORITY', blockedReason: `Approval required for ${authority.policyKey || 'this checkpoint'}.`,
            result: { runtime_playbook_run_id: run.id, authority_gate: authority.gate, authority_policy_key: authority.policyKey },
          } });
          await event(prisma, runtime, cycle, {
            eventType: 'approval_required', title: `Approval required: ${todo.title}`,
            summary: 'The Room completed the preparatory stages. HQ is holding the exact checkpoint before any governed external action.',
            details: { run_id: run.id, gate: authority.gate, policy_key: authority.policyKey },
          });
        }
        await move('WAITING', { nextWakeAt: null, currentCycleId: null, blockedReason: null });
        return { transition: 'WAIT', reason: 'runtime_playbook_waiting_authority', run_id: run.id };
      } else if (run.status === 'WAITING_EVENT') {
        const waitingForCapability = (run.waitingFor?.types || []).includes('capability.connected');
        const waitingCapability = waitingForCapability ? String(run.waitingFor?.capability || '').trim().toLowerCase() : '';
        const waitingPresentation = run.waitingFor?.presentation || {};
        const waitingTitle = String(waitingPresentation.title || '').trim()
          || (waitingForCapability ? `A connection is required: ${todo.title}` : `Waiting for lifecycle evidence: ${todo.title}`);
        const waitingSummary = String(waitingPresentation.summary || '').trim()
          || (waitingForCapability
            ? `The Room's accepted work and ${artifactRefs.length} durable artifact(s) remain attached to this execution. HQ is waiting for the missing tenant connection and will resume the same playbook checkpoint when it becomes available.`
            : `The lifecycle completed ${run.completedStageIds.length} checkpointed stage(s) and retained ${artifactRefs.length} durable artifact(s). The same checkpoint will resume when its declared event or deadline arrives.`);
        await prisma.hqTodo.update({ where: { id: todo.id }, data: {
          status: waitingForCapability ? 'WAITING_FOR_CONNECTOR' : 'MONITORING',
          blockedReason: waitingForCapability ? 'A required tenant capability is not connected yet.' : null,
          ...(waitingCapability ? {
            requiredCapabilities: [...new Set([...(todo.requiredCapabilities || []), waitingCapability])],
            context: {
              ...(todo.context || {}),
              runtime_required_capabilities: [...new Set([...(todo.context?.runtime_required_capabilities || []), waitingCapability])],
              runtime_capability_run_id: run.id,
            },
          } : {}),
          result: {
            runtime_playbook_run_id: run.id,
            playbook_id: run.playbookId,
            playbook_version: run.playbookVersion,
            status: run.status,
            waiting_for: run.waitingFor || {},
            artifact_refs: artifactRefs,
          },
        } });
        if (waitingCapability) {
          const existingRequest = await prisma.hqCapabilityRequest.findFirst({
            where: { runtimeId: runtime.id, todoId: todo.id, capability: waitingCapability, status: 'REQUIRED' },
          });
          if (!existingRequest) await prisma.hqCapabilityRequest.create({ data: {
            runtimeId: runtime.id,
            orgId: runtime.orgId,
            todoId: todo.id,
            capability: waitingCapability,
            provider: getHyperagentsRuntimeConnectorProvider(),
            reason: String(run.waitingFor?.reason || `${todo.title} requires ${waitingCapability} before it can continue.`),
            connectPath: runtimeConnectorConnectPath(waitingCapability),
          } });
        }
        await event(prisma, runtime, cycle, {
          eventType: waitingForCapability ? 'capability_required' : 'observation',
          title: waitingTitle,
          summary: waitingSummary,
          details: { run_id: run.id, waiting_for: run.waitingFor || {}, artifact_refs: artifactRefs },
          evidenceRefs: artifactRefs,
        });
        if (waitingForCapability || run.waitingFor?.releases_execution_slot !== true) {
          await move('WAITING', { nextWakeAt: null, currentCycleId: null, blockedReason: null });
          return {
            transition: 'WAIT',
            reason: waitingForCapability ? 'runtime_playbook_waiting_capability' : 'runtime_playbook_waiting_event',
            run_id: run.id,
          };
        }
        if (!waitingForCapability && run.waitingFor?.releases_execution_slot === true) {
          const activation = await activateEligibleFirstLifeWork({
            prisma, runtime, expansionTrigger: 'verified_monitoring_checkpoint',
          });
          for (const promoted of activation.promoted) await event(prisma, runtime, cycle, {
            eventType: 'todo_created',
            title: `Promoted from the operating plan: ${promoted.title}`,
            summary: 'A verified lifecycle checkpoint released policy capacity. This proposal is now eligible for its own playbook selection.',
            details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'verified_monitoring_checkpoint' },
          });
          if (activation.promoted.length) {
            await scheduleHqWake({
              prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
              idempotencyKey: `first-life-monitoring:${run.id}:${run.checkpointSequence}`,
              triggerType: 'queue_advance', dueAt: new Date(),
              payload: { run_id: run.id, promoted_todo_ids: activation.promoted.map((item) => item.id) },
            });
            queueContinuationScheduled = true;
          }
        }
      } else {
        const requestedTerminals = Array.isArray(run.context?.playbook_selection?.acceptable_terminal_states)
          ? run.context.playbook_selection.acceptable_terminal_states : [];
        const terminalMatchesRequest = requestedTerminals.length > 0 && requestedTerminals.includes(run.terminalState);
        const completed = run.status === 'COMPLETED' && terminalMatchesRequest;
        // A terminal state that ASKS FOR INPUT (campaign_needs_input, *_needs_input) is a
        // human-in-the-loop request, not a broken lifecycle. It was reported as
        // "Playbook needs intervention" and then rolled into "retained todo(s) cannot
        // advance because their exact lifecycle or owner is unavailable" — which is false
        // and hid an actionable ask: the lifecycle ran correctly and is waiting on the
        // operator. Classify it separately so the user is asked, not told it broke.
        const needsUserInput = run.status === 'COMPLETED' && !terminalMatchesRequest
          && /(^|_)needs_input$/.test(String(run.terminalState || ''));
        const outcomeGap = run.status === 'COMPLETED' && !terminalMatchesRequest
          ? (needsUserInput
            ? `The lifecycle completed and is waiting on you: it reached ${run.terminalState}. Provide the missing input (or cancel it) and this work continues — nothing is broken and nothing external was sent.`
            : `Lifecycle reached ${run.terminalState || 'an unspecified terminal state'}, but the requested outcome requires one of: ${requestedTerminals.join(', ') || 'a Director-approved terminal state'}.`)
          : null;
        await prisma.hqTodo.update({
          where: { id: todo.id },
          data: {
            status: completed ? 'COMPLETED' : 'BLOCKED',
            completedAt: completed ? new Date() : null,
            blockedReason: completed ? null : (outcomeGap || JSON.stringify(run.lastVerdict || {})).slice(0, 2000),
            result: {
              runtime_playbook_run_id: run.id,
              playbook_id: run.playbookId,
              playbook_version: run.playbookVersion,
              terminal_state: run.terminalState,
              status: run.status,
              artifact_refs: artifactRefs,
              requested_terminal_states: requestedTerminals,
              requested_outcome_satisfied: completed,
              last_verdict: run.lastVerdict || {},
            },
          },
        });
        await event(prisma, runtime, cycle, {
          eventType: completed ? 'decision' : needsUserInput ? 'decision_required' : 'blocked',
          title: completed
            ? `Completed: ${todo.title}`
            : needsUserInput
              ? `Your input is needed: ${todo.title}`
              : `Playbook needs intervention: ${todo.title}`,
          summary: completed
            ? `I read the completed lifecycle and accepted ${artifactRefs.length} durable output(s)${artifactSummary ? `: ${artifactSummary}` : ''}. It reached ${run.terminalState} after ${run.completedStageIds.length} checkpointed stage(s). This todo is complete; the next executable queue item can now start.`
            : outcomeGap || 'The lifecycle stopped at a failed predicate or terminal safety condition. Exact unmet checks remain attached to the run.',
          details: { run_id: run.id, playbook_id: run.playbookId, terminal_state: run.terminalState, requested_terminal_states: requestedTerminals, requested_outcome_satisfied: completed, artifact_refs: artifactRefs, artifact_counts: artifactCounts, verdict: run.lastVerdict || {} },
          evidenceRefs: artifactRefs,
        });
        if (completed) {
          const proposalOrigin = String(todo.context?.proposal_origin || '');
          const programBuilderReady = proposalOrigin === 'first_life_bootstrap'
            && firstLifePolicy.initial_lifecycle?.materialize_motions === true;
          const strategyMotionCompleted = proposalOrigin === 'strategy_program';
          const activation = await activateEligibleFirstLifeWork({
            prisma,
            runtime,
            expansionTrigger: programBuilderReady ? 'strategy_program_ready' : 'verified_result',
            proposalOrigin: programBuilderReady || strategyMotionCompleted ? 'strategy_program' : null,
          });
          for (const promoted of activation.promoted) await event(prisma, runtime, cycle, {
            eventType: 'todo_created',
            title: `Promoted from the operating plan: ${promoted.title}`,
            summary: 'A verified result released policy capacity. This proposal is now eligible for its own playbook selection.',
            details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'verified_result' },
          });
          if (activation.promoted.length) {
            await scheduleHqWake({
              prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
              idempotencyKey: `first-life-result:${run.id}:${run.checkpointSequence}`,
              triggerType: 'queue_advance', dueAt: new Date(),
              payload: { run_id: run.id, promoted_todo_ids: activation.promoted.map((item) => item.id) },
            });
            queueContinuationScheduled = true;
          }
        }
      }
    }
    }
    // Reconcile after applying the current lifecycle event. The pre-cycle snapshot can
    // still say RUNNING after the result above completed it, which used to suppress the
    // next READY task and let a future measurement deadline win.
    capabilityState = await reconcileTodoCapabilities({ prisma, runtime });
    readyTodo = capabilityState.todos.find((todo) => todo.status === 'READY');
    const capacityOwningRuns = this.runtimePlaybooks
      ? await prisma.runtimePlaybookRun.findMany({
        where: { orgId: runtime.orgId, status: { in: ['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY'] } },
        select: { id: true, status: true, waitingFor: true, trigger: true },
      }).catch(() => [])
      : [];
    roomInFlight = capabilityState.todos.some((todo) => todo.status === 'RUNNING')
      || reconciledLifecycleOwnsCapacity
      || capacityOwningRuns.some(playbookRunOwnsCapacity);
    // Cross-domain parallelism, steady state: computed once, read by both the
    // dispatch branch (to admit a genuinely free lane alongside in-flight
    // work) and the wait branch (to fall through here only when no free lane
    // exists). See freeLaneReadyTodo above for the fail-safe attribution rule.
    const freeLaneTodo = roomInFlight
      ? freeLaneReadyTodo({ readyTodo, todos: capabilityState.todos, capacityOwningRuns })
      : null;
    if (trigger.type === 'work_result') {
      const workOrderId = String(trigger.payload?.work_order_id || '');
      const order = workOrderId ? await prisma.hyperWorkOrder.findFirst({
        where: { id: workOrderId, orgId: runtime.orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null } },
      }) : null;
      const result = order ? await prisma.hyperWorkResult.findFirst({
        where: { workOrderId: order.id, runtimeEpoch: runtime.epoch }, orderBy: { attempt: 'desc' },
      }) : null;
      const reviewSkill = this.skills.load('stage-review');
      await event(prisma, runtime, cycle, {
        eventType: 'skill_loaded', title: 'Specialist result review selected',
        summary: reviewSkill.description, skillRef: reviewSkill.id, workOrderId: order?.id || null,
      });
      const workResult = resolveWorkResultTodo({ order, result });
      if (!workResult) {
        await move('BLOCKED', { blockedReason: 'A Work Result event arrived without a durable result packet.' });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked', title: 'Specialist result could not be reconciled',
          summary: 'HQ retained the event and stopped rather than inventing or replaying specialist work.',
          workOrderId: order?.id || null,
        });
        return { transition: 'ESCALATE', reason: 'work_result_missing' };
      }
      const { todoId, resultOutput } = workResult;
      const delivery = verifySpecialistDelivery({ order, result, resultOutput });
      const accepted = delivery.accepted;
      if (todoId) await prisma.hqTodo.updateMany({ where: { id: todoId, runtimeId: runtime.id }, data: accepted
        ? { status: 'COMPLETED', result: resultOutput, completedAt: new Date(), blockedReason: null }
        : { status: 'BLOCKED', result: resultOutput, blockedReason: delivery.failures.join(', ') } });
      if (order.growthDelegationId) await prisma.growthDelegation.updateMany({
        where: { id: order.growthDelegationId, orgId: runtime.orgId },
        data: accepted
          ? { status: 'COMPLETED', result: resultOutput, completedAt: new Date() }
          : { status: 'BLOCKED', result: { ...resultOutput, governance_failures: delivery.failures } },
      });
      await event(prisma, runtime, cycle, {
        eventType: 'verification',
        title: accepted ? 'Specialist result accepted' : 'Specialist result requires intervention',
        summary: accepted
          ? 'The bounded result is durable, attributable, evidence-linked, and ready to inform the active Growth Stage.'
          : `HQ rejected this as incomplete: ${delivery.failures.join('; ')}. The Work Order remains executable and will not be counted as completed.`,
        details: { status: result.status, attempt: result.attempt, usage: result.usage, governance_failures: delivery.failures },
        workOrderId: order.id, evidenceRefs: Array.isArray(result.evidence) ? result.evidence : [],
      });
      if (!accepted) {
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `queue-after-blocked:${order.id}`,
          triggerType: 'queue_advance', dueAt: new Date(),
          payload: { todo_id: todoId, rejected_work_order_id: order.id, governance_failures: delivery.failures },
        });
        await move('WAITING', { blockedReason: null, currentCycleId: null, nextWakeAt: new Date() });
        await event(prisma, runtime, cycle, {
          eventType: 'schedule_created', title: 'I retained the gap and advanced the queue',
          summary: 'The incomplete todo remains blocked with its exact governance gaps. I will not regenerate the same work. Another independent ready priority may proceed while this evidence gap remains visible.',
          details: { todo_id: todoId, rejected_work_order_id: order.id, governance_failures: delivery.failures },
          workOrderId: order.id,
        });
        return { transition: 'WAIT', reason: 'specialist_delivery_incomplete', failures: delivery.failures };
      }
      const dependents = todoId ? await prisma.hqTodo.findMany({
        where: {
          runtimeId: runtime.id, orgId: runtime.orgId, status: 'WAITING_FOR_DEPENDENCY',
          context: { path: ['depends_on_todo_id'], equals: todoId },
        },
        orderBy: [{ priority: 'asc' }, { position: 'asc' }],
      }) : [];
      const upstreamContract = resultOutput?.work_order_result && typeof resultOutput.work_order_result === 'object'
        ? resultOutput.work_order_result : null;
      for (const dependent of dependents) {
        await prisma.hqTodo.update({ where: { id: dependent.id }, data: {
          status: 'READY', blockedReason: null,
          context: {
            ...(dependent.context || {}), upstream_todo_id: todoId,
            upstream_work_order_id: order.id,
            upstream_result: upstreamContract ? {
              status: upstreamContract.status,
              deliverables: Array.isArray(upstreamContract.deliverables) ? upstreamContract.deliverables.slice(0, 20) : [],
              evidence_refs: Array.isArray(upstreamContract.evidence_refs) ? upstreamContract.evidence_refs.slice(0, 30) : [],
            } : { status: result.status, summary: result.summary },
          },
        } });
        await event(prisma, runtime, cycle, {
          eventType: 'todo_created', title: `Dependency satisfied: ${dependent.title}`,
          summary: `${dependent.title} is now executable with the accepted output from ${order.title}.`,
          details: { todo_id: dependent.id, depends_on_todo_id: todoId, upstream_work_order_id: order.id },
          workOrderId: order.id,
        });
      }
      if (dependents.length) {
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `dependency-ready:${order.id}`, triggerType: 'queue_advance', dueAt: new Date(),
          payload: { completed_todo_id: todoId, ready_todo_ids: dependents.map((row) => row.id) },
        });
        queueContinuationScheduled = true;
      }
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: 'Active Growth Stage continues with new evidence',
        summary: 'HQ accepted the specialist contribution and will compare stage outcomes at the next measurement checkpoint.',
        workOrderId: order.id,
      });
    } else if (readyTodo && (!roomInFlight || freeLaneTodo)) {
      // The first-life "wow batch" burst: first-life-control.js's
      // initial_plan_ready promotion now marks EVERY cohort proposal READY
      // at once (not just the recommendation), specifically so the founder
      // sees the company move on multiple fronts immediately. Detect that
      // burst here — multiple simultaneously-READY todos sharing the same
      // activation_sprint_id, none dispatched yet — and dispatch all of
      // them in this one cycle instead of just the first found. Every
      // subsequent cycle goes back to strict one-at-a-time: once any of
      // these moves to RUNNING, it no longer matches `status === 'READY'`,
      // so a later cycle's burstSiblings collapses back to a single todo
      // and roomInFlight naturally blocks further dispatch until it clears.
      // Burst/idle-crosslane are both scoped to the genuinely-idle case —
      // when a Room is already in flight, freeLaneTodo (computed once above)
      // is the only other admission path, and it is exactly one todo.
      const burstSiblings = !roomInFlight && readyTodo.context?.activation_sprint_id
        ? capabilityState.todos.filter((todo) => todo.status === 'READY'
          && todo.context?.activation_sprint_id === readyTodo.context.activation_sprint_id)
        : [readyTodo];
      // Cross-domain parallelism, idle case (shipped 2026-08-15): when
      // nothing is running ANYWHERE, starting a second genuinely independent
      // lane is risk-free — it can never disturb an already-in-flight Room,
      // because there isn't one.
      const crossLaneCandidate = !roomInFlight && burstSiblings.length <= 1
        ? capabilityState.todos.find((todo) => todo.status === 'READY'
          && todo.id !== readyTodo.id
          && effectClass(todo) !== effectClass(readyTodo))
        : null;
      // Cross-domain parallelism, steady state (shipped 2026-08-16): the
      // harder case — starting lane B while lane A is already running — see
      // freeLaneReadyTodo above. Only reachable when roomInFlight is true,
      // so it never competes with the idle-only burst/crossLane paths.
      const todosToDispatchThisCycle = burstSiblings.length > 1 ? burstSiblings
        : crossLaneCandidate ? [readyTodo, crossLaneCandidate]
        : freeLaneTodo ? [freeLaneTodo] : [readyTodo];
      if (todosToDispatchThisCycle.length > 1 || freeLaneTodo) await event(prisma, runtime, cycle, {
        eventType: 'decision',
        title: burstSiblings.length > 1 ? 'Starting the first-life batch in parallel'
          : freeLaneTodo ? 'Starting an independent lane alongside in-flight work'
          : 'Starting two independent lanes together',
        summary: burstSiblings.length > 1
          ? `${todosToDispatchThisCycle.length} evidenced proposals from the first operating plan start together: ${todosToDispatchThisCycle.map((todo) => todo.title).join('; ')}. Every task after this one goes back to one bounded step at a time.`
          : freeLaneTodo
          ? `A specialist Room is already working, but ${freeLaneTodo.title} is a genuinely independent ${effectClass(freeLaneTodo)} task with no shared lane. Starting it now instead of waiting behind unrelated in-flight work.`
          : `Nothing is currently running, and these two tasks are genuinely independent (${effectClass(readyTodo)} and ${effectClass(crossLaneCandidate)}): ${todosToDispatchThisCycle.map((todo) => todo.title).join('; ')}. They start together instead of waiting on each other.`,
        details: { todo_ids: todosToDispatchThisCycle.map((todo) => todo.id) },
      });
      // Runtime-level state transitions happen ONCE for the whole burst/free-
      // lane dispatch, not once per todo — move() tracks a single shared
      // in-memory `state` for this cycle, and a SECOND todo's attempt to
      // re-enter DIAGNOSING from DELEGATING is not a valid transition. Live
      // incident (2026-08-17, org Singulance): calling move() inside the loop
      // meant only the FIRST of 5 first-life burst todos ever dispatched — the
      // second iteration's move('DIAGNOSING') threw
      // hq_runtime_invalid_transition:DELEGATING:DIAGNOSING, caught by the
      // scheduler's outer safety wrapper ("HQ cycle failed safely"), aborting
      // the cycle before todos 3-5 were ever touched — while the burst's own
      // "N tasks start together" narration had already fired moments earlier,
      // so the founder saw a claim that didn't match what actually ran.
      await move('DIAGNOSING');
      await move('DELEGATING');
      for (const readyTodo of todosToDispatchThisCycle) {
      const skillId = 'specialist-delegation';
      const selectedSkill = this.skills.load(skillId);
      await event(prisma, runtime, cycle, { eventType: 'skill_loaded', title: `I am taking the next item: ${readyTodo.title}`, summary: selectedSkill.description, skillRef: skillId, details: { todo_id: readyTodo.id } });
      const rooms = await prisma.hyperRoom.findMany({ where: { orgId: runtime.orgId, archivedAt: null }, orderBy: { updatedAt: 'desc' } });
      const boundedObjective = specialistWorkObjective(readyTodo, skillId);
      const selectionObjective = lifecycleSelectionObjective(readyTodo);
      const adminStatusRun = await prisma.runtimePlaybookRun.findFirst({
        where: {
          orgId: runtime.orgId,
          playbookId: 'operations.browser-admin-checkin-to-status',
          status: 'COMPLETED',
          trigger: { path: ['runtime_epoch'], equals: runtime.epoch },
        },
        include: { artifacts: { orderBy: { createdAt: 'desc' } } },
        orderBy: { updatedAt: 'desc' },
      });
      const adminCurrentStatus = adminStatusRun?.artifacts
        ?.find((artifact) => artifact.artifactKey === 'user_current_status') || null;
      const lifecycleCatalog = this.runtimePlaybooks?.registry.descriptors({ scopeKey: 'global', latestOnly: true })
        .filter((entry) => entry.status === 'ACTIVE')
        .map((entry) => ({
          playbook_id: entry.playbook_id,
          version: entry.version,
          owner_room_tag: entry.metadata?.owner_room_tag || null,
          supported_actions: Array.isArray(entry.metadata?.supported_actions) ? entry.metadata.supported_actions : [],
          effect_class: entry.metadata?.effect_class || null,
          first_life_program_builder: entry.metadata?.first_life_program_builder === true,
          purpose: entry.metadata?.purpose || entry.description || '',
          terminal_states: entry.terminal_states,
          input_contract: entry.input_contract || null,
        }));
      const policyBootstrap = isPolicyBootstrapTodo(readyTodo);
      const retainedStrategy = readyTodo.context?.strategy_source_artifact_id
        ? await prisma.sourceArtifact.findFirst({
          where: { id: readyTodo.context.strategy_source_artifact_id, orgId: runtime.orgId, sourcePlatform: 'runtime_strategy' },
          select: { id: true, payload: true, createdAt: true },
        }) : null;
      const lifecycleContext = {
        mode: readyTodo.context?.execution_mode || null,
        company: compactCompanyOperatingContext(context.company),
        baseline: context.evidence?.baseline || null,
        connected_capabilities: [
          ...(context.capabilities?.connected || []),
          ...(context.capabilities?.platform_managed || []),
        ],
        admin_current_status: adminCurrentStatus ? {
          artifact_id: adminCurrentStatus.artifactId,
          data: adminCurrentStatus.data || {},
          source_refs: adminCurrentStatus.sourceRefs || [],
        } : null,
        strategy: retainedStrategy ? {
          source_artifact_id: retainedStrategy.id,
          created_at: retainedStrategy.createdAt,
          ...(retainedStrategy.payload && typeof retainedStrategy.payload === 'object' ? retainedStrategy.payload : {}),
        } : null,
        lifecycle_catalog: lifecycleCatalog || [],
        policy: {
          first_life_policy_id: readyTodo.context?.first_life_policy_id || null,
          first_life_policy_version: readyTodo.context?.first_life_policy_version || null,
          execution_defaults: readyTodo.context?.execution_defaults || null,
        },
        target: {
          ...(readyTodo.context?.target || {}),
          ...(readyTodo.context?.location ? { location: readyTodo.context.location } : {}),
        },
        constraints: {
          authority_mode: readyTodo.context?.external_action_requested === true || readyTodo.context?.authority_mode === 'EXECUTE' ? 'EXECUTE' : 'PREPARE',
          acceptance_criteria: readyTodo.context?.acceptance_criteria || [],
          instruction_id: readyTodo.instructionId || null,
        },
        task: {
          title: readyTodo.title,
          objective: readyTodo.objective,
          expected_outcome: readyTodo.context?.expected_outcome || null,
          success_measure: readyTodo.context?.success_measure || null,
          effect_class: readyTodo.context?.effect_class || null,
          dependencies: readyTodo.context?.dependencies || [],
          evidence_refs: readyTodo.context?.evidence_refs || [],
        },
        request: {
          owner_room_tag: policyBootstrap
            ? String(readyTodo.context?.room_tag || readyTodo.kind || '').trim().toLowerCase() || null
            : null,
          instruction: readyTodo.objective,
          objective: readyTodo.objective,
          // A direct user instruction may retain its requested effect as input to
          // Runtime selection. A Company Room proposal never gets to carry one.
          requested_action: policyBootstrap || readyTodo.context?.proposal_origin === 'user_instruction'
            ? readyTodo.context?.requested_action || null : null,
          requested_terminal_outcome: readyTodo.context?.requested_terminal_outcome || readyTodo.context?.expected_outcome || 'completed_as_requested',
          playbook_id: policyBootstrap ? readyTodo.context?.planned_playbook_id || null : null,
          playbook_version: policyBootstrap ? readyTodo.context?.planned_playbook_version || null : null,
          external_action_requested: readyTodo.context?.external_action_requested === true || readyTodo.context?.authority_mode === 'EXECUTE',
          exact_targets: Array.isArray(readyTodo.context?.exact_targets)
            ? readyTodo.context.exact_targets
            : Array.isArray(readyTodo.context?.suggested_targets) ? readyTodo.context.suggested_targets : [],
          acceptance_criteria: readyTodo.context?.acceptance_criteria || [],
        },
      };
      let selectionError = null;
      let selectedLifecycle = null;
      if (this.runtimePlaybooks && policyBootstrap
        && readyTodo.context?.planned_playbook_id && readyTodo.context?.planned_playbook_version) {
        try {
          const declared = this.runtimePlaybooks.registry.get(
            readyTodo.context.planned_playbook_id,
            Number(readyTodo.context.planned_playbook_version),
            { scopeKey: 'global' },
          );
          const requestedAction = String(readyTodo.context?.requested_action || '');
          const supportedActions = Array.isArray(declared.metadata?.supported_actions)
            ? declared.metadata.supported_actions : [];
          if (!requestedAction || !supportedActions.includes(requestedAction)) {
            throw new Error(`runtime_bootstrap_action_unsupported:${requestedAction || 'missing'}`);
          }
          const contextPatch = bindPlaybookContext(declared, readyTodo.context?.input_bindings, lifecycleContext);
          const actionTerminals = declared.metadata?.terminal_states_by_action?.[requestedAction];
          selectedLifecycle = {
            matched: true,
            playbook: declared,
            selection: {
              playbook_id: declared.playbook_id,
              version: declared.version,
              matched_supported_action: requestedAction,
              acceptable_terminal_states: Array.isArray(actionTerminals) && actionTerminals.length
                ? actionTerminals : declared.terminal_states,
              reason: 'The persisted Growth Plan already selected this exact registered lifecycle.',
              ...(contextPatch ? { context_patch: contextPatch } : {}),
            },
          };
        } catch (error) {
          selectionError = error;
        }
      }
      if (!selectedLifecycle && !selectionError && this.runtimePlaybooks) selectedLifecycle = await this.runtimePlaybooks.selectAssignment({
        objective: selectionObjective, context: lifecycleContext,
      }).catch((error) => {
        selectionError = error;
        this.logger.warn('[hq-runtime] playbook selection unavailable:', error.message);
        return null;
      });
      if (!selectedLifecycle?.matched) {
        const reason = selectionError
          ? `Playbook selection failed: ${String(selectionError.message || selectionError).slice(0, 1000)}`
          : String(selectedLifecycle?.selection?.reason || 'No installed lifecycle fits this bounded assignment.').slice(0, 1000);
        await prisma.hqTodo.update({
          where: { id: readyTodo.id },
          data: { status: 'BLOCKED', blockedReason: reason },
        });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked',
          title: 'No checkpointed lifecycle is installed for this work',
          summary: `${reason} I retained the todo and will advance another independent priority instead of bypassing artifact governance with a one-shot Room run.`,
          details: {
            todo_id: readyTodo.id,
            selection_reason: selectedLifecycle?.selection?.reason || null,
            selector_error: selectionError ? String(selectionError.message || selectionError).slice(0, 1000) : null,
          },
        });
        const anotherReady = capabilityState.todos.some((todo) => todo.id !== readyTodo.id && todo.status === 'READY');
        if (anotherReady) {
          await scheduleHqWake({
            prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
            idempotencyKey: `queue-after-missing-playbook:${readyTodo.id}`,
            triggerType: 'queue_advance', dueAt: new Date(),
            payload: { todo_id: readyTodo.id, reason: 'playbook_unavailable' },
          });
          queueContinuationScheduled = true;
        }
      } else {
        const roomTag = String(selectedLifecycle.playbook.metadata?.owner_room_tag || '').trim().toLowerCase();
        const room = rooms.find((candidate) => candidate.roomTag === roomTag);
        if (!room) {
          await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'BLOCKED', blockedReason: `No ${roomTag} Company Room is available.` } });
          await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'The right specialist room is unavailable', summary: `I retained the todo, but no ${roomTag} Company Room exists to own it. I will advance to another independent priority instead of substituting the wrong Room.`, details: { todo_id: readyTodo.id, required_room_tag: roomTag } });
          const anotherReady = capabilityState.todos.some((todo) => todo.id !== readyTodo.id && todo.status === 'READY');
          if (anotherReady) {
            await scheduleHqWake({
              prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
              idempotencyKey: `queue-after-missing-room:${readyTodo.id}`,
              triggerType: 'queue_advance', dueAt: new Date(),
              payload: { todo_id: readyTodo.id, missing_room_tag: roomTag },
            });
            queueContinuationScheduled = true;
          }
        } else {
          const playbookAssignment = await this.runtimePlaybooks.createSelectedAssignment({
            orgId: runtime.orgId,
            roomId: room.id,
            objective: boundedObjective,
            idempotencyKey: `hq-todo:${runtime.epoch}:${readyTodo.id}`,
            trigger: {
              type: 'hq_todo',
              runtime_id: runtime.id,
              runtime_epoch: runtime.epoch,
              cycle_id: cycle.id,
              todo_id: readyTodo.id,
            },
            context: lifecycleContext,
            selection: selectedLifecycle.selection,
          });
          await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: {
            status: 'RUNNING', startedAt: new Date(), blockedReason: null,
            context: {
              ...(readyTodo.context || {}),
              runtime_owner_room_tag: roomTag,
              runtime_selected_playbook_id: playbookAssignment.selection.playbook_id,
              runtime_selected_playbook_version: playbookAssignment.selection.version,
            },
          } });
          await event(prisma, runtime, cycle, {
            eventType: 'work_order_created',
            title: `I started a checkpointed lifecycle: ${readyTodo.title}`,
            summary: `The ${roomTag} Room owns the current stage. HQ will advance only when the playbook predicates accept durable artifacts.`,
            details: {
              todo_id: readyTodo.id,
              room_id: room.id,
              room_tag: roomTag,
              runtime_playbook_run_id: playbookAssignment.run.id,
              playbook_id: playbookAssignment.selection.playbook_id,
              playbook_version: playbookAssignment.selection.version,
              selection_reason: playbookAssignment.selection.reason,
            },
          });
        }
      }
      }
    } else if (readyTodo && roomInFlight) {
      // A Room is already working, and the next todo is NOT a genuinely free
      // lane (freeLaneTodo above was null: same effectClass as the in-flight
      // work, or occupancy couldn't be attributed). Do NOT dispatch and do
      // NOT re-plan — one steady step at a time within a lane. The in-flight
      // Room's result will wake us to continue.
      // isNoisyRepeatCycle: skip re-narrating "still working" every single minute for
      // a connector_changed repeat where nothing changed — the Room's own real
      // work_result wake still narrates normally when it actually returns.
      if (!isNoisyRepeatCycle) await event(prisma, runtime, cycle, {
        eventType: 'observation',
        title: 'One task at a time — the current Room is still working',
        summary: `${readyTodo.title} is queued next, but a specialist Room already owns the active task. I will not open parallel work; I dispatch the next item only when this Room returns its result.`,
        details: { next_todo_id: readyTodo.id },
      });
    } else if (growthPlanMode) {
      await move('DIAGNOSING');
      const selectedSkill = this.skills.load('growth-constraint-diagnosis');
      const [growthToolkit] = this.toolkits.select(['growth_plan']);
      const selectedModel = selectedSkill.model_policy?.model || 'gpt-oss-120b';
      await event(prisma, runtime, cycle, { eventType: 'skill_loaded', title: 'I am ranking the company constraints', summary: `${selectedSkill.description} I will compare the complete company state, preserve material unknowns, and order only the work justified by evidence and the operating requirements.`, skillRef: selectedSkill.id, details: { model_policy: selectedSkill.model_policy, selected_model: selectedModel } });
      await event(prisma, runtime, cycle, {
        eventType: 'tool_started',
        title: growthPlanMode === 'initial_full' ? 'I am building the first Growth Operating Plan' : 'I am updating the Growth Operating Plan',
        summary: growthPlanMode === 'initial_full'
          ? 'I will assess the complete baseline, rank multiple constraints, define the first bounded stage, and commit an ordered specialist todo queue before dispatching any work.'
          : 'The first-life program has produced outcomes. I will now compare current evidence, retain one company-wide goal, and choose the next highest-leverage operating move.',
        toolRef: 'growth_plan_run', details: { toolkit: growthToolkit.id, model: selectedModel, mode: growthPlanMode },
      });
      const planningRequirements = appliedInstructions.map((item) => item.instruction.body).filter(Boolean);
      const adminStatusRun = await prisma.runtimePlaybookRun.findFirst({
        where: { orgId: runtime.orgId, playbookId: 'operations.browser-admin-checkin-to-status', status: 'COMPLETED' },
        include: { artifacts: { orderBy: { createdAt: 'desc' } } }, orderBy: { updatedAt: 'desc' },
      });
      const currentStatus = adminStatusRun?.artifacts?.find((artifact) => artifact.artifactKey === 'user_current_status') || null;
      const lifecycleCatalog = this.runtimePlaybooks?.registry.descriptors({ scopeKey: 'global', latestOnly: true })
        .filter((entry) => entry.status === 'ACTIVE')
        .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.playbook_id === entry.playbook_id) === index)
        .map((entry) => ({
          playbook_id: entry.playbook_id,
          version: entry.version,
          owner_room_tag: entry.metadata?.owner_room_tag || null,
          supported_actions: Array.isArray(entry.metadata?.supported_actions) ? entry.metadata.supported_actions : [],
          effect_class: entry.metadata?.effect_class || null,
          first_life_program_builder: entry.metadata?.first_life_program_builder === true,
          purpose: entry.metadata?.purpose || entry.description || '',
          terminal_states: entry.terminal_states,
          input_contract: entry.input_contract || null,
        })) || [];
      // Journal-recall (2026-08-15): see projectRecentDecisions above — the
      // growth-plan LLM previously never saw its own decision history.
      const recentDecisions = projectRecentDecisions(context.growth?.journal);
      let result;
      try {
        result = await this.toolkits.invoke('growth_plan', 'run', {
          mode: growthPlanMode, objective: [runtime.objective, ...planningRequirements].filter(Boolean).join('\n\nOperating requirement:\n'), hqCycleId: cycle.id,
          model: selectedModel, lifecycleCatalog,
          additionalEvidence: (currentStatus || recentDecisions.length) ? {
            ...(currentStatus ? { user_current_status: { artifact_id: currentStatus.artifactId, data: currentStatus.data || {}, source_refs: currentStatus.sourceRefs || [] } } : {}),
            ...(recentDecisions.length ? { recent_decisions: recentDecisions } : {}),
          } : null,
          onProgress: async ({ stage, detail }) => event(prisma, runtime, cycle, {
            eventType: 'observation',
            title: stage === 'context' ? 'I loaded the evidence for this decision' : stage === 'planning' ? 'I am comparing the company as a whole' : stage === 'governance' ? 'I am checking whether this plan can actually operate' : 'I am committing the chosen next move',
            summary: detail,
            details: { growth_plan_stage: stage },
          }),
        }, { prisma, orgId: runtime.orgId, userId: runtime.ownerUserId });
      } catch (error) {
        const reason = String(error?.message || error);
        if (growthPlanMode !== 'initial_full' && reason.startsWith('growth_plan_')) {
          await event(prisma, runtime, cycle, {
            eventType: 'observation',
            title: 'The operating diagnosis needs better evidence',
            summary: 'I retained the completed first-life program and stopped this planning attempt. I will retry only after new material evidence or an explicit instruction, rather than repeating the same rejected model contract.',
            details: { waiting_reason: 'operating_plan_evidence', error: reason.slice(0, 500) },
          });
          await move('WAITING', { blockedReason: 'operating_plan_evidence', currentCycleId: null, nextWakeAt: null });
          return { transition: 'WAIT_FOR_OPERATING_EVIDENCE', reason: 'operating_plan_evidence' };
        }
        if (!reason.includes('first_life_evidenced_proposals_required')) throw error;
        await event(prisma, runtime, cycle, {
          eventType: 'observation',
          title: 'The first operating plan needs more evidence',
          summary: 'The current evidence does not support enough independent proposals to form a truthful first operating plan. I retained the baseline and will resume planning when a connector, source, or user instruction adds material evidence.',
          details: { waiting_reason: 'planning_evidence', error: 'first_life_evidenced_proposals_required' },
        });
        await move('WAITING', { blockedReason: 'planning_evidence', currentCycleId: null, nextWakeAt: null });
        return { transition: 'WAIT_FOR_PLANNING_EVIDENCE', reason: 'planning_evidence' };
      }
      const acknowledged = summarizeGrowthPlanResult(result);
      const requiresInitialStart = firstLifePolicy.require_initial_start_decision === true
        || firstLifePolicy.require_initial_policy_choice === true;
      const growthPlanSummary = `${acknowledged.summary} The persisted proposals are now the source of truth. ${requiresInitialStart
        ? 'I will not delegate them until you start the recommendation.'
        : 'I will promote one recommendation, select its lifecycle, and prepare it now; external effects remain governed at their exact gates.'}`;
      await event(prisma, runtime, cycle, {
        eventType: 'tool_result', title: 'I read and committed the Growth Operating Plan',
        summary: growthPlanSummary,
        toolRef: 'growth_plan_run', evidenceRefs: [result.artifact_id],
        details: { toolkit: growthToolkit.id, model: result.model, usage: result.usage || {}, ...acknowledged.details },
      });
      // First-growth-plan persona email — only the very first plan (matches
      // "growth plan for the 1st time"); every plan after this narrates only
      // through the popup hook in event(), not a dedicated email each time.
      if (growthPlanMode === 'initial_full') import('./persona-narrator.js')
        .then(({ notifyOwnerByEmail }) => notifyOwnerByEmail({ prisma, runtime, kind: 'growth_plan', summary: growthPlanSummary }))
        .catch(() => {});
      await move('DELEGATING', { activeGoalId: result.committed.goal_id, activeStageId: result.committed.stage_id });
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: 'I selected the first bounded Growth Stage',
        summary: result.plan?.stage?.objective || result.plan?.executive_thesis || 'The initial Growth Stage is ready.',
        details: { constraints: result.plan?.constraints, stage: result.plan?.stage }, evidenceRefs: [result.artifact_id],
      });
      await event(prisma, runtime, cycle, {
        eventType: 'todo_created', title: 'I committed the first operating proposals',
        summary: `${(result.plan?.operating_queue || []).map((item, index) => `${index + 1}. ${item.title}`).join('; ')}. ${requiresInitialStart
          ? 'These remain proposed until you start the recommendation.'
          : 'Runtime will start the recommendation and keep the remaining proposals dormant until the current lifecycle produces a verified result.'}`,
        details: { todo_ids: result.committed?.todo_ids || [], operating_queue: result.plan?.operating_queue || [] }, evidenceRefs: [result.artifact_id],
      });
      initialPolicyCommitted = true;
      if (dailyCadenceEnabled()) {
        const cadenceDueAt = nextCadenceDueAt();
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: cadenceIdempotencyKey(runtime.id, cadenceDueAt),
          triggerType: 'daily_cadence', dueAt: cadenceDueAt,
          payload: { armed_from: 'initial_plan_ready', growth_plan_artifact_id: result.artifact_id },
        });
      }
      if (firstLifePolicy.auto_start_initial_plan === true) {
        const activation = await activateEligibleFirstLifeWork({
          prisma, runtime, expansionTrigger: 'initial_plan_ready',
        });
        for (const promoted of activation.promoted) await event(prisma, runtime, cycle, {
          eventType: 'todo_created', title: `I started the first bounded task: ${promoted.title}`,
          summary: 'Runtime promoted one persisted proposal. It will select the compatible lifecycle and Company Room next; every other proposal remains dormant.',
          details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'initial_plan_ready' },
        });
        if (activation.promoted.length) {
          await scheduleHqWake({
            prisma,
            runtimeId: runtime.id,
            orgId: runtime.orgId,
            runtimeEpoch: runtime.epoch,
            idempotencyKey: `first-life-plan-ready:${runtime.epoch}:${result.artifact_id}`,
            triggerType: 'queue_advance',
            dueAt: new Date(),
            payload: { growth_plan_artifact_id: result.artifact_id, expansion_trigger: 'initial_plan_ready' },
          });
          queueContinuationScheduled = true;
        }
      } else if (firstLifePolicy.optional_admin_checkin === true
        && firstLifePolicy.admin_checkin_before_planning !== true && this.runtimePlaybooks) {
        await scheduleHqWake({
          prisma,
          runtimeId: runtime.id,
          orgId: runtime.orgId,
          runtimeEpoch: runtime.epoch,
          idempotencyKey: `first-life-plan-to-admin-checkin:${runtime.epoch}`,
          triggerType: 'queue_advance',
          dueAt: new Date(),
          payload: { first_life_admin_checkin: true, growth_plan_artifact_id: result.artifact_id },
        });
        queueContinuationScheduled = true;
        adminCheckinScheduled = true;
      }
    } else if (focusedOutcome) {
      await event(prisma, runtime, cycle, {
        eventType: 'observation', title: 'The focused outcome remains retained',
        summary: 'The single requested outcome has not reached a terminal lifecycle state. I will not replace it with a broader operating plan.',
        details: { todo_id: focusedOutcome.id, todo_status: focusedOutcome.status },
      });
    } else {
      await move('DIAGNOSING');
      const action = context.growth.next_action;
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: `Next operating action: ${action.action}`,
        summary: action.reason, details: { priority: action.priority },
        evidenceRefs: operatingDecisionEvidenceRefs(context.evidence),
      });
      if (trigger.type === 'user_wake' && action.action === 'monitor' && !appliedInstructions.length) {
        await event(prisma, runtime, cycle, { eventType: 'observation', title: 'No material change detected', summary: 'The company state, operating instruction, work ownership, and measurement evidence are unchanged. Repeating the same work would create activity, not progress.' });
      }
    }

    // Runtime playbooks promote and wake their next eligible proposal only from
    // the verified expansion paths above. A terminal mismatch, input request,
    // or safety stop must never fall through into an unrelated READY row.
    if (trigger.type === 'work_result' && capabilityState.todos.some((todo) => todo.status === 'READY')) {
      await scheduleHqWake({
        prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
        idempotencyKey: `queue-advance:${cycle.id}`, triggerType: 'queue_advance', dueAt: new Date(),
        payload: { completed_cycle_id: cycle.id },
      });
    }

    const finalReadyTodo = await prisma.hqTodo.findFirst({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'READY' },
      orderBy: [{ priority: 'asc' }, { position: 'asc' }], select: { id: true },
    });
    // Queue liveness is cross-cutting: a READY row is not the only retained
    // operating work. A Room lease, capability wait, authority gate, or
    // monitoring run prevents Runtime from truthfully claiming the queue is
    // empty or sleeping until a distant growth checkpoint.
    const [livenessWorkOrders, livenessPlaybookRuns] = await Promise.all([
      prisma.hyperWorkOrder.findMany({
        where: { orgId: runtime.orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null }, status: { in: ['queued', 'running', 'processing'] } },
        select: { id: true, status: true }, take: 50,
      }),
      prisma.runtimePlaybookRun?.findMany ? prisma.runtimePlaybookRun.findMany({
        where: { orgId: runtime.orgId, status: { in: ['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY', 'NEEDS_INTERVENTION'] } },
        select: { id: true, status: true, currentStageId: true, waitingFor: true }, take: 50,
      }).catch(() => []) : Promise.resolve([]),
    ]);
    const liveness = projectRuntimeLiveness({
      todos: capabilityState.todos,
      playbookRuns: livenessPlaybookRuns,
      workOrders: livenessWorkOrders,
    });
    const stageCheckpoint = context.growth.active_stage?.checkpoint_at
      ? new Date(context.growth.active_stage.checkpoint_at) : null;
    const declaredDueAt = stageCheckpoint && Number.isFinite(stageCheckpoint.getTime()) ? stageCheckpoint : null;
    // A measurement date cannot outrank executable preparation. Measurement begins
    // only after launch or an explicit playbook monitoring checkpoint.
    const queueExhausted = liveness.queueEmpty && !queueContinuationScheduled;
    const dueAt = queueExhausted ? declaredDueAt : null;
    if (dueAt) await scheduleHqWake({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
      idempotencyKey: `checkpoint:${runtime.activeStageId}:${dueAt.toISOString()}`,
      triggerType: 'checkpoint', dueAt, payload: { stage_id: runtime.activeStageId },
    });
    // The real declared checkpoint above can be many days out (a live trace
    // showed 7) — but once the queue is fully exhausted, daily_cadence
    // (when enabled) already has its OWN independent wake armed roughly
    // every 24h, completely uncoordinated with this one. Previously
    // `nextWakeAt`/the narration below only ever reflected the far
    // checkpoint, so Runtime told the user "I'll wake in 7 days" even
    // though it would genuinely wake itself tomorrow via cadence — true in
    // the narrow sense (that checkpoint IS scheduled) but misleading about
    // what actually happens first. Reusing nextCadenceDueAt() (already
    // exported, already tested) rather than inventing a second "wake
    // tonight" mechanism that would just be a third uncoordinated schedule.
    const { displayDueAt, displayDueAtIsCadence } = resolveQueueExhaustedDisplayWakeAt({
      queueExhausted, dueAt, cadenceEnabled: dailyCadenceEnabled(),
    });
    const measurement = context.growth.active_stage?.measurement || {};
    const metrics = [...new Set([...(measurement.primary_metrics || []), ...(measurement.metrics || []), ...Object.keys(measurement.thresholds || {})])].slice(0, 6);
    const waitingDays = displayDueAt ? Math.max(1, Math.ceil((displayDueAt.getTime() - Date.now()) / DAY)) : null;
    const openCapability = capabilityState.requests[0];
    // Root-caused live (2026-08-15, orgs DIOR/Brdteengal, then Singulance
    // itself): the sole promoted first-life task goes capacity-frozen —
    // WAITING_FOR_CONNECTOR on a missing capability, or MONITORING while a
    // Room watches for provider replies — and nothing ever re-triggered
    // promotion of the other evidenced, genuinely independent proposals (a
    // prospect list, a research question, a TARA call sequence). Originally
    // scoped to just the connector-wait case (openCapability); broadened
    // after finding the SAME gap for MONITORING: the existing
    // verified_monitoring_checkpoint path only attempts promotion when the
    // playbook stage itself declares waitingFor.releases_execution_slot —
    // the outreach playbook's observe_responses stage doesn't, so it never
    // even tried. This now fires whenever nothing is READY at all,
    // regardless of WHY the active task is frozen or whether its playbook
    // opted in. Idempotent and cheap — once promoted, a todo leaves PROPOSED
    // and stops being a candidate, so repeat cycles just no-op.
    if (!finalReadyTodo) {
      const capabilityRelease = await activateEligibleFirstLifeWork({
        prisma, runtime, expansionTrigger: 'capability_wait_release',
      }).catch((releaseError) => {
        this.logger?.warn?.('[hq-runtime] capability_wait_release check failed (non-fatal):', releaseError?.message || releaseError);
        return { promoted: [] };
      });
      for (const promoted of capabilityRelease.promoted) await event(prisma, runtime, cycle, {
        eventType: 'todo_created',
        title: `Promoted while waiting: ${promoted.title}`,
        summary: 'Another prepared task is waiting on a human to connect a capability. I am not idle while that happens — this independent, evidenced proposal is ready to start now.',
        details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'capability_wait_release' },
      });
      if (capabilityRelease.promoted.length) {
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `capability-wait-release:${runtime.epoch}:${capabilityRelease.promoted.map((row) => row.id).join(':')}`,
          triggerType: 'queue_advance', dueAt: new Date(),
          payload: { expansion_trigger: 'capability_wait_release' },
        });
      }
    }
    const [pendingLegacySpecialist, pendingPlaybookRuns] = await Promise.all([
      prisma.hyperWorkOrder.findFirst({
        where: { orgId: runtime.orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null }, status: { in: ['queued', 'running', 'processing'] } },
        select: { title: true, status: true },
      }),
      prisma.runtimePlaybookRun?.findMany ? prisma.runtimePlaybookRun.findMany({
        where: { orgId: runtime.orgId, status: { in: ['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY'] } },
        orderBy: { updatedAt: 'desc' }, take: 24,
        select: { id: true, currentStageId: true, status: true, waitingFor: true },
      }).catch(() => []) : Promise.resolve([]),
    ]);
    const pendingPlaybookRun = selectPendingPlaybookRun(pendingPlaybookRuns);
    const pendingSpecialist = pendingLegacySpecialist || (pendingPlaybookRun ? {
      title: `stage ${pendingPlaybookRun.currentStageId}`, status: pendingPlaybookRun.status,
    } : null);
    const blockedTodos = capabilityState.todos.filter((todo) => todo.status === 'BLOCKED');
    const waitingForResponse = pendingPlaybookRun?.status === 'WAITING_EVENT';
    const waitingPresentation = pendingPlaybookRun?.waitingFor?.presentation || {};
    const sleepReason = adminCheckinScheduled
      ? 'The initial diagnosis is retained. I am opening the optional administrator check-in next so corrections can shape the strategy program before specialist work begins.'
      : initialPolicyCommitted
      ? (firstLifePolicy.require_initial_start_decision === true || firstLifePolicy.require_initial_policy_choice === true
        ? 'I have retained the evidenced proposals without dispatching them. Start the recommendation when you are ready, or review it later. External authority remains undecided until a real immutable action reaches its gate.'
        : 'I retained the evidenced proposals and scheduled exactly one recommended task. Runtime will select its lifecycle before specialist work begins.')
      : queueContinuationScheduled
      ? 'The next independent todo is already scheduled for immediate dispatch. I am retaining every in-flight assignment and will reconcile each result when it returns.'
      : openCapability
      ? `I am pausing because ${openCapability.provider} is not connected. That capability is required by the next todo; pretending otherwise would produce an unusable result. Connect it and I will wake immediately, verify the tenant binding, and continue the same todo.`
      : waitingForResponse
        ? String(waitingPresentation.summary || 'The active lifecycle is waiting for its declared event or deadline. The same checkpoint will resume when that evidence arrives.')
      : pendingSpecialist
        ? `I am waiting for the specialist working on ${pendingSpecialist.title}. Its result, a connector failure, or a new instruction will wake me immediately.`
      : blockedTodos.length
        ? `${blockedTodos.length} retained todo(s) cannot advance because their exact lifecycle or owner is unavailable. No work is running, and I will not describe this as observation or completed activity.`
      : displayDueAt
        ? (displayDueAtIsCadence
          ? `I have no executable work left in the queue. My daily operating cadence will check the company again at ${displayDueAt.toISOString()}${dueAt ? `, sooner than the active stage's own checkpoint at ${dueAt.toISOString()}` : ''}.`
          : `I am sleeping because the active stage now needs ${waitingDays} day(s) of measured observation${metrics.length ? ` across ${metrics.join(', ')}` : ''}. I will wake at ${displayDueAt.toISOString()} or earlier for material evidence.`)
      : 'No executable or in-flight work remains. I will wake for a new instruction, connector event, or durable result.';
    if (displayDueAt) await event(prisma, runtime, cycle, {
      eventType: 'schedule_created',
      title: displayDueAtIsCadence ? 'I scheduled my next daily check-in' : 'I scheduled the next measurement checkpoint',
      summary: displayDueAtIsCadence
        ? `The queue is empty, so my daily cadence will check the company again at ${displayDueAt.toISOString()} rather than waiting for the active stage's own checkpoint${dueAt ? ` (${dueAt.toISOString()})` : ''}.`
        : `The next evidence review is ${displayDueAt.toISOString()} because the active Growth Stage declares that checkpoint.`,
      details: { wake_reasons: ['checkpoint', 'daily_cadence', 'work_result', 'instruction_updated', 'connector_changed', 'material_evidence'], metrics },
    });
    const initialStartRequired = initialPolicyCommitted
      && (firstLifePolicy.require_initial_start_decision === true || firstLifePolicy.require_initial_policy_choice === true);
    await move('WAITING', { nextWakeAt: displayDueAt, currentCycleId: null, blockedReason: initialStartRequired ? 'initial_start_decision' : null });
    const waitingTitle = adminCheckinScheduled ? 'The initial diagnosis is ready'
      : initialPolicyCommitted ? 'The first operating plan is ready'
      : queueContinuationScheduled ? 'The queue is still moving'
      : openCapability ? 'I am waiting for access'
      : waitingForResponse ? String(waitingPresentation.title || 'I am waiting for lifecycle evidence')
      : pendingSpecialist ? 'I am waiting for specialist work'
      : blockedTodos.length ? 'The operating queue needs intervention' : 'I am sleeping';
    // isNoisyRepeatCycle: the final wait/sleep narration is the last of the
    // repeated block — the move('WAITING', ...) state transition above still
    // always runs; only this specific duplicate event is skipped.
    if (!isNoisyRepeatCycle) await event(prisma, runtime, cycle, { eventType: queueContinuationScheduled || waitingForResponse ? 'observation' : blockedTodos.length ? 'blocked' : 'sleep', title: waitingTitle, summary: sleepReason, details: { due_at: displayDueAt?.toISOString() || null, capability_request_id: openCapability?.id || null, pending_specialist: pendingSpecialist, blocked_todo_ids: blockedTodos.map((todo) => todo.id) } });
    return { transition: 'WAIT', nextWakeAt: displayDueAt };
  }
}
