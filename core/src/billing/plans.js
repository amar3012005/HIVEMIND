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
    },
    features: {
      ...BASE_FEATURES,
    },
    overage: null, // hard limit
    support: 'community',
    sla: null,
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
    },
    features: {
      ...BASE_FEATURES,
    },
    overage: { tokensPerThousand: 0.01, queriesPerThousand: 0.10 },
    support: 'email',
    sla: '99.5%',
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
  },
};

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

export function getAllPlans() {
  return Object.values(PLANS);
}

export function isFeatureEnabled(planId, feature) {
  const plan = getPlan(planId);
  return plan.features[feature] === true;
}

export function getLimit(planId, limitKey) {
  const plan = getPlan(planId);
  return plan.limits[limitKey] ?? 0;
}
