import crypto from 'node:crypto';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPath(value, path) {
  return String(path || '').split('.').filter(Boolean)
    .reduce((current, part) => current == null ? undefined : current[part], value);
}

function artifactId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}

function itemIdentity(item, index, path) {
  return String(getPath(item, path) ?? item?.id ?? item?.external_ref ?? index).trim();
}

function mappedTarget(item, mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return item;
  return Object.fromEntries(Object.entries(mapping).map(([key, path]) => [key, getPath(item, path)]));
}

const SETTLED = new Set(['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION']);

export function createChildPlaybookAdapter({ prisma, getService } = {}) {
  if (!prisma || typeof getService !== 'function') throw new Error('child_playbook_adapter_dependencies_required');
  return {
    id: 'child-playbook',
    name: 'Checkpointed child lifecycle',
    description: 'Creates and reconciles idempotent child playbook runs from playbook-declared item data.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const config = input.config || {};
      const sourceKey = String(config.source_key || '').trim();
      const sourceArtifacts = asArray(input.inputs?.[`artifacts.${sourceKey}`]);
      const itemsPath = String(config.items_path || 'data.items');
      const items = sourceArtifacts.flatMap((artifact) => {
        const value = getPath(artifact, itemsPath);
        return Array.isArray(value) ? value : [artifact?.data || artifact].filter(Boolean);
      });
      const itemKeyPath = String(config.item_key_path || 'id');
      const children = await prisma.runtimePlaybookRun.findMany({
        where: { parentRunId: context.runId, orgId: context.orgId },
        include: { artifacts: { orderBy: { createdAt: 'asc' } } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });
      const byItem = new Map(children.map((child) => [String(child.itemKey || ''), child]));
      const action = String(config.action || 'dispatch_next');

      if (action === 'evaluate') {
        const outcomes = items.map((item, index) => {
          const key = itemIdentity(item, index, itemKeyPath);
          const child = byItem.get(key);
          return {
            item_key: key,
            position: index,
            run_id: child?.id || null,
            status: child?.status || 'PENDING',
            terminal_state: child?.terminalState || null,
          };
        });
        const complete = items.length > 0 && outcomes.every((outcome) => SETTLED.has(outcome.status));
        const outputKey = complete ? String(config.complete_key || 'child_set_complete') : String(config.pending_key || 'child_set_pending');
        return { artifacts: [{
          id: artifactId(outputKey, context.runId, JSON.stringify(outcomes)),
          key: outputKey,
          status: complete ? 'READY' : 'PENDING',
          data: { total: items.length, settled: outcomes.filter((row) => SETTLED.has(row.status)).length, outcomes },
          source_refs: children.map((child) => `runtime-run:${child.id}`),
          external_ref: null,
        }] };
      }

      if (!items.length) throw new Error('child_playbook_items_required');
      const next = items.map((item, index) => ({ item, index, key: itemIdentity(item, index, itemKeyPath) }))
        .find(({ key }) => !SETTLED.has(byItem.get(key)?.status));
      if (!next) throw new Error('child_playbook_no_pending_item');
      let child = byItem.get(next.key);
      if (!child) {
        const service = getService();
        if (!service) throw new Error('child_playbook_service_unavailable');
        const parent = await prisma.runtimePlaybookRun.findFirst({ where: { id: context.runId, orgId: context.orgId } });
        if (!parent) throw new Error('child_playbook_parent_not_found');
        const safeLearning = children.flatMap((row) => row.artifacts)
          .filter((artifact) => artifact.artifactKey === 'call_analysis')
          .flatMap((artifact) => asArray(artifact.data?.safe_generalized_learning))
          .map(String).filter(Boolean).slice(-20);
        const selection = {
          playbook_id: String(config.child_playbook_id || ''),
          version: Number(config.child_playbook_version || 0),
          context_patch: {},
        };
        const childTarget = mappedTarget(next.item, config.child_target_mapping);
        const created = await service.createSelectedAssignment({
          orgId: context.orgId,
          roomId: context.roomId,
          idempotencyKey: `child:${context.runId}:${next.key}`.slice(0, 180),
          trigger: { ...parent.trigger, parent_run_id: context.runId, parent_stage_id: context.stageId, item_key: next.key },
          context: {
            ...parent.context,
            request: { ...(parent.context?.request || {}), exact_targets: [childTarget] },
            target: childTarget,
            parent_execution: { run_id: context.runId, stage_id: context.stageId, item_key: next.key, position: next.index },
            safe_prior_learning: safeLearning,
          },
          scopeKey: parent.scopeKey,
          selection,
          parentRunId: context.runId,
          parentStageId: context.stageId,
          itemKey: next.key,
          position: next.index,
        });
        child = created.run;
      }
      const outputKey = String(config.output_key || 'child_run');
      return { artifacts: [{
        id: artifactId(outputKey, context.runId, next.key),
        key: outputKey,
        status: 'READY',
        data: { child_run_id: child.id, item_key: next.key, position: next.index, status: child.status },
        source_refs: [`runtime-run:${child.id}`],
        external_ref: child.id,
      }] };
    },
  };
}
