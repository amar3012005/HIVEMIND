import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  enterpriseInvitationCodeDigest,
  enterpriseInvitationEmailDigest,
  findEnterpriseInvitationAdmission,
  normalizeEnterpriseInvitationCode,
  normalizeEnterpriseInvitationInput,
  publicEnterpriseInvitationPreview,
  unlimitedEnterpriseOnboardingLimits,
} from '../../src/billing/enterprise-invitation-service.js';
import { renderTemplate } from '../../src/email/email-service.js';

describe('EnterpriseInvitationService', () => {
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
      supportEmail: 'support@singulancelabs.com', privacyUrl: 'https://example.test/privacy', termsUrl: 'https://example.test/terms',
    });
    assert.match(rendered.html, /https:\/\/example\.test\/activate/);
    assert.match(rendered.html, /HM-EXAMPLE/);
    assert.match(rendered.subject, /Example GmbH/);
  });
});
