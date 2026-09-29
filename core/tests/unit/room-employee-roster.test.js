import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveAuthorizedRoomEmployeeRoster,
  resolveRoomEmployeeRoster,
} from '../../src/employees/room-employee-roster.js';

function prismaFixture({ room, employees = [], membership = { isActive: true } }) {
  const calls = { membership: null, room: null, employees: null };
  return {
    calls,
    userOrganization: {
      async findUnique(query) {
        calls.membership = query;
        return membership?.isActive ? membership : null;
      },
    },
    hyperRoom: {
      async findFirst(query) {
        calls.room = query;
        if (!room) return null;
        const where = query.where;
        return room.id === where.id && room.orgId === where.orgId && room.archivedAt === where.archivedAt
          ? room
          : null;
      },
    },
    digitalEmployee: {
      async findMany(query) {
        calls.employees = query;
        const where = query.where;
        return employees.filter((employee) => (
          where.id.in.includes(employee.id)
          && employee.orgId === where.orgId
          && employee.archivedAt === null
          && where.status.in.includes(employee.status)
        ));
      },
    },
  };
}

test('returns the admitted active lead and active specialists in room order', async () => {
  const orgId = 'org-a';
  const prisma = prismaFixture({
    room: { id: 'room-a', orgId, archivedAt: null, permanentLeadId: 'lead', participantIds: ['specialist', 'lead', 'specialist'] },
    employees: [
      { id: 'lead', orgId, archivedAt: null, status: 'draft', slug: 'lead', name: 'Lead', persona: 'owner', roleArchetype: 'Strategist' },
      { id: 'specialist', orgId, archivedAt: null, status: 'deploying', slug: 'specialist', name: 'Specialist', persona: 'bounded', roleArchetype: 'Researcher' },
    ],
  });

  const roster = await resolveRoomEmployeeRoster(prisma, { orgId, roomId: 'room-a' });

  assert.equal(roster.employee.id, 'lead');
  assert.deepEqual(roster.specialists.map((employee) => employee.id), ['specialist']);
  assert.equal(roster.source, 'room_permanent_lead');
  assert.deepEqual(prisma.calls.room.where, { id: 'room-a', orgId, archivedAt: null });
  assert.deepEqual(prisma.calls.employees.where, {
    id: { in: ['specialist', 'lead'] },
    orgId,
    archivedAt: null,
    status: { in: ['draft', 'running', 'deploying'] },
  });
});

test('rejects an off-roster lead and excludes paused, archived, and cross-org employees', async () => {
  const orgId = 'org-a';
  const base = { slug: 'employee', name: 'Employee', persona: 'persona', roleArchetype: 'Researcher' };
  const prisma = prismaFixture({
    room: { id: 'room-a', orgId, archivedAt: null, permanentLeadId: 'off-roster', participantIds: ['paused', 'archived', 'cross-org', 'active'] },
    employees: [
      { ...base, id: 'off-roster', orgId, archivedAt: null, status: 'running' },
      { ...base, id: 'paused', orgId, archivedAt: null, status: 'paused' },
      { ...base, id: 'archived', orgId, archivedAt: new Date(), status: 'running' },
      { ...base, id: 'cross-org', orgId: 'org-b', archivedAt: null, status: 'running' },
      { ...base, id: 'active', orgId, archivedAt: null, status: 'running' },
    ],
  });

  const roster = await resolveRoomEmployeeRoster(prisma, { orgId, roomId: 'room-a' });

  assert.equal(roster.employee.id, 'active');
  assert.deepEqual(roster.specialists, []);
  assert.equal(roster.source, 'room_active_participant');
  assert.ok(!prisma.calls.employees.where.id.in.includes('off-roster'));
});

test('does not expose a room from another organization', async () => {
  const prisma = prismaFixture({
    room: { id: 'room-a', orgId: 'org-b', archivedAt: null, permanentLeadId: 'lead', participantIds: ['lead'] },
  });

  const roster = await resolveRoomEmployeeRoster(prisma, { orgId: 'org-a', roomId: 'room-a' });

  assert.equal(roster, null);
  assert.equal(prisma.calls.employees, null);
});

test('rejects an inactive organization member before reading the room or employees', async () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const prisma = prismaFixture({
    membership: null,
    room: { id: 'room-a', orgId, archivedAt: null, permanentLeadId: 'lead', participantIds: ['lead'] },
  });

  const resolved = await resolveAuthorizedRoomEmployeeRoster(prisma, {
    orgId,
    userId,
    roomId: 'room-a',
  });

  assert.deepEqual(resolved, { authorized: false, roster: null });
  assert.deepEqual(prisma.calls.membership.where, { userId_orgId: { userId, orgId } });
  assert.equal(prisma.calls.room, null);
  assert.equal(prisma.calls.employees, null);
});
