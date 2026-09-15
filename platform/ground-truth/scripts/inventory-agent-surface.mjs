import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [root = process.cwd(), output = path.join(process.cwd(), 'agent-surface-inventory.json')] = process.argv.slice(2);
const ignored = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage']);
const records = [];

function classify(relative) {
  const normalized = relative.toLowerCase();
  if (normalized === 'agents.md' || normalized === 'claude.md' || normalized.startsWith('.agents/') || normalized.startsWith('.claude/')) return 'agent-surface';
  if (normalized.startsWith('platform/ground-truth/')) return 'canonical';
  if (normalized.includes('journal') || normalized.includes('worklog') || normalized.includes('handoff') || normalized.includes('summary') || normalized.includes('phase')) return 'archive-review';
  if (normalized.endsWith('readme.md') || normalized.endsWith('.md')) return 'documentation-review';
  return 'outside-agent-surface';
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute) || '.';
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile()) {
      const info = await stat(absolute);
      records.push({ path: relative, bytes: info.size, classification: classify(relative), action: 'review-only' });
    }
  }
}

await walk(root);
records.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), root, records }, null, 2)}\n`);
const summary = {};
for (const record of records) summary[record.classification] = (summary[record.classification] ?? 0) + 1;
console.log(JSON.stringify(summary, null, 2));
