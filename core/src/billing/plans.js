/**
 * HIVEMIND Subscription Plans
 *
 * Pricing: flat monthly + overage. EUR currency.
 * Philosophy: all features available on all plans — pay for volume, not capabilities.
 * Limits: memories, LLM tokens/mo, deep research/mo, web intel/day, connectors, users, KB uploads/mo.
 */

const BASE_FEATURES = {
  webIntelligence: true,
  deepResearch: true,
  agentSwarm: true,
  mcpProtocol: true,
  graphVisualization: true,
  talkToHive: true,
  taraVoiceAgent: true,
  llmObserver: true,
  secondBrain: true,
  // Plan-gated (not usage-gated):
  ssoSaml: false,
  auditLogs: false,
  webhooks: false,
  teamWorkspaces: false,
  hyok: false,
  dpa: false,
  dedicatedInfra: false,
};

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    currency: 'EUR',
    limits: {
      maxMemories: 1_000,
      llmTokensPerMonth: 1_000_000,
      deepResearchPerMonth: 3,
      webIntelPerDay: 5,
      searchQueriesPerMonth: 10_000,
      maxUsers: 1,
      maxConnectors: 3,
      knowledgeBaseUploadsPerMonth: 10,
      maxHyperRooms: 1,
    },
    features: {
      ...BASE_FEATURES,
    },
    overage: null, // hard limit
    support: 'community',
    sla: null,
    // Stripe price IDs are read from env (different prices per env).
    // Stays null on free since there's nothing to charge.
    stripePriceIdEnv: null,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 19,
    currency: 'EUR',
    limits: {
      maxMemories: 25_000,
      llmTokensPerMonth: 10_000_000,
      deepResearchPerMonth: 20,
      webIntelPerDay: 50,
      searchQueriesPerMonth: 100_000,
      maxUsers: 5,
      maxConnectors: 10,
      knowledgeBaseUploadsPerMonth: -1, // unlimited
      maxHyperRooms: 5,
    },
    features: {
      ...BASE_FEATURES,
    },
    overage: { tokensPerThousand: 0.01, queriesPerThousand: 0.10 },
    support: 'email',
    sla: '99.5%',
    stripePriceIdEnv: 'STRIPE_PRICE_ID_PRO',
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    price: 199,
    currency: 'EUR',
    limits: {
      maxMemories: 250_000,
      llmTokensPerMonth: 100_000_000,
      deepResearchPerMonth: -1, // unlimited
      webIntelPerDay: 500,
      searchQueriesPerMonth: 2_000_000,
      maxUsers: 25,
      maxConnectors: -1, // unlimited
      knowledgeBaseUploadsPerMonth: -1,
      maxHyperRooms: 25,
    },
    features: {
      ...BASE_FEATURES,
      ssoSaml: true,
      auditLogs: true,
      webhooks: true,
      teamWorkspaces: true,
      dpa: true,
    },
    overage: { tokensPerThousand: 0.008, queriesPerThousand: 0.08 },
    support: 'priority',
    sla: '99.9%',
    stripePriceIdEnv: 'STRIPE_PRICE_ID_SCALE',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: null, // custom
    currency: 'EUR',
    limits: {
      maxMemories: -1,
      llmTokensPerMonth: -1,
      deepResearchPerMonth: -1,
      webIntelPerDay: -1,
      searchQueriesPerMonth: -1,
      maxUsers: -1,
      maxConnectors: -1,
      knowledgeBaseUploadsPerMonth: -1,
      maxHyperRooms: -1,
    },
    features: {
      ...BASE_FEATURES,
      ssoSaml: true,
      auditLogs: true,
      webhooks: true,
      teamWorkspaces: true,
      hyok: true,
      dpa: true,
      dedicatedInfra: true,
    },
    overage: null,
    support: 'dedicated',
    sla: 'custom',
    // Enterprise is sales-led; we don't expose a self-serve Stripe price.
    stripePriceIdEnv: null,
  },
};

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

export function getAllPlans() {
  return Object.values(PLANS);
}

/**
 * Resolve the Stripe price ID for a plan from env at call time.
 * Returns null if the plan is free / enterprise / not configured.
 */
export function getStripePriceId(planId) {
  const plan = PLANS[planId];
  if (!plan?.stripePriceIdEnv) return null;
  const id = process.env[plan.stripePriceIdEnv];
  return id ? String(id) : null;
}

/**
 * Reverse map: given a Stripe price ID (from a webhook payload) return
 * the local plan ID. Lets the webhook handler stay in sync without
 * reaching back into Stripe metadata.
 */
export function planIdForStripePrice(priceId) {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    if (!plan.stripePriceIdEnv) continue;
    if (process.env[plan.stripePriceIdEnv] === priceId) return plan.id;
  }
  return null;
}

export function isFeatureEnabled(planId, feature) {
  const plan = getPlan(planId);
  return plan.features[feature] === true;
}

export function getLimit(planId, limitKey) {
  const plan = getPlan(planId);
  return plan.limits[limitKey] ?? 0;
}
