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

    assert.equal(urls.success, 'https://next.singulancelabs.com/hivemind/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}');
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

  it('extracts subscription ids from Checkout and invoice payloads', async () => {
    const stripeMod = await loadStripeModule();
    assert.equal(stripeMod.getSubscriptionIdFromStripeObject({ subscription: 'sub_checkout' }), 'sub_checkout');
    assert.equal(stripeMod.getSubscriptionIdFromStripeObject({ parent: { subscription_details: { subscription: 'sub_invoice' } } }), 'sub_invoice');
    assert.equal(stripeMod.isEntitledSubscriptionStatus('active'), true);
    assert.equal(stripeMod.isEntitledSubscriptionStatus('trialing'), true);
    assert.equal(stripeMod.isEntitledSubscriptionStatus('past_due'), false);
  });

  it('copies enterprise onboarding identity to the PaymentIntent metadata', async () => {
    const stripeMod = await loadStripeModule();
    let payload;
    const session = await stripeMod.createEnterpriseCheckout({
      customerId: 'cus_test', orgId: 'org_123', userId: 'user_123', phase: 'onboarding',
      terms: { onboarding_price_cents: 100000, runway_monthly_cents: 250000, currency: 'EUR' },
      stripeClient: { checkout: { sessions: { create: async (value) => { payload = value; return { id: 'cs_test' }; } } } },
    });

    assert.equal(session.id, 'cs_test');
    assert.equal(payload.mode, 'payment');
    assert.deepEqual(payload.payment_intent_data.metadata, {
      hivemind_org_id: 'org_123',
      hivemind_user_id: 'user_123',
      hivemind_enterprise_phase: 'onboarding',
    });
  });
});
