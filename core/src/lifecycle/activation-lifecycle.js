import crypto from 'node:crypto';

export const ACTIVATION_STAGES = Object.freeze({
  INVITED_PENDING_SIGNUP: 'invited_pending_signup',
  SIGNED_IN_PENDING_COMPANY: 'signed_in_pending_company',
  ONBOARDING_IN_PROGRESS: 'onboarding_in_progress',
  DAY0_DELIVERED: 'day0_delivered',
  STOPPED: 'stopped',
});

const REMINDER_HOURS = Object.freeze({
  [ACTIVATION_STAGES.INVITED_PENDING_SIGNUP]: [24, 96, 240],
  [ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY]: [24, 96],
  [ACTIVATION_STAGES.ONBOARDING_IN_PROGRESS]: [24, 72],
});

export function isActivationLifecycleEnabled() {
  return process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED === 'true';
}

export function isAuthorizedActivationLifecycleRequest(req) {
  const expected = Buffer.from(String(process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET || ''));
  const token = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const actual = Buffer.from(token);
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function emailHash(email = '') {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

function emailHint(email = '') {
  const [local = '', domain = ''] = String(email).trim().toLowerCase().split('@');
  return `${local.slice(0, 2)}***@${domain}`.slice(0, 160);
}

function nextReminder(stage, reminderCount, now = new Date()) {
  const hours = REMINDER_HOURS[stage]?.[reminderCount];
  return hours === undefined ? null : new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export async function startInvitationActivation({ prisma, invite, metadata = {}, now = new Date() } = {}) {
  if (!isActivationLifecycleEnabled() || !prisma || !invite?.id || !invite?.email) return { skipped: true };
  const nextAt = nextReminder(ACTIVATION_STAGES.INVITED_PENDING_SIGNUP, 0, now);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hivemind.activation_lifecycles
       (invite_id, org_id, email_hash, email_hint, stage, next_reminder_at, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (invite_id) WHERE invite_id IS NOT NULL DO UPDATE
       SET metadata = hivemind.activation_lifecycles.metadata || EXCLUDED.metadata,
           updated_at = CURRENT_TIMESTAMP
     RETURNING id, generation, stage, next_reminder_at`,
    invite.id, invite.orgId, emailHash(invite.email), emailHint(invite.email),
    ACTIVATION_STAGES.INVITED_PENDING_SIGNUP, nextAt, JSON.stringify(metadata),
  );
  return rows?.[0] || null;
}

export async function advanceActivationForEmail({ prisma, email, userId = null, orgId = null, stage, reason, now = new Date() } = {}) {
  if (!isActivationLifecycleEnabled() || !prisma || !email || !stage) return { skipped: true };
  const firstNext = nextReminder(stage, 0, now);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.activation_lifecycles
        SET stage=$2, user_id=COALESCE($3::uuid, user_id), org_id=COALESCE($4::uuid, org_id),
            generation=generation+1, reminder_count=0, next_reminder_at=$5,
            stopped_at=CASE WHEN $2=$6 THEN CURRENT_TIMESTAMP ELSE NULL END,
            stop_reason=CASE WHEN $2=$6 THEN $7 ELSE NULL END,
            updated_at=CURRENT_TIMESTAMP
      WHERE email_hash=$1 AND stopped_at IS NULL
        AND stage <> $2
      RETURNING id, generation, stage, next_reminder_at`,
    emailHash(email), stage, userId, orgId, firstNext, ACTIVATION_STAGES.STOPPED, reason || null,
  );
  return rows || [];
}

export async function evaluateActivationReminder({ prisma, activationId, generation, now = new Date() } = {}) {
  if (!isActivationLifecycleEnabled()) return { status: 'paused' };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.org_id, a.user_id, a.email_hash, a.email_hint, a.stage, a.generation, a.reminder_count, a.next_reminder_at, a.delivery_lease_until, a.metadata,
            COALESCE(u.email, i.email) AS email
       FROM hivemind.activation_lifecycles a
       LEFT JOIN hivemind.users u ON u.id=a.user_id
       LEFT JOIN hivemind.org_invites i ON i.id=a.invite_id
      WHERE a.id=$1::uuid AND a.generation=$2 AND a.stopped_at IS NULL`, activationId, Number(generation),
  );
  const lifecycle = rows?.[0];
  if (!lifecycle) return { status: 'stale' };
  if (!lifecycle.next_reminder_at || new Date(lifecycle.next_reminder_at).getTime() > now.getTime()) return { status: 'not_due' };
  if (lifecycle.delivery_lease_until && new Date(lifecycle.delivery_lease_until).getTime() > now.getTime()) return { status: 'in_flight' };
  if (!REMINDER_HOURS[lifecycle.stage]?.[Number(lifecycle.reminder_count)]) return { status: 'complete' };
  return { status: 'due', lifecycle };
}

/** Atomically owns one outbound attempt; duplicate Workflow retries exit. */
export async function claimActivationReminder({ prisma, activationId, generation, now = new Date() } = {}) {
  const leaseUntil = new Date(now.getTime() + 15 * 60 * 1000);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.activation_lifecycles
        SET delivery_lease_until=$3, updated_at=CURRENT_TIMESTAMP
      WHERE id=$1::uuid AND generation=$2 AND stopped_at IS NULL
        AND next_reminder_at IS NOT NULL AND next_reminder_at <= $4
        AND (delivery_lease_until IS NULL OR delivery_lease_until <= $4)
      RETURNING id, org_id, user_id, stage, generation, reminder_count, next_reminder_at, metadata,
                (SELECT email FROM hivemind.users WHERE id=user_id) AS user_email,
                (SELECT email FROM hivemind.org_invites WHERE id=invite_id) AS invite_email`,
    activationId, Number(generation), leaseUntil, now,
  );
  const lifecycle = rows?.[0];
  if (!lifecycle) return null;
  return { ...lifecycle, email: lifecycle.user_email || lifecycle.invite_email || null };
}

export async function releaseActivationReminderClaim({ prisma, activationId, generation } = {}) {
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.activation_lifecycles SET delivery_lease_until=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=$1::uuid AND generation=$2`, activationId, Number(generation),
  );
}

export async function scheduleActivationWorkflow({ activation, fetchImpl = globalThis.fetch } = {}) {
  if (!isActivationLifecycleEnabled() || !activation?.id || !activation?.generation || !activation?.next_reminder_at) return { skipped: true };
  const base = String(process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET || '');
  if (!base || !secret) return { skipped: true, reason: 'workflow_not_configured' };
  const response = await fetchImpl(`${base}/start`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ activation_id: activation.id, generation: activation.generation, sequence: Number(activation.reminder_count || 0), target_at: new Date(activation.next_reminder_at).toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`activation_workflow_http_${response.status}`);
  return response.json().catch(() => ({ ok: true }));
}

export async function recordActivationReminder({ prisma, activationId, generation, delivery, now = new Date() } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.activation_lifecycles
        SET reminder_count=reminder_count+1, last_reminder_at=$3,
            next_reminder_at=CASE
              WHEN stage='invited_pending_signup' AND reminder_count+1=1 THEN $3 + interval '96 hours'
              WHEN stage='invited_pending_signup' AND reminder_count+1=2 THEN $3 + interval '240 hours'
              WHEN stage='signed_in_pending_company' AND reminder_count+1=1 THEN $3 + interval '96 hours'
              WHEN stage='onboarding_in_progress' AND reminder_count+1=1 THEN $3 + interval '72 hours'
              ELSE NULL END,
            delivery_lease_until=NULL, metadata=metadata || $4::jsonb, updated_at=CURRENT_TIMESTAMP
      WHERE id=$1::uuid AND generation=$2 AND stopped_at IS NULL
      RETURNING id, generation, stage, next_reminder_at, reminder_count`,
    activationId, Number(generation), now, JSON.stringify({ last_delivery: delivery || null }),
  );
  return rows?.[0] || null;
}

export function activationReminderCopy(stage, companyName = 'your company') {
  if (stage === ACTIVATION_STAGES.INVITED_PENDING_SIGNUP) return {
    subject: 'Your HIVEMIND invitation is waiting', heading: 'Your invitation is waiting.',
    body: 'Your private HIVEMIND invitation is ready when you are. Start your secure workspace and continue the journey.',
    cta: 'Accept your invitation', href: '/hivemind/invite', type: 'lifecycle.invitation.reminder',
  };
  if (stage === ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY) return {
    subject: 'It is time to awaken your AI company', heading: 'Your AI company is ready to awaken.',
    body: 'Add your company context and your HyperAgents can prepare the first moves for you.',
    cta: 'Awaken your HIVEMIND', href: '/hivemind/app/employees/mycompany?onboard=1', type: 'lifecycle.signup.reminder',
  };
  return {
    subject: `Finish awakening ${companyName}`, heading: 'Your HyperAgents need your company context.',
    body: 'Complete company onboarding to receive your Day 0 briefing and begin your lifecycle.',
    cta: 'Continue company setup', href: '/hivemind/app/employees/mycompany?onboard=1', type: 'lifecycle.onboarding.reminder',
  };
}
