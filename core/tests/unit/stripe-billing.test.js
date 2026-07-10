import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };

async function loadStripeModule() {
  return import(`../../src/billing/stripe.js?test=${Date.now()}_${Math.random()}`);
}

describe('stripe billing urls and metadata', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.STRIPE_PUBLIC_BILLING_URL;
    delete process.env.STRIPE_PUBLIC_CHECKOUT_RETURN;
    delete process.env.STRIPE_PUBLIC_CHECKOUT_CANCEL;
    delete process.env.STRIPE_PUBLIC_PORTAL_RETURN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('falls back to the next singulancelabs billing route', async () => {
    const stripeMod = await loadStripeModule();
    const urls = stripeMod.resolveHostedBillingUrls();

    assert.equal(urls.success, 'https://next.singulancelabs.com/hivemind/app/billing?checkout=success');
    assert.equal(urls.cancel, 'https://next.singulancelabs.com/hivemind/app/billing?checkout=cancelled');
    assert.equal(urls.portal, 'https://next.singulancelabs.com/hivemind/app/billing');
  });

  it('adds plan and referral metadata to checkout and subscription payloads', async () => {
    const stripeMod = await loadStripeModule();
    const metadata = stripeMod.buildCheckoutMetadata({
      orgId: 'org_123',
      userId: 'user_123',
      planId: 'scale',
      referralCode: 'GTM2026',
    });

    assert.equal(metadata.hivemind_org_id, 'org_123');
    assert.equal(metadata.hivemind_user_id, 'user_123');
    assert.equal(metadata.hivemind_plan_id, 'scale');
    assert.equal(metadata.hivemind_referral_code, 'GTM2026');
  });

  it('keeps automatic tax disabled by default', async () => {
    const stripeMod = await loadStripeModule();
    assert.equal(stripeMod.isAutomaticTaxEnabled(), false);

    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = 'true';
    const stripeModEnabled = await loadStripeModule();
    assert.equal(stripeModEnabled.isAutomaticTaxEnabled(), true);
  });
});
