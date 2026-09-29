import { getActiveOrganizationMembership } from '../workspace/access-policy.js';

// A room explicitly admits employees by participant ID. Newly created employees
// remain "draft" until the separate legacy sidecar deployment, but Cloudflare
// room turns can use their saved persona without that sidecar.
const RUNTIME_EMPLOYEE_STATUSES = Object.freeze(['draft', 'running', 'deploying']);

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value))];
}

function safeEmployee(employee) {
  return {
    id: employee.id,
    slug: employee.slug,
    name: employee.name,
    persona: String(employee.persona || '').slice(0, 6000),
    role: employee.roleArchetype || '',
    status: employee.status,
  };
}

/**
 * Resolve the runtime employee roster for an org-scoped, non-archived room.
 * Room participantIds are the only employee admission list; a stored lead
 * outside that list is never admitted.
 */
export async function resolveRoomEmployeeRoster(prisma, { orgId, roomId }) {
  const room = await prisma.hyperRoom.findFirst({
    where: { id: roomId, orgId, archivedAt: null },
    select: { permanentLeadId: true, participantIds: true },
  });
  if (!room) return null;

  const participantIds = uniqueIds(room.participantIds);
  if (participantIds.length === 0) {
    return { employee: null, specialists: [], source: 'room_active_participant' };
  }

  const rows = await prisma.digitalEmployee.findMany({
    where: {
      id: { in: participantIds },
      orgId,
      archivedAt: null,
      status: { in: [...RUNTIME_EMPLOYEE_STATUSES] },
    },
    select: { id: true, slug: true, name: true, persona: true, roleArchetype: true, status: true },
  });
  const byId = new Map(rows.map((employee) => [employee.id, employee]));
  const active = participantIds.map((id) => byId.get(id)).filter(Boolean);
  const storedLeadIsAdmitted = participantIds.includes(room.permanentLeadId) && byId.has(room.permanentLeadId);
  const owner = storedLeadIsAdmitted ? byId.get(room.permanentLeadId) : active[0] || null;

  return {
    employee: owner ? safeEmployee(owner) : null,
    specialists: active.filter((employee) => employee.id !== owner?.id).map(safeEmployee),
    source: storedLeadIsAdmitted ? 'room_permanent_lead' : 'room_active_participant',
  };
}

export async function resolveAuthorizedRoomEmployeeRoster(prisma, { orgId, userId, roomId }) {
  const membership = await getActiveOrganizationMembership(prisma, { orgId, userId });
  if (!membership) return { authorized: false, roster: null };
  return {
    authorized: true,
    roster: await resolveRoomEmployeeRoster(prisma, { orgId, roomId }),
  };
}

export { RUNTIME_EMPLOYEE_STATUSES };
