import crypto from 'crypto';

import { getPlan } from './plans.js';
import { digestPromotionValue, normalizeAccountProfile, promotionCodeHint } from './promotion-service.js';

export const DEFAULT_ENTERPRISE_INVITATION_DAYS = 14;
export const DEFAULT_ENTERPRISE_ONBOARDING_DAYS = 14;

const ACTIVE_STATUSES = new Set(['draft', 'sent']);
const INVITATION_STATUSES = new Set(['draft', 'sent', 'redeeming', 'redeemed', 'expired', 'revoked']);

function normalizedEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('recipient email is invalid');
  return email;
}

function emailHint(email) {
  return email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2');
}

function invitationDigest(namespace, value) {
  return digestPromotionValue(`enterprise-invitation:${namespace}:${String(value || '').trim()}`);
}

export function normalizeEnterpriseInvitationCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

export function generateEnterpriseInvitationCode() {
  return `HM-${crypto.randomBytes(9).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 12).toUpperCase()}`;
}

export function generateEnterpriseInvitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function enterpriseInvitationCodeDigest(value) {
  return invitationDigest('code', normalizeEnterpriseInvitationCode(value));
}

export function enterpriseInvitationTokenDigest(value) {
  return invitationDigest('link', value);
}

export function enterpriseInvitationEmailDigest(value) {
  return invitationDigest('email', normalizedEmail(value));
}

const MAX_ENTERPRISE_ONBOARDING_INVITES = 10_000;

export function normalizeEnterpriseOnboardingMaxInvites(value, { defaultValue = 0 } = {}) {
  if (value == null || value === '') return defaultValue;
  const maxInvites = Number(value);
  if (!Number.isSafeInteger(maxInvites) || maxInvites < 0 || maxInvites > MAX_ENTERPRISE_ONBOARDING_INVITES) {
    throw new Error(`max_invites must be a whole number between 0 and ${MAX_ENTERPRISE_ONBOARDING_INVITES}`);
  }
  return maxInvites;
}

export function enterpriseOnboardingLimits(maxInvites = 0) {
  // Clone so an invitation remains an immutable snapshot while its active
  // entitlement is Scale-equivalent, never an accidental unlimited Enterprise
  // allocation. maxUsers includes the owner; the admin-facing max_invites
  // value is therefore intentionally one less than this entitlement cap.
  return { ...getPlan('enterprise_onboarding').limits, maxUsers: maxInvites + 1 };
}

function asFutureDate(value, fallbackDays, now) {
  if (value == null || value === '') return new Date(now.getTime() + fallbackDays * 24 * 60 * 60 * 1000);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date <= now) throw new Error('invitation expiry must be in the future');
  return date;
}

function onboardingDays(value) {
  if (value == null || value === '') return DEFAULT_ENTERPRISE_ONBOARDING_DAYS;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('onboarding_days must be between 1 and 90');
  return days;
}

function text(value, max) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, max) : null;
}

export function normalizeEnterpriseInvitationInput(input = {}, now = new Date()) {
  const companyName = text(input.company_name || input.companyName, 255);
  if (!companyName) throw new Error('company_name is required');
  const account = normalizeAccountProfile({
    accountType: input.account_type || input.accountType,
    hostingMode: input.hosting_mode || input.hostingMode,
    storageMode: input.storage_mode || input.storageMode,
  });
  if (!account.accountType.startsWith('enterprise_')) throw new Error('enterprise invitation requires an enterprise account type');
  const recipientEmail = normalizedEmail(input.recipient_email || input.recipientEmail);
  const expiresAt = asFutureDate(input.invitation_expires_at || input.invitationExpiresAt, DEFAULT_ENTERPRISE_INVITATION_DAYS, now);
  const days = onboardingDays(input.onboarding_days || input.onboardingDays);
  const maxInvites = normalizeEnterpriseOnboardingMaxInvites(input.max_invites ?? input.maxInvites);
  const limits = enterpriseOnboardingLimits(maxInvites);
  const workspaceName = text(input.workspace_name || input.workspaceName, 255);
  const welcomeMessage = text(input.welcome_message || input.welcomeMessage, 4_000);
  const privateNotes = text(input.private_notes || input.privateNotes, 4_000);
  return {
    companyName,
    workspaceName,
    recipientEmail,
    recipientEmailHash: enterpriseInvitationEmailDigest(recipientEmail),
    recipientEmailHint: emailHint(recipientEmail),
    ...account,
    onboardingDays: days,
    onboardingLimits: limits,
    configSnapshot: {
      kind: 'enterprise_invitation_v1',
      company_name: companyName,
      workspace_name: workspaceName,
      recipient_email_hint: emailHint(recipientEmail),
      account_type: account.accountType,
      hosting_mode: account.hostingMode,
      storage_mode: account.storageMode,
      onboarding_days: days,
      onboarding_plan: 'enterprise_onboarding',
      onboarding_max_invites: maxInvites,
      onboarding_max_users: limits.maxUsers,
      onboarding_limits: limits,
      fallback_action: 'manual_review',
    },
    welcomeMessage,
    privateNotes,
    invitationExpiresAt: expiresAt,
  };
}

function publicStatus(invitation, now = new Date()) {
  if (ACTIVE_STATUSES.has(invitation.status) && invitation.invitationExpiresAt <= now) return 'expired';
  return invitation.status;
}

export function publicEnterpriseInvitation(invitation, now = new Date()) {
  if (!invitation) return null;
  const maxUsers = Number(invitation.onboardingLimits?.maxUsers);
  const maxInvites = Number.isSafeInteger(maxUsers) && maxUsers >= 1 ? maxUsers - 1 : 0;
  return {
    id: invitation.id,
    company_name: invitation.companyName,
    workspace_name: invitation.workspaceName,
    recipient_email: invitation.recipientEmail,
    recipient_email_hint: invitation.recipientEmailHint,
    account_type: invitation.accountType,
    hosting_mode: invitation.hostingMode,
    storage_mode: invitation.storageMode,
    onboarding_days: invitation.onboardingDays,
    onboarding_plan: 'enterprise_onboarding',
    onboarding_plan_name: getPlan('enterprise_onboarding').name,
    onboarding_limits: invitation.onboardingLimits,
    max_invites: maxInvites,
    max_users: maxInvites + 1,
    status: publicStatus(invitation, now),
    delivery_status: invitation.deliveryStatus,
    last_delivery_error: invitation.lastDeliveryError,
    code_hint: invitation.accessCodeHint,
    invitation_expires_at: invitation.invitationExpiresAt,
    sent_at: invitation.sentAt,
    last_sent_at: invitation.lastSentAt,
    redeemed_at: invitation.redeemedAt,
    redeemed_by_user_id: invitation.redeemedByUserId,
    organization_id: invitation.orgId,
    revoked_at: invitation.revokedAt,
    created_at: invitation.createdAt,
    updated_at: invitation.updatedAt,
  };
}

export function publicEnterpriseInvitationPreview(invitation, now = new Date()) {
  if (!invitation || !ACTIVE_STATUSES.has(invitation.status) || invitation.invitationExpiresAt <= now) return null;
  return {
    company_name: invitation.companyName,
    workspace_name: invitation.workspaceName,
    account_type: invitation.accountType,
    hosting_mode: invitation.hostingMode,
    storage_mode: invitation.storageMode,
    onboarding_plan: 'enterprise_onboarding',
    onboarding_plan_name: getPlan('enterprise_onboarding').name,
    max_invites: Math.max(0, Number(invitation.onboardingLimits?.maxUsers || 1) - 1),
    invitation_expires_at: invitation.invitationExpiresAt,
  };
}

export async function createEnterpriseInvitation({ prisma, input, now = new Date() }) {
  const normalized = normalizeEnterpriseInvitationInput(input, now);
  const code = normalizeEnterpriseInvitationCode(input.code || generateEnterpriseInvitationCode());
  if (!/^HM-[A-Z0-9]{8,20}$/.test(code)) throw new Error('invitation code is invalid');
  const token = generateEnterpriseInvitationToken();
  const invitation = await prisma.enterpriseInvitation.create({
    data: {
      ...normalized,
      status: 'draft',
      deliveryStatus: 'not_sent',
      accessCodeHash: enterpriseInvitationCodeDigest(code),
      accessCodeHint: promotionCodeHint(code),
      linkTokenHash: enterpriseInvitationTokenDigest(token),
    },
  });
  return { invitation: publicEnterpriseInvitation(invitation, now), plaintextCode: code, plaintextToken: token };
}

function admissionFromInvitation(invitation, method, now) {
  if (!invitation || !ACTIVE_STATUSES.has(invitation.status) || invitation.invitationExpiresAt <= now) return null;
  return {
    invitationId: invitation.id,
    method,
    version: method === 'code' ? invitation.accessCodeVersion : invitation.linkVersion,
    preview: publicEnterpriseInvitationPreview(invitation, now),
  };
}

export async function findEnterpriseInvitationAdmission({ prisma, code, token, now = new Date() }) {
  if (token) {
    const invitation = await prisma.enterpriseInvitation.findUnique({ where: { linkTokenHash: enterpriseInvitationTokenDigest(token) } });
    return admissionFromInvitation(invitation, 'link', now);
  }
  const normalized = normalizeEnterpriseInvitationCode(code);
  if (!normalized) return null;
  const invitation = await prisma.enterpriseInvitation.findUnique({ where: { accessCodeHash: enterpriseInvitationCodeDigest(normalized) } });
  return admissionFromInvitation(invitation, 'code', now);
}

export async function getEnterpriseInvitationPreview({ prisma, token, now = new Date() }) {
  const admission = await findEnterpriseInvitationAdmission({ prisma, token, now });
  return admission?.preview || null;
}

function assertRedeemableInvitation(invitation, { method, version, userEmail, now }) {
  if (!invitation || !ACTIVE_STATUSES.has(invitation.status) || invitation.invitationExpiresAt <= now) throw new Error('invitation unavailable');
  if (method === 'code' && invitation.accessCodeVersion !== version) throw new Error('invitation unavailable');
  if (method === 'link' && invitation.linkVersion !== version) throw new Error('invitation unavailable');
  if (!method || !Number.isInteger(version)) throw new Error('invitation unavailable');
  if (invitation.recipientEmailHash !== enterpriseInvitationEmailDigest(userEmail)) throw new Error('invitation unavailable');
}

export async function redeemEnterpriseInvitation({ tx, invitationId, method, version, userId, userEmail, orgId, now = new Date() }) {
  const invitation = await tx.enterpriseInvitation.findUnique({ where: { id: invitationId } });
  assertRedeemableInvitation(invitation, { method, version, userEmail, now });
  const claimed = await tx.enterpriseInvitation.updateMany({
    where: { id: invitationId, status: { in: ['draft', 'sent'] }, invitationExpiresAt: { gt: now } },
    data: { status: 'redeeming' },
  });
  if (claimed.count !== 1) throw new Error('invitation unavailable');

  const endsAt = new Date(now.getTime() + invitation.onboardingDays * 24 * 60 * 60 * 1000);
  const grant = await tx.entitlementGrant.create({ data: {
    orgId, source: 'enterprise_invitation', status: 'active', startsAt: now, endsAt,
    fallbackAction: 'manual_review',
  } });
  const entitlementVersion = await tx.entitlementVersion.create({ data: {
    grantId: grant.id, version: 1, planId: 'enterprise_onboarding', limits: invitation.onboardingLimits,
    accountType: invitation.accountType, hostingMode: invitation.hostingMode, storageMode: invitation.storageMode,
    commercialTerms: { kind: 'enterprise_onboarding', invitation_id: invitation.id, onboarding_days: invitation.onboardingDays },
    effectiveFrom: now, transitionReason: 'enterprise_invitation_redemption',
  } });
  await tx.organizationEntitlement.createMany({ data: [
    {
      orgId, source: 'enterprise_invitation', phase: 'onboarding', planId: 'enterprise_onboarding', limits: invitation.onboardingLimits,
      effectiveFrom: now, effectiveUntil: endsAt,
    },
    // The explicit future row prevents expiry from silently falling back to
    // Organization.plan (Enterprise, whose contract limits may be unlimited).
    // Sales can replace this row with a contracted Enterprise entitlement.
    {
      orgId, source: 'enterprise_invitation', phase: 'runway', planId: 'free', limits: {}, effectiveFrom: endsAt,
    },
  ] });
  await tx.organization.update({ where: { id: orgId }, data: {
    plan: 'enterprise', accountType: invitation.accountType, hostingMode: invitation.hostingMode,
    memoryStorageMode: invitation.storageMode, subscriptionStatus: 'active', trialEndsAt: endsAt,
  } });
  const redeemed = await tx.enterpriseInvitation.update({ where: { id: invitation.id }, data: {
    status: 'redeemed', redeemedAt: now, redeemedByUserId: userId, orgId,
  } });
  return { invitation: publicEnterpriseInvitation(redeemed, now), grant, entitlementVersion, onboardingEndsAt: endsAt };
}

export async function rotateEnterpriseInvitationSecrets({ prisma, invitationId, rotateCode = false, rotateLink = true, now = new Date() }) {
  const invitation = await prisma.enterpriseInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation || !ACTIVE_STATUSES.has(invitation.status) || invitation.invitationExpiresAt <= now) throw new Error('invitation unavailable');
  const code = rotateCode ? generateEnterpriseInvitationCode() : null;
  const token = rotateLink ? generateEnterpriseInvitationToken() : null;
  const updated = await prisma.enterpriseInvitation.update({ where: { id: invitationId }, data: {
    ...(code ? { accessCodeHash: enterpriseInvitationCodeDigest(code), accessCodeHint: promotionCodeHint(code), accessCodeVersion: { increment: 1 } } : {}),
    ...(token ? { linkTokenHash: enterpriseInvitationTokenDigest(token), linkVersion: { increment: 1 } } : {}),
  } });
  return { invitation: publicEnterpriseInvitation(updated, now), plaintextCode: code, plaintextToken: token };
}

export async function markEnterpriseInvitationDelivery({ prisma, invitationId, delivered, error = null, now = new Date() }) {
  const invitation = await prisma.enterpriseInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation || !ACTIVE_STATUSES.has(invitation.status)) throw new Error('invitation unavailable');
  const updated = await prisma.enterpriseInvitation.update({ where: { id: invitationId }, data: {
    status: delivered ? 'sent' : invitation.status,
    deliveryStatus: delivered ? 'sent' : 'failed',
    lastDeliveryError: delivered ? null : String(error || 'Email delivery failed').slice(0, 240),
    sentAt: delivered && !invitation.sentAt ? now : invitation.sentAt,
    lastSentAt: now,
  } });
  return publicEnterpriseInvitation(updated, now);
}

export async function revokeEnterpriseInvitation({ prisma, invitationId, now = new Date() }) {
  const updated = await prisma.enterpriseInvitation.updateMany({
    where: { id: invitationId, status: { in: ['draft', 'sent'] } },
    data: { status: 'revoked', revokedAt: now },
  });
  if (updated.count !== 1) throw new Error('invitation unavailable');
  return true;
}

export async function extendEnterpriseInvitation({ prisma, invitationId, expiresAt, now = new Date() }) {
  const nextExpiry = asFutureDate(expiresAt, DEFAULT_ENTERPRISE_INVITATION_DAYS, now);
  const updated = await prisma.enterpriseInvitation.updateMany({
    where: { id: invitationId, status: { in: ['draft', 'sent'] } },
    data: { invitationExpiresAt: nextExpiry },
  });
  if (updated.count !== 1) throw new Error('invitation unavailable');
  return prisma.enterpriseInvitation.findUnique({ where: { id: invitationId } });
}

// Changes the invitation snapshot for a draft/sent invitation and, if it has
// already created an onboarding tenant, publishes a new immutable entitlement
// version plus updates the effective time-row. The invite API therefore sees
// the new capacity immediately; this is not a UI-only setting.
export async function updateEnterpriseInvitationMaxInvites({ prisma, invitationId, maxInvites, now = new Date() }) {
  const normalizedMaxInvites = normalizeEnterpriseOnboardingMaxInvites(maxInvites);
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.enterpriseInvitation.findUnique({ where: { id: invitationId } });
    if (!invitation) throw new Error('invitation unavailable');
    const limits = enterpriseOnboardingLimits(normalizedMaxInvites);
    const snapshot = {
      ...(invitation.configSnapshot && typeof invitation.configSnapshot === 'object' ? invitation.configSnapshot : {}),
      onboarding_plan: 'enterprise_onboarding',
      onboarding_max_invites: normalizedMaxInvites,
      onboarding_max_users: limits.maxUsers,
      onboarding_limits: limits,
    };
    const updated = await tx.enterpriseInvitation.update({ where: { id: invitation.id }, data: {
      onboardingLimits: limits,
      configSnapshot: snapshot,
    } });

    let entitlementVersion = null;
    if (invitation.orgId && invitation.status === 'redeemed') {
      const grant = await tx.entitlementGrant.findFirst({
        where: { orgId: invitation.orgId, source: 'enterprise_invitation', status: 'active', startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        orderBy: { startsAt: 'desc' },
      });
      if (grant) {
        const latest = await tx.entitlementVersion.findFirst({ where: { grantId: grant.id }, orderBy: { version: 'desc' } });
        const isAlreadyCurrent = latest?.planId === 'enterprise_onboarding'
          && Number(latest?.limits?.maxUsers) === limits.maxUsers;
        if (!isAlreadyCurrent) {
          entitlementVersion = await tx.entitlementVersion.create({ data: {
            grantId: grant.id,
            version: (latest?.version || 0) + 1,
            planId: 'enterprise_onboarding',
            limits,
            accountType: invitation.accountType,
            hostingMode: invitation.hostingMode,
            storageMode: invitation.storageMode,
            commercialTerms: {
              ...(latest?.commercialTerms && typeof latest.commercialTerms === 'object' ? latest.commercialTerms : {}),
              invitation_id: invitation.id,
              max_invites: normalizedMaxInvites,
              max_users: limits.maxUsers,
            },
            effectiveFrom: now,
            effectiveUntil: grant.endsAt,
            transitionReason: 'enterprise_invitation_max_invites_updated',
          } });
        }
        await tx.organizationEntitlement.updateMany({ where: {
          orgId: invitation.orgId,
          source: 'enterprise_invitation',
          phase: 'onboarding',
          effectiveFrom: { lte: now },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
        }, data: { limits } });
      }
    }
    return {
      invitation: publicEnterpriseInvitation(updated, now),
      entitlementVersion,
      appliedToActiveTenant: Boolean(invitation.orgId && invitation.status === 'redeemed'),
    };
  });
}

export async function activateEnterpriseRunway({ tx, orgId, offer, now = new Date() }) {
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { accountType: true, hostingMode: true, memoryStorageMode: true } });
  if (!org?.accountType?.startsWith('enterprise_')) throw new Error('enterprise runway requires an enterprise organization');
  const grant = await tx.entitlementGrant.create({ data: {
    orgId, source: 'enterprise_runway', status: 'active', startsAt: now, fallbackAction: 'manual_review',
  } });
  const version = await tx.entitlementVersion.create({ data: {
    grantId: grant.id, version: 1, planId: 'enterprise', limits: offer.runway_limits || {},
    accountType: org.accountType, hostingMode: org.hostingMode || 'managed', storageMode: org.memoryStorageMode || 'hybrid',
    commercialTerms: { kind: 'runway', scope: offer.scope || {}, monthly_total: offer.monthly_total, currency: offer.currency },
    effectiveFrom: now, transitionReason: 'runway_checkout_confirmed',
  } });
  return { grant, version };
}
