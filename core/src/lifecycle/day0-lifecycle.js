import { advanceActivationForEmail, ACTIVATION_STAGES } from './activation-lifecycle.js';
import { isDayZeroLifecycleEnabled } from './day0-lifecycle-flag.js';

async function defaultStartReport(input) {
  return (await import('./day0-onboarding-report.js')).startDayZeroOnboardingReport(input);
}

async function defaultScheduleDayOne(input) {
  return (await import('./day1-first-move.js')).scheduleDayOneWorkflow(input);
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
    if (!dayOne.ok && !dayOne.skipped) {
      console.warn('[hyper-company] day-1 workflow scheduling failed:', dayOne.reason);
    }
    return result;
  });

  return { ...started, completion };
}
