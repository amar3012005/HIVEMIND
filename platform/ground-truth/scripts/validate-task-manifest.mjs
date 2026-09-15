import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
assert.ok(file, 'usage: node validate-task-manifest.mjs <task.json>');
const task = JSON.parse(await readFile(file, 'utf8'));

const allowed = new Set([
  'contractVersion', 'id', 'skill', 'modelTier', 'repository', 'baseBranch',
  'execution', 'objective', 'files', 'allowedCommands', 'checks', 'risk', 'requiresApproval',
  'release', 'rollback', 'dependencies',
]);
for (const key of Object.keys(task)) assert.ok(allowed.has(key), `unsupported field: ${key}`);
for (const key of ['id', 'skill', 'modelTier', 'repository', 'baseBranch', 'execution', 'objective', 'files', 'allowedCommands', 'checks', 'risk']) assert.ok(task[key], `missing ${key}`);
assert.equal(task.contractVersion, 1, 'unsupported contractVersion');
assert.match(task.id, /^[a-z0-9][a-z0-9-]{2,80}$/);

const skills = new Set(['memory-platform', 'identity-platform', 'cordis-harness-platform', 'tara-voice-platform', 'platform-security-audit', 'platform-evals', 'platform-release']);
assert.ok(skills.has(task.skill), 'unknown skill');
assert.ok(['luna', 'terra', 'sol-astra'].includes(task.modelTier), 'unknown model tier');
assert.ok(['mechanical', 'bounded', 'critical'].includes(task.risk), 'unknown risk');
assert.ok(Array.isArray(task.files) && task.files.length > 0, 'files must be a non-empty array');
assert.ok(Array.isArray(task.allowedCommands) && task.allowedCommands.length > 0, 'allowedCommands must be a non-empty array');
assert.ok(Array.isArray(task.checks) && task.checks.length > 0, 'checks must be a non-empty array');
assert.equal(typeof task.execution, 'object', 'execution must be an object');
assert.equal(task.execution.mode, 'worktree', 'tasks must run in an explicit worktree');
assert.equal(typeof task.execution.sourceRef, 'string', 'execution.sourceRef must be an exact Git ref');
assert.ok(task.execution.sourceRef.length > 0, 'execution.sourceRef must not be empty');
assert.equal(task.execution.onMissing, 'error', 'missing source refs must fail; never fall back to main');

const releases = new Set(['none', 'local', 'enigma', 'production']);
assert.ok(releases.has(task.release ?? 'none'), 'invalid release target');
if (task.modelTier === 'luna') {
  assert.equal(task.risk, 'mechanical', 'luna tasks must be mechanical');
  assert.equal(task.release ?? 'none', 'none', 'luna cannot release');
  assert.equal(task.requiresApproval ?? false, false, 'luna cannot execute approval-gated work');
}
if (task.risk === 'critical') assert.equal(task.modelTier, 'sol-astra', 'critical tasks require sol-astra');
if (task.release === 'production') {
  assert.equal(task.modelTier, 'sol-astra', 'production tasks require sol-astra');
  assert.ok(task.rollback, 'production task requires rollback');
}
if (task.skill === 'platform-release') {
  assert.ok(task.rollback, 'release tasks require rollback');
  assert.notEqual(task.release ?? 'none', 'none', 'release skill requires a target environment');
}

console.log(`task manifest: valid (${task.skill}/${task.modelTier}/${task.risk})`);
