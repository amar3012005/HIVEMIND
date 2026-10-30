/**
 * Daily reconcile between Composio trigger instances and HIVEMIND trigger subscriptions.
 *
 * - A Composio trigger that backs no active subscription of an active membership is disabled on Composio (never deleted).
 * - An active subscription whose trigger is missing on Composio is re-created when its connected account is still
 *   ACTIVE; otherwise the subscription is marked `missing`, which every `status='active'` reader already excludes.
 * - An active subscription whose user row is gone or has no active membership in its org is marked `orphaned`.
 *
 * Dry run computes the same plan and changes nothing. Logs carry counts only, never ids, subjects or configs.
 */
import { triggerRequest } from './composio-service.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

/**
 * Read every enabled Composio trigger instance.
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} request - Composio v3.1 request function.
 * @returns {Promise<Array<{ id: string, connectedAccountId: string, slug: string }>>}
 */
export async function listComposioTriggers(request) {
  const triggers = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await request('GET', `/trigger_instances/active?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const item of items) {
      if (typeof item?.id !== 'string' || item.disabled_at) continue;
      triggers.push({ id: item.id, connectedAccountId: item.connected_account_id, slug: item.trigger_name });
    }
    cursor = result?.next_cursor;
    if (!cursor || !items.length) return triggers;
  }
  throw new Error('Composio trigger listing exceeded the page limit');
}

/**
 * Build the reconcile plan from both sides.
 * @param {Array<{ id: string }>} remote - Enabled Composio triggers.
 * @param {Array<{ id: string, remote_id: string | null, member_active: boolean }>} subscriptions - Active subscriptions with their membership state.
 * @returns {{ disable: string[], missing: Array<object>, orphaned: Array<object>, counts: Record<string, number> }}
 */
export function planTriggerReconcile(remote, subscriptions) {
  const owned = new Set(subscriptions.filter(row => row.member_active && row.remote_id).map(row => row.remote_id));
  const known = new Set(subscriptions.filter(row => row.remote_id).map(row => row.remote_id));
  const remoteIds = new Set(remote.map(trigger => trigger.id));
  const disable = remote.filter(trigger => !owned.has(trigger.id)).map(trigger => trigger.id);
  const missing = subscriptions.filter(row => row.member_active && (!row.remote_id || !remoteIds.has(row.remote_id)));
  const orphaned = subscriptions.filter(row => !row.member_active);
  return {
    disable,
    missing,
    orphaned,
    counts: {
      composioActive: remote.length,
      subscriptionsActive: subscriptions.length,
      subscriptionsInactiveMember: subscriptions.filter(row => !row.member_active).length,
      matched: remote.length - disable.length,
      unknownOnComposio: disable.length,
      unknownNotOurs: disable.filter(id => !known.has(id)).length,
      unknownInactiveMember: disable.filter(id => known.has(id)).length,
      missingOnComposio: missing.length,
    },
  };
}

/**
 * Reconcile once.
 * @param {object} db - Prisma client (raw queries only).
 * @param {{ dryRun?: boolean, request?: Function, log?: (line: string) => void }} [options]
 * @returns {Promise<Record<string, number | boolean>>} Counts of what was found and, unless dry run, changed.
 */
export async function reconcileComposioTriggers(db, { dryRun = true, request = triggerRequest, log = line => console.info(line) } = {}) {
  const remote = await listComposioTriggers(request);
  const subscriptions = await db.$queryRawUnsafe(`SELECT s.id, s.remote_id, s.account_id, s.slug, s.subject, s.toolkit, s.version, s.config,
      EXISTS (SELECT 1 FROM user_organizations uo WHERE uo.user_id::text = s.user_id AND uo.org_id::text = s.org_id AND uo.is_active) AS member_active
    FROM hivemind_trigger_subscriptions s WHERE s.status = 'active'`);
  const plan = planTriggerReconcile(remote, subscriptions);
  const counts = { dryRun, ...plan.counts, disabled: 0, disableFailed: 0, markedOrphaned: 0, recreated: 0, markedMissing: 0, recreateFailed: 0, accountActive: 0, accountGone: 0 };
  const accountActive = new Map();
  for (const row of plan.missing) {
    if (!accountActive.has(row.account_id)) {
      try {
        const account = await request('GET', `/connected_accounts/${encodeURIComponent(row.account_id)}`);
        accountActive.set(row.account_id, account?.status === 'ACTIVE');
      } catch (error) {
        if (error?.status !== 404) throw error;
        accountActive.set(row.account_id, false);
      }
    }
    if (accountActive.get(row.account_id)) counts.accountActive++; else counts.accountGone++;
  }
  if (!dryRun) {
    for (const id of plan.disable) {
      try { await request('PATCH', `/trigger_instances/manage/${encodeURIComponent(id)}`, { status: 'disable' }); counts.disabled++; }
      catch { counts.disableFailed++; }
    }
    for (const row of plan.orphaned) {
      counts.markedOrphaned += await db.$executeRawUnsafe("UPDATE hivemind_trigger_subscriptions SET status='orphaned', updated_at=now() WHERE id=$1::uuid AND status='active'", row.id);
    }
    for (const row of plan.missing) {
      if (!accountActive.get(row.account_id)) {
        await db.$executeRawUnsafe("UPDATE hivemind_trigger_subscriptions SET status='missing', updated_at=now() WHERE id=$1::uuid AND status='active'", row.id);
        counts.markedMissing++;
        continue;
      }
      try {
        const created = await request('POST', `/trigger_instances/${encodeURIComponent(row.slug)}/upsert`, {
          connected_account_id: row.account_id, user_id: row.subject, trigger_config: row.config, toolkit_versions: { [row.toolkit]: row.version },
        });
        if (typeof created?.trigger_id !== 'string') throw new Error('upsert returned no trigger id');
        await db.$executeRawUnsafe("UPDATE hivemind_trigger_subscriptions SET remote_id=$1, updated_at=now() WHERE id=$2::uuid AND status='active'", created.trigger_id, row.id);
        counts.recreated++;
      } catch { counts.recreateFailed++; }
    }
  }
  log(`[composio-trigger-reconcile] ${JSON.stringify(counts)}`);
  return counts;
}

/**
 * Reconcile mode from `COMPOSIO_TRIGGER_RECONCILE`: `off`, `dry-run` (default) or `apply`.
 * @param {Record<string, string | undefined>} env
 * @returns {'off' | 'dry-run' | 'apply'}
 */
export function triggerReconcileMode(env = process.env) {
  const value = (env.COMPOSIO_TRIGGER_RECONCILE || 'dry-run').trim().toLowerCase();
  if (value === 'off' || value === 'dry-run' || value === 'apply') return value;
  throw new Error(`COMPOSIO_TRIGGER_RECONCILE must be off, dry-run or apply, not "${value}"`);
}
