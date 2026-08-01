function rows(value) { return Array.isArray(value) ? value : []; }

function nextAction(status) {
  if (status === 'WAITING_AUTHORITY') return 'request_authority';
  if (status === 'WAITING_EVENT') return 'wait_for_event';
  if (status === 'NEEDS_INTERVENTION') return 'inspect_unmet_predicates';
  return ['COMPLETED', 'TERMINATED'].includes(status) ? null : 'execute_current_stage';
}

export function projectRuntimePlaybookSnapshot(run, { turns = [] } = {}) {
  const counts = {};
  for (const artifact of rows(run.artifacts)) {
    const key = artifact.artifactKey || artifact.key;
    counts[key] = (counts[key] || 0) + 1;
  }
  const checkpoint = rows(run.checkpoints).at(-1) || null;
  return {
    execution_id: run.id,
    todo_id: run.trigger?.todo_id || null,
    room_id: run.roomId || null,
    playbook: { id: run.playbookId, version: run.playbookVersion },
    status: run.status,
    current_stage: run.currentStageId,
    completed_stages: rows(run.completedStageIds),
    checkpoint_sequence: Number(run.checkpointSequence || checkpoint?.sequence || 0),
    attempt: Number(run.stageAttempts?.[run.currentStageId] || 0),
    artifact_counts: counts,
    artifact_refs: rows(run.artifacts).map((artifact) => ({ id: artifact.artifactId || artifact.id, key: artifact.artifactKey || artifact.key, stage_id: artifact.stageId || artifact.stage_id, status: artifact.status })),
    authority: Object.fromEntries(rows(run.authorities).map((grant) => [grant.gate, { status: grant.status, granted_at: grant.grantedAt, revoked_at: grant.revokedAt, payload: grant.payload || {} }])),
    waiting_for: run.waitingFor || null,
    verdict: run.lastVerdict || checkpoint?.verdict || {},
    warnings: rows(run.lastVerdict?.warnings || checkpoint?.verdict?.warnings),
    next_action: nextAction(run.status),
    room_turns: turns.map((turn) => ({ id: turn.id, stage_id: turn.runtimeStageId, checkpoint_sequence: turn.runtimeCheckpointSequence, attempt: turn.runtimeAttempt, status: turn.status, started_at: turn.startedAt, sealed_at: turn.sealedAt })),
    updated_at: run.updatedAt,
  };
}

export async function loadRuntimePlaybookSnapshot(prisma, runId, orgId) {
  const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: runId, orgId }, include: { artifacts: { orderBy: { createdAt: 'asc' } }, checkpoints: { orderBy: { sequence: 'asc' } }, authorities: { orderBy: { grantedAt: 'asc' } } } });
  if (!run) return null;
  const turns = await prisma.hyperTurn.findMany({ where: { runtimePlaybookRunId: run.id }, orderBy: [{ runtimeCheckpointSequence: 'asc' }, { runtimeAttempt: 'asc' }] }).catch(() => []);
  return projectRuntimePlaybookSnapshot(run, { turns });
}
