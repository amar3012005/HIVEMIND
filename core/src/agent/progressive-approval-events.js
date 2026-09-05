/** Project canonical PendingWrite terminal events into the originating run. */
const TERMINAL = new Set(['sent', 'failed', 'cancelled', 'expired']);

export async function reconcileProgressiveApproval({ prisma, draft } = {}) {
  if (draft?.toolArgs?._harness_version !== 'progressive-v1' || !TERMINAL.has(draft.status)) return { reconciled: false, reason: 'not_terminal_progressive_approval' };
  if (!draft.id || !draft.traceId || !draft.orgId || !draft.userId) return { reconciled: false, reason: 'scope_required' };
  if (!prisma?.agentRun?.findFirst || !prisma?.agentRun?.updateMany) return { reconciled: false, reason: 'storage_required' };
  const where = { id: draft.traceId, orgId: draft.orgId, userId: draft.userId };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const run = await prisma.agentRun.findFirst({ where });
    if (!run || run.id !== draft.traceId || run.orgId !== draft.orgId || run.userId !== draft.userId
      || run.scratch?.harness_version !== 'progressive-v1') return { reconciled: false, reason: 'run_not_found' };
    const scratch = run.scratch;
    const ids = Array.isArray(scratch.draft_ids) ? scratch.draft_ids : [];
    if (!ids.includes(draft.id)) return { reconciled: false, reason: 'draft_not_in_run' };
    const approvals = { ...(scratch.approvals || {}) };
    const prior = approvals[draft.id];
    // A canonical approval is terminal once settled; duplicate delivery is a no-op.
    const duplicate = prior?.status === draft.status;
    if (prior && !duplicate && TERMINAL.has(prior.status)) return { reconciled: false, reason: 'conflicting_terminal_receipt' };
    const receipt = { draft_id: draft.id, status: draft.status, source: 'pending_write',
      occurred_at: new Date(draft.sentAt || draft.approvedAt || draft.updatedAt || Date.now()).toISOString() };
    approvals[draft.id] = prior || receipt;
    const readReceipts = Array.isArray(scratch.read_results) ? scratch.read_results : [];
    const draftReceipts = Array.isArray(scratch.draft_receipts) ? scratch.draft_receipts : [];
    const covered = new Set([...readReceipts, ...draftReceipts].filter(r => r.successful === true).flatMap(r => r.outcome_ids || []));
    const outcomes = scratch.intent?.outcomes;
    const coveredAll = Array.isArray(outcomes) && outcomes.length > 0 && outcomes.every(o => covered.has(o.id));
    const allSent = ids.length > 0 && ids.every(id => approvals[id]?.status === 'sent');
    const failed = ids.some(id => ['failed', 'expired'].includes(approvals[id]?.status));
    const cancelled = ids.some(id => approvals[id]?.status === 'cancelled');
    // While execution owns the run, only append the receipt. Its next checkpoint
    // remains authoritative for execution state; never clear or replace its lease.
    const active = scratch.lease?.owner && scratch.lease.until > Date.now();
    const status = active ? run.status : failed ? 'failed' : cancelled ? 'cancelled'
      : coveredAll && allSent ? 'done' : run.status;
    if (duplicate && status === run.status) return { reconciled: true, duplicate: true, status };
    const nextScratch = { ...scratch, approvals, approval_receipts_complete: allSent,
      ...(status === 'done' ? { final_summary: 'All approved actions completed.' } : {}) };
    const steps = [...(Array.isArray(run.steps) ? run.steps : []), ...(duplicate ? [] : [{
      id: `approval:${draft.id}:${draft.status}`, at: receipt.occurred_at, kind: 'approval',
      status: draft.status, draft_id: draft.id, source: 'pending_write',
      summary: draft.status === 'sent' ? 'Approved action completed' : `Approval ${draft.status}`,
    }])];
    const updated = await prisma.agentRun.updateMany({ where: { ...where, updatedAt: run.updatedAt },
      data: { status, scratch: nextScratch, steps } });
    if (updated.count === 1) return { reconciled: true, duplicate, status };
  }
  return { reconciled: false, reason: 'concurrent_update_retry_required' };
}
