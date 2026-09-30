import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalogDocs, loadDocs, readDocs, searchDocs } from './docs-index.mjs';

test('search, exact read and catalog use the current Markdown files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-docs-'));
  await mkdir(path.join(root, 'subsystems'));
  await writeFile(path.join(root, 'subsystems', 'schedule.md'), '# Host-wide Schedule\n\n## Delivery\nDelivery acknowledges the inbox, not model completion.\n');
  await writeFile(path.join(root, 'subsystems', 'goal.md'), '# Goals\n\nGoals persist a phase.\n');
  const { pages } = await loadDocs(root);
  assert.equal(pages.length, 2);
  assert.equal(searchDocs(pages, 'schedule delivery')[0].path, 'subsystems/schedule.md');
  assert.match(readDocs(pages, 'subsystems/schedule.md', 3, 2).text, /4: Delivery acknowledges/);
  assert.equal(catalogDocs(pages, 'subsystems/', 1).next_cursor, 'subsystems/goal.md');
  await assert.rejects(async () => readDocs(pages, '../secrets.md'), /Invalid documentation path/);
});
