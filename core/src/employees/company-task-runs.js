const RUNTIME_TURN_PREFIXES = ['hq-wo:', 'growth-plan:', 'runtime:'];

const COMPANY_TASK_ROOM_TYPES = new Set([
  'general',
  'seo',
  'marketing',
  'outreach',
  'campaign',
  'branding',
  'fundraising',
  'research',
  'product',
  'design',
  'legal_finance',
]);

const COMPANY_TASK_ROOM_NAMES = new Map([
  ['company hq', 'general'],
  ['general', 'general'],
  ['seo', 'seo'],
  ['marketing', 'marketing'],
  ['outreach intelligence', 'outreach'],
  ['outreach', 'outreach'],
  ['campaign intelligence', 'campaign'],
  ['campaign', 'campaign'],
  ['branding', 'branding'],
  ['fundraising', 'fundraising'],
  ['research', 'research'],
  ['product', 'product'],
  ['design', 'design'],
  ['legal & finance', 'legal_finance'],
  ['legal and finance', 'legal_finance'],
  ['legal finance', 'legal_finance'],
]);

export function resolveCompanyTaskRoomType(task = {}) {
  const candidate = String(task.room_tag || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const roomName = String(task.room_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const recovered = COMPANY_TASK_ROOM_NAMES.get(roomName);
  // A prior release overwrote clicked specialist tasks with room_tag=general.
  // Their immutable onboarding room_name remains available for safe recovery.
  if (candidate === 'general' && recovered && recovered !== 'general') return recovered;
  if (COMPANY_TASK_ROOM_TYPES.has(candidate)) return candidate;
  return recovered || 'general';
}

export function buildCompanyTaskContext(company = {}) {
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  const lines = [
    ['Company', company.company || company.name],
    ['Website', company.website],
    ['Location', company.company_location || profile.location],
    ['Mission', company.mission],
    ['What it does', profile.what_it_does],
    ['ICP', profile.icp],
    ['Offer', profile.offer],
    ['Positioning', profile.positioning],
    ['Operating context', company.company_context],
  ].filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => `${label}: ${String(value).trim()}`);
  const gaps = Array.isArray(profile.evidence_gaps)
    ? profile.evidence_gaps.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (gaps.length) lines.push(`Known evidence gaps: ${gaps.join('; ')}`);
  return lines.join('\n').slice(0, 12000);
}

export function buildCompanyTaskInstruction(task = {}) {
  return [
    String(task.title || '').trim(),
    String(task.detail || '').trim(),
    task.deliverable ? `Expected deliverable: ${String(task.deliverable).trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

function isDirectHumanTurn(turn, runtimeOwnedTurnIds) {
  if (!turn?.id || turn.runtimePlaybookRunId || runtimeOwnedTurnIds.has(turn.id)) return false;
  return !RUNTIME_TURN_PREFIXES.some((prefix) => String(turn.idempotencyKey || '').startsWith(prefix));
}

export async function clearHumanAgentRoomRuns({ prisma, orgId }) {
  if (!prisma || !orgId) throw new Error('agent_room_runs_org_required');

  return prisma.$transaction(async (tx) => {
    const rooms = await tx.hyperRoom.findMany({
      where: { orgId, archivedAt: null },
      select: { id: true },
    });
    const roomIds = rooms.map((room) => room.id);
    if (!roomIds.length) return { turns: 0, work_orders: 0, work_results: 0, activity: 0 };

    const [turns, runtimeOrders] = await Promise.all([
      tx.hyperTurn.findMany({
        where: { roomId: { in: roomIds } },
        select: { id: true, idempotencyKey: true, runtimePlaybookRunId: true },
      }),
      tx.hyperWorkOrder.findMany({
        where: {
          orgId,
          roomId: { in: roomIds },
          OR: [{ hqCycleId: { not: null } }, { runtimeEpoch: { not: null } }],
        },
        select: { turnId: true },
      }),
    ]);
    const runtimeOwnedTurnIds = new Set(runtimeOrders.map((row) => row.turnId).filter(Boolean));
    const turnIds = turns.filter((turn) => isDirectHumanTurn(turn, runtimeOwnedTurnIds)).map((turn) => turn.id);

    const workOrders = await tx.hyperWorkOrder.findMany({
      where: {
        orgId,
        roomId: { in: roomIds },
        hqCycleId: null,
        runtimeEpoch: null,
        OR: [
          ...(turnIds.length ? [{ turnId: { in: turnIds } }] : []),
          { turnId: null },
        ],
      },
      select: { id: true },
    });
    const workOrderIds = workOrders.map((order) => order.id);
    const deletedResults = workOrderIds.length
      ? await tx.hyperWorkResult.deleteMany({ where: { workOrderId: { in: workOrderIds } } })
      : { count: 0 };
    const deletedOrders = workOrderIds.length
      ? await tx.hyperWorkOrder.deleteMany({ where: { id: { in: workOrderIds } } })
      : { count: 0 };

    let activityCount = 0;
    if (turnIds.length) {
      const placeholders = turnIds.map((_, index) => `$${index + 2}::uuid`).join(', ');
      const activity = await tx.$executeRawUnsafe(
        `DELETE FROM "hivemind"."hq_activity"
          WHERE org_id = $1::uuid AND turn_id IN (${placeholders})`,
        orgId,
        ...turnIds,
      ).catch(() => 0);
      activityCount = Number(activity || 0);
    }
    const deletedTurns = turnIds.length
      ? await tx.hyperTurn.deleteMany({ where: { id: { in: turnIds } } })
      : { count: 0 };

    return {
      turns: deletedTurns.count,
      work_orders: deletedOrders.count,
      work_results: deletedResults.count,
      activity: activityCount,
    };
  }, { timeout: 15000, maxWait: 8000 });
}
