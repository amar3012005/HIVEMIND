import { createPostgresCheckpointer } from './postgres-checkpointer.js';
import { compileRoomOperatorLifecycle, roomOperatorThreadConfig } from './room-operator-lifecycle.js';

function artifactRefs(contract = {}) {
  return (Array.isArray(contract.deliverables) ? contract.deliverables : []).map((artifact, index) =>
    String(artifact?.id || artifact?.external_ref || artifact?.artifact_key
      || `${artifact?.kind || artifact?.artifact_type || 'artifact'}:${index}`));
}

export async function createProductionRoomOperatorService({ logger = console } = {}) {
  const checkpointRuntime = await createPostgresCheckpointer({
    connectionString: process.env.DATABASE_URL,
    schema: process.env.HQ_LANGGRAPH_SCHEMA || 'hivemind_langgraph',
  });
  const graph = compileRoomOperatorLifecycle({ checkpointer: checkpointRuntime.checkpointer });

  return {
    async checkpoint({ organizationId, executionId, todoId, workOrderId, roomTag, objective, contract }) {
      const checkpoint = contract?.checkpoint || {};
      const config = roomOperatorThreadConfig({ organizationId, executionId });
      const result = await graph.invoke({
        executionId, organizationId, todoId, workOrderId, roomTag, objective,
        stage: checkpoint.stage || null,
        completed: checkpoint.completed || [],
        next: checkpoint.next || null,
        disposition: checkpoint.disposition,
        reason: checkpoint.reason || '',
        requires: checkpoint.requires || [],
        artifactRefs: artifactRefs(contract),
        evidenceRefs: Array.isArray(contract?.evidence_refs) ? contract.evidence_refs : [],
      }, config);
      const snapshot = await graph.getState(config);
      return {
        status: result.status,
        checkpointId: snapshot?.config?.configurable?.checkpoint_id || null,
        threadId: config.configurable.thread_id,
        historyLength: Array.isArray(result.checkpointHistory) ? result.checkpointHistory.length : 0,
      };
    },
    async close() { await checkpointRuntime.close(); },
  };
}
