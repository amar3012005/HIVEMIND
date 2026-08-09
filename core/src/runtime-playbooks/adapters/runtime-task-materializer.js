import crypto from 'node:crypto';

const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function stableKey(...parts) {
  return `strategy-motion:${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex')}`;
}

function reject(motion, reason) {
  return { motion_id: String(motion?.motion_id || ''), reason };
}

export function createRuntimeTaskMaterializerAdapter({ prisma, getService = () => null } = {}) {
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

      const service = getService();
      if (!service?.registry) throw new Error('runtime_task_materializer_registry_unavailable');
      const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: context.runId, orgId: context.orgId } });
      if (!run) throw new Error('runtime_task_materializer_run_not_found');
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

      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRawUnsafe(
          `SELECT id, epoch FROM hivemind.hq_runtimes WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`,
          runtimeId, context.orgId,
        );
        if (!locked.length) throw new Error('runtime_task_materializer_runtime_not_found');
        const epoch = String(locked[0].epoch);
        for (const [index, raw] of motions.entries()) {
          const motion = asObject(raw);
          const motionId = String(motion.motion_id || '').trim();
          const playbookId = String(motion.playbook_id || '').trim();
          const version = Number(motion.playbook_version);
          const supportedAction = String(motion.supported_action || '').trim();
          const evidenceRefs = asArray(motion.evidence_refs).map(String).filter(Boolean);
          if (!motionId || !playbookId || !Number.isInteger(version) || !supportedAction) {
            rejected.push(reject(motion, 'identity_or_lifecycle_fields_missing')); continue;
          }
          if (!evidenceRefs.length || evidenceRefs.some((ref) => !sourceRefs.has(ref))) {
            rejected.push(reject(motion, 'evidence_reference_not_in_strategy_lineage')); continue;
          }
          let playbook;
          try {
            playbook = service.registry.get(playbookId, version, { scopeKey: run.scopeKey });
          } catch {
            rejected.push(reject(motion, 'playbook_version_unavailable')); continue;
          }
          if (playbookId === run.playbookId
            && version === Number(run.playbookVersion)
            && playbook.metadata?.allow_recursive_children !== true) {
            rejected.push(reject(motion, 'recursive_playbook_not_allowed')); continue;
          }
          const supported = asArray(playbook.metadata?.supported_actions).map(String);
          const roomTag = String(playbook.metadata?.owner_room_tag || '').trim().toLowerCase();
          if (!supported.includes(supportedAction) || !roomTag) {
            rejected.push(reject(motion, 'action_or_room_not_supported')); continue;
          }
          const room = await tx.hyperRoom.findFirst({
            where: { orgId: context.orgId, archivedAt: null, roomTag }, select: { id: true },
          });
          if (!room) { rejected.push(reject(motion, 'owner_room_unavailable')); continue; }

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
              kind: roomTag.slice(0, 60),
              status: 'PROPOSED',
              priority: Number.isFinite(Number(motion.priority)) ? Number(motion.priority) : index + 1,
              position: index,
              requiredCapabilities: asArray(motion.required_capabilities),
              context: {
                strategy_motion_key: materializationKey,
                strategy_run_id: context.runId,
                strategy_stage_id: context.stageId,
                strategy_artifact_id: strategy?.id || null,
                portfolio_artifact_id: portfolio.id,
                motion_id: motionId,
                runtime_epoch: epoch,
                proposal_origin: 'strategy_program',
                first_life_policy_id: 'runtime.first-life-policy',
                first_life_policy_version: 5,
                activation_sprint_id: `strategy-program:${context.runId}`,
                recommendation_rank: index + 1,
                recommended: index === 0,
                room_tag: roomTag,
                effect_class: motion.effect_class === 'external' ? 'external' : 'internal',
                external_action_requested: motion.effect_class === 'external',
                planned_playbook_id: playbookId,
                planned_playbook_version: version,
                requested_action: supportedAction,
                requested_terminal_outcome: String(motion.expected_outcome || supportedAction),
                expected_outcome: motion.expected_outcome || null,
                success_measure: motion.success_measure || null,
                dependencies: asArray(motion.dependencies),
                evidence_refs: evidenceRefs,
                source_instruction: String(asObject(run.context).request?.instruction || motion.objective || ''),
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
        data: { portfolio_ref: portfolio.id, strategy_ref: strategy?.id || null, accepted_todo_ids: accepted, rejected_motions: rejected },
        source_refs: [portfolio.id, strategy?.id].filter(Boolean),
      }] };
    },
  };
}
