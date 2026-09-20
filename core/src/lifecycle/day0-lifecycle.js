import { advanceActivationForEmail, ACTIVATION_STAGES } from './activation-lifecycle.js';
import { isDayZeroLifecycleEnabled } from './day0-lifecycle-flag.js';

async function defaultStartReport(input) {
  return (await import('./day0-onboarding-report.js')).startDayZeroOnboardingReport(input);
}

async function defaultScheduleDayOne(input) {
  return (await import('./day1-first-move.js')).scheduleDayOneWorkflow(input);
}

export async function persistDayOneSchedule({ prisma, orgId, hqRoomId, schedule } = {}) {
  if (!prisma || !schedule?.ok || schedule?.admitted === false || !schedule?.target_at) {
    return { persisted: false, reason: 'schedule_not_admitted' };
  }
  const state = {
    version: 'day-1-first-move-v2',
    status: 'scheduled',
    target_at: schedule.target_at,
    workflow_instance_id: schedule.instance_id || schedule.workflow_instance_id || null,
    scheduled_at: new Date().toISOString(),
  };
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms"
        SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day1_first_move}', $1::jsonb, true)
      WHERE id = $2::uuid AND org_id = $3::uuid
        AND COALESCE("agent_connectors" #>> '{_company,day1_first_move,status}', '')
            NOT IN ('running','completed','sending','sent')`,
    JSON.stringify(state), hqRoomId, orgId,
  );
  return { persisted: Number(updated) > 0, state };
}

/**
 * Starts the Day-0 report and owns the post-delivery transition into Day 1.
 * The persistent Day-0 claim makes this safe for onboarding retries, tabs,
 * and dashboard fallback calls. Callers must not duplicate this continuation.
 */
export async function startDayZeroLifecycle({
  prisma,
  orgId,
  hqRoomId,
  userId,
  allowVersionedReissue = false,
  startReport = defaultStartReport,
  advanceActivation = advanceActivationForEmail,
  scheduleDayOne = defaultScheduleDayOne,
  isEnabled = isDayZeroLifecycleEnabled,
} = {}) {
  if (!await isEnabled({ orgId, userId })) {
    return { ok: true, accepted: false, skipped: true, reason: 'feature_disabled' };
  }

  const started = await startReport({
    prisma,
    orgId,
    hqRoomId,
    userId,
    allowVersionedReissue,
  });
  if (!started.accepted || started.reissue) return started;

  const completion = started.completion.then(async (result) => {
    const owner = await prisma.user.findUnique({
      where: { id: started.ownerId },
      select: { email: true },
    }).catch(() => null);
    if (owner?.email) {
      await advanceActivation({
        prisma,
        email: owner.email,
        userId: started.ownerId,
        orgId: started.orgId,
        stage: ACTIVATION_STAGES.DAY0_DELIVERED,
        reason: 'day0_delivered',
      });
    }
    const dayOne = await scheduleDayOne({
      orgId: started.orgId,
      hqRoomId: started.hqRoomId,
      onboardedAt: started.company.onboarded_at,
    });
    if (dayOne.ok) {
      await persistDayOneSchedule({
        prisma,
        orgId: started.orgId,
        hqRoomId: started.hqRoomId,
        schedule: dayOne,
      }).catch((error) => console.warn('[hyper-company] day-1 schedule receipt persistence failed:', error.message));
    }
    if (!dayOne.ok && !dayOne.skipped) {
      console.warn('[hyper-company] day-1 workflow scheduling failed:', dayOne.reason);
    }
    return result;
  });

  return { ...started, completion };
}
