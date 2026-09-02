import assert from 'node:assert/strict';

function comparable(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Replays a persisted Runtime trace through an injected adapter and checks the
 * durable projection after every input. The adapter is intentionally supplied
 * by the caller so the same harness works with a test database or a read-only
 * production snapshot without creating a second Runtime execution path.
 */
export async function replayRuntimeTrace({ trace, applyInput, readProjection }) {
  if (!trace || !Array.isArray(trace.steps)) throw new Error('runtime_replay_trace_steps_required');
  if (typeof applyInput !== 'function' || typeof readProjection !== 'function') throw new Error('runtime_replay_adapter_required');
  const results = [];
  for (const [index, step] of trace.steps.entries()) {
    const result = await applyInput(step.input, { index, trace });
    const projection = comparable(await readProjection({ index, step, result }));
    if (step.expected) assert.deepEqual(projection, comparable(step.expected), `runtime replay step ${index + 1} diverged`);
    results.push({ index, input: comparable(step.input), result: comparable(result), projection });
  }
  return { traceId: trace.id || null, steps: results };
}

export function runtimeProjection({ events = [], schedules = [], runs = [], todos = [] } = {}) {
  return {
    events: events.map((row) => ({ id: row.id, type: row.eventType || row.type, sequence: String(row.sequence ?? ''), visibility: row.visibility || null })),
    schedules: schedules.map((row) => ({ id: row.id, status: row.status, triggerType: row.triggerType || row.trigger_type, cause: row.materialCauseId || row.material_cause_id || null })),
    runs: runs.map((row) => ({ id: row.id, status: row.status, stage: row.currentStageId || row.current_stage_id || null, checkpointSequence: row.checkpointSequence ?? row.checkpoint_sequence ?? null })),
    todos: todos.map((row) => ({ id: row.id, status: row.status, blockedReason: row.blockedReason || row.blocked_reason || null })),
  };
}
