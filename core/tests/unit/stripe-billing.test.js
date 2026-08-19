import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSubscriptionIdFromStripeObject,
  getSubscriptionPriceId,
  createCheckoutIntegrationIdentifier,
  isAutomaticTaxEnabled,
  isEntitledSubscriptionStatus,
} from '../../src/billing/stripe.js';

describe('Stripe subscription payload helpers', () => {
  it('extracts subscription ids from Checkout and invoice payloads', () => {
    assert.equal(getSubscriptionIdFromStripeObject({ subscription: 'sub_checkout' }), 'sub_checkout');
    assert.equal(getSubscriptionIdFromStripeObject({ parent: { subscription_details: { subscription: 'sub_invoice' } } }), 'sub_invoice');
  });

  it('extracts the subscription price and accepts only entitled statuses', () => {
    assert.equal(getSubscriptionPriceId({ items: { data: [{ price: { id: 'price_pro' } }] } }), 'price_pro');
    assert.equal(isEntitledSubscriptionStatus('active'), true);
    assert.equal(isEntitledSubscriptionStatus('trialing'), true);
    assert.equal(isEntitledSubscriptionStatus('past_due'), false);
  });

  it('keeps automatic tax opt-in rather than silently enabling it', () => {
    const original = process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
    delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
    assert.equal(isAutomaticTaxEnabled(), false);
    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = 'true';
    assert.equal(isAutomaticTaxEnabled(), true);
    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = 'false';
    assert.equal(isAutomaticTaxEnabled(), false);
    if (original === undefined) delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
    else process.env.STRIPE_AUTOMATIC_TAX_ENABLED = original;
  });

  it('uses an opaque unique Checkout integration identifier', () => {
    const first = createCheckoutIntegrationIdentifier();
    const second = createCheckoutIntegrationIdentifier();
    assert.match(first, /^hivemind_checkout_[a-z]{8}$/);
    assert.match(second, /^hivemind_checkout_[a-z]{8}$/);
    assert.notEqual(first, second);
  });
});
