import { createWorkspaceNotification } from './notifications.js';

const STATUSES = new Set(['draft', 'scheduled', 'published', 'paused', 'archived']);
const PLACEMENTS = new Set(['toast', 'dialog', 'reader', 'banner']);
const MAX_FACTS = 6;

function text(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function list(value, limit = 200) { return Array.isArray(value) ? [...new Set(value.map((item) => text(String(item), limit)).filter(Boolean))] : []; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function timestamp(value) { if (!value) return null; const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
function allowedHref(value) {
  const href = text(value, 1000);
  if (!href) return null;
  if (href.startsWith('/hivemind/')) return href;
  try { const url = new URL(href); return ['https:'].includes(url.protocol) && ['cal.com', 'www.cal.com', 'next.singulancelabs.com'].includes(url.hostname) ? url.href : null; } catch { return null; }
}

export function normalizeAnnouncementInput(input = {}, { existing = null, operator = null } = {}) {
  const content = object(input.content ?? existing?.content);
  const facts = Array.isArray(content.facts) ? content.facts.slice(0, MAX_FACTS).map((fact) => ({ label: text(fact?.label, 48), value: text(fact?.value, 280) })).filter((fact) => fact.label && fact.value) : [];
  const agents = list(content.agent_ids, 80).slice(0, 8);
  const cta = object(content.cta);
  const audience = object(input.audience ?? existing?.audience);
  const audienceKind = text(audience.kind || 'all', 32);
  if (!['all', 'targeted'].includes(audienceKind)) throw new Error('announcement audience kind is invalid');
  const startsAt = timestamp(input.starts_at ?? input.startsAt ?? existing?.startsAt);
  const endsAt = timestamp(input.ends_at ?? input.endsAt ?? existing?.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error('announcement end must be after start');
  const status = text(input.status ?? existing?.status ?? 'draft', 24);
  const placement = text(input.placement ?? existing?.placement ?? 'toast', 24);
  if (!STATUSES.has(status)) throw new Error('announcement status is invalid');
  if (!PLACEMENTS.has(placement)) throw new Error('announcement placement is invalid');
  const key = text(input.key ?? existing?.key, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(key)) throw new Error('announcement key must use lowercase letters, numbers, dots, underscores, or hyphens');
  const title = text(input.title ?? existing?.title, 180);
  if (!title) throw new Error('announcement title is required');
  const primaryHref = allowedHref(cta.href);
  if (cta.href && !primaryHref) throw new Error('announcement CTA destination is not allowed');
  return {
    key, status, placement, priority: Math.max(-100, Math.min(100, Number(input.priority ?? existing?.priority ?? 0) || 0)), title,
    body: text(input.body ?? existing?.body, 1000) || null,
    content: {
      eyebrow: text(content.eyebrow, 80) || null,
      facts,
      agent_ids: agents,
      artifact: object(content.artifact),
      cta: primaryHref ? { label: text(cta.label, 80) || 'Open update', href: primaryHref } : null,
    },
    audience: {
      kind: audienceKind,
      org_ids: list(audience.org_ids, 36),
      user_ids: list(audience.user_ids, 36),
      plans: list(audience.plans, 50),
      account_types: list(audience.account_types, 50),
      lifecycle_days: Array.isArray(audience.lifecycle_days) ? audience.lifecycle_days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 30) : [],
    },
    requiresNotification: input.requires_notification ?? input.requiresNotification ?? existing?.requiresNotification ?? true,
    startsAt, endsAt, ...(operator && !existing ? { createdBy: operator } : {}),
  };
}

function audienceMatches(audience, { orgId, userId, plan, accountType, lifecycleDay }) {
  const target = object(audience);
  if (target.kind === 'all') return true;
  const includesOrEmpty = (values, value) => !values?.length || values.includes(value);
  return includesOrEmpty(target.org_ids, orgId)
    && includesOrEmpty(target.user_ids, userId)
    && includesOrEmpty(target.plans, plan)
    && includesOrEmpty(target.account_types, accountType)
    && includesOrEmpty(target.lifecycle_days, lifecycleDay);
}

async function userContext(prisma, { orgId, userId }) {
  const membership = await prisma.userOrganization.findFirst({ where: { orgId, userId, isActive: true }, select: { org: { select: { plan: true, accountType: true } } } });
  if (!membership?.org) return null;
  const room = await prisma.hyperRoom.findFirst({ where: { orgId, userId, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { agentConnectors: true } }).catch(() => null);
  const lifecycleDay = room?.agentConnectors?._company?.day2_brand_dna?.status === 'sent' ? 2
    : room?.agentConnectors?._company?.day1_first_move?.status === 'sent' ? 1
      : room?.agentConnectors?._company?.day0_report_email?.status === 'sent' ? 0 : null;
  return { plan: String(membership.org.plan || 'free'), accountType: String(membership.org.accountType || 'personal'), lifecycleDay };
}

function publicAnnouncement(row, delivery) {
  return {
    id: row.id, key: row.key, version: row.version, placement: row.placement, priority: row.priority,
    title: row.title, body: row.body, content: row.content, starts_at: row.startsAt, ends_at: row.endsAt,
    delivery: delivery ? { id: delivery.id, notification_id: delivery.notificationId, first_seen_at: delivery.firstSeenAt, dismissed_at: delivery.dismissedAt, actioned_at: delivery.actionedAt } : null,
  };
}

/** Return one eligible popup only. The notification is persisted before delivery. */
export async function nextWorkspaceAnnouncement({ prisma, orgId, userId, now = new Date() } = {}) {
  if (!prisma?.workspaceAnnouncement || !prisma?.workspaceAnnouncementDelivery) return null;
  const context = await userContext(prisma, { orgId, userId });
  if (!context) return null;
  const rows = await prisma.workspaceAnnouncement.findMany({
    where: { status: { in: ['published', 'scheduled'] }, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
    orderBy: [{ priority: 'desc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }], take: 30,
  });
  for (const row of rows) {
    if (!audienceMatches(row.audience, { orgId, userId, ...context })) continue;
    let delivery = await prisma.workspaceAnnouncementDelivery.findUnique({ where: { announcementId_orgId_userId: { announcementId: row.id, orgId, userId } } });
    // A workspace update is a one-time interruption. Its durable notification
    // remains available in the inbox after the person dismisses it or follows
    // its CTA, but neither action should surface the popup again on refresh.
    if (delivery?.dismissedAt || delivery?.actionedAt) continue;
    let notificationId = delivery?.notificationId || null;
    if (row.requiresNotification && !notificationId) {
      const notice = await createWorkspaceNotification(prisma, {
        orgId, userId, type: 'announcement.published', title: row.title, body: row.body,
        resourceType: 'workspace_announcement', resourceId: row.id,
        dedupeKey: `announcement:${row.id}:v${row.version}`,
        data: { announcement_id: row.id, announcement_key: row.key, announcement_version: row.version, placement: row.placement, ...(row.content?.cta?.href ? { href: row.content.cta.href } : {}) },
      });
      notificationId = notice?.id || null;
    }
    delivery = await prisma.workspaceAnnouncementDelivery.upsert({
      where: { announcementId_orgId_userId: { announcementId: row.id, orgId, userId } },
      create: { announcementId: row.id, orgId, userId, notificationId, firstSeenAt: now },
      update: { notificationId: notificationId || undefined, firstSeenAt: delivery?.firstSeenAt || now },
    });
    return publicAnnouncement(row, delivery);
  }
  return null;
}

export async function recordWorkspaceAnnouncementDelivery({ prisma, announcementId, orgId, userId, event } = {}) {
  if (!['dismiss', 'action', 'impression'].includes(event)) throw new Error('announcement event is invalid');
  const delivery = await prisma.workspaceAnnouncementDelivery.findUnique({ where: { announcementId_orgId_userId: { announcementId, orgId, userId } } });
  if (!delivery) throw new Error('announcement delivery not found');
  const data = event === 'dismiss' ? { dismissedAt: new Date() } : event === 'action' ? { actionedAt: new Date() } : { firstSeenAt: delivery.firstSeenAt || new Date() };
  return prisma.workspaceAnnouncementDelivery.update({ where: { id: delivery.id }, data });
}

export async function announcementMetrics(prisma, announcementId) {
  const [deliveries, impressions, dismissals, actions] = await Promise.all([
    prisma.workspaceAnnouncementDelivery.count({ where: { announcementId } }),
    prisma.workspaceAnnouncementDelivery.count({ where: { announcementId, firstSeenAt: { not: null } } }),
    prisma.workspaceAnnouncementDelivery.count({ where: { announcementId, dismissedAt: { not: null } } }),
    prisma.workspaceAnnouncementDelivery.count({ where: { announcementId, actionedAt: { not: null } } }),
  ]);
  return { deliveries, impressions, dismissals, actions };
}

export function announcementForAdmin(row, metrics = null) {
  return { id: row.id, key: row.key, version: row.version, status: row.status, placement: row.placement, priority: row.priority, title: row.title, body: row.body, content: row.content, audience: row.audience, requires_notification: row.requiresNotification, starts_at: row.startsAt, ends_at: row.endsAt, created_at: row.createdAt, updated_at: row.updatedAt, published_at: row.publishedAt, metrics };
}
