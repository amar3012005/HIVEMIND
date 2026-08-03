const RUNTIME_TURN_PREFIXES = ['hq-wo:', 'growth-plan:', 'runtime:'];

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
