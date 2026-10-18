import { isDraftOnlyTool } from './runtime-adapter.js';

/** A saved mail draft is a reversible write, not permission to send it.
 * Reuse the pending-write receipt/idempotency store without fabricating a
 * human approval. An uncertain provider outcome is never automatically retried.
 */
export async function executeDraftOnly({ prisma, row, orgId, userId, execute }) {
  if (!row || row.orgId !== orgId || row.userId !== userId || row.provider !== 'composio'
    || !isDraftOnlyTool(row.toolName)) throw new Error('draft_only_scope_denied');
  const receipt = { provider: 'composio', toolSlug: row.toolName, operationId: row.id, policy: 'draft-only-no-send' };
  if (row.status === 'sent') return { status: 'completed', data: row.result, receipt, replayed: true };
  if (row.status !== 'draft') return { status: 'reconciliation_required', receipt };
  const claimed = await prisma.pendingWrite.updateMany({
    where: { id: row.id, orgId, userId, status: 'draft', argsHash: row.argsHash, expiresAt: { gt: new Date() } },
    data: { status: 'executing' },
  });
  if (claimed.count !== 1) return { status: 'reconciliation_required', receipt };
  try {
    const result = await execute();
    if (result?.successful !== true) {
      await prisma.pendingWrite.update({ where: { id: row.id }, data: { status: 'unknown', errorMsg: 'Draft outcome requires provider reconciliation; do not retry automatically.' } });
      return { status: 'reconciliation_required', receipt };
    }
    await prisma.pendingWrite.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date(), result: result.data ?? {}, errorMsg: null } });
    return { status: 'completed', data: result.data, receipt };
  } catch {
    await prisma.pendingWrite.update({ where: { id: row.id }, data: { status: 'unknown', errorMsg: 'Draft outcome unconfirmed; inspect provider before retry.' } }).catch(() => {});
    return { status: 'reconciliation_required', receipt };
  }
}
