import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [taskPath, repository = process.cwd()] = process.argv.slice(2);
assert.ok(taskPath, 'usage: node resolve-worktree-start.mjs <task.json> [repository]');

const task = JSON.parse(await readFile(taskPath, 'utf8'));
assert.equal(task.execution?.mode, 'worktree', 'task must require a worktree');
assert.equal(task.execution?.onMissing, 'error', 'missing source refs must fail');
assert.equal(typeof task.execution?.sourceRef, 'string', 'task requires execution.sourceRef');
assert.ok(task.execution.sourceRef.length > 0, 'task requires a non-empty execution.sourceRef');

const sourceRef = task.execution.sourceRef;
try {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repository, 'rev-parse', '--verify', '--quiet', `${sourceRef}^{commit}`],
    { encoding: 'utf8' },
  );
  const sourceSha = stdout.trim();
  assert.ok(sourceSha, `cannot resolve source ref: ${sourceRef}`);
  console.log(JSON.stringify({
    repository,
    baseBranch: task.baseBranch,
    sourceRef,
    sourceSha,
    codexStartingState: {
      type: 'branch',
      branchName: sourceRef,
      onMissing: 'error',
    },
  }, null, 2));
} catch (error) {
  throw new Error(`Cannot create worktree: source ref ${JSON.stringify(sourceRef)} is unavailable in ${repository}. Fetch or select the exact environment ref; main fallback is prohibited.`, { cause: error });
}
