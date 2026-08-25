import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AmrMemoryStore } from '../../src/vector/mneme/amr-store.mjs';

test('AMR memory inventory filter excludes evidence from list and stats', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-memory-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const amr = new AmrMemoryStore({ dataRoot: root, org: 'inventory-org', dim: 2 });
  const write = (id, layer) => amr.write({
    id,
    content: `${layer} record`,
    layer,
    isLatest: true,
    createdAt: new Date().toISOString(),
  }, [1, 0]);

  write('memory-1', 'memory');
  write('cognitive-1', 'cognitive');
  write('evidence-1', 'evidence');

  const filter = { layers: ['memory', 'cognitive'] };
  const listed = amr.list(filter, null, 10);
  assert.deepEqual(listed.memories.map((row) => row.id).sort(), ['cognitive-1', 'memory-1']);
  assert.equal(listed.total, 2, 'inventory total excludes evidence as well as the visible page');
  assert.equal(amr.stats(filter).memories, 2);
  assert.equal(amr.stats({}).memories, 3, 'the store remains able to report all live content when an internal caller explicitly asks');
});

test('AMR inventory totals honor access tiers, project/team grants, and hidden tags', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-memory-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const amr = new AmrMemoryStore({ dataRoot: root, org: 'inventory-access-org', dim: 2 });
  let sequence = 0;
  const write = (id, record = {}) => amr.write({
    id,
    content: id,
    layer: record.layer || 'memory',
    isLatest: true,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString(),
    ...record,
  }, [1, 0]);

  write('own-personal', { userId: 'user-one', scope: 'personal' });
  write('other-personal', { userId: 'user-two', scope: 'personal' });
  write('org-memory', { userId: 'user-two', scope: 'organization' });
  write('project-visible', { userId: 'user-two', scope: 'project', projectIds: ['project-one'] });
  write('project-hidden', { userId: 'user-two', scope: 'project', projectIds: ['project-two'] });
  write('team-visible', { userId: 'user-two', scope: 'team', primaryTeamId: 'team-one' });
  write('team-hidden', { userId: 'user-two', scope: 'team', primaryTeamId: 'team-two' });
  write('hidden-activity', { userId: 'user-one', scope: 'personal', tags: ['tara-turn'] });
  write('visible-synthesis', {
    userId: 'user-two', scope: 'organization', tags: ['tara-turn'], layer: 'cognitive', cognitiveLayerRole: 'canonical',
  });
  write('guest-cross-project', {
    userId: 'user-two', scope: 'project', projectIds: ['project-one'], tags: ['scope:cross-project'],
  });
  write('evidence-row', { userId: 'user-one', scope: 'personal', layer: 'evidence' });

  const memberFilter = {
    layers: ['memory', 'cognitive'],
    is_latest: true,
    user_id: 'user-one',
    access_context: { projectIds: ['project-one'], teamIds: ['team-one'], orgRole: 'member', crossProject: true },
    exclude_tags: ['tara-turn'],
  };
  const memberPage = amr.list(memberFilter, null, 2, 0);
  assert.equal(memberPage.total, 6, 'total uses the same ACL and noise predicate as rows');
  assert.equal(memberPage.memories.length, 2, 'page limit never changes the total');
  assert.equal(amr.stats(memberFilter).memories, 6);
  assert.deepEqual(amr.list(memberFilter, null, 20).memories.map((row) => row.id).sort(), [
    'guest-cross-project', 'org-memory', 'own-personal', 'project-visible', 'team-visible', 'visible-synthesis',
  ]);

  // When membership lookup is unavailable, stats must fail closed to the
  // caller's personal tier, which is the same fallback central Prisma uses.
  const noContextFilter = {
    layers: ['memory', 'cognitive'],
    is_latest: true,
    user_id: 'user-one',
    scope: 'tier:personal',
    exclude_tags: ['tara-turn'],
  };
  assert.deepEqual(amr.list(noContextFilter, null, 20).memories.map((row) => row.id), ['own-personal']);
  assert.equal(amr.stats(noContextFilter).memories, 1);

  const guestFilter = {
    layers: ['memory', 'cognitive'],
    is_latest: true,
    user_id: 'user-one',
    access_context: { projectIds: ['project-one'], teamIds: [], orgRole: 'guest', crossProject: false },
    exclude_tags: ['tara-turn'],
  };
  assert.deepEqual(amr.list(guestFilter, null, 20).memories.map((row) => row.id).sort(), ['own-personal', 'project-visible']);
  assert.equal(amr.stats(guestFilter).memories, 2);
  assert.equal(amr.stats({ ...guestFilter, scope: 'tier:organization' }).memories, 0, 'guests cannot widen a tier selector into the organization scope');
});
