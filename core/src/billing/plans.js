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
      llmTokensPerDay: 100_000,
      llmTokensPerMonth: 1_000_000,
      searchQueriesPerDay: 1_000,
      deepResearchPerMonth: 3,
      deepResearchPerDay: 1,
      webIntelPerDay: 5,
      searchQueriesPerMonth: 10_000,
      maxUsers: 1,
      maxProjects: 3,
      maxConnectors: 3,
      knowledgeBaseUploadsPerMonth: 10,
      knowledgeBaseUploadsPerDay: 3,
      knowledgeBasePagesPerMonth: 100,
      knowledgeBasePagesPerDay: 25,
      maxHyperRooms: 1,
      hyperAgentRunsPerDay: 5,
      hyperAgentRunsPerMonth: 25,
      taraTalkSecondsPerDay: 300,
      taraTalkSecondsPerMonth: 1_800,
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
    commercial: { audience: 'personal', onboardingDays: 0, onboardingPrice: 0, selfServe: true },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 79,
    currency: 'EUR',
    limits: {
      maxMemories: 25_000,
      llmTokensPerDay: 1_000_000,
      llmTokensPerMonth: 10_000_000,
      searchQueriesPerDay: 10_000,
      deepResearchPerMonth: 20,
      deepResearchPerDay: 5,
      webIntelPerDay: 50,
      searchQueriesPerMonth: 100_000,
      maxUsers: 5,
      maxProjects: 20,
      maxConnectors: 10,
      knowledgeBaseUploadsPerMonth: -1, // unlimited
      knowledgeBaseUploadsPerDay: 50,
      knowledgeBasePagesPerMonth: 1_000,
      knowledgeBasePagesPerDay: 250,
      maxHyperRooms: 5,
      hyperAgentRunsPerDay: 50,
      hyperAgentRunsPerMonth: 500,
      taraTalkSecondsPerDay: 1_800,
      taraTalkSecondsPerMonth: 18_000,
    },
    features: {
      ...BASE_FEATURES,
    },
    // Hard cap until metered overage charging is explicitly enabled end-to-end.
    overage: null,
    support: 'email',
    sla: '99.5%',
    stripePriceIdEnv: 'STRIPE_PRICE_ID_PRO',
    commercial: { audience: 'business', onboardingDays: 14, onboardingPrice: 0, selfServe: true },
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    price: 239,
    currency: 'EUR',
    limits: {
      maxMemories: 250_000,
      llmTokensPerDay: 10_000_000,
      llmTokensPerMonth: 100_000_000,
      searchQueriesPerDay: 200_000,
      deepResearchPerMonth: -1, // unlimited
      deepResearchPerDay: 100,
      webIntelPerDay: 500,
      searchQueriesPerMonth: 2_000_000,
      maxUsers: 25,
      maxProjects: 100,
      maxConnectors: -1, // unlimited
      knowledgeBaseUploadsPerMonth: -1,
      knowledgeBaseUploadsPerDay: 500,
      knowledgeBasePagesPerMonth: 10_000,
      knowledgeBasePagesPerDay: 2_500,
      maxHyperRooms: 25,
      hyperAgentRunsPerDay: 500,
      hyperAgentRunsPerMonth: 5_000,
      taraTalkSecondsPerDay: 14_400,
      taraTalkSecondsPerMonth: 120_000,
    },
    features: {
      ...BASE_FEATURES,
      ssoSaml: true,
      auditLogs: true,
      webhooks: true,
      teamWorkspaces: true,
      dpa: true,
    },
    overage: null,
    support: 'priority',
    sla: '99.9%',
    stripePriceIdEnv: 'STRIPE_PRICE_ID_SCALE',
    commercial: { audience: 'business', onboardingDays: 14, onboardingPrice: 0, selfServe: true },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: null, // custom
    currency: 'EUR',
    limits: {
      maxMemories: -1,
      llmTokensPerDay: -1,
      llmTokensPerMonth: -1,
      searchQueriesPerDay: -1,
      deepResearchPerMonth: -1,
      deepResearchPerDay: -1,
      webIntelPerDay: -1,
      searchQueriesPerMonth: -1,
      maxUsers: -1,
      maxProjects: -1,
      maxConnectors: -1,
      knowledgeBaseUploadsPerMonth: -1,
      knowledgeBaseUploadsPerDay: -1,
      knowledgeBasePagesPerMonth: -1,
      knowledgeBasePagesPerDay: -1,
      maxHyperRooms: -1,
      hyperAgentRunsPerDay: -1,
      hyperAgentRunsPerMonth: -1,
      taraTalkSecondsPerDay: -1,
      taraTalkSecondsPerMonth: -1,
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
    commercial: { audience: 'enterprise', onboardingDays: 14, onboardingPrice: null, selfServe: false },
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
