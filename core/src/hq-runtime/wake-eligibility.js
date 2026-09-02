/**
 * A leased schedule is transport, not proof that there is still work to do.
 * New schedules carry a material cause. Before creating a cycle we re-check
 * the authoritative row that made that cause meaningful. Legacy schedules are
 * deliberately allowed through unchanged so rolling this out cannot strand
 * historical work.
 */
export async function evaluateHqScheduleEligibility({ prisma, schedule }) {
  const cause = schedule.material_cause_id || schedule.materialCauseId
    || schedule.payload?.wake_contract?.material_cause_id;
  if (!cause) return { eligible: true, reason: 'legacy_schedule' };
  const payload = schedule.payload || {};
  const contract = payload.wake_contract || {};
  if (schedule.trigger_type === 'instruction_updated' && payload.instruction_id) {
    const instruction = await prisma.hqInstruction.findUnique({
      where: { id: payload.instruction_id }, select: { status: true },
    });
    return instruction?.status === 'PENDING'
      ? { eligible: true, reason: 'instruction_pending' }
      : { eligible: false, reason: 'instruction_already_applied' };
  }
  if (contract.kind === 'deadline') {
    const run = await prisma.runtimePlaybookRun.findUnique({
      where: { id: contract.run_id }, select: { status: true, checkpointSequence: true, waitingFor: true },
    });
    const stillWaiting = run?.status === 'WAITING_EVENT'
      && Number(run?.checkpointSequence) === Number(contract.checkpoint_sequence)
      && String(run?.waitingFor?.deadline || '') === String(contract.deadline || '');
    return stillWaiting ? { eligible: true, reason: 'deadline_due' } : { eligible: false, reason: 'deadline_obsolete' };
  }
  if (contract.kind === 'lease_recovery') {
    const order = await prisma.hyperWorkOrder.findUnique({
      where: { id: contract.resource_id }, select: { status: true, leaseExpiresAt: true },
    });
    const expired = order?.leaseExpiresAt && new Date(order.leaseExpiresAt).getTime() <= Date.now();
    return expired ? { eligible: true, reason: 'lease_expired' } : { eligible: false, reason: 'lease_recovered' };
  }
  if (contract.kind === 'playbook_transition') {
    const run = await prisma.runtimePlaybookRun.findUnique({
      where: { id: contract.run_id }, select: { status: true, checkpointSequence: true },
    });
    const current = run && String(run.status) === String(contract.status)
      && Number(run.checkpointSequence) === Number(contract.checkpoint_sequence);
    return current ? { eligible: true, reason: 'playbook_transition_current' } : { eligible: false, reason: 'playbook_transition_obsolete' };
  }
  return { eligible: true, reason: 'material_cause_current' };
}
