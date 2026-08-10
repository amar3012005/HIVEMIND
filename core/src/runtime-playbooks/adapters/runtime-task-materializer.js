import crypto from 'node:crypto';

const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const ASSIGNMENT_CONTRACT_VERSION = 2;

function stableKey(...parts) {
  return `runtime-task-proposal:v${ASSIGNMENT_CONTRACT_VERSION}:${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex')}`;
}

function reject(motion, reason) {
  return { motion_id: String(motion?.motion_id || ''), reason };
}

function proposalIsComplete(motion) {
  return ['motion_id', 'title', 'objective', 'reason', 'expected_outcome', 'success_measure']
    .every((field) => String(motion?.[field] || '').trim().length > 0);
}

export function createRuntimeTaskMaterializerAdapter({ prisma } = {}) {
  if (!prisma) throw new Error('runtime_task_materializer_prisma_required');
  return {
    id: 'runtime-task-materializer',
    name: 'Runtime task materializer',
    description: 'Validates an evidence-backed portfolio against the immutable lifecycle registry and atomically creates idempotent proposed Runtime tasks.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const config = asObject(input.config);
      const portfolio = asArray(input.inputs?.[`artifacts.${String(config.input_key || 'first_life_motion_portfolio')}`]).at(-1);
      const strategy = asArray(input.inputs?.[`artifacts.${String(config.strategy_key || 'marketing_strategy')}`]).at(-1);
      if (!portfolio?.id) throw new Error('runtime_task_materializer_portfolio_required');
      const motions = asArray(portfolio.data?.motions).slice(0, 4);
      if (motions.length < 2) throw new Error('runtime_task_materializer_minimum_motions_required');

      const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: context.runId, orgId: context.orgId } });
      if (!run) throw new Error('runtime_task_materializer_run_not_found');
      const runPolicyVersion = Number(asObject(run.context).policy?.first_life_policy_version);
      const policyVersion = Number.isInteger(runPolicyVersion) && runPolicyVersion > 0
        ? runPolicyVersion
        : Number.isInteger(Number(config.first_life_policy_version)) ? Number(config.first_life_policy_version) : 5;
      const trigger = asObject(run.trigger);
      const runtimeId = String(trigger.runtime_id || '');
      if (!runtimeId) throw new Error('runtime_task_materializer_runtime_required');

      const sourceRefs = new Set([
        ...asArray(portfolio.sourceRefs || portfolio.source_refs),
        ...asArray(strategy?.sourceRefs || strategy?.source_refs),
        portfolio.id,
        strategy?.id,
      ].filter(Boolean).map(String));
      const accepted = [];
      const rejected = [];
      let strategySourceArtifactId = null;

      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRawUnsafe(
          `SELECT id, epoch FROM hivemind.hq_runtimes WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`,
          runtimeId, context.orgId,
        );
        if (!locked.length) throw new Error('runtime_task_materializer_runtime_not_found');
        const epoch = String(locked[0].epoch);
        if (strategy?.id) {
          const room = await tx.hyperRoom.findFirst({
            where: { id: run.roomId, orgId: context.orgId }, select: { userId: true },
          });
          if (!room?.userId) throw new Error('runtime_task_materializer_strategy_owner_required');
          const strategyPayload = {
            artifact_key: 'marketing_strategy_program',
            artifact_id: strategy.id,
            playbook_run_id: context.runId,
            data: strategy.data || {},
            source_refs: asArray(strategy.sourceRefs || strategy.source_refs),
          };
          const checksum = crypto.createHash('sha256').update(JSON.stringify(strategyPayload)).digest('hex');
          const retained = await tx.sourceArtifact.upsert({
            where: { userId_orgId_checksum_sourcePlatform: {
              userId: room.userId, orgId: context.orgId, checksum, sourcePlatform: 'runtime_strategy',
            } },
            create: {
              userId: room.userId, orgId: context.orgId, artifactType: 'api_response',
              sourcePlatform: 'runtime_strategy', sourceId: strategy.id, checksum,
              storageLocation: 'postgres:inline', payload: strategyPayload,
              metadata: { reusable: true, runtime_epoch: epoch, playbook_run_id: context.runId },
            },
            update: { payload: strategyPayload, metadata: { reusable: true, runtime_epoch: epoch, playbook_run_id: context.runId } },
          });
          strategySourceArtifactId = retained.id;
          sourceRefs.add(retained.id);
        }
        for (const [index, raw] of motions.entries()) {
          const motion = asObject(raw);
          const motionId = String(motion.motion_id || '').trim();
          const evidenceRefs = asArray(motion.evidence_refs).map(String).filter(Boolean);
          if (!motionId || !proposalIsComplete(motion)) {
            rejected.push(reject(motion, 'runtime_task_proposal_fields_missing')); continue;
          }
          if (!evidenceRefs.length || evidenceRefs.some((ref) => !sourceRefs.has(ref))) {
            rejected.push(reject(motion, 'evidence_reference_not_in_strategy_lineage')); continue;
          }

          const materializationKey = stableKey(context.runId, portfolio.id, motionId);
          let todo = await tx.hqTodo.findFirst({
            where: { runtimeId, orgId: context.orgId, context: { path: ['strategy_motion_key'], equals: materializationKey } },
          });
          if (!todo) {
            todo = await tx.hqTodo.create({ data: {
              runtimeId,
              orgId: context.orgId,
              instructionId: trigger.instruction_id || null,
              title: String(motion.title || motionId).slice(0, 240),
              objective: String(motion.objective || motion.expected_outcome || motion.title || motionId),
              kind: 'runtime_task',
              status: 'PROPOSED',
              priority: Number.isFinite(Number(motion.priority)) ? Number(motion.priority) : index + 1,
              position: index,
              requiredCapabilities: asArray(motion.required_capabilities),
              context: {
                strategy_motion_key: materializationKey,
                assignment_contract_version: ASSIGNMENT_CONTRACT_VERSION,
                strategy_run_id: context.runId,
                strategy_stage_id: context.stageId,
                strategy_artifact_id: strategy?.id || null,
                strategy_source_artifact_id: strategySourceArtifactId,
                portfolio_artifact_id: portfolio.id,
                motion_id: motionId,
                runtime_epoch: epoch,
                proposal_origin: 'strategy_program',
                first_life_policy_id: 'runtime.first-life-policy',
                first_life_policy_version: policyVersion,
                activation_sprint_id: `strategy-program:${context.runId}`,
                recommendation_rank: index + 1,
                recommended: index === 0,
                effect_class: motion.effect_class === 'external' ? 'external' : 'internal',
                external_action_requested: motion.effect_class === 'external',
                requested_terminal_outcome: String(motion.expected_outcome),
                expected_outcome: motion.expected_outcome || null,
                success_measure: motion.success_measure || null,
                dependencies: asArray(motion.dependencies),
                evidence_refs: [...new Set([...evidenceRefs, strategySourceArtifactId].filter(Boolean))],
                suggested_targets: asArray(motion.exact_targets),
                source_instruction: String(motion.objective),
                strategy_source_instruction: String(asObject(run.context).request?.instruction || ''),
              },
            } });
          }
          accepted.push(todo.id);
        }
      });

      if (accepted.length === 0) {
        throw new Error(`runtime_task_materializer_no_valid_motions:${rejected.map((row) => `${row.motion_id}:${row.reason}`).join(',')}`);
      }

      return { artifacts: [{
        id: stableKey(context.runId, context.stageId, portfolio.id),
        key: 'runtime_task_materialization',
        status: rejected.length ? 'READY_WITH_WARNINGS' : 'READY',
        data: { portfolio_ref: portfolio.id, strategy_ref: strategy?.id || null, strategy_source_artifact_ref: strategySourceArtifactId, accepted_todo_ids: accepted, rejected_motions: rejected },
        source_refs: [portfolio.id, strategy?.id, strategySourceArtifactId].filter(Boolean),
      }] };
    },
  };
}
