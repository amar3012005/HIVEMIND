/**
 * Generic completion-contract validation for an AgentScope-led WorkRun.
 *
 * This is deliberately a predicate evaluator, not an executor: AgentScope
 * still decides the plan and next tool call. HIVE only answers whether the
 * durable evidence required by the selected playbook is present.
 */

const COMPLETED_TASK_STATES = new Set(['completed', 'complete', 'done', 'success']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function latestTasks(events) {
  if (!Array.isArray(events)) return [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.t === 'plan.updated' && Array.isArray(event.tasks)) return event.tasks;
  }
  return [];
}

/**
 * Evaluate only generic, data-defined predicates. Unknown fields are ignored
 * rather than interpreted as custom workflow instructions.
 */
export function validateWorkRunCompletion({ scope, events, resultArtifactIds } = {}) {
  const contract = asObject(asObject(scope).completion_contract);
  if (Object.keys(contract).length === 0) return { passed: true, unmet: [], contract: null };

  const unmet = [];
  const taskContract = asObject(contract.tasks);
  const tasks = latestTasks(events);
  const minCompleted = Math.max(0, Number(taskContract.min_completed || 0));
  const completed = tasks.filter((task) => COMPLETED_TASK_STATES.has(String(task?.state || '').toLowerCase()));
  if (completed.length < minCompleted) {
    unmet.push({ predicate: 'tasks.min_completed', expected: minCompleted, actual: completed.length });
  }
  if (taskContract.require_all_completed === true && tasks.some(
    (task) => !COMPLETED_TASK_STATES.has(String(task?.state || '').toLowerCase()),
  )) {
    unmet.push({ predicate: 'tasks.require_all_completed', expected: true, actual: false });
  }

  const artifactContract = asObject(contract.artifacts);
  const artifacts = Array.isArray(resultArtifactIds) ? resultArtifactIds.filter(Boolean) : [];
  const minArtifacts = Math.max(0, Number(artifactContract.min_count || 0));
  if (artifacts.length < minArtifacts) {
    unmet.push({ predicate: 'artifacts.min_count', expected: minArtifacts, actual: artifacts.length });
  }

  return { passed: unmet.length === 0, unmet, contract };
}
