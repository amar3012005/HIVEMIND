import { Command } from '@langchain/langgraph';

function assertId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`email_lifecycle_runtime_missing_${name}`);
  return normalized;
}

function checkpointId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('email_lifecycle_checkpoint_id_missing');
  return normalized;
}

function threadConfig(execution, selectedCheckpointId) {
  return {
    configurable: {
      thread_id: execution.threadId,
      checkpoint_ns: '',
      ...(selectedCheckpointId ? { checkpoint_id: selectedCheckpointId } : {}),
    },
  };
}

function checkpointSummary(tuple) {
  const configurable = tuple?.config?.configurable || {};
  const parent = tuple?.parentConfig?.configurable || {};
  return {
    checkpointId: configurable.checkpoint_id || tuple?.checkpoint?.id || null,
    parentCheckpointId: parent.checkpoint_id || null,
    createdAt: tuple?.checkpoint?.ts || null,
    metadata: tuple?.metadata || {},
    pendingWriteCount: Array.isArray(tuple?.pendingWrites) ? tuple.pendingWrites.length : 0,
    updatedChannels: tuple?.checkpoint?.updated_channels || [],
  };
}

function stateSummary(snapshot) {
  const configurable = snapshot?.config?.configurable || {};
  const parent = snapshot?.parentConfig?.configurable || {};
  return {
    checkpointId: configurable.checkpoint_id || null,
    parentCheckpointId: parent.checkpoint_id || null,
    createdAt: snapshot?.createdAt || null,
    values: snapshot?.values || {},
    next: snapshot?.next || [],
    metadata: snapshot?.metadata || {},
    tasks: snapshot?.tasks || [],
  };
}

export function createEmailLifecycleRuntime({
  graph,
  checkpointer,
  executionRegistry,
  supportedGraphVersions = [1],
}) {
  if (!graph || typeof graph.invoke !== 'function') {
    throw new Error('email_lifecycle_runtime_missing_graph');
  }
  for (const method of ['create', 'get']) {
    if (!executionRegistry || typeof executionRegistry[method] !== 'function') {
      throw new Error(`email_lifecycle_runtime_missing_registry_${method}`);
    }
  }

  const authorize = async ({ organizationId, executionId }) => {
    const orgId = assertId(organizationId, 'organization_id');
    const execId = assertId(executionId, 'execution_id');
    const execution = await executionRegistry.get(execId);
    if (!execution || execution.organizationId !== orgId) {
      throw new Error('email_lifecycle_execution_not_found');
    }
    if (!supportedGraphVersions.includes(Number(execution.graphVersion))) {
      throw new Error(`email_lifecycle_graph_version_unsupported:${execution.graphVersion}`);
    }
    return execution;
  };

  return {
    async start(input) {
      const organizationId = assertId(input.organizationId, 'organization_id');
      const executionId = assertId(input.executionId, 'execution_id');
      const execution = await executionRegistry.create({
        executionId,
        organizationId,
        workOrderId: assertId(input.workOrderId, 'work_order_id'),
        threadId: `hq:${organizationId}:email:${executionId}:v${input.graphVersion || 1}`,
        graphVersion: input.graphVersion || 1,
      });
      return graph.invoke(input, threadConfig(execution));
    },

    async resume({ organizationId, executionId, value }) {
      const execution = await authorize({ organizationId, executionId });
      return graph.invoke(new Command({ resume: value }), threadConfig(execution));
    },

    async retry({ organizationId, executionId }) {
      const execution = await authorize({ organizationId, executionId });
      return graph.invoke(null, threadConfig(execution));
    },

    async getState({ organizationId, executionId, checkpointId: selectedCheckpointId }) {
      const execution = await authorize({ organizationId, executionId });
      return graph.getState(threadConfig(execution, selectedCheckpointId
        ? checkpointId(selectedCheckpointId) : null));
    },

    async getCheckpoint({ organizationId, executionId, checkpointId: selectedCheckpointId }) {
      const execution = await authorize({ organizationId, executionId });
      if (!checkpointer || typeof checkpointer.getTuple !== 'function') {
        throw new Error('email_lifecycle_checkpointer_inspection_unavailable');
      }
      const tuple = await checkpointer.getTuple(threadConfig(
        execution,
        selectedCheckpointId ? checkpointId(selectedCheckpointId) : null,
      ));
      return tuple ? checkpointSummary(tuple) : null;
    },

    async listCheckpoints({ organizationId, executionId, limit = 50, beforeCheckpointId }) {
      const execution = await authorize({ organizationId, executionId });
      if (!checkpointer || typeof checkpointer.list !== 'function') {
        throw new Error('email_lifecycle_checkpointer_inspection_unavailable');
      }
      const rows = [];
      const before = beforeCheckpointId
        ? threadConfig(execution, checkpointId(beforeCheckpointId))
        : undefined;
      for await (const tuple of checkpointer.list(threadConfig(execution), {
        limit: Math.max(1, Math.min(200, Number(limit) || 50)),
        ...(before ? { before } : {}),
      })) {
        rows.push(checkpointSummary(tuple));
      }
      return rows;
    },

    async getStateHistory({ organizationId, executionId, limit = 50, beforeCheckpointId }) {
      const execution = await authorize({ organizationId, executionId });
      const rows = [];
      const before = beforeCheckpointId
        ? threadConfig(execution, checkpointId(beforeCheckpointId))
        : undefined;
      for await (const snapshot of graph.getStateHistory(threadConfig(execution), {
        limit: Math.max(1, Math.min(200, Number(limit) || 50)),
        ...(before ? { before } : {}),
      })) {
        rows.push(stateSummary(snapshot));
      }
      return rows;
    },

    async replayFromCheckpoint({ organizationId, executionId, checkpointId: selectedCheckpointId }) {
      const execution = await authorize({ organizationId, executionId });
      return graph.invoke(null, threadConfig(execution, checkpointId(selectedCheckpointId)));
    },

    async deleteCheckpoints({ organizationId, executionId }) {
      const execution = await authorize({ organizationId, executionId });
      if (!checkpointer || typeof checkpointer.deleteThread !== 'function') {
        throw new Error('email_lifecycle_checkpointer_deletion_unavailable');
      }
      await checkpointer.deleteThread(execution.threadId);
      return { deleted: true, threadId: execution.threadId };
    },
  };
}
