import { createHash } from 'node:crypto';
import { parseChatIntentProgressive } from './chat-progressive-router.js';

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

function validateGroups(groups, allowedGroups) {
  const normalized = [...new Set((Array.isArray(groups) ? groups : [])
    .map((group) => String(group || '').trim().toLowerCase())
    .filter(Boolean))];
  if (normalized.length !== 1) throw new Error('planner_step_requires_exactly_one_tool_group');
  if (!allowedGroups.has(normalized[0])) throw new Error(`planner_selected_unavailable_tool_group:${normalized[0]}`);
  return normalized;
}

export function decisionToHostedPlan(decision, { request, connectedProviders = [] } = {}) {
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

  return rawSteps.map((step, index) => ({
    index,
    operation: String(step?.operation || `step_${index + 1}`).slice(0, 64),
    authority: step?.authority === 'write' ? 'write' : 'read',
    output_kind: ['knowledge', 'recipient', 'record', 'document', 'message', 'generic'].includes(step?.output_kind)
      ? step.output_kind : 'generic',
    tool_groups: validateGroups(step?.tool_groups, allowedGroups),
    depends_on: normalizeDependencies(step?.depends_on, index),
    instruction: String(step?.message || '').slice(0, 2000),
    query: typeof step?.query === 'string' && step.query.trim() ? step.query.trim().slice(0, 500) : null,
    retrieval: step?.retrieval || null,
  }));
}

export async function planHostedComposioWorkflow({
  request,
  history = [],
  language = null,
  apiKey,
  signal,
  orgId,
  composio = null,
  parseIntent = parseChatIntentProgressive,
} = {}) {
  const message = String(request || '').trim();
  if (!message) throw new Error('request_required');
  if (!orgId) throw new Error('org_scope_required');

  const composioSvc = composio || await import('../connectors/composio/composio-service.js');
  const accounts = await composioSvc.listConnectedAccounts(orgId);
  const connectedProviders = connectedProvidersFromAccounts(accounts);
  let parsed = null;
  let steps = null;
  let attempts = 0;
  let lastError = null;
  while (attempts < 2 && !steps) {
    attempts += 1;
    parsed = await parseIntent({
      message,
      history,
      language,
      apiKey,
      signal,
      useTools: true,
      connectedProviders,
      workflowPlanner: true,
    });
    if (parsed?.decision?._router_error) {
      lastError = new Error(`hosted_planner_router_failed:${parsed.decision._router_error}`);
      continue;
    }
    try {
      steps = decisionToHostedPlan(parsed?.decision, { request: message, connectedProviders });
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
