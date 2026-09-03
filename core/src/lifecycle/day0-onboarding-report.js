import { sendRenderedSystemEmail } from '../email/email-service.js';
import { renderDayZeroOnboardingPdf } from '../email/day0-company-report-pdf.js';
import { DAY_ZERO_REPORT_VERSION, renderDayZeroOnboardingEmail, renderDayZeroOnboardingReportHtml } from '../email/templates/day0-company-onboarding.js';

const SENDING_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_APP_URL = 'https://next.singulancelabs.com/hivemind/app';

function parseCompany(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function previousReceipt(state = {}) {
  return {
    version: String(state.version || '').slice(0, 80) || null,
    sent_at: state.sent_at || null,
    message_id: state.message_id || null,
    provider: state.provider || null,
  };
}

function isActiveSendingLease(state = {}) {
  const claimedAt = Date.parse(state.claimed_at || '');
  return state.status === 'sending' && Number.isFinite(claimedAt) && Date.now() - claimedAt < SENDING_LEASE_MS;
}

/**
 * Claims one Day-0 delivery under PostgreSQL. A prior version may be reissued
 * exactly once by an authenticated lifecycle worker; refreshes and browser
 * callers continue to see the existing receipt.
 */
export async function startDayZeroOnboardingReport({
  prisma,
  orgId,
  hqRoomId,
  userId,
  allowVersionedReissue = false,
  renderPdf = renderDayZeroOnboardingPdf,
  sendEmail = sendRenderedSystemEmail,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, user_id, "agent_connectors"->'_company' AS company
       FROM "hivemind"."hyper_rooms"
      WHERE id = $1::uuid AND org_id = $2::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL
      LIMIT 1`,
    hqRoomId, orgId,
  );
  const row = rows?.[0];
  const company = parseCompany(row?.company);
  if (!row || !company) throw new Error('not_onboarded');
  if (userId && String(row.user_id) !== String(userId)) throw new Error('day0_report_owner_mismatch');

  const prior = company.day0_report_email || {};
  const reissue = Boolean(allowVersionedReissue && prior.status === 'sent' && prior.version !== DAY_ZERO_REPORT_VERSION);
  if (prior.status === 'sent' && !reissue) return { ok: true, accepted: false, status: 'sent', version: prior.version || null };
  if (isActiveSendingLease(prior)) return { ok: true, accepted: false, status: 'sending', version: prior.version || null };

  const claimedAt = new Date().toISOString();
  const claimState = {
    version: DAY_ZERO_REPORT_VERSION,
    status: 'sending',
    claimed_at: claimedAt,
    ...(reissue ? { reissued_from: previousReceipt(prior) } : {}),
  };
  const claimed = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms"
        SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day0_report_email}', $1::jsonb, true)
      WHERE id = $2::uuid AND org_id = $3::uuid
        AND (
          COALESCE("agent_connectors" #>> '{_company,day0_report_email,status}', '') NOT IN ('sending', 'sent')
          OR (
            "agent_connectors" #>> '{_company,day0_report_email,status}' = 'sending'
            AND COALESCE(("agent_connectors" #>> '{_company,day0_report_email,claimed_at}')::timestamptz, to_timestamp(0)) < now() - interval '10 minutes'
          )
          OR (
            $4::boolean = true
            AND "agent_connectors" #>> '{_company,day0_report_email,status}' = 'sent'
            AND COALESCE("agent_connectors" #>> '{_company,day0_report_email,version}', '') <> $5
          )
        )
      RETURNING id`,
    JSON.stringify(claimState), row.id, orgId, reissue, DAY_ZERO_REPORT_VERSION,
  );
  if (!claimed?.length) return { ok: true, accepted: false, status: 'sending' };

  const employees = await prisma.digitalEmployee.findMany({
    where: { orgId, archivedAt: null },
    select: { id: true, slug: true, name: true, avatarUrl: true, roleArchetype: true, persona: true },
    take: 12,
  }).catch(() => []);
  const dashboardCompany = {
    ...company,
    team: employees.map((employee) => ({
      id: employee.id,
      slug: employee.slug,
      name: employee.name,
      avatarUrl: employee.avatarUrl,
      roleArchetype: employee.roleArchetype || 'Communicator',
      persona: employee.persona,
    })),
  };
  const ownerId = userId || row.user_id;

  const completion = (async () => {
    try {
      const recipient = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true } });
      if (!recipient?.email) throw new Error('day0_report_recipient_missing');
      const appBase = String(process.env.HIVEMIND_APP_URL || DEFAULT_APP_URL).replace(/\/$/, '');
      const appUrl = appBase.endsWith('/employees/mycompany') ? appBase : `${appBase}/employees/mycompany`;
      const rendered = renderDayZeroOnboardingEmail(dashboardCompany, { appUrl });
      const print = renderDayZeroOnboardingReportHtml(dashboardCompany, { appUrl });
      const pdf = await renderPdf(print.html);
      const delivery = await sendEmail({
        templateId: 'day0_company_onboarding',
        to: recipient.email,
        rendered,
        attachments: [{ filename: `${dashboardCompany.company.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 72) || 'company'}-day-0-onboarding-report.pdf`, type: 'application/pdf', content: pdf }],
        notification: {
          orgId,
          userId: ownerId,
          type: 'lifecycle.email.sent',
          title: reissue ? `Your ${dashboardCompany.company} Day-0 report has been refreshed` : `Your ${dashboardCompany.company} Day-0 report is in your inbox`,
          body: reissue ? 'Your refreshed onboarding report is ready.' : 'Your onboarding report and new AI HyperAgents are ready.',
          resourceType: 'hyper_company',
          resourceId: `${row.id}:day0:${DAY_ZERO_REPORT_VERSION}`,
          href: appUrl,
          data: { lifecycle_day: 0, lifecycle_version: DAY_ZERO_REPORT_VERSION, reissue, company: dashboardCompany.company },
        },
      });
      if (!delivery.ok) throw new Error(`day0_report_delivery_${delivery.reason || 'failed'}`);
      const sentAt = new Date().toISOString();
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."hyper_rooms"
            SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day0_report_email}', $1::jsonb, true)
          WHERE id = $2::uuid AND org_id = $3::uuid`,
        JSON.stringify({ ...claimState, status: 'sent', sent_at: sentAt, provider: delivery.provider, delivery_status: delivery.deliveryStatus || 'accepted', message_id: delivery.messageId || null }),
        row.id, orgId,
      );
      return { ok: true, status: 'sent', version: DAY_ZERO_REPORT_VERSION, reissue, provider: delivery.provider, delivery_status: delivery.deliveryStatus || 'accepted' };
    } catch (error) {
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."hyper_rooms"
            SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day0_report_email}', $1::jsonb, true)
          WHERE id = $2::uuid AND org_id = $3::uuid`,
        JSON.stringify({ ...claimState, status: 'failed', failed_at: new Date().toISOString(), failure_reason: String(error.message || 'delivery_failed').slice(0, 240) }),
        row.id, orgId,
      ).catch(() => {});
      throw error;
    }
  })();

  return { ok: true, accepted: true, status: 'sending', reissue, completion, orgId, hqRoomId: row.id, ownerId, company: dashboardCompany };
}
