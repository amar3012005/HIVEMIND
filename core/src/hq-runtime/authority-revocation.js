// Self-correction, v1 (2026-08-15): RuntimePlaybookAuthority already carries
// status/revokedAt fields, and the checkpoint-resolution read path already
// filters on { status: 'GRANTED', revokedAt: null } — but nothing in this
// codebase ever WRITES a revocation. Every existing write sets
// status: 'GRANTED' (grant or re-grant), never REVOKED. An approved-but-
// not-yet-executed authority could sit forever even after the context that
// justified it changed.
//
// Scoped narrowly for v1: a genuinely NEW user instruction is the one
// unambiguous "something changed" signal available today (unlike an
// autonomous research finding, which would need real LLM judgment on
// whether it materially contradicts a specific draft — deliberately NOT
// attempted here, to avoid guessing at "does this evidence matter" without
// real evaluation). Only authorities on runs that are still in flight are
// touched — a run that already reached COMPLETED/TERMINATED/FAILED means
// whatever it authorized already happened (or definitively didn't), and
// retroactively revoking would be meaningless or actively misleading.

const IN_FLIGHT_RUN_STATUSES_EXCLUDED = ['COMPLETED', 'TERMINATED', 'FAILED'];

export async function revokeAuthoritiesForNewInstruction({ prisma, runtime, instructionId, instructionBody }) {
  if (!prisma || !runtime?.orgId || !instructionId) return { revoked: [] };
  const candidates = await prisma.runtimePlaybookAuthority.findMany({
    where: {
      orgId: runtime.orgId,
      status: 'GRANTED',
      revokedAt: null,
      run: { status: { notIn: IN_FLIGHT_RUN_STATUSES_EXCLUDED } },
    },
    include: { run: { select: { id: true, playbookId: true, currentStageId: true, status: true } } },
  });
  const revoked = [];
  for (const authority of candidates) {
    const updated = await prisma.runtimePlaybookAuthority.updateMany({
      where: { id: authority.id, status: 'GRANTED', revokedAt: null },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        payload: {
          ...(authority.payload && typeof authority.payload === 'object' ? authority.payload : {}),
          revoked_reason: 'new_operating_instruction',
          revoked_by_instruction_id: instructionId,
        },
      },
    });
    if (updated.count === 1) revoked.push({
      id: authority.id, gate: authority.gate, runId: authority.runId,
      playbookId: authority.run?.playbookId || null, stageId: authority.run?.currentStageId || null,
    });
  }
  return { revoked, instructionBody: instructionBody || null };
}
