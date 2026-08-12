import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEnterpriseInvitation,
  enterpriseInvitationCodeDigest,
  enterpriseInvitationEmailDigest,
  findEnterpriseInvitationAdmission,
  normalizeEnterpriseInvitationCode,
  normalizeEnterpriseInvitationInput,
  publicEnterpriseInvitationPreview,
  redeemEnterpriseInvitation,
  unlimitedEnterpriseOnboardingLimits,
} from '../../src/billing/enterprise-invitation-service.js';
import { renderTemplate } from '../../src/email/email-service.js';

describe('EnterpriseInvitationService', () => {
  it('creates a draft without any delivery state so email is always an explicit later action', async () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    let persisted = null;
    const prisma = {
      enterpriseInvitation: {
        create: async ({ data }) => {
          persisted = { id: '11111111-1111-4111-8111-111111111111', ...data, createdAt: now, updatedAt: now };
          return persisted;
        },
      },
    };
    const created = await createEnterpriseInvitation({ prisma, now, input: {
      company_name: 'Example GmbH', recipient_email: 'owner@example.com',
      account_type: 'enterprise_managed', storage_mode: 'hybrid', code: 'HM-EXPLICIT1',
    } });
    assert.equal(persisted.status, 'draft');
    assert.equal(persisted.deliveryStatus, 'not_sent');
    assert.equal(created.invitation.status, 'draft');
    assert.equal(created.plaintextCode, 'HM-EXPLICIT1');
  });

  it('creates a fixed unlimited commercial onboarding profile without accepting arbitrary caps', () => {
    const input = normalizeEnterpriseInvitationInput({
      company_name: 'Example GmbH', recipient_email: 'Owner@Example.com',
      account_type: 'enterprise_managed', storage_mode: 'hybrid', onboarding_days: 14,
    }, new Date('2026-08-08T00:00:00.000Z'));
    assert.equal(input.accountType, 'enterprise_managed');
    assert.equal(input.hostingMode, 'managed');
    assert.equal(input.storageMode, 'hybrid');
    assert.equal(input.recipientEmail, 'owner@example.com');
    assert.deepEqual(input.onboardingLimits, unlimitedEnterpriseOnboardingLimits());
    assert.ok(Object.values(input.onboardingLimits).every((limit) => limit === -1));
    assert.throws(() => normalizeEnterpriseInvitationInput({
      company_name: 'Example', recipient_email: 'owner@example.com', account_type: 'personal',
    }), /enterprise invitation requires an enterprise account type/);
  });

  it('does not expose a usable admission after expiry and binds recovery codes to their hashed value', async () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const code = normalizeEnterpriseInvitationCode(' hm-test-code ');
    const invitation = {
      id: '11111111-1111-4111-8111-111111111111', status: 'sent', accessCodeVersion: 1, linkVersion: 1,
      invitationExpiresAt: new Date('2026-08-09T00:00:00.000Z'), accountType: 'enterprise_managed',
      hostingMode: 'managed', storageMode: 'hybrid', companyName: 'Example', workspaceName: null,
    };
    const prisma = { enterpriseInvitation: { findUnique: async ({ where }) => where.accessCodeHash === enterpriseInvitationCodeDigest(code) ? invitation : null } };
    const admission = await findEnterpriseInvitationAdmission({ prisma, code, now });
    assert.equal(admission.invitationId, invitation.id);
    assert.equal(admission.method, 'code');
    assert.equal(enterpriseInvitationEmailDigest('owner@example.com').length, 64);
    assert.equal(publicEnterpriseInvitationPreview({ ...invitation, invitationExpiresAt: now }, now), null);
  });

  it('renders the server-owned invitation email with a secure link and recovery code', () => {
    const rendered = renderTemplate('enterprise_invitation', {
      companyName: 'Example GmbH', workspaceName: 'Example HIVEMIND', recipientEmail: 'owner@example.com',
      hostingLabel: 'Managed', hostingExplanation: 'Managed EU infrastructure.', invitationUrl: 'https://example.test/activate',
      accessCode: 'HM-EXAMPLE', expiresOn: '22 August 2026', welcomeMessage: 'Welcome aboard.',
      onboardingDays: 14, storageLabel: 'Managed hybrid company brain',
      supportEmail: 'support@singulancelabs.com', privacyUrl: 'https://example.test/privacy', termsUrl: 'https://example.test/terms',
    });
    assert.match(rendered.html, /https:\/\/example\.test\/activate/);
    assert.match(rendered.html, /HM-EXAMPLE/);
    assert.match(rendered.subject, /Example GmbH/);
    assert.match(rendered.html, /AI Operating System/);
    assert.match(rendered.text, /invitation already applied/);
  });

  it('redeems only once and binds the resulting unlimited grant to the invited owner', async () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const recipient = 'owner@example.com';
    const invitation = {
      id: '11111111-1111-4111-8111-111111111111', status: 'sent', accessCodeVersion: 1, linkVersion: 1,
      invitationExpiresAt: new Date('2026-08-22T00:00:00.000Z'), recipientEmailHash: enterpriseInvitationEmailDigest(recipient),
      onboardingDays: 14, onboardingLimits: unlimitedEnterpriseOnboardingLimits(), accountType: 'enterprise_managed',
      hostingMode: 'managed', storageMode: 'hybrid', companyName: 'Example', workspaceName: null,
      recipientEmail: recipient, recipientEmailHint: 'ow***@example.com', deliveryStatus: 'sent', accessCodeHint: 'HM-...',
      sentAt: now, lastSentAt: now, redeemedAt: null, redeemedByUserId: null, orgId: null, revokedAt: null, createdAt: now, updatedAt: now,
    };
    const tx = {
      enterpriseInvitation: {
        findUnique: async () => invitation,
        updateMany: async ({ where, data }) => {
          if (!where.status.in.includes(invitation.status) || invitation.invitationExpiresAt <= now) return { count: 0 };
          invitation.status = data.status; return { count: 1 };
        },
        update: async ({ data }) => Object.assign(invitation, data),
      },
      entitlementGrant: { create: async ({ data }) => ({ id: 'grant-1', ...data }) },
      entitlementVersion: { create: async ({ data }) => ({ id: 'version-1', ...data }) },
      organizationEntitlement: { create: async ({ data }) => data },
      organization: { update: async ({ data }) => data },
    };
    const redeemed = await redeemEnterpriseInvitation({ tx, invitationId: invitation.id, method: 'link', version: 1, userId: '22222222-2222-4222-8222-222222222222', userEmail: recipient, orgId: '33333333-3333-4333-8333-333333333333', now });
    assert.equal(redeemed.grant.source, 'enterprise_invitation');
    assert.equal(redeemed.entitlementVersion.limits.llmTokensPerMonth, -1);
    assert.equal(invitation.status, 'redeemed');
    await assert.rejects(() => redeemEnterpriseInvitation({ tx, invitationId: invitation.id, method: 'link', version: 1, userId: '22222222-2222-4222-8222-222222222222', userEmail: recipient, orgId: '33333333-3333-4333-8333-333333333333', now }), /invitation unavailable/);
  });
});
