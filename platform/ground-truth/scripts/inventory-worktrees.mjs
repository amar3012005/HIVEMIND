import { access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const [repository = process.cwd(), output = path.join(process.cwd(), 'worktree-inventory.json')] = process.argv.slice(2);

async function git(args, cwd = repository) {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    return { error: error.stderr?.trim() || error.message };
  }
}

function parse(entries) {
  const worktrees = [];
  let current;
  for (const line of entries.split('\n')) {
    if (!line) {
      if (current) worktrees.push(current);
      current = undefined;
      continue;
    }
    const [key, ...values] = line.split(' ');
    if (key === 'worktree') current = { path: values.join(' ') };
    else if (current && key === 'HEAD') current.head = values[0];
    else if (current && key === 'branch') current.branch = values[0]?.replace('refs/heads/', '');
    else if (current && key === 'detached') current.detached = true;
    else if (current && key === 'prunable') current.prunable = values.join(' ') || true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

const listing = await git(['worktree', 'list', '--porcelain']);
if (typeof listing !== 'string') throw new Error(`cannot list worktrees: ${listing.error}`);
const worktrees = parse(listing);

for (const worktree of worktrees) {
  try {
    await access(worktree.path);
    worktree.exists = true;
  } catch {
    worktree.exists = false;
  }
  if (!worktree.exists || worktree.prunable) continue;
  const status = await git(['status', '--porcelain'], worktree.path);
  worktree.dirty = typeof status === 'string' ? status.length > 0 : true;
  if (worktree.branch) {
    const upstream = await git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${worktree.branch}`]);
    worktree.upstream = typeof upstream === 'string' && upstream ? upstream : null;
    if (worktree.upstream) {
      const counts = await git(['rev-list', '--left-right', '--count', `refs/heads/${worktree.branch}...${worktree.upstream}`]);
      if (typeof counts === 'string') {
        const [ahead, behind] = counts.split(/\s+/).map(Number);
        worktree.ahead = ahead;
        worktree.behind = behind;
      }
    }
  }
  worktree.cleanupEligible = Boolean(worktree.exists && !worktree.dirty && !worktree.prunable && worktree.ahead === 0);
  worktree.action = worktree.cleanupEligible ? 'review-before-removal' : 'retain-until-resolved';
}

const summary = {
  registered: worktrees.length,
  prunable: worktrees.filter((item) => item.prunable || !item.exists).length,
  dirty: worktrees.filter((item) => item.dirty).length,
  ahead: worktrees.filter((item) => (item.ahead ?? 0) > 0).length,
  reviewBeforeRemoval: worktrees.filter((item) => item.cleanupEligible).length,
};
await writeFile(output, `${JSON.stringify({ repository, generatedAt: new Date().toISOString(), summary, worktrees }, null, 2)}\n`);
console.log(JSON.stringify(summary));
