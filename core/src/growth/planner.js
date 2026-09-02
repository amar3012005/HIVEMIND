import crypto from 'node:crypto';
import { groqFetch } from '../llm/groq-fallback.js';
import { buildGrowthPlanningContext, commitGrowthPlan, getGrowthOperatingState } from './operating-loop.js';
import { applyFirstLifePolicy, loadFirstLifePolicy } from './first-life-policy.js';

const ALL_ASPECTS = ['positioning', 'audience', 'offer', 'product_readiness', 'channels', 'content', 'pipeline', 'measurement', 'operations', 'risks'];
const MODES = new Set(['initial_full', 'operate']);

export function selectGrowthPlanAspects(mode, aspects) {
  if (mode === 'initial_full') return ALL_ASPECTS;
  const selected = [...new Set((Array.isArray(aspects) ? aspects : []).map((item) => String(item).toLowerCase()))]
    .filter((item) => ALL_ASPECTS.includes(item));
  return selected.length ? selected : ['measurement', 'pipeline', 'channels'];
}

function extractJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(source); } catch { /* inspect a fenced or prose response */ }
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('growth_plan_model_returned_no_json');
  return JSON.parse(source.slice(start, end + 1));
}

function markdownList(values, empty = 'None recorded.') {
  const rows = Array.isArray(values) ? values.filter(Boolean) : [];
  return rows.length ? rows.map((value) => `- ${value}`).join('\n') : empty;
}

export function renderGrowthPlanReport(plan) {
  const assessments = (plan.aspect_assessments || []).map((item) => `### ${String(item.aspect || '').replaceAll('_', ' ')}\n**Status:** ${item.status || 'unknown'}\n\n${markdownList(item.observations)}\n\n**Implication:** ${item.implication || 'Not established.'}\n\n**Next move:** ${item.next_move || 'Observe before acting.'}`).join('\n\n');
  const hypotheses = (plan.hypotheses || []).map((item, index) => `${index + 1}. **${item.statement}** (${item.confidence || 'LOW'})\n   Expected: ${item.expected_signal || 'Not defined'}\n   Falsified when: ${item.falsification || 'Not defined'}`).join('\n');
  const roadmap = (plan.roadmap || []).map((item) => `- **${item.horizon || 'Later'}:** ${item.focus || ''}\n  Activate when: ${item.activation_condition || 'The current stage provides evidence.'}`).join('\n');
  const constraints = (plan.constraints || []).map((item, index) => `${index + 1}. **${item.type}: ${item.statement}**\n   Priority: ${item.priority || index + 1}\n   Known: ${(item.known_facts || []).join('; ') || 'None'}\n   Unknown: ${(item.unknowns || []).join('; ') || 'None'}`).join('\n');
  const queue = (plan.operating_queue || []).map((item, index) => `${index + 1}. **${item.title}** → ${item.room_tag}\n   ${item.objective}\n   Deliverable: ${item.deliverable}\n   Done when: ${(item.acceptance_criteria || []).join('; ')}`).join('\n');
  return `# Growth Operating Plan\n\n## Executive thesis\n${plan.executive_thesis || ''}\n\n## Company assessment\n${assessments}\n\n## Ranked operating constraints\n${constraints || 'No evidenced constraints were accepted.'}\n\n## First bounded Growth Stage\n### ${plan.stage?.name || ''}\n${plan.stage?.objective || ''}\n\n- Duration: ${plan.stage?.duration_days || 0} days\n- Checkpoint: Day ${plan.stage?.checkpoint_day || 0}\n- Primary signal: ${plan.stage?.measurement?.primary_signal || 'Not defined'}\n- Source: ${plan.stage?.measurement?.source || 'Not connected'}\n- Decision rule: ${plan.stage?.measurement?.decision_rule || 'Not defined'}\n- Stop condition: ${plan.stage?.measurement?.stop_condition || 'Not defined'}\n\n## Ordered operating queue\n${queue || 'No executable work was committed.'}\n\n## Hypotheses\n${hypotheses || 'No hypotheses were accepted.'}\n\n## Directional roadmap\n${roadmap || 'The next horizon will be selected from stage evidence.'}`;
}

export function normalizeGrowthPlanEvidence(plan, context) {
  const baselineId = context?.baseline?.resource_id;
  if (!baselineId || !plan || typeof plan !== 'object') return plan;
  const withBaseline = (refs) => [...new Set([...(Array.isArray(refs) ? refs : []), baselineId].filter(Boolean))];
  plan.baseline_ref = { ...(plan.baseline_ref || {}), resource_id: baselineId, captured_at: context.baseline.captured_at };
  if (Array.isArray(plan.constraints)) plan.constraints = plan.constraints.map((item) => ({ ...item, evidence_refs: withBaseline(item?.evidence_refs) }));
  if (Array.isArray(plan.aspect_assessments)) {
    plan.aspect_assessments = plan.aspect_assessments.map((item) => ({ ...item, evidence_refs: withBaseline(item?.evidence_refs) }));
  }
  if (Array.isArray(plan.hypotheses)) {
    plan.hypotheses = plan.hypotheses.map((item) => ({ ...item, evidence_refs: withBaseline(item?.evidence_refs) }));
  }
  return plan;
}

export function completeGrowthPlanAssessments(plan, context, aspects) {
  if (!plan || typeof plan !== 'object') return plan;
  const baselineId = context?.baseline?.resource_id;
  const existing = Array.isArray(plan.aspect_assessments) ? plan.aspect_assessments : [];
  const normalized = existing.map((item) => ({
    ...item,
    aspect: String(item?.aspect || '').trim().toLowerCase().replace(/[\s-]+/g, '_'),
  }));
  const present = new Set(normalized.map((item) => item.aspect));
  for (const aspect of aspects) {
    if (present.has(aspect)) continue;
    normalized.push({
      aspect,
      status: 'unknown',
      observations: ['The planning response did not establish a source-backed assessment for this aspect.'],
      evidence_refs: [baselineId].filter(Boolean),
      implication: 'HQ must retain this as an evidence gap instead of failing or inventing a conclusion.',
      next_move: 'Collect the missing evidence when it becomes material to a bounded work order.',
    });
  }
  plan.aspect_assessments = normalized;
  return plan;
}

export function compilePrepareQueue(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  plan.operating_queue = (Array.isArray(plan.operating_queue) ? plan.operating_queue : []).map((item) => {
    const requested = Array.isArray(item?.required_capabilities) ? item.required_capabilities : [];
    return {
      ...item,
      required_capabilities: [],
      authority_mode: 'PREPARE',
      external_actions_required: false,
      ignored_capability_suggestions: requested,
    };
  });
  return plan;
}

function validatePlan(plan, context, mode, aspects, lifecycleCatalog = [], firstLifePolicy = null) {
  if (!plan || plan.contract_version !== 'growth-plan.v3') throw new Error('growth_plan_v3_contract_required');
  if (plan.mode !== mode) throw new Error('growth_plan_mode_mismatch');
  plan.response_locale = String(plan.response_locale || context?.company?.locale || context?.company?.language || 'und').slice(0, 80);
  if (plan.baseline_ref?.resource_id !== context.baseline.resource_id) throw new Error('growth_plan_baseline_mismatch');
  const assessments = Array.isArray(plan.aspect_assessments) ? plan.aspect_assessments : [];
  for (const aspect of aspects) {
    if (!assessments.some((item) => item?.aspect === aspect)) throw new Error(`growth_plan_missing_aspect:${aspect}`);
  }
  const constraints = Array.isArray(plan.constraints) ? plan.constraints : [];
  const queue = Array.isArray(plan.operating_queue) ? plan.operating_queue : [];
  const minimum = mode === 'initial_full' ? 2 : 1;
  if (constraints.length < minimum) throw new Error('growth_plan_ranked_constraints_required');
  if (queue.length < minimum) throw new Error('growth_plan_operating_queue_required');
  if (constraints.some((item) => !item?.id || !item?.type || !(item.evidence_refs || []).includes(context.baseline.resource_id))) {
    throw new Error('growth_plan_constraints_must_reference_baseline');
  }
  const runtimeSelectsLifecycle = mode === 'initial_full' && firstLifePolicy?.runtime_selects_lifecycle === true;
  const available = new Set((context.available_rooms || []).map((room) => room.room_tag));
  if (queue.some((item) => !item?.id || !item?.title || !item?.objective
    || (!runtimeSelectsLifecycle && (!item?.room_tag || !available.has(item.room_tag)))
    || !constraints.some((constraint) => constraint.id === item.constraint_id)
    || !Array.isArray(item.acceptance_criteria) || !item.acceptance_criteria.length
    || !['internal', 'external'].includes(item.effect_class)
    || !String(item.effect_basis || '').trim())) {
    throw new Error('growth_plan_queue_item_invalid');
  }
  plan.operating_queue = queue.map((item) => ({
    ...item,
    external_action_requested: item.effect_class === 'external',
  }));
  if (!constraints.some((item) => item.id === plan.primary_constraint_id)) throw new Error('growth_plan_primary_constraint_required');
  if (!plan.stage?.name || !plan.stage?.objective) throw new Error('growth_plan_stage_required');
  if (!queue.some((item) => item.id === plan.stage.queue_item_id)) throw new Error('growth_plan_stage_queue_item_required');
  if (mode === 'initial_full' && lifecycleCatalog.length && !runtimeSelectsLifecycle) {
    const recommended = queue.find((item) => item.id === plan.stage.queue_item_id);
    const lifecycle = lifecycleCatalog.find((entry) => entry.playbook_id === recommended?.playbook_id
      && Number(entry.version) === Number(recommended?.playbook_version));
    const actions = Array.isArray(lifecycle?.supported_actions) ? lifecycle.supported_actions : [];
    if (!lifecycle || !actions.includes(recommended?.requested_action)
      || recommended.room_tag !== lifecycle.owner_room_tag) {
      throw new Error('growth_plan_recommended_lifecycle_binding_required');
    }
  }
  // No two queue items may bind the SAME lifecycle. Observed in production: "Validate
  // audience and channel performance" and "Develop go-to-market strategy brief" both
  // bound marketing form_strategy, so the Marketing Room ran the identical single-stage
  // playbook twice and produced two marketing_strategy artifacts — duplicated cost, and
  // neither run satisfied its own distinct stated outcome. One lifecycle produces one
  // outcome; a second item needing the same lifecycle is the same work, not new work.
  const boundLifecycles = queue
    .filter((item) => item?.playbook_id)
    .map((item) => `${item.playbook_id}@${item.playbook_version}`);
  const duplicateLifecycle = boundLifecycles.find((key, index) => boundLifecycles.indexOf(key) !== index);
  if (duplicateLifecycle) throw new Error(`growth_plan_duplicate_lifecycle_binding:${duplicateLifecycle}`);
  plan.constraint = constraints.find((item) => item.id === plan.primary_constraint_id);
  plan.delegation = queue.find((item) => item.id === plan.stage.queue_item_id);
  return plan;
}

function toCommitContract(plan) {
  return {
    contract_version: 'growth-plan.v2',
    baseline_ref: plan.baseline_ref,
    goal: plan.goal,
    constraints: plan.constraints,
    primary_constraint_id: plan.primary_constraint_id,
    stage: plan.stage,
    hypotheses: plan.hypotheses,
    operating_queue: plan.operating_queue,
    policy: plan.policy,
    response_locale: plan.response_locale,
    first_life: plan.first_life || null,
    activation_sprint: plan.activation_sprint || null,
  };
}

async function ensureDetachedTurn({ prisma, orgId, prompt, runId }) {
  const [hq] = await prisma.$queryRawUnsafe(
    `SELECT * FROM hivemind.hyper_rooms
      WHERE org_id=$1::uuid AND archived_at IS NULL AND agent_connectors->>'_domain_home'='true'
      ORDER BY updated_at DESC LIMIT 1`, orgId,
  );
  if (!hq) throw new Error('growth_plan_hq_room_required');
  return prisma.$transaction(async (tx) => {
    const latest = await tx.hyperTurn.findFirst({ where: { roomId: hq.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    return tx.hyperTurn.create({ data: {
      roomId: hq.id, seq: Number(latest?.seq || 0) + 1, userMessage: prompt,
      status: 'live', lines: [], idempotencyKey: `growth-plan:${runId}`.slice(0, 64),
    } });
  });
}

async function persistPlanArtifact({ prisma, orgId, userId, runId, mode, aspects, plan, committed, usage }) {
  return prisma.sourceArtifact.create({
    data: buildGrowthPlanArtifactData({ orgId, userId, runId, mode, aspects, plan, committed, usage }),
  });
}

export function buildGrowthPlanArtifactData({ orgId, userId, runId, mode, aspects, plan, committed, usage }) {
  const payload = { kind: 'growth_operating_plan', run_id: runId, mode, aspects, plan, committed, usage };
  return {
    userId, orgId, artifactType: 'api_response', sourcePlatform: 'growth_plan', sourceId: runId,
    contentType: 'application/json', sizeBytes: Buffer.byteLength(JSON.stringify(payload)),
    checksum: crypto.createHash('sha256').update(JSON.stringify({ orgId, runId, plan })).digest('hex'),
    storageLocation: `inline:growth_plan:${runId}`, payload,
    metadata: growthPlanArtifactMetadata({ mode, aspects, plan, committed }),
  };
}

export function growthPlanArtifactMetadata({ mode, aspects, plan, committed }) {
  return { mode, aspects, baseline_id: plan.baseline_ref.resource_id, growth_stage_id: committed.stage_id };
}

export async function runGrowthPlan({ prisma, orgId, userId, mode = 'operate', aspects = [], objective = '', autonomyMode, turnId, hqCycleId, onProgress, model = 'gpt-oss-120b', lifecycleCatalog = [], additionalEvidence = null, firstLifePolicyVersion = null }) {
  if (!MODES.has(mode)) throw new Error('growth_plan_mode_invalid');
  const context = await buildGrowthPlanningContext({ prisma, orgId });
  if (!context) throw new Error('growth_plan_baseline_required');
  if (additionalEvidence && typeof additionalEvidence === 'object' && !Array.isArray(additionalEvidence)) {
    context.additional_evidence = additionalEvidence;
  }
  if (mode === 'initial_full') {
    const existing = await prisma.sourceArtifact.findFirst({
      where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response', AND: [
        { metadata: { path: ['mode'], equals: 'initial_full' } },
        { metadata: { path: ['baseline_id'], equals: context.baseline.resource_id } },
      ] }, select: { id: true },
    });
    if (existing) throw new Error(`growth_plan_initial_full_already_exists:${existing.id}`);
  }
  const selected = selectGrowthPlanAspects(mode, aspects);
  const runId = crypto.randomUUID();
  const progress = async (stage, detail) => { if (onProgress) await onProgress({ stage, detail }); };
  await progress('context', `Loaded company memory, baseline ${context.baseline.resource_id}, connector signals, and operating history.`);

  const system = `You are the Company HQ Growth Planner. Produce a source-grounded company operating decision, not a brainstorm and not a generic report.
Facts must come from the supplied context. A correlation is not a cause. Unknown causes must remain hypotheses. Never invent competitors, CRM results, connector capabilities, budgets, dates, or benchmarks.
For initial_full, assess every requested company aspect, rank multiple material constraints, and create an ordered queue of bounded work. The first queue item defines the first Growth Stage, but the complete ordered queue must survive so HQ can continue without replanning after every result. For operate, inspect only the requested aspects and current operating state, then update the queue as evidence requires. Use the language of the operating requirements when they establish one; otherwise use the company's retained locale. Keep machine identifiers unchanged while writing every user-facing field in response_locale.
Return JSON only. Contract:
{contract_version:'growth-plan.v3',mode:'initial_full|operate',response_locale:string,baseline_ref:{resource_id,captured_at},goal:{title,objective},executive_thesis:string,aspect_assessments:[{aspect,status:'strength|constraint|unknown',observations:string[],evidence_refs:string[],implication:string,next_move:string}],constraints:[{id,type:string,statement,priority:number,evidence_refs:string[],known_facts:string[],unknowns:string[]}],primary_constraint_id:string,hypotheses:[{statement,confidence:'LOW|MEDIUM|HIGH',evidence_refs:string[],expected_signal,falsification}],stage:{name,objective,queue_item_id,duration_days:7-30,checkpoint_day,measurement:{primary_signal,source,decision_rule,stop_condition}},operating_queue:[{id,constraint_id,title,kind:string,room_tag:string|null,objective,deliverable,success_measure,skills:string[],required_capabilities:string[],acceptance_criteria:string[],priority:number,position:number,activation_condition:string,target:{location:string|null,audience:string|null,sector:string|null,quantity:number|null},playbook_id:string|null,playbook_version:integer|null,effect_class:'internal|external',effect_basis:string,external_action_requested:boolean,requested_action:string|null,requested_terminal_outcome:string}],policy:{autonomy_mode,channel_policy:{},claim_constraints:string[]},roadmap:[{horizon,focus,activation_condition}]}.
For initial_full obey first_life_policy.proposal_minimum and proposal_target. Return only the ranked, genuinely evidenced queue items the company state supports; never pad the queue. Follow first_life_policy.task_style and consider its outcome preferences only where retained evidence supports them. Keep titles short and objectives concrete enough for a specialist Director to execute without inheriting the parent diagnosis. When first_life_policy.runtime_selects_lifecycle is true, set room_tag, playbook_id, playbook_version, and requested_action to null: Runtime selects those mechanics after persistence. The first queue item must match stage.queue_item_id and the primary constraint. Every factual assessment, constraint, and hypothesis must reference the baseline resource id or another supplied source reference.
		effect_class describes the complete lifecycle's eventual effect, not the authority of the current planning phase. Use external whenever reaching requested_terminal_outcome requires any state change outside Runtime's persisted internal artifacts. Use internal only when persisted internal evidence or preparation fully satisfies every acceptance criterion. State that distinction briefly in effect_basis, and set external_action_requested to exactly (effect_class == 'external'). For initial_full, the first queue item must bind one supplied available_lifecycle by exact playbook_id, version, owner_room_tag, and one exact supported_actions value. Other proposals may use null playbook fields when no supplied lifecycle directly implements them; never invent a lifecycle or action identifier. All initial queue items still begin in PREPARE authority: they may research and persist internal deliverables, but may not make an external change. The selected playbook, not this planner, resolves capabilities and exact authority gates. Treat unavailable evidence as an explicit gap and do not block unrelated safe preparation.`;
  const firstLifePolicy = mode === 'initial_full' ? await loadFirstLifePolicy(firstLifePolicyVersion || undefined) : null;
  const user = JSON.stringify({ objective: String(objective || '').slice(0, 4000), mode, aspects: selected, autonomy_mode: autonomyMode || context.active_goal?.autonomy_mode || 'MANUAL_REVIEW', first_life_policy: firstLifePolicy, available_lifecycles: lifecycleCatalog, context });
  await progress('planning', mode === 'initial_full' ? 'Assessing the complete company growth system.' : `Reviewing ${selected.join(', ')} for the next operating decision.`);
  // Bounded retry WITH the validator's own reason fed back. validatePlan enforces a
  // strict contract (every queue item needs an available room_tag, a matching
  // constraint_id, non-empty acceptance_criteria, effect_class + effect_basis; and the
  // recommended item must bind an available lifecycle by exact playbook_id, version,
  // owner_room_tag and one supported_actions value). A single miss threw the WHOLE HQ
  // cycle away — and the scheduler then retried the identical prompt blind, so it failed
  // the same way and the runtime looped on "HQ cycle failed safely"
  // (observed: growth_plan_queue_item_invalid, growth_plan_recommended_lifecycle_binding_required).
  // Re-asking the model with the exact rejection lets it self-correct instead of burning
  // a whole cycle per attempt. Only contract errors are retried; anything else rethrows.
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const MAX_PLAN_ATTEMPTS = 3;
  let body = null;
  let plan = null;
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
    const response = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.1, max_completion_tokens: 8000, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages }),
    }, { timeoutMs: 120000 });
    if (!response?.ok) throw new Error(`growth_plan_model_failed:${response?.status || 'unknown'}`);
    body = await response.json();
    const raw = body?.choices?.[0]?.message?.content || '';
    try {
      const extracted = extractJson(raw);
      let preparedPlan = completeGrowthPlanAssessments(normalizeGrowthPlanEvidence(extracted, context), context, selected);
      if (mode === 'initial_full') preparedPlan = applyFirstLifePolicy(preparedPlan, context, firstLifePolicy, lifecycleCatalog);
      plan = validatePlan(compilePrepareQueue(preparedPlan), context, mode, selected, lifecycleCatalog, firstLifePolicy);
      break;
    } catch (error) {
      const reason = String(error?.message || error);
      if (!reason.startsWith('growth_plan_') || attempt === MAX_PLAN_ATTEMPTS) throw error;
      console.warn(`[growth-plan] contract rejected (attempt ${attempt}/${MAX_PLAN_ATTEMPTS}): ${reason} — re-asking with the reason`);
      await progress('planning', 'The first draft did not satisfy the operating contract. I am correcting it against the exact rule it missed.');
      messages.push({ role: 'assistant', content: String(raw).slice(0, 12000) });
      messages.push({ role: 'user', content:
        `Your plan was REJECTED by the contract validator with: ${reason}\n`
        + 'Fix ONLY what that rule requires and return the COMPLETE corrected JSON again.\n'
        + '- growth_plan_queue_item_invalid: every operating_queue item needs id, title, objective, a room_tag that exists in context.available_rooms, a constraint_id matching one of your constraints[].id, a non-empty acceptance_criteria array, effect_class of exactly "internal" or "external", and a non-empty effect_basis.\n'
        + '- growth_plan_recommended_lifecycle_binding_required: the queue item whose id equals stage.queue_item_id MUST copy one entry from available_lifecycles exactly — same playbook_id, same playbook_version, its room_tag equal to that lifecycle owner_room_tag, and requested_action equal to one of that lifecycle supported_actions. Never invent these values.\n'
        + '- growth_plan_duplicate_lifecycle_binding: two queue items bound the SAME playbook_id@version. One lifecycle produces one outcome, so that is the same work twice. Either MERGE those items into a single queue item whose objective covers the whole outcome, or bind the other item to a DIFFERENT available_lifecycle, or leave its playbook_id/playbook_version null when no supplied lifecycle implements it. Never bind one lifecycle twice.\n'
        + '- growth_plan_first_life_bootstrap_lifecycle_required: first_life_policy.initial_bootstrap_selector requires the recommended first item to use an available lifecycle carrying that metadata flag and effect class. Select that exact lifecycle; do not add downstream motions because the bootstrap artifact materializes them.\n'
        + 'Return JSON only.' });
    }
  }
  plan.report_markdown = renderGrowthPlanReport(plan);
  await progress('governance', 'Validated evidence references, aspect coverage, stage bounds, and specialist ownership.');

  const suppliedTurn = turnId ? await prisma.hyperTurn.findFirst({ where: { id: turnId, room: { orgId } }, select: { id: true } }).catch(() => null) : null;
  const sourceTurn = hqCycleId ? null : (suppliedTurn || await ensureDetachedTurn({ prisma, orgId, prompt: objective || 'Run the Growth Operating Planner', runId }));
  const committed = await commitGrowthPlan({ prisma, orgId, userId, turnId: sourceTurn?.id || null, hqCycleId: hqCycleId || null, contract: toCommitContract(plan) });
  const artifact = await persistPlanArtifact({ prisma, orgId, userId, runId, mode, aspects: selected, plan, committed: {
    goal_id: committed.goal.id, stage_id: committed.stage.id,
    todo_ids: committed.todos.map((todo) => todo.id),
  }, usage: body.usage || {} });
  await progress('delegated', `Created ${committed.stage.name} and committed ${committed.todos.length} ordered Runtime todo(s).`);
  if (!turnId && sourceTurn) await prisma.hyperTurn.update({ where: { id: sourceTurn.id }, data: {
    status: 'complete', sealedAt: new Date(), costTokens: Number(body.usage?.total_tokens || 0),
    lines: [{ t: 'growth_plan_runner', run_id: runId, mode, aspects: selected }, { t: 'growth_plan_complete', artifact_id: artifact.id, plan, committed: artifact.payload.committed }, { t: 'seal', status: 'complete', cost_tokens: Number(body.usage?.total_tokens || 0) }],
  } });
  return { run_id: runId, mode, aspects: selected, artifact_id: artifact.id, plan, committed: artifact.payload.committed, usage: body.usage || {}, model };
}

export async function listGrowthPlans({ prisma, orgId, limit = 12 }) {
  const rows = await prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response' }, orderBy: { createdAt: 'desc' }, take: Math.min(50, Math.max(1, Number(limit) || 12)) });
  return rows.map((row) => ({
    resource_id: row.id, captured_at: row.createdAt, run_id: row.sourceId,
    mode: row.payload?.mode, aspects: row.payload?.aspects, plan: row.payload?.plan,
    stage: row.payload?.plan?.stage, constraint: row.payload?.plan?.constraint,
    committed: row.payload?.committed,
  }));
}

export async function getLatestGrowthPlan({ prisma, orgId }) {
  return prisma.sourceArtifact.findFirst({ where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response' }, orderBy: { createdAt: 'desc' } });
}
