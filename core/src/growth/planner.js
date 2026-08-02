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

function validatePlan(plan, context, mode, aspects) {
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
  const available = new Set((context.available_rooms || []).map((room) => room.room_tag));
  if (queue.some((item) => !item?.id || !item?.title || !item?.objective || !item?.room_tag
    || !available.has(item.room_tag) || !constraints.some((constraint) => constraint.id === item.constraint_id)
    || !Array.isArray(item.acceptance_criteria) || !item.acceptance_criteria.length)) {
    throw new Error('growth_plan_queue_item_invalid');
  }
  if (!constraints.some((item) => item.id === plan.primary_constraint_id)) throw new Error('growth_plan_primary_constraint_required');
  if (!plan.stage?.name || !plan.stage?.objective) throw new Error('growth_plan_stage_required');
  if (!queue.some((item) => item.id === plan.stage.queue_item_id)) throw new Error('growth_plan_stage_queue_item_required');
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

export async function runGrowthPlan({ prisma, orgId, userId, mode = 'operate', aspects = [], objective = '', autonomyMode, turnId, hqCycleId, onProgress, model = 'gpt-oss-120b' }) {
  if (!MODES.has(mode)) throw new Error('growth_plan_mode_invalid');
  const context = await buildGrowthPlanningContext({ prisma, orgId });
  if (!context) throw new Error('growth_plan_baseline_required');
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
For initial_full, assess every requested company aspect, rank multiple material constraints, and create an ordered queue of bounded work across only the specialist Rooms genuinely needed. The first queue item defines the first Growth Stage, but the complete ordered queue must survive so HQ can continue without replanning after every result. For operate, inspect only the requested aspects and current operating state, then update the queue as evidence requires. Use the language of the operating requirements when they establish one; otherwise use the company's retained locale. Keep machine identifiers unchanged while writing every user-facing field in response_locale.
Return JSON only. Contract:
{contract_version:'growth-plan.v3',mode:'initial_full|operate',response_locale:string,baseline_ref:{resource_id,captured_at},goal:{title,objective},executive_thesis:string,aspect_assessments:[{aspect,status:'strength|constraint|unknown',observations:string[],evidence_refs:string[],implication:string,next_move:string}],constraints:[{id,type:string,statement,priority:number,evidence_refs:string[],known_facts:string[],unknowns:string[]}],primary_constraint_id:string,hypotheses:[{statement,confidence:'LOW|MEDIUM|HIGH',evidence_refs:string[],expected_signal,falsification}],stage:{name,objective,queue_item_id,duration_days:7-30,checkpoint_day,measurement:{primary_signal,source,decision_rule,stop_condition}},operating_queue:[{id,constraint_id,title,kind:string,room_tag:string,objective,deliverable,success_measure,skills:string[],required_capabilities:string[],acceptance_criteria:string[],priority:number,position:number,activation_condition:string,target:{location:string|null,audience:string|null,sector:string|null,quantity:number|null},external_action_requested:boolean,requested_action:string,requested_terminal_outcome:string}],policy:{autonomy_mode,channel_policy:{},claim_constraints:string[]},roadmap:[{horizon,focus,activation_condition}]}.
For initial_full return 2-4 ranked, genuinely evidenced queue items. Do not create busywork, prescribe a domain, pad the queue, or assign every Room. Every queue item must address an evidenced constraint, have an exact available room_tag, and be independently verifiable. The first queue item must match stage.queue_item_id and the primary constraint. Every factual assessment, constraint, and hypothesis must reference the baseline resource id or another supplied source reference.
	All initial queue items run in PREPARE authority: they may research and persist internal deliverables, but may not make an external change. The selected playbook, not this planner, resolves capabilities and exact authority gates. Treat unavailable evidence as an explicit gap and do not block unrelated safe preparation.`;
  const user = JSON.stringify({ objective: String(objective || '').slice(0, 4000), mode, aspects: selected, autonomy_mode: autonomyMode || context.active_goal?.autonomy_mode || 'MANUAL_REVIEW', context });
  await progress('planning', mode === 'initial_full' ? 'Assessing the complete company growth system.' : `Reviewing ${selected.join(', ')} for the next operating decision.`);
  const response = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.1, max_completion_tokens: mode === 'initial_full' ? 16000 : 8000, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }, { timeoutMs: 120000 });
  if (!response?.ok) throw new Error(`growth_plan_model_failed:${response?.status || 'unknown'}`);
  const body = await response.json();
  const extracted = extractJson(body?.choices?.[0]?.message?.content);
  let preparedPlan = completeGrowthPlanAssessments(normalizeGrowthPlanEvidence(extracted, context), context, selected);
  if (mode === 'initial_full') preparedPlan = applyFirstLifePolicy(preparedPlan, context, await loadFirstLifePolicy());
  const plan = validatePlan(compilePrepareQueue(preparedPlan), context, mode, selected);
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
