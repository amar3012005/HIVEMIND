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
 *   STRIPE_PRICE_ID_PRO          — price_… for the Pro plan
 *   STRIPE_PRICE_ID_SCALE        — price_… for the Scale plan
 *
 *   STRIPE_PUBLIC_CHECKOUT_RETURN  — defaults to
 *       https://hivemind.davinciai.eu/hivemind/app/billing?checkout=success
 *   STRIPE_PUBLIC_CHECKOUT_CANCEL  — defaults to
 *       https://hivemind.davinciai.eu/hivemind/app/billing?checkout=cancelled
 *   STRIPE_PUBLIC_PORTAL_RETURN    — defaults to
 *       https://hivemind.davinciai.eu/hivemind/app/billing
 */

let _client = null;
let _clientPromise = null;

export function defaultBillingUrl() {
  return String(
    process.env.STRIPE_PUBLIC_BILLING_URL
    || 'https://next.singulancelabs.com/hivemind/app/billing',
  ).replace(/\/+$/, '');
}

export function resolveHostedBillingUrls() {
  return {
    success: process.env.STRIPE_PUBLIC_CHECKOUT_RETURN
      || `${defaultBillingUrl()}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel: process.env.STRIPE_PUBLIC_CHECKOUT_CANCEL
      || `${defaultBillingUrl()}?checkout=cancelled`,
    portal: process.env.STRIPE_PUBLIC_PORTAL_RETURN
      || defaultBillingUrl(),
  };
}

export function isEntitledSubscriptionStatus(status) {
  return status === 'active' || status === 'trialing';
}

export function getSubscriptionIdFromStripeObject(object = {}) {
  if (typeof object.subscription === 'string') return object.subscription;
  if (object.subscription?.id) return object.subscription.id;
  return object.parent?.subscription_details?.subscription || null;
}

export function getSubscriptionPriceId(subscription = {}) {
  return subscription.items?.data?.[0]?.price?.id || null;
}

export function buildCheckoutMetadata({ orgId, userId, planId = '', referralCode = '' }) {
  const metadata = {
    hivemind_org_id: orgId,
    hivemind_user_id: userId || '',
    hivemind_plan_id: planId || '',
  };
  if (referralCode) metadata.hivemind_referral_code = referralCode;
  return metadata;
}

export function isAutomaticTaxEnabled() {
  const raw = String(process.env.STRIPE_AUTOMATIC_TAX_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
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
      apiVersion: '2024-06-20',
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
export async function createCheckoutSession({ customerId, priceId, orgId, userId, planId = '', referralCode = '' }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const urls = resolveHostedBillingUrls();
  const metadata = buildCheckoutMetadata({ orgId, userId, planId, referralCode });
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.success,
    cancel_url: urls.cancel,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    ...(isAutomaticTaxEnabled() ? { automatic_tax: { enabled: true } } : {}),
    customer_update: { address: 'auto', name: 'auto' },
    subscription_data: {
      metadata,
    },
    metadata,
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
  const urls = resolveHostedBillingUrls();
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: urls.portal,
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
