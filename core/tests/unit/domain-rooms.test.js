import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOMAIN_ROOM_DEFINITIONS,
  countQuotaHyperRooms,
  ensureDomainRooms,
} from '../../src/employees/domain-rooms.js';

test('domain room registry exposes every permanent expertise home', () => {
  assert.deepEqual(
    DOMAIN_ROOM_DEFINITIONS.map((room) => room.key),
    ['general', 'seo', 'marketing', 'branding', 'fundraising', 'research', 'product', 'design', 'legal_finance'],
  );
});

test('domain room provisioning is idempotent and marks system homes', async () => {
  const creates = [];
  const tx = {
    $executeRawUnsafe: async () => {},
    $queryRawUnsafe: async () => [{ id: 'existing-research', room_tag: 'research' }],
    hyperRoom: {
      create: async ({ data }) => {
        creates.push(data);
        return { id: `created-${data.roomTag}` };
      },
    },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const rooms = await ensureDomainRooms({
    prisma,
    orgId: 'org-1',
    userId: 'user-1',
    participantIds: ['b', 'a', 'a'],
    company: { company: 'Acme', mission: 'Make work clearer' },
  });

  assert.equal(rooms.length, 9);
  assert.equal(creates.length, 8);
  assert.equal(rooms.find((room) => room.room_tag === 'research').created, false);
  assert.ok(creates.every((data) => data.agentConnectors._domain_home === true));
  assert.ok(creates.every((data) => data.participantIds.join(',') === 'b,a'));
  assert.match(creates[0].goal, /Acme/);
});

test('quota room count excludes permanent domain homes', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (sql, orgId) => {
      calls.push({ sql, orgId });
      return [{ count: 4 }];
    },
  };
  assert.equal(await countQuotaHyperRooms(prisma, 'org-1'), 4);
  assert.match(calls[0].sql, /NOT \(agent_connectors \? '_domain_home'\)/);
});

test('control plane exposes tenant-scoped domain backfill and permanent-room protection', () => {
  const source = fs.readFileSync(path.resolve('src/control-plane-server.js'), 'utf8');
  assert.match(source, /\/v1\/hyper\/domain-rooms\/ensure/);
  assert.match(source, /current\.session\.orgId/);
  assert.match(source, /DOMAIN_HOME_ROOM/);
  assert.match(source, /is_domain_home/);
});
