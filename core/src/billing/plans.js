/**
 * HIVEMIND Subscription Plans
 *
 * Pricing: flat monthly + overage. EUR currency.
 * Limits: tokens processed/mo + search queries/mo.
 */

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    currency: 'EUR',
    limits: {
      tokensPerMonth: 1_000_000,
      searchQueriesPerMonth: 10_000,
      maxUsers: 1,
      maxConnectors: 1,
      knowledgeBaseUploadsPerMonth: 10,
    },
    features: {
      webIntelligence: false,
      agentSwarm: true,
      mcpProtocol: true,
      graphVisualization: true,
      llmObserver: false, // heuristic only
      ssoSaml: false,
      auditLogs: false,
      hyok: false,
      dpa: false,
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
      tokensPerMonth: 5_000_000,
      searchQueriesPerMonth: 100_000,
      maxUsers: 5,
      maxConnectors: 10,
      knowledgeBaseUploadsPerMonth: -1, // unlimited
    },
    features: {
      webIntelligence: true,
      agentSwarm: true,
      mcpProtocol: true,
      graphVisualization: true,
      llmObserver: true,
      ssoSaml: false,
      auditLogs: false,
      hyok: false,
      dpa: false,
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
      tokensPerMonth: 80_000_000,
      searchQueriesPerMonth: 2_000_000,
      maxUsers: 25,
      maxConnectors: -1, // unlimited
      knowledgeBaseUploadsPerMonth: -1,
    },
    features: {
      webIntelligence: true,
      agentSwarm: true,
      mcpProtocol: true,
      graphVisualization: true,
      llmObserver: true,
      ssoSaml: true,
      auditLogs: true,
      hyok: false,
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
      tokensPerMonth: -1,
      searchQueriesPerMonth: -1,
      maxUsers: -1,
      maxConnectors: -1,
      knowledgeBaseUploadsPerMonth: -1,
    },
    features: {
      webIntelligence: true,
      agentSwarm: true,
      mcpProtocol: true,
      graphVisualization: true,
      llmObserver: true,
      ssoSaml: true,
      auditLogs: true,
      hyok: true,
      dpa: true,
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
