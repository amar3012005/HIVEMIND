import { randomBytes } from 'node:crypto';

/**
 * Stripe client wrapper.
 *
 * Lazy-loaded so the control-plane keeps booting when STRIPE_SECRET_KEY
 * is unset (free / self-hosted deploys). Every helper checks `isEnabled()`
 * first; callers should branch on that and return 503 to the user when
 * Stripe is not configured.
 *
 * Required env vars (control-plane container):
 *   STRIPE_SECRET_KEY            — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET        — whsec_… (for signature verification)
 *   STRIPE_PRICE_ID_PLUS         — price_… for the Plus plan
 *   STRIPE_PRICE_ID_PRO          — price_… for the Pro plan
 *   STRIPE_PRICE_ID_SCALE        — price_… for the Scale plan
 *
 *   STRIPE_AUTOMATIC_TAX_ENABLED   — opt-in only after Stripe Tax
 *       registrations and product tax codes are configured (defaults false)
 *   STRIPE_PUBLIC_CHECKOUT_RETURN  — defaults to
 *       https://next.singulancelabs.com/hivemind/app/billing?checkout=success
 *   STRIPE_PUBLIC_CHECKOUT_CANCEL  — defaults to
 *       https://next.singulancelabs.com/hivemind/app/billing?checkout=cancelled
 *   STRIPE_PUBLIC_PORTAL_RETURN    — defaults to
 *       https://next.singulancelabs.com/hivemind/app/billing
 */

let _client = null;
let _clientPromise = null;

const PUBLIC_BILLING_URL = 'https://next.singulancelabs.com/hivemind/app/billing';

/**
 * Tax must be an explicit production decision.  Stripe accepts a Checkout
 * request with automatic_tax enabled even when no active registration exists,
 * which silently produces zero tax.  Keep it off until Finance has recorded
 * the applicable registrations and product tax codes in Stripe.
 */
export function isAutomaticTaxEnabled() {
  return String(process.env.STRIPE_AUTOMATIC_TAX_ENABLED || '').trim().toLowerCase() === 'true';
}

export function isEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Checkout traffic is identified in Stripe without using tenant or user data.
 * Stripe requires an eight-letter random suffix for API versions >= 2026-03-25.
 */
export function createCheckoutIntegrationIdentifier() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(8);
  return `hivemind_checkout_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

/**
 * Lazy-init the Stripe SDK. Returns null when STRIPE_SECRET_KEY is unset;
 * callers must check before using.
 */
export async function getStripe() {
  if (!isEnabled()) return null;
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const mod = await import('stripe');
    const Ctor = mod.default || mod.Stripe || mod;
    _client = new Ctor(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-06-24.dahlia',
      maxNetworkRetries: 2,
      timeout: 15_000,
      appInfo: { name: 'HIVEMIND', version: '1.0' },
    });
    return _client;
  })();
  return _clientPromise;
}

/**
 * Ensure the org has a Stripe customer. Idempotent: returns the existing
 * stripe_customer_id when set, otherwise creates one and persists.
 *
 * @param {Object} prisma
 * @param {{id: string, name: string, billingEmail?: string|null}} org
 * @param {string} ownerEmail  — fallback when org.billingEmail is null
 * @returns {Promise<string|null>}
 */
export async function ensureCustomer(prisma, org, ownerEmail) {
  const stripe = await getStripe();
  if (!stripe) return null;
  if (org.stripeCustomerId) return org.stripeCustomerId;

  const customer = await stripe.customers.create({
    name: org.name,
    email: org.billingEmail || ownerEmail || undefined,
    metadata: { hivemind_org_id: org.id },
  });
  await prisma.organization.update({
    where: { id: org.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

/**
 * Create a Stripe Checkout session for an upgrade. Returns the hosted URL
 * the user is redirected to. The webhook handler is what finalises the
 * subscription state after payment succeeds.
 */
export async function createCheckoutSession({ customerId, priceId, orgId, userId, promotionCodeId = null, promotionId = null, promotionVersionId = null }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const returnSuccess = process.env.STRIPE_PUBLIC_CHECKOUT_RETURN
    || `${PUBLIC_BILLING_URL}?checkout=success`;
  const returnCancel = process.env.STRIPE_PUBLIC_CHECKOUT_CANCEL
    || `${PUBLIC_BILLING_URL}?checkout=cancelled`;
  const automaticTax = isAutomaticTaxEnabled();
  return stripe.checkout.sessions.create({
    integration_identifier: createCheckoutIntegrationIdentifier(),
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: returnSuccess,
    cancel_url: returnCancel,
    // A managed promotion is server-selected after eligibility has been checked.
    // Never expose arbitrary Stripe promotion codes when a tenant-bound offer applies.
    ...(promotionCodeId
      ? { discounts: [{ promotion_code: promotionCodeId }] }
      : { allow_promotion_codes: true }),
    billing_address_collection: 'auto',
    ...(automaticTax ? {
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
    } : {}),
    subscription_data: {
      metadata: { hivemind_org_id: orgId, hivemind_user_id: userId || '' },
    },
    metadata: {
      hivemind_org_id: orgId,
      ...(promotionId ? { hivemind_promotion_id: promotionId } : {}),
      ...(promotionVersionId ? { hivemind_promotion_version_id: promotionVersionId } : {}),
    },
  });
}

/**
 * Creates a platform-managed Stripe coupon and promotion code. The plaintext
 * code is supplied only at creation time and is never persisted in HIVEMIND.
 */
export async function createManagedPromotionCode({ code, name, terms = {} }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const kind = String(terms.kind || '').toLowerCase();
  const duration = String(terms.discount_duration || 'once').toLowerCase();
  if (!['once', 'repeating', 'forever'].includes(duration)) throw new Error('Invalid Stripe coupon duration');
  const couponData = { duration, name: String(name || 'HIVEMIND promotion').slice(0, 40) };
  if (duration === 'repeating') couponData.duration_in_months = Number(terms.duration_in_months);
  if (kind === 'percentage_discount') {
    couponData.percent_off = Number(terms.percent_off);
  } else if (kind === 'fixed_discount') {
    couponData.amount_off = Number(terms.amount_off_cents);
    couponData.currency = String(terms.currency || 'EUR').toLowerCase();
  } else {
    throw new Error('Stripe promotions require a percentage or fixed discount');
  }
  const coupon = await stripe.coupons.create(couponData);
  const promotionCode = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code: String(code).toUpperCase(),
    active: true,
    metadata: { hivemind_managed: 'true' },
  });
  return { couponId: coupon.id, promotionCodeId: promotionCode.id };
}

/**
 * Runway self-serve checkout — a DYNAMIC-price monthly subscription for a scope the
 * org configured (no fixed Stripe price id). `unit_amount` is the server-computed
 * monthly total; a self-hosted setup fee rides the first invoice via add_invoice_items.
 * The subscription carries metadata.kind='runway' + checkout_id so (a) the webhook can
 * activate the stored custom entitlement and (b) syncPersonalStripeSubscription's
 * price→plan map (which returns null for this unmapped dynamic price) never clobbers it.
 */
export async function createRunwayCheckoutSession({ customerId, orgId, userId, quote, checkoutId }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const returnSuccess = process.env.STRIPE_PUBLIC_CHECKOUT_RETURN
    || `${PUBLIC_BILLING_URL}?checkout=success`;
  const returnCancel = process.env.STRIPE_PUBLIC_CHECKOUT_CANCEL
    || `${PUBLIC_BILLING_URL}?checkout=cancelled`;
  const currency = String(quote?.currency || 'eur').toLowerCase();
  const cfg = quote?.config || {};
  const label = `HIVEMIND Runway — ${quote?.mode || 'managed'} · ${cfg.seats} seats · ${cfg.tokens}M tokens`
    + (quote?.mode === 'managed' ? ` · ${cfg.dataGb}GB` : '');
  // Optional Stripe tax code (e.g. txcd_10103001 = SaaS, business use). When set,
  // automatic tax is enabled with this code on the ad-hoc line; when unset, tax is
  // skipped so the ad-hoc-price checkout always opens (see product_data below).
  const runwayTaxCode = process.env.RUNWAY_STRIPE_TAX_CODE || null;
  const subscription_data = {
    metadata: { hivemind_org_id: orgId, hivemind_user_id: userId || '', kind: 'runway', checkout_id: checkoutId || '' },
  };
  // Recurring monthly line. Ad-hoc product: Stripe automatic_tax needs a per-line
  // tax_code for ad-hoc products (unlike the fixed Pro/Scale prices, whose Products
  // carry a tax code in the dashboard). Only attach a tax_code + enable automatic_tax
  // when RUNWAY_STRIPE_TAX_CODE is set — otherwise automatic tax throws "You must
  // specify a tax code…" and the checkout never opens. Default: no automatic tax.
  const line_items = [{
    quantity: 1,
    price_data: {
      currency,
      recurring: { interval: 'month' },
      unit_amount: Math.round(Number(quote.monthlyTotal) * 100),
      product_data: { name: label, ...(runwayTaxCode ? { tax_code: runwayTaxCode } : {}) },
    },
  }];
  // Self-hosted one-time setup fee: a ONE-TIME line item (no `recurring`). In
  // subscription mode Stripe bills one-time line items on the first invoice.
  // (subscription_data.add_invoice_items is NOT accepted by Checkout Sessions.)
  if (Number(quote?.setupOneTime) > 0) {
    line_items.push({
      quantity: 1,
      price_data: {
        currency,
        unit_amount: Math.round(Number(quote.setupOneTime) * 100),
        product_data: { name: 'One-time deployment & security setup', ...(runwayTaxCode ? { tax_code: runwayTaxCode } : {}) },
      },
    });
  }
  return stripe.checkout.sessions.create({
    integration_identifier: createCheckoutIntegrationIdentifier(),
    mode: 'subscription',
    customer: customerId,
    line_items,
    success_url: returnSuccess,
    cancel_url: returnCancel,
    billing_address_collection: 'auto',
    ...(runwayTaxCode
      ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } }
      : {}),
    subscription_data,
    metadata: { hivemind_org_id: orgId, kind: 'runway', checkout_id: checkoutId || '' },
  });
}

/**
 * Create a Stripe Customer Portal session so the user can manage their
 * subscription (change plan, update card, view invoices, cancel) without
 * us building those screens ourselves.
 */
export async function createPortalSession({ customerId }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const returnUrl = process.env.STRIPE_PUBLIC_PORTAL_RETURN
    || PUBLIC_BILLING_URL;
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

/**
 * List recent invoices for an org's Stripe customer. Returns Stripe-native
 * objects (id, amount_paid, status, hosted_invoice_url, invoice_pdf, ...).
 * For CSV export we just transform this list client-side.
 */
export async function listInvoices({ customerId, limit = 24 }) {
  const stripe = await getStripe();
  if (!stripe) return [];
  const res = await stripe.invoices.list({ customer: customerId, limit });
  return res.data.map(inv => ({
    id: inv.id,
    number: inv.number,
    status: inv.status,
    amount_paid: inv.amount_paid,
    amount_due: inv.amount_due,
    currency: inv.currency?.toUpperCase(),
    period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    hosted_invoice_url: inv.hosted_invoice_url,
    invoice_pdf: inv.invoice_pdf,
    created: new Date(inv.created * 1000).toISOString(),
  }));
}

/**
 * Verify a Stripe webhook signature and parse the event. Throws if the
 * signature is invalid — caller must respond 400.
 */
export async function constructEvent({ rawBody, signature }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Lookup the org bound to a Stripe customer id. We index this column so
 * webhooks resolve in O(log n).
 */
export async function findOrgByCustomerId(prisma, customerId) {
  if (!prisma || !customerId) return null;
  return prisma.organization.findUnique({ where: { stripeCustomerId: customerId } });
}

export function getSubscriptionIdFromStripeObject(object) {
  const subscription = object?.subscription
    || object?.parent?.subscription_details?.subscription
    || object?.subscription_details?.subscription;
  if (typeof subscription === 'string') return subscription;
  return subscription?.id || null;
}

export function getSubscriptionPriceId(subscription) {
  return subscription?.items?.data?.[0]?.price?.id || null;
}

export function isEntitledSubscriptionStatus(status) {
  return status === 'active' || status === 'trialing';
}
