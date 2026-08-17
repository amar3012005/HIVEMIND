/**
 * Persona email thread for HQ Runtime (2026-08-17).
 *
 * One continuous email thread per runtime, written in Runtime's own first-
 * person voice, narrating: Day-0 activation, the first growth plan, and
 * every decision-required moment (the same events the Runtime terminal's
 * own POPUP=true classification uses — kept in sync deliberately, not
 * reinvented). Reuses core/src/email/email-service.js (Cloudflare Email
 * Sending, already configured in production) rather than a second send
 * path — real RFC 5322 threading via Message-ID/In-Reply-To/References,
 * persisted on the HqRuntime row so the SAME thread continues across every
 * wake, not a new email chain each time.
 *
 * Never throws, never blocks the caller — a failed/skipped email must never
 * break a real Runtime cycle.
 */
import { sendSystemEmail } from '../email/email-service.js';
import { createAuthorityApprovalToken } from './approval-links.js';

const APP_URL = process.env.HIVEMIND_APP_URL || 'https://next.singulancelabs.com/hivemind/app';
const APPROVAL_BASE_URL = process.env.HQ_RUNTIME_APPROVAL_BASE_URL || 'https://next.singulancelabs.com/hivemind/approve';
const PERSONA_NAME = process.env.HQ_RUNTIME_PERSONA_NAME || 'Runtime';

function personaCopy(kind, { orgName, title, summary }) {
  const org = orgName || 'your company';
  if (kind === 'activation') {
    return {
      subject: `${org} — I'm awake and getting to work`,
      heading: `Hi — I'm ${PERSONA_NAME}.`,
      body: `I just came online for ${org}. Before I touch anything, I'm reading everything I can find — your website, connected channels, campaigns, leads — so the first plan I build is grounded in what's actually true today, not a guess.\n\nI'll write back here as I go: when I've built the first operating plan, and any time I need your input before I can act. One thread, so you always have the whole story in one place.`,
    };
  }
  if (kind === 'growth_plan') {
    return {
      subject: `${org} — here's the plan I've built`,
      heading: `I've built our first operating plan.`,
      body: `${summary || title}\n\nI'm starting on the highest-leverage pieces now. Anything that needs your say-so before it goes external, I'll ask you right here.`,
    };
  }
  // 'popup' — approval_required / capability_required / decision_required
  return {
    subject: `${org} — I need something from you`,
    heading: title || 'I need your input to keep going.',
    body: summary || 'I\'ve reached a point where I want your decision before I act any further.',
  };
}

/**
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {object} args.runtime  the HqRuntime row (must include email* fields)
 * @param {'activation'|'growth_plan'|'popup'} args.kind
 * @param {string} [args.title]
 * @param {string} [args.summary]
 * @param {object} [args.details]  the raw hq_runtime_event.details — for an
 *   approval_required event this carries run_id/gate, which is enough to
 *   mint a one-click approval link (see approval-links.js). Any other
 *   popup shape (capability_required, decision_required) narrates without
 *   a button — there's nothing a link can safely approve for those yet.
 */
export async function notifyOwnerByEmail({ prisma, runtime, kind, title, summary, details }, {
  sendEmail = sendSystemEmail, mintApprovalToken = createAuthorityApprovalToken,
} = {}) {
  if (!prisma || !runtime) return { ok: false, skipped: true, error: 'missing_args' };
  if (runtime.emailUpdatesEnabled === false) return { ok: false, skipped: true, error: 'updates_disabled' };

  try {
    let to = runtime.emailThreadTo;
    if (!to) {
      const owner = await prisma.user.findUnique({ where: { id: runtime.ownerUserId }, select: { email: true } });
      to = owner?.email || null;
    }
    if (!to) return { ok: false, skipped: true, error: 'no_owner_email' };

    const org = await prisma.organization.findUnique({ where: { id: runtime.orgId }, select: { name: true } }).catch(() => null);
    const orgName = org?.name || null;

    const copy = personaCopy(kind, { orgName, title, summary });
    // The thread's own subject is fixed at the FIRST send and reused
    // unchanged for every later one — a consistent subject is what actually
    // makes mail clients group these as one thread, on top of the real
    // References/In-Reply-To headers.
    const subject = runtime.emailThreadSubject || copy.subject;

    let approveUrl = null;
    if (kind === 'popup' && details?.run_id && details?.gate) {
      const token = await mintApprovalToken({
        prisma, runtime, orgName, runId: details.run_id, gate: details.gate, title, summary,
      });
      if (token) approveUrl = `${APPROVAL_BASE_URL}/${token}`;
    }

    const result = await sendEmail({
      templateId: approveUrl ? 'runtime_persona_approval_update' : 'runtime_persona_update',
      to,
      vars: {
        subject,
        preheader: copy.heading,
        body: `${copy.heading}\n\n${copy.body}`,
        personaName: PERSONA_NAME,
        orgName: orgName || 'your company',
        appUrl: APP_URL,
        ...(approveUrl ? { approveUrl } : {}),
      },
      thread: runtime.emailThreadMessageId ? { inReplyTo: runtime.emailThreadMessageId } : undefined,
    });

    if (result.ok || result.messageId) {
      await prisma.hqRuntime.updateMany({
        where: { id: runtime.id, orgId: runtime.orgId },
        data: {
          emailThreadTo: to,
          emailThreadSubject: subject,
          // Keep referencing the ORIGINAL root message, not the most recent
          // one — a well-established simplified threading pattern that
          // still groups correctly and never loses the thread if one send's
          // provider response is missing a messageId.
          emailThreadMessageId: runtime.emailThreadMessageId || result.messageId || null,
          emailThreadSentCount: { increment: 1 },
          emailThreadLastSentAt: new Date(),
        },
      }).catch(() => {});
    }
    return result;
  } catch (error) {
    return { ok: false, error: error?.message || 'persona_email_failed' };
  }
}
