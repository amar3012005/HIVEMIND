import crypto from 'node:crypto';
import { groqFetch } from '../llm/groq-fallback.js';
import { buildGrowthPlanningContext, commitGrowthPlan, getGrowthOperatingState } from './operating-loop.js';

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
  return `# Growth Operating Plan\n\n## Executive thesis\n${plan.executive_thesis || ''}\n\n## Company assessment\n${assessments}\n\n## Current operating constraint\n**${plan.constraint?.type || 'unknown'}:** ${plan.constraint?.statement || ''}\n\n### Known facts\n${markdownList(plan.constraint?.known_facts)}\n\n### Unknowns\n${markdownList(plan.constraint?.unknowns)}\n\n## Hypotheses\n${hypotheses || 'No hypotheses were accepted.'}\n\n## Current Growth Stage\n### ${plan.stage?.name || ''}\n${plan.stage?.objective || ''}\n\n- Duration: ${plan.stage?.duration_days || 0} days\n- Checkpoint: Day ${plan.stage?.checkpoint_day || 0}\n- Primary signal: ${plan.stage?.measurement?.primary_signal || 'Not defined'}\n- Source: ${plan.stage?.measurement?.source || 'Not connected'}\n- Decision rule: ${plan.stage?.measurement?.decision_rule || 'Not defined'}\n- Stop condition: ${plan.stage?.measurement?.stop_condition || 'Not defined'}\n\n## Delegated Work Order\n**${plan.delegation?.room_tag || 'specialist'}:** ${plan.delegation?.objective || ''}\n\nDeliverable: ${plan.delegation?.deliverable || ''}\n\nSuccess measure: ${plan.delegation?.success_measure || ''}\n\n### Acceptance criteria\n${markdownList(plan.delegation?.acceptance_criteria)}\n\n## Directional roadmap\n${roadmap || 'The next horizon will be selected from stage evidence.'}`;
}

export function normalizeGrowthPlanEvidence(plan, context) {
  const baselineId = context?.baseline?.resource_id;
  if (!baselineId || !plan || typeof plan !== 'object') return plan;
  const withBaseline = (refs) => [...new Set([...(Array.isArray(refs) ? refs : []), baselineId].filter(Boolean))];
  plan.baseline_ref = { ...(plan.baseline_ref || {}), resource_id: baselineId, captured_at: context.baseline.captured_at };
  if (plan.constraint && typeof plan.constraint === 'object') plan.constraint.evidence_refs = withBaseline(plan.constraint.evidence_refs);
  if (Array.isArray(plan.aspect_assessments)) {
    plan.aspect_assessments = plan.aspect_assessments.map((item) => ({ ...item, evidence_refs: withBaseline(item?.evidence_refs) }));
  }
  if (Array.isArray(plan.hypotheses)) {
    plan.hypotheses = plan.hypotheses.map((item) => ({ ...item, evidence_refs: withBaseline(item?.evidence_refs) }));
  }
  return plan;
}

function validatePlan(plan, context, mode, aspects) {
  if (!plan || plan.contract_version !== 'growth-plan.v2') throw new Error('growth_plan_v2_contract_required');
  if (plan.mode !== mode) throw new Error('growth_plan_mode_mismatch');
  if (plan.baseline_ref?.resource_id !== context.baseline.resource_id) throw new Error('growth_plan_baseline_mismatch');
  const assessments = Array.isArray(plan.aspect_assessments) ? plan.aspect_assessments : [];
  for (const aspect of aspects) {
    if (!assessments.some((item) => item?.aspect === aspect)) throw new Error(`growth_plan_missing_aspect:${aspect}`);
  }
  if (!plan.constraint?.type) throw new Error('growth_plan_constraint_required');
  if (!(plan.constraint.evidence_refs || []).includes(context.baseline.resource_id)) throw new Error('growth_plan_constraint_must_reference_baseline');
  if (!plan.stage?.name || !plan.stage?.objective) throw new Error('growth_plan_stage_required');
  if (!plan.delegation?.room_tag || !plan.delegation?.objective) throw new Error('growth_plan_delegation_required');
  return plan;
}

function toCommitContract(plan) {
  return {
    contract_version: 'growth-plan.v1',
    baseline_ref: plan.baseline_ref,
    goal: plan.goal,
    constraint: plan.constraint,
    stage: plan.stage,
    hypotheses: plan.hypotheses,
    delegation: plan.delegation,
    policy: plan.policy,
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

  const system = `You are the Company HQ Growth Planner. Produce one source-grounded operating decision, not a brainstorm and not a generic report.
Facts must come from the supplied context. A correlation is not a cause. Unknown causes must remain hypotheses. Never invent competitors, CRM results, connector capabilities, budgets, dates, or benchmarks.
For initial_full, assess every requested company aspect and produce a detailed high-level growth thesis plus one bounded next stage. For operate, inspect only the requested aspects and current operating state, then continue, monitor, iterate, pause, or replace the next stage as evidence requires.
Return JSON only. Contract:
{contract_version:'growth-plan.v2',mode:'initial_full|operate',baseline_ref:{resource_id,captured_at},goal:{title,objective},executive_thesis:string,aspect_assessments:[{aspect,status:'strength|constraint|unknown',observations:string[],evidence_refs:string[],implication:string,next_move:string}],constraint:{type:'positioning|reach|conversion|qualified_pipeline|retention|measurement',statement,evidence_refs:string[],known_facts:string[],unknowns:string[]},hypotheses:[{statement,confidence:'LOW|MEDIUM|HIGH',evidence_refs:string[],expected_signal,falsification}],stage:{name,objective,duration_days:7-30,checkpoint_day,measurement:{primary_signal,source,decision_rule,stop_condition}},delegation:{room_tag,objective,deliverable,success_measure,skills:string[],acceptance_criteria:string[]},policy:{autonomy_mode,channel_policy:{},claim_constraints:string[]},roadmap:[{horizon,focus,activation_condition}]}.
The roadmap is directional; only the single stage and delegation are committed. Use only an available room_tag. Every factual assessment and hypothesis must reference the baseline resource id or another supplied source reference.`;
  const user = JSON.stringify({ objective: String(objective || '').slice(0, 4000), mode, aspects: selected, autonomy_mode: autonomyMode || context.active_goal?.autonomy_mode || 'MANUAL_REVIEW', context });
  await progress('planning', mode === 'initial_full' ? 'Assessing the complete company growth system.' : `Reviewing ${selected.join(', ')} for the next operating decision.`);
  const response = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.1, max_completion_tokens: mode === 'initial_full' ? 16000 : 8000, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }, { timeoutMs: 120000 });
  if (!response?.ok) throw new Error(`growth_plan_model_failed:${response?.status || 'unknown'}`);
  const body = await response.json();
  const plan = validatePlan(normalizeGrowthPlanEvidence(extractJson(body?.choices?.[0]?.message?.content), context), context, mode, selected);
  plan.report_markdown = renderGrowthPlanReport(plan);
  await progress('governance', 'Validated evidence references, aspect coverage, stage bounds, and specialist ownership.');

  const suppliedTurn = turnId ? await prisma.hyperTurn.findFirst({ where: { id: turnId, room: { orgId } }, select: { id: true } }).catch(() => null) : null;
  const sourceTurn = hqCycleId ? null : (suppliedTurn || await ensureDetachedTurn({ prisma, orgId, prompt: objective || 'Run the Growth Operating Planner', runId }));
  const committed = await commitGrowthPlan({ prisma, orgId, userId, turnId: sourceTurn?.id || null, hqCycleId: hqCycleId || null, contract: toCommitContract(plan) });
  const artifact = await persistPlanArtifact({ prisma, orgId, userId, runId, mode, aspects: selected, plan, committed: {
    goal_id: committed.goal.id, stage_id: committed.stage.id, delegation_id: committed.delegation.id,
    work_order_id: committed.work_order?.id, room_id: committed.room.id,
  }, usage: body.usage || {} });
  await progress('delegated', `Created ${committed.stage.name} and delegated its Work Order to ${committed.delegation.room_tag}.`);
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
