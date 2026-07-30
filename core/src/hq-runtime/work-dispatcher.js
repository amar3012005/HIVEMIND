import { appendHqEvent, scheduleHqWake } from './repository.js';
import { validateWorkResultPacket } from './contracts.js';

function internalKey() {
  return process.env.HIVEMIND_MASTER_API_KEY || process.env.HIVEMIND_API_KEY || '';
}

function sidecarUrl() {
  return process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
}

async function nextQueuedOrder(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT wo.id, wo.org_id, wo.hq_cycle_id, wo.growth_delegation_id,
           wo.title, rt.id AS runtime_id
      FROM hivemind.hyper_work_orders wo
      JOIN hivemind.hq_runtimes rt ON rt.org_id = wo.org_id
     WHERE wo.hq_cycle_id IS NOT NULL
       AND wo.status = 'queued'
       AND rt.state <> 'PAUSED'
     ORDER BY wo.created_at ASC
     LIMIT 1
  `);
  return rows[0] || null;
}

function resultPacket(body, status) {
  const result = body?.result || {};
  return validateWorkResultPacket({
    result,
    actions: [],
    metrics: {},
    cost: result.usage || {},
    failures: status === 'failed' ? [body?.error || 'specialist execution failed'] : [],
    blockers: status === 'blocked' ? [body?.error || 'specialist execution blocked'] : [],
    recommendation: status === 'completed' ? 'continue' : 'escalate',
    source_refs: Array.isArray(result.evidence) ? result.evidence : [],
  });
}

export async function dispatchNextHqWorkOrder({ prisma, logger = console } = {}) {
  const order = await nextQueuedOrder(prisma);
  if (!order) return null;
  const key = internalKey();
  if (!key) throw new Error('hq_dispatch_internal_key_missing');

  let response;
  let body;
  try {
    response = await fetch(`${sidecarUrl()}/internal/hq/work-order/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ work_order_id: order.id, org_id: order.org_id }),
      signal: AbortSignal.timeout(180000),
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    // The sidecar claims before model execution. A transport timeout is therefore
    // ambiguous and must be reconciled from the durable Work Order, not replayed.
    logger.warn('[hq-runtime] specialist dispatch transport outcome is ambiguous:', error.message);
    return { workOrderId: order.id, status: 'AMBIGUOUS', error: error.message };
  }

  if (!response.ok && !body.status) {
    throw new Error(`hq_dispatch_sidecar_http_${response.status}`);
  }

  if (response.status === 409 || body.status === 'already_claimed') {
    return { workOrderId: order.id, status: 'ALREADY_CLAIMED' };
  }
  const status = String(body.status || (response.ok ? 'completed' : 'failed')).toLowerCase();
  if (!['completed', 'blocked', 'failed'].includes(status)) {
    logger.warn('[hq-runtime] specialist returned non-terminal status:', status);
    return { workOrderId: order.id, status: status.toUpperCase() };
  }

  const packet = resultPacket(body, status);
  if (order.growth_delegation_id) {
    await prisma.growthDelegation.updateMany({
      where: { id: order.growth_delegation_id, orgId: order.org_id },
      data: {
        status: status === 'completed' ? 'COMPLETED' : status.toUpperCase(),
        result: packet,
        completedAt: new Date(),
      },
    });
  }
  await appendHqEvent({
    prisma, runtimeId: order.runtime_id, orgId: order.org_id,
    eventType: status === 'completed' ? 'work_order_completed' : 'blocked',
    title: status === 'completed' ? `Specialist result returned: ${order.title}` : `Specialist work ${status}: ${order.title}`,
    summary: String(body?.result?.text || body?.error || status).slice(0, 1200),
    details: { status, packet }, workOrderId: order.id,
  });
  await scheduleHqWake({
    prisma, runtimeId: order.runtime_id, orgId: order.org_id,
    idempotencyKey: `work-result:${order.id}`,
    triggerType: 'work_result', dueAt: new Date(),
    payload: { work_order_id: order.id, status },
  });
  return { workOrderId: order.id, status: status.toUpperCase() };
}
