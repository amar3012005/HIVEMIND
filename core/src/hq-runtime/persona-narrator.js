/**
 * Persona email notifications for HQ Runtime (2026-08-17, revised).
 *
 * Each narrated moment (Day-0 activation, first growth plan, every decision-
 * required popup — the same events the Runtime terminal's own POPUP=true
 * classification uses, kept in sync deliberately, not reinvented) is sent as
 * its OWN independent email with its own subject line — NOT threaded into
 * one chain. A fresh, varied subject per send reads like a real running
 * update stream (and avoids every email looking identical in an inbox list),
 * rather than one growing thread. Reuses core/src/email/email-service.js
 * (Cloudflare Email Sending, already configured in production) rather than a
 * second send path.
 *
 * Sent from Runtime's own persona address (runtime@admin.singulancelabs.com
 * by default), rendered on Runtime's dedicated dark theme (see email-service
 * `runtime_dark` layout) — text directly on a full-bleed dark background, no
 * light card/box shell.
 *
 * Never throws, never blocks the caller — a failed/skipped email must never
 * break a real Runtime cycle.
 */
import { sendSystemEmail } from '../email/email-service.js';
import { createAuthorityApprovalToken } from './approval-links.js';

const APP_URL = process.env.HIVEMIND_APP_URL || 'https://next.singulancelabs.com/hivemind/app';
const APPROVAL_BASE_URL = process.env.HQ_RUNTIME_APPROVAL_BASE_URL || 'https://next.singulancelabs.com/hivemind/approve';
const PERSONA_NAME = process.env.HQ_RUNTIME_PERSONA_NAME || 'Runtime';
const RUNTIME_EMAIL_FROM = process.env.RUNTIME_EMAIL_FROM || 'Runtime <runtime@admin.singulancelabs.com>';

function pick(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

/** A short, inbox-safe excerpt of a task title/summary for use inside a subject line. */
function excerpt(text, max = 60) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function craftSubject(kind, { orgName, title, summary }) {
  const org = orgName || 'your company';
  if (kind === 'activation') {
    return pick([
      `${org} — I'm awake and getting to work`,
      `${org}: Runtime just started its first shift`,
      `Starting up for ${org}`,
    ]);
  }
  if (kind === 'growth_plan') {
    const what = excerpt(title || summary);
    return pick([
      `${org} — here's the plan I've built`,
      `${org}: our first operating plan is ready`,
      what ? `${org}: I've built our plan around "${what}"` : `${org}: first operating plan drafted`,
    ]);
  }
  // 'popup' — approval_required / capability_required / decision_required
  const what = excerpt(title || summary);
  return pick([
    what ? `${org}: I need your OK — ${what}` : `${org}: I need something from you`,
    what ? `${org} needs a decision: ${what}` : `${org}: waiting on your input`,
    what ? `Action needed for ${org}: ${what}` : `${org}: I'm blocked until you weigh in`,
  ]);
}

function personaLabel(kind) {
  if (kind === 'activation') return 'ACTIVATION';
  if (kind === 'growth_plan') return 'GROWTH PLAN';
  return 'ACTION NEEDED';
}

function personaCopy(kind, { orgName, title, summary }) {
  const org = orgName || 'your company';
  if (kind === 'activation') {
    return {
      heading: `Hi — I'm ${PERSONA_NAME}.`,
      body: `I just came online for ${org}. Before I touch anything, I'm reading everything I can find — your website, connected channels, campaigns, leads — so the first plan I build is grounded in what's actually true today, not a guess.\n\nI'll email you as I go: when I've built the first operating plan, and any time I need your input before I can act.`,
    };
  }
  if (kind === 'growth_plan') {
    return {
      heading: `I've built our first operating plan.`,
      body: `${summary || title}\n\nI'm starting on the highest-leverage pieces now. Anything that needs your say-so before it goes external, I'll email you about it directly.`,
    };
  }
  // 'popup' — approval_required / capability_required / decision_required
  return {
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
    // Every send gets its own fresh, varied subject — these are deliberately
    // INDEPENDENT emails, not one growing thread, so no root subject/message
    // is reused or referenced here.
    const subject = craftSubject(kind, { orgName, title, summary });

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
      from: RUNTIME_EMAIL_FROM,
      vars: {
        subject,
        label: personaLabel(kind),
        preheader: copy.heading,
        heading: copy.heading,
        body: copy.body,
        personaName: PERSONA_NAME,
        orgName: orgName || 'your company',
        appUrl: APP_URL,
        ...(approveUrl ? { approveUrl } : {}),
      },
    });

    if (result.ok || result.messageId) {
      await prisma.hqRuntime.updateMany({
        where: { id: runtime.id, orgId: runtime.orgId },
        data: {
          emailThreadTo: to,
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
