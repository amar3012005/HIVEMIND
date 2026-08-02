const ACTIVE = ['PLANNED', 'ACTIVE', 'MONITORING'];

export function evaluateNextGrowthAction({ baseline, stage, delegations = [], now = new Date() }) {
  if (!baseline) return { action: 'inspect', reason: 'No source-backed baseline is available.', priority: 'high' };
  if (!stage) return { action: 'plan', reason: 'No active growth stage exists for the current company position.', priority: 'high' };
  if (stage.status === 'PAUSED') return { action: 'iterate', reason: 'The current stage is paused and needs an evidence-backed decision.', priority: 'medium' };
  if (stage.checkpoint_at && new Date(stage.checkpoint_at) <= now) return { action: 'monitor', reason: 'The stage checkpoint is due; compare connector results with its thresholds.', priority: 'high' };
  if (!delegations.some((item) => ['PENDING', 'RUNNING', 'COMPLETED'].includes(item.status))) return { action: 'delegate', reason: 'The active stage has no specialist work in progress.', priority: 'high' };
  return { action: 'monitor', reason: 'Observe correlated lifecycle outcomes until the next checkpoint.', priority: 'normal' };
}

export async function getGrowthOperatingState({ prisma, orgId }) {
  const [goals, stages, hypotheses, delegations, journal, baselines] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT * FROM hivemind.growth_goals WHERE org_id=$1::uuid ORDER BY updated_at DESC LIMIT 8', orgId),
    prisma.$queryRawUnsafe(`SELECT s.* FROM hivemind.growth_stages s WHERE s.org_id=$1::uuid AND s.status = ANY($2::text[]) ORDER BY s.updated_at DESC LIMIT 4`, orgId, ACTIVE),
    prisma.$queryRawUnsafe('SELECT * FROM hivemind.growth_hypotheses WHERE org_id=$1::uuid ORDER BY updated_at DESC LIMIT 20', orgId),
    prisma.$queryRawUnsafe('SELECT * FROM hivemind.growth_delegations WHERE org_id=$1::uuid ORDER BY updated_at DESC LIMIT 20', orgId),
    prisma.$queryRawUnsafe('SELECT * FROM hivemind.growth_journal WHERE org_id=$1::uuid ORDER BY created_at DESC LIMIT 20', orgId),
    prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' }, select: { id: true, createdAt: true, payload: true }, orderBy: { createdAt: 'desc' }, take: 12 }),
  ]);
  const baseline = baselines.find((item) => item.payload?.scope?.mode === 'full_all') || baselines[0] || null;
  const stage = stages[0] || null;
  return { goals, stage, stages, hypotheses: hypotheses.filter((item) => !stage || item.growth_stage_id === stage.id), delegations: delegations.filter((item) => !stage || item.growth_stage_id === stage.id), journal, baseline, next_action: evaluateNextGrowthAction({ baseline: baseline?.payload, stage, delegations }) };
}

export async function createGrowthGoal({ prisma, orgId, userId, title, objective, autonomyMode = 'MANUAL_REVIEW', policy = {}, sourceRefs = [] }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hivemind.growth_goals (org_id, owner_user_id, title, objective, autonomy_mode, policy, source_refs)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
    orgId, userId, title, objective, autonomyMode, JSON.stringify(policy), JSON.stringify(sourceRefs),
  );
  const goal = rows[0];
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.growth_journal (org_id,growth_goal_id,actor_user_id,event_type,summary,evidence_refs,decision)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'goal_created',$4,$5::jsonb,$6::jsonb)`,
    orgId, goal.id, userId, `Growth goal created: ${title}`, JSON.stringify(sourceRefs), JSON.stringify({ autonomy_mode: autonomyMode }),
  );
  return goal;
}

const compact = (value) => JSON.stringify(value, null, 2);

function boundedSocialPresence(social = {}) {
  const rows = (value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  const reports = Object.fromEntries(Object.entries(social.platform_reports || {}).map(([platform, report]) => [platform, {
    profile: report?.profile || report?.account || null,
    totals: report?.totals || report?.metrics || null,
    recent_posts: rows(report?.recent_posts || report?.posts).slice(0, 5),
    limitations: rows(report?.limitations).slice(0, 5),
  }]));
  return {
    official_profiles: social.official_profiles || [], metrics: social.metrics,
    accounts: rows(social.accounts).slice(0, 12), followers: social.followers,
    totals: social.totals || {}, analytics_window: social.analytics_window,
    recent_posts: rows(social.recent_posts).slice(0, 12), platform_reports: reports,
  };
}

function boundedCompany(company = {}) {
  return Object.fromEntries(['company', 'name', 'website', 'location', 'industry', 'description', 'mission', 'icp', 'positioning', 'offer']
    .filter((key) => company?.[key] != null).map((key) => [key, company[key]]));
}

export async function buildGrowthPlanningContext({ prisma, orgId }) {
  const state = await getGrowthOperatingState({ prisma, orgId });
  if (!state.baseline) return null;
  const hqRows = await prisma.$queryRawUnsafe(
    `SELECT agent_connectors->'_company' AS company
       FROM hivemind.hyper_rooms
      WHERE org_id=$1::uuid AND archived_at IS NULL AND agent_connectors ? '_company'
      ORDER BY updated_at DESC LIMIT 1`, orgId,
  ).catch(() => []);
  const rooms = await prisma.hyperRoom.findMany({
    where: { orgId, archivedAt: null },
    select: { id: true, name: true, roomTag: true, participantIds: true, permanentLeadId: true },
  });
  const instructions = await prisma.hqInstruction.findMany({
    where: { orgId, status: 'APPLIED' }, orderBy: { createdAt: 'desc' }, take: 12,
    select: { id: true, body: true, interpreted: true, createdAt: true },
  }).catch(() => []);
  const baselinePayload = state.baseline.payload || {};
  return {
    contract: 'growth-stage-context.v1',
    company: boundedCompany(hqRows[0]?.company || baselinePayload.company || {}),
    baseline: {
      resource_id: state.baseline.id,
      captured_at: state.baseline.createdAt,
      scope: baselinePayload.scope,
      company: baselinePayload.company,
      website: baselinePayload.website,
      social_presence: boundedSocialPresence(baselinePayload.social_presence),
      execution: baselinePayload.execution,
      market_signals: baselinePayload.market_signals,
      data_gaps: baselinePayload.data_gaps,
      sources: baselinePayload.sources,
    },
    live_connector_signals: {
      as_of: baselinePayload.as_of,
      accounts: baselinePayload.social_presence?.accounts || [],
      totals: baselinePayload.social_presence?.totals || {},
      recent_posts: (baselinePayload.social_presence?.recent_posts || []).slice(0, 20),
      channels: baselinePayload.execution?.channels || [],
      limitations: baselinePayload.data_gaps || [],
    },
    active_goal: state.goals.find((goal) => goal.status === 'ACTIVE') || null,
    active_stage: state.stage,
    operating_instructions: instructions.reverse().map((item) => ({
      id: item.id, instruction: item.body, interpretation: item.interpreted, created_at: item.createdAt,
    })),
    available_rooms: rooms.filter((room) => room.roomTag !== 'general').map((room) => ({
      room_id: room.id, room_tag: room.roomTag, name: room.name,
      participant_ids: room.participantIds, permanent_lead_id: room.permanentLeadId,
    })),
    rules: {
      rank_constraints: [...CONSTRAINTS], stage_duration_days: { min: 7, max: 30 },
      max_hypotheses: 3, ordered_todo_queue: true,
      numbers_require_evidence: true, provider_results_are_source_of_truth: true,
    },
  };
}

export function serializeGrowthPlanningContext(context) {
  if (!context) return '';
  const prefix = 'STAGE 2 GROWTH OPERATING CONTEXT (server sourced; never replace with recalled estimates):\n';
  let body = compact(context);
  if (prefix.length + body.length > 15500) {
    const bounded = structuredClone(context);
    bounded.baseline.market_signals = (bounded.baseline.market_signals || []).slice(0, 3);
    bounded.baseline.social_presence.recent_posts = (bounded.baseline.social_presence.recent_posts || []).slice(0, 5)
      .map((post) => ({ ...post, text: String(post.text || post.content || '').slice(0, 400), content: undefined }));
    bounded.live_connector_signals.recent_posts = (bounded.live_connector_signals.recent_posts || []).slice(0, 5)
      .map((post) => ({ ...post, text: String(post.text || post.content || '').slice(0, 400), content: undefined }));
    bounded.baseline.social_presence.platform_reports = {};
    body = JSON.stringify(bounded);
    if (prefix.length + body.length > 15500) {
      bounded.baseline.social_presence.accounts = (bounded.baseline.social_presence.accounts || []).map((account) => ({
        platform: account.platform, username: account.username || account.name, followers: account.followers,
      }));
      bounded.live_connector_signals.accounts = bounded.baseline.social_presence.accounts;
      bounded.baseline.social_presence.recent_posts = [];
      bounded.live_connector_signals.recent_posts = [];
      body = JSON.stringify(bounded);
    }
  }
  return `${prefix}${body}`;
}

export async function commitGrowthPlan({ prisma, orgId, userId, turnId = null, hqCycleId = null, contract }) {
  if (!turnId && !hqCycleId) throw new Error('Growth plan requires a Room turn or HQ cycle');
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT j.growth_goal_id,j.growth_stage_id,j.decision
       FROM hivemind.growth_journal j
      WHERE j.org_id=$1::uuid AND j.event_type='initial_operating_queue_committed'
        AND (($2::text IS NOT NULL AND j.decision->>'turn_id'=$2)
          OR ($3::text IS NOT NULL AND j.decision->>'hq_cycle_id'=$3)) LIMIT 1`, orgId, turnId, hqCycleId,
  );
  if (existingRows.length) {
    const existing = existingRows[0];
    const [goal] = await prisma.$queryRawUnsafe('SELECT * FROM hivemind.growth_goals WHERE id=$1::uuid', existing.growth_goal_id);
    const [stage] = await prisma.$queryRawUnsafe('SELECT * FROM hivemind.growth_stages WHERE id=$1::uuid', existing.growth_stage_id);
    const todoIds = Array.isArray(existing.decision?.todo_ids) ? existing.decision.todo_ids : [];
    const todos = todoIds.length ? await prisma.hqTodo.findMany({ where: { id: { in: todoIds }, orgId } }) : [];
    return { goal, stage, todos };
  }
  if (!contract || contract.contract_version !== 'growth-plan.v2') throw new Error('Invalid growth plan contract version');
  const constraints = Array.isArray(contract.constraints) ? contract.constraints : [];
  const primary = constraints.find((item) => item?.id === contract.primary_constraint_id);
  const constraint = String(primary?.type || '').trim().toLowerCase().replace(/[\s-]+/g, '_').slice(0, 120);
  if (!/^[a-z][a-z0-9_:]*$/.test(constraint)) throw new Error('Growth plan must choose one stable constraint identifier');
  const queue = Array.isArray(contract.operating_queue) ? contract.operating_queue : [];
  if (!queue.length) throw new Error('Growth plan must contain an operating queue');
  const stage = contract.stage || {};
  const durationDays = Number(stage.duration_days);
  if (!Number.isInteger(durationDays) || durationDays < 7 || durationDays > 30) throw new Error('Growth stage must be bounded to 7-30 days');
  const hypotheses = Array.isArray(contract.hypotheses) ? contract.hypotheses.slice(0, 3) : [];
  if (!hypotheses.length || hypotheses.some((item) => !item.statement || !(item.evidence_refs || []).length)) {
    throw new Error('Every growth hypothesis must include a statement and evidence references');
  }
  const sourceRefs = [...new Set([contract.baseline_ref?.resource_id, ...(primary?.evidence_refs || [])].filter(Boolean))];
  if (!sourceRefs.length) throw new Error('Growth plan must reference the baseline artifact');
  const baselineArtifact = await prisma.sourceArtifact.findFirst({
    where: { id: contract.baseline_ref?.resource_id, orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' },
    select: { id: true },
  });
  if (!baselineArtifact) throw new Error('Growth plan references a baseline outside this organization or one that does not exist');

  const roomTags = [...new Set(queue.map((item) => String(item.room_tag).toLowerCase()))];
  const rooms = await prisma.hyperRoom.findMany({
    where: { orgId, archivedAt: null, roomTag: { in: roomTags } }, select: { roomTag: true },
  });
  const available = new Set(rooms.map((room) => room.roomTag));
  const missingRooms = roomTags.filter((tag) => !available.has(tag));
  if (missingRooms.length) throw new Error(`Missing Company Room(s): ${missingRooms.join(', ')}`);
  const runtime = await prisma.hqRuntime.findUnique({ where: { orgId }, select: { id: true, epoch: true } });
  if (!runtime) throw new Error('Growth plan requires an active HQ Runtime');
  const now = new Date();
  const checkpointAt = new Date(now.getTime() + Math.max(1, Number(stage.checkpoint_day || durationDays)) * 86400000);
  const endsAt = new Date(now.getTime() + durationDays * 86400000);

  return prisma.$transaction(async (tx) => {
    let goalRows = await tx.$queryRawUnsafe(
      `SELECT * FROM hivemind.growth_goals WHERE org_id=$1::uuid AND status='ACTIVE' ORDER BY updated_at DESC LIMIT 1`, orgId,
    );
    if (!goalRows.length) {
      goalRows = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.growth_goals (org_id,owner_user_id,title,objective,autonomy_mode,source_refs)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb) RETURNING *`,
        orgId, userId, String(contract.goal?.title || 'Company growth'), String(contract.goal?.objective || stage.objective),
        String(contract.policy?.autonomy_mode || 'MANUAL_REVIEW'), JSON.stringify(sourceRefs),
      );
    }
    const goal = goalRows[0];
    await tx.$executeRawUnsafe(
      `UPDATE hivemind.growth_stages SET status='SUPERSEDED',updated_at=now()
        WHERE org_id=$1::uuid AND status IN ('PLANNED','ACTIVE','MONITORING')`, orgId,
    );
    const stageRows = await tx.$queryRawUnsafe(
      `INSERT INTO hivemind.growth_stages
       (org_id,growth_goal_id,name,objective,growth_constraint,status,starts_at,checkpoint_at,ends_at,channel_policy,measurement,source_refs)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,'PLANNED',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb) RETURNING *`,
      orgId, goal.id, String(stage.name), String(stage.objective), constraint, now, checkpointAt, endsAt,
      JSON.stringify(contract.policy?.channel_policy || {}), JSON.stringify(stage.measurement || {}), JSON.stringify(sourceRefs),
    );
    const createdStage = stageRows[0];
    for (const hypothesis of hypotheses) {
      await tx.$executeRawUnsafe(
        `INSERT INTO hivemind.growth_hypotheses
         (org_id,growth_stage_id,statement,confidence,evidence_refs,expected_signal,falsification)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6,$7)`, orgId, createdStage.id, String(hypothesis.statement),
        String(hypothesis.confidence || 'MEDIUM').toUpperCase(), JSON.stringify(hypothesis.evidence_refs || []),
        String(hypothesis.expected_signal || ''), String(hypothesis.falsification || ''),
      );
    }
    const firstLife = contract.first_life && typeof contract.first_life === 'object' ? contract.first_life : null;
    const recommendedSourceId = String(firstLife?.recommended_todo_source_id || stage.queue_item_id || '');
    const todos = [];
    for (const [index, item] of queue.entries()) {
      const target = item.target && typeof item.target === 'object' ? item.target : {};
      const proposalConstraint = constraints.find((row) => String(row?.id || '') === String(item.constraint_id || contract.primary_constraint_id || ''));
      const proposalEvidenceRefs = Array.isArray(item.evidence_refs) && item.evidence_refs.length
        ? item.evidence_refs
        : Array.isArray(proposalConstraint?.evidence_refs) ? proposalConstraint.evidence_refs : sourceRefs;
      const todo = await tx.hqTodo.create({ data: {
        runtimeId: runtime.id, orgId,
        title: String(item.title).slice(0, 240), objective: String(item.objective),
        kind: String(item.kind || item.room_tag).toLowerCase(), status: firstLife ? 'PROPOSED' : 'READY',
        priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : (index + 1) * 10,
        position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
        requiredCapabilities: Array.isArray(item.required_capabilities) ? item.required_capabilities : [],
        context: {
          room_tag: String(item.room_tag).toLowerCase(), skill: item.skills?.[0] || null,
          skills: Array.isArray(item.skills) ? item.skills : [],
          deliverable: String(item.deliverable || ''), success_measure: String(item.success_measure || ''),
          acceptance_criteria: Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria : [],
          activation_condition: String(item.activation_condition || ''), target,
          location: target.location || null, growth_stage_id: createdStage.id,
          constraint_id: item.constraint_id || contract.primary_constraint_id,
          baseline_ref: contract.baseline_ref, growth_plan_cycle_id: hqCycleId || null,
          runtime_epoch: runtime.epoch,
          activation_sprint_id: item.activation_sprint_id || null,
          activation_slot: item.activation_slot || null,
          proposal_source_id: item.id || null,
          first_life_policy_id: item.first_life_policy_id || firstLife?.policy_id || null,
          first_life_policy_version: item.first_life_policy_version || firstLife?.policy_version || null,
          recommendation_rank: Number(item.recommendation_rank || index + 1),
          recommended: String(item.id || '') === recommendedSourceId,
          effect_class: item.effect_class,
          effect_basis: item.effect_basis || null,
          response_locale: contract.response_locale || null,
          evidence_refs: proposalEvidenceRefs,
          requested_action: item.requested_action || null,
          requested_terminal_outcome: item.requested_terminal_outcome || null,
          planned_playbook_id: item.playbook_id || null,
          planned_playbook_version: Number.isInteger(Number(item.playbook_version)) ? Number(item.playbook_version) : null,
          external_action_requested: item.effect_class === 'external',
          authority_mode: 'PREPARE',
          ignored_capability_suggestions: Array.isArray(item.ignored_capability_suggestions) ? item.ignored_capability_suggestions : [],
        },
      } });
      todos.push(todo);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO hivemind.growth_journal
       (org_id,growth_goal_id,growth_stage_id,actor_user_id,event_type,summary,evidence_refs,decision)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'initial_operating_queue_committed',$5,$6::jsonb,$7::jsonb)`,
      orgId, goal.id, createdStage.id, userId, `HQ ranked ${constraints.length} constraints and committed ${todos.length} ordered operating todo(s).`,
      JSON.stringify(sourceRefs), JSON.stringify({
        turn_id: turnId,
        hq_cycle_id: hqCycleId,
        todo_ids: todos.map((todo) => todo.id),
        recommended_todo_id: todos.find((todo) => todo.context?.recommended)?.id || null,
        first_life: firstLife,
        runtime_epoch: runtime.epoch,
      }),
    );
    return { goal, stage: createdStage, todos };
  }, { timeout: 15000 });
}
