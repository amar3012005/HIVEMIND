/**
 * Account erasure step for connected-app triggers: every Composio trigger that only this account's subscriptions use
 * is disabled on Composio (never deleted), then the account's subscriptions are marked `removed`.
 * A trigger another account still uses stays enabled. Composio failures throw, so the erasure blocks and retries.
 */
import { triggerRequest } from '../connectors/composio/composio-service.js';

/**
 * @param {object} prisma - Prisma client (raw queries only).
 * @param {string} userId - Account being erased.
 * @param {{ request?: (method: string, path: string, body?: unknown) => Promise<unknown> }} [options]
 * @returns {Promise<{ disabled: number, alreadyGone: number, sharedKept: number, removed: number }>}
 */
export async function eraseAccountTriggers(prisma, userId, { request = triggerRequest } = {}) {
  const rows = await prisma.$queryRawUnsafe("SELECT DISTINCT remote_id FROM hivemind_trigger_subscriptions WHERE user_id=$1 AND remote_id IS NOT NULL AND status NOT IN ('deleted','removed')", userId);
  const receipt = { disabled: 0, alreadyGone: 0, sharedKept: 0, removed: 0 };
  for (const { remote_id: remoteId } of rows) {
    const others = await prisma.$queryRawUnsafe("SELECT 1 FROM hivemind_trigger_subscriptions WHERE remote_id=$1 AND user_id<>$2 AND status='active' LIMIT 1", remoteId, userId);
    if (others.length) { receipt.sharedKept++; continue; }
    try {
      await request('PATCH', `/trigger_instances/manage/${encodeURIComponent(remoteId)}`, { status: 'disable' });
      receipt.disabled++;
    } catch (error) {
      if (error?.status !== 404) throw Object.assign(new Error('Connected-app trigger erasure unavailable'), { code: 'COMPOSIO_TRIGGER_ERASURE_UNAVAILABLE' });
      receipt.alreadyGone++;
    }
  }
  receipt.removed = await prisma.$executeRawUnsafe("UPDATE hivemind_trigger_subscriptions SET status='removed', updated_at=now() WHERE user_id=$1 AND status NOT IN ('deleted','removed')", userId);
  return receipt;
}
