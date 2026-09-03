import { createHash } from 'node:crypto';
import { isUseToolsUnifiedDagEnabled } from './use-tools-unified-flag.js';

const TOOLKIT_TO_PROVIDER = Object.freeze({
  gmail: 'gmail',
  googledrive: 'google-drive',
  googledocs: 'google-docs',
  googlesheets: 'google-sheets',
  googlecalendar: 'google-calendar',
  googletasks: 'google-tasks',
  googlegemini: 'google-gemini',
  slack: 'slack',
  notion: 'notion',
  github: 'github',
  linear: 'linear',
});

const NATIVE_GROUPS = new Set(['hivemind-recall', 'hivemind-memory-write', 'hivemind-projects']);
export const CATALOG_CONNECTOR_PROVIDERS = Object.freeze([...new Set(Object.values(TOOLKIT_TO_PROVIDER))]);

export const HIVEMIND_HOSTED_TOOL_CARDS = Object.freeze([
  {
    slug: 'HIVEMIND_RECALL',
    method: 'POST',
    path: '/api/recall',
    authority: 'read',
    description: 'Grounded tenant-scoped hybrid retrieval over authorized HIVE-MIND memories and evidence.',
  },
  {
    slug: 'HIVEMIND_PLAN_WORKFLOW',
    method: 'POST',
    path: '/api/composio/plan',
    authority: 'read',
    description: 'Plan a bounded sequential workflow across native HIVE-MIND capabilities and this tenant\'s active Composio connectors. This tool plans only and never executes provider actions.',
  },
]);

export function connectedProvidersFromAccounts(accounts = []) {
  return [...new Set((Array.isArray(accounts) ? accounts : [])
    .filter((account) => account?.status === 'ACTIVE')
    .map((account) => {
      const toolkit = String(account?.toolkit || '').trim().toLowerCase();
      return TOOLKIT_TO_PROVIDER[toolkit] || toolkit;
    })
    .filter(Boolean))];
}

function normalizeDependencies(dependsOn, index) {
  if (!Array.isArray(dependsOn)) return [];
  return [...new Set(dependsOn.filter((dependency) => Number.isInteger(dependency)
    && dependency >= 0 && dependency < index))].slice(0, 4);
}

function validateGroups(groups, allowedGroups, { allowCatalogDisconnected = false } = {}) {
  const normalized = [...new Set((Array.isArray(groups) ? groups : [])
    .map((group) => String(group || '').trim().toLowerCase())
    .filter(Boolean))];
  if (normalized.length !== 1) throw new Error('planner_step_requires_exactly_one_tool_group');
  const group = normalized[0];
  if (allowedGroups.has(group)) return { groups: normalized, connection_required: false };
  if (allowCatalogDisconnected && (CATALOG_CONNECTOR_PROVIDERS.includes(group) || NATIVE_GROUPS.has(group))) {
    return { groups: normalized, connection_required: !NATIVE_GROUPS.has(group) };
  }
  throw new Error(`planner_selected_unavailable_tool_group:${group}`);
}

export function decisionToHostedPlan(decision, { request, connectedProviders = [], unifiedDag = isUseToolsUnifiedDagEnabled() } = {}) {
  const allowedGroups = new Set([...NATIVE_GROUPS, ...connectedProviders]);
  let rawSteps = [];
  if (decision?.operation === 'compound') {
    rawSteps = Array.isArray(decision.subtasks) ? decision.subtasks : [];
  } else if (['connector_read', 'connector_write'].includes(decision?.operation)) {
    rawSteps = [{
      operation: decision.operation === 'connector_write' ? 'write' : 'read',
      tool_groups: [decision.connector_provider],
      depends_on: null,
      message: decision.queries?.[0] || request,
      retrieval: decision.connector_retrieval || null,
    }];
  } else {
    rawSteps = [{
      operation: decision?.operation || 'recall',
      tool_groups: Array.isArray(decision?.tool_groups) && decision.tool_groups.length
        ? [decision.tool_groups[0]] : ['hivemind-recall'],
      depends_on: null,
      message: decision?.query_canonical_en || decision?.queries?.[0] || request,
      retrieval: null,
    }];
  }
  if (rawSteps.length === 0 || rawSteps.length > 8) throw new Error('planner_invalid_step_count');

  const steps = rawSteps.map((step, index) => {
    const validated = validateGroups(step?.tool_groups, allowedGroups, { allowCatalogDisconnected: unifiedDag });
    return {
      index,
      operation: String(step?.operation || `step_${index + 1}`).slice(0, 64),
      authority: step?.authority === 'write' ? 'write' : 'read',
      output_kind: ['knowledge', 'recipient', 'record', 'document', 'message', 'generic'].includes(step?.output_kind)
        ? step.output_kind : 'generic',
      tool_groups: validated.groups,
      connection_required: validated.connection_required,
      depends_on: normalizeDependencies(step?.depends_on, index),
      instruction: String(step?.message || '').slice(0, 2000),
      query: typeof step?.query === 'string' && step.query.trim() ? step.query.trim().slice(0, 500) : null,
      retrieval: step?.retrieval || null,
    };
  });

  // A recipient needed by a connected action must be resolved by that live
  // connector, not by mining arbitrary addresses from memory evidence. Repair
  // the planner edge structurally from the dependent step, without inspecting
  // user language or hard-coding a toolkit name.
  for (const step of steps) {
    if (step.output_kind !== 'recipient' || !step.tool_groups.some((group) => NATIVE_GROUPS.has(group))) continue;
    const dependentGroups = [...new Set(steps
      .filter((candidate) => candidate.depends_on.includes(step.index))
      .flatMap((candidate) => candidate.tool_groups)
      .filter((group) => !NATIVE_GROUPS.has(group) && connectedProviders.includes(group)))];
    if (dependentGroups.length === 1) step.tool_groups = dependentGroups;
  }
  return steps;
}

export async function planHostedComposioWorkflow({
  request,
  history = [],
  language = null,
  apiKey,
  signal,
  orgId,
  composio = null,
  parseIntent = null,
} = {}) {
  if (!parseIntent) {
    const progressive = await import('./chat-progressive-router.js');
    parseIntent = progressive.parseChatIntentProgressive;
  }
  const message = String(request || '').trim();
  if (!message) throw new Error('request_required');
  if (!orgId) throw new Error('org_scope_required');

  const composioSvc = composio || await import('../connectors/composio/composio-service.js');
  const accounts = await composioSvc.listConnectedAccounts(orgId);
  const connectedProviders = connectedProvidersFromAccounts(accounts);
  let parsed = null;
  let steps = null;
  let bestCandidate = null;
  let attempts = 0;
  let lastError = null;
  while (attempts < 2 && !steps) {
    attempts += 1;
    const auditHistory = attempts === 1 || !bestCandidate
      ? history
      : [
          ...(Array.isArray(history) ? history : []),
          {
            role: 'assistant',
            content: `PROPOSED_WORKFLOW (audit only; nothing executed): ${JSON.stringify(bestCandidate.steps.map((step) => ({
              operation: step.operation,
              authority: step.authority,
              output_kind: step.output_kind,
              tool_groups: step.tool_groups,
              depends_on: step.depends_on,
              instruction: step.instruction,
            })))}`,
          },
          {
            role: 'user',
            content: `Audit the proposed workflow against this exact original request: ${JSON.stringify(message)}. Return a corrected compound plan containing every requested retrieval and terminal action exactly once, with explicit dependencies. Preserve the requested application, artifact type, recipient, and action semantics; never substitute a different connected application or artifact. Do not answer the request and do not omit a requested action.`,
          },
        ];
    parsed = await parseIntent({
      message,
      history: auditHistory,
      language,
      apiKey,
      signal,
      useTools: true,
      connectedProviders,
      unifiedDag: isUseToolsUnifiedDagEnabled(),
      workflowPlanner: true,
    });
    if (parsed?.decision?._router_error) {
      lastError = new Error(`hosted_planner_router_failed:${parsed.decision._router_error}`);
      continue;
    }
    try {
      const candidateSteps = decisionToHostedPlan(parsed?.decision, {
        request: message,
        connectedProviders,
        unifiedDag: isUseToolsUnifiedDagEnabled(),
      });
      if (!bestCandidate || candidateSteps.length > bestCandidate.steps.length
        || (attempts > 1 && candidateSteps.length === bestCandidate.steps.length)) {
        bestCandidate = { steps: candidateSteps, parsed };
      }
      // Audit every first proposal once. Step-count validation alone cannot
      // detect a semantically substituted connector (for example, a Gmail
      // draft in place of a requested Google Doc). On the second pass prefer
      // an equally complete audited candidate, or retain the richer valid
      // candidate if the audit accidentally drops a step. This remains
      // language- and toolkit-general: the model compares semantic contracts
      // against the exact request rather than code matching provider words.
      if (attempts >= 2) {
        steps = bestCandidate.steps;
        parsed = bestCandidate.parsed;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!steps) throw lastError || new Error('hosted_planner_failed');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ orgId, message, connectedProviders, steps }))
    .digest('hex');

  return {
    version: 'hivemind-hosted-planner.v1',
    plan_id: `hp_${fingerprint.slice(0, 24)}`,
    request: message,
    connected_providers: connectedProviders,
    native_tools: HIVEMIND_HOSTED_TOOL_CARDS.map((tool) => tool.slug),
    steps,
    execution: {
      mode: 'sequential_dag',
      side_effects_executed: false,
      writes_require_approval: true,
    },
    usage: parsed?.usage || null,
    planner_attempts: attempts,
    _decision: parsed?.decision,
  };
}
