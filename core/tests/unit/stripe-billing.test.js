import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSubscriptionIdFromStripeObject,
  getSubscriptionPriceId,
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
});
