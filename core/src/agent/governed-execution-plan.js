import { capabilityRelevance, isProviderIdentifier } from './governed-agent-contract.js';

const asText = (value, limit = 800) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const unique = values => [...new Set((values || []).map(value => asText(value, 160)).filter(Boolean))];

export function normalizeConnectionState(value) {
  const raw = asText(typeof value === 'string' ? value : (value?.status || value?.connection_status || value?.state), 80).toLowerCase();
  if (/(active|connected|ready)/.test(raw)) return 'connected';
  if (/(pending|initiated|waiting)/.test(raw)) return 'pending';
  if (/(expired|revoked|invalid)/.test(raw)) return 'expired';
  if (/(disconnected|missing|not[_ -]?connected|inactive)/.test(raw)) return 'disconnected';
  return 'unknown';
}

function candidateSource(slug, discovery = {}) {
  if ((discovery.primary_tool_slugs || []).includes(slug)) return 'composio_primary';
  if ((discovery.related_tool_slugs || []).includes(slug)) return 'composio_related';
  return 'catalog';
}

function candidatesFor(outcome, capabilities = [], discovery = {}) {
  const authority = outcome.kind === 'draft' ? 'write' : 'read';
  return capabilities
    .filter(card => card?.slug && card.authority === authority)
    .map(card => {
      const source = card.source === 'core' ? 'core' : candidateSource(card.slug, discovery);
      const sourceRank = source === 'composio_primary' ? 0 : source === 'core' ? 1 : source === 'composio_related' ? 2 : 3;
      const relevance = capabilityRelevance(card, { intent: { outcomes: [outcome], discovery_query: outcome.description } });
      const unresolvedProviderInputs = (card.required || []).filter(isProviderIdentifier).length;
      return {
        tool_slug: card.slug,
        toolkit: card.toolkit || null,
        source,
        // A top-level outcome should not start with a detail/follow-up tool
        // whose required provider identifier has no receipt yet. Keep it as a
        // fallback candidate, but rank directly executable capabilities first.
        rank: sourceRank * 100 - relevance + unresolvedProviderInputs * 250,
        schema_status: card.schema ? 'valid' : 'unknown',
        status: 'available',
        attempts: 0,
        failure_code: null,
      };
    })
    .sort((left, right) => left.rank - right.rank || left.tool_slug.localeCompare(right.tool_slug));
}

export function compileExecutionPlan({ intent, capabilities = [], discovery = {}, previous = null, reason = 'initial_compile' } = {}) {
  const priorNodes = new Map((previous?.nodes || []).map(node => [node.id, node]));
  const outcomes = intent?.outcomes || [];
  const readOutcomeIds = outcomes.filter(outcome => outcome.kind !== 'draft').map(outcome => asText(outcome.id, 80));
  const nodes = outcomes.map((outcome, index) => {
    const id = asText(outcome.id || `outcome_${index + 1}`, 80);
    const prior = priorNodes.get(id);
    const freshCandidates = candidatesFor(outcome, capabilities, discovery);
    const priorCandidates = new Map((prior?.candidates || []).map(candidate => [candidate.tool_slug, candidate]));
    const candidates = freshCandidates.map(candidate => ({ ...candidate, ...(priorCandidates.get(candidate.tool_slug) || {}) }));
    const selected = candidates.find(candidate => candidate.status === 'available') || null;
    return {
      id,
      kind: outcome.kind === 'draft' ? 'draft_write' : 'read',
      outcome_ids: [id],
      description: asText(outcome.description, 600),
      // Mutation outcomes consume verified read evidence. This establishes a
      // generic data dependency without teaching the planner about any app.
      depends_on: unique(prior?.depends_on || (outcome.kind === 'draft' ? readOutcomeIds.filter(value => value !== id) : [])),
      required_evidence: outcome.evidence || null,
      candidates,
      selected_candidate: prior?.selected_candidate || null,
      attempts: Number(prior?.attempts || 0),
      max_attempts: 3,
      status: prior?.status === 'completed' ? 'completed' : (!selected ? 'blocked' : 'ready'),
      receipt_refs: unique(prior?.receipt_refs || []),
      blocked_reason: !selected ? 'no_candidate' : null,
    };
  });
  return {
    version: Math.max(1, Number(previous?.version || 0) + 1),
    status: nodes.every(node => node.status === 'completed') ? 'completed' : 'running',
    revision_reason: reason,
    outcomes: (intent?.outcomes || []).map(outcome => ({
      id: outcome.id, kind: outcome.kind, description: outcome.description, evidence: outcome.evidence || null,
    })),
    nodes,
  };
}

export function revisePlanConnection(plan, toolkit, state) {
  if (!plan) return plan;
  const normalizedToolkit = asText(toolkit, 80).toLowerCase();
  const connectionState = normalizeConnectionState(state);
  return {
    ...plan,
    version: Number(plan.version || 0) + 1,
    revision_reason: `connection_${connectionState}`,
    nodes: (plan.nodes || []).map(node => {
      const selected = (node.candidates || []).find(candidate => candidate.tool_slug === node.selected_candidate)
        || (node.candidates || []).find(candidate => candidate.status === 'available');
      if (String(selected?.toolkit || '').toLowerCase() !== normalizedToolkit || node.status === 'completed') return node;
      return {
        ...node,
        status: connectionState === 'connected' ? 'ready' : 'waiting_connection',
        blocked_reason: connectionState === 'connected' ? null : `connection_${connectionState}`,
      };
    }),
  };
}

export function revisePlanHumanInput(plan, fieldNames = []) {
  if (!plan) return plan;
  return {
    ...plan,
    version: Number(plan.version || 0) + 1,
    revision_reason: 'human_input_received',
    supplied_fields: unique([...(plan.supplied_fields || []), ...fieldNames]),
    nodes: (plan.nodes || []).map(node => node.status === 'waiting_input'
      ? { ...node, status: 'ready', blocked_reason: null }
      : node),
  };
}

export function nextPlanNode(plan) {
  if (!plan) return null;
  const completed = new Set((plan.nodes || []).filter(node => node.status === 'completed').map(node => node.id));
  return (plan.nodes || []).find(node => node.status !== 'completed'
    && (node.depends_on || []).every(id => completed.has(id))) || null;
}

export function schedulePlan(plan) {
  const node = nextPlanNode(plan);
  if (!node) return { action: 'done', node: null, candidate: null };
  const candidate = (node.candidates || []).find(item => item.tool_slug === node.selected_candidate && item.status === 'available')
    || (node.candidates || []).find(item => item.status === 'available') || null;
  if (node.status === 'waiting_connection') return { action: 'connect', node, candidate };
  if (node.status === 'waiting_input') return { action: 'ask', node, candidate };
  if (!candidate) return { action: 'blocked', node, candidate: null };
  return { action: node.kind === 'draft_write' ? 'draft' : 'read', node, candidate };
}

export function scheduleExecutionDecision({ plan, capabilities = [], receipts = [], dependencyRequirements = [], dependencyResolved = false } = {}) {
  if (dependencyRequirements.length && !dependencyResolved) {
    const attempted = new Set(receipts.map(row => row?.slug).filter(Boolean));
    const candidate = capabilities
      .filter(card => card?.source !== 'core' && card?.authority === 'read' && !attempted.has(card.slug))
      .map(card => {
        const acceptsSemanticInput = (card.fields || Object.keys(card.schema?.properties || {}))
          .some(field => /^(?:query|search_query|search_term|term|name)$/i.test(String(field)));
        return {
          card,
          relevance: capabilityRelevance(card, { missing: dependencyRequirements }),
          inputRank: acceptsSemanticInput ? 0 : 1,
        };
      })
      .sort((left, right) => left.inputRank - right.inputRank || right.relevance - left.relevance || left.card.slug.localeCompare(right.card.slug))
      .find(item => item.relevance > 0);
    if (candidate) return {
      action: 'read', tool_slug: candidate.card.slug, purpose: 'prerequisite', outcome_ids: [],
      reason: 'Highest-ranked discovered read capability for the persisted schema dependency.',
    };
  }
  const scheduled = schedulePlan(plan);
  if (scheduled.action === 'draft' && scheduled.candidate && receipts.some(receipt => receipt?.successful)) {
    return {
      action: 'draft', tool_slug: scheduled.candidate.tool_slug, purpose: 'outcome',
      outcome_ids: scheduled.node.outcome_ids || [],
      reason: 'Persisted plan candidate is ready after prerequisite evidence resolved.',
    };
  }
  return null;
}

export function markPlanNodeRunning(plan, nodeId, toolSlug) {
  if (!plan) return plan;
  return {
    ...plan,
    nodes: (plan.nodes || []).map(node => node.id !== nodeId ? node : {
      ...node,
      status: 'running',
      selected_candidate: toolSlug,
      attempts: Number(node.attempts || 0) + 1,
      candidates: (node.candidates || []).map(candidate => candidate.tool_slug === toolSlug
        ? { ...candidate, attempts: Number(candidate.attempts || 0) + 1 }
        : candidate),
    }),
  };
}

export function settlePlanNode(plan, { nodeId, toolSlug, receiptRef = null, successful = false, evidenceSufficient = false, failureCode = null } = {}) {
  if (!plan) return plan;
  const nodes = (plan.nodes || []).map(node => {
    if (node.id !== nodeId) return node;
    const completed = successful && evidenceSufficient;
    const candidates = (node.candidates || []).map(candidate => candidate.tool_slug !== toolSlug ? candidate : {
      ...candidate,
      status: completed ? 'succeeded' : 'exhausted',
      failure_code: completed ? null : (failureCode || (successful ? 'insufficient_evidence' : 'execution_failed')),
    });
    const alternate = candidates.find(candidate => candidate.status === 'available');
    return {
      ...node,
      status: completed ? 'completed' : (alternate ? 'ready' : 'blocked'),
      selected_candidate: completed ? toolSlug : (alternate?.tool_slug || null),
      blocked_reason: completed ? null : (alternate ? null : (failureCode || 'candidates_exhausted')),
      receipt_refs: receiptRef ? unique([...(node.receipt_refs || []), receiptRef]) : (node.receipt_refs || []),
      candidates,
    };
  });
  return {
    ...plan,
    status: nodes.every(node => node.status === 'completed') ? 'completed' : 'running',
    nodes,
  };
}

export function markPlanNodeWaitingInput(plan, nodeId, reason = 'business_input_required') {
  if (!plan) return plan;
  return {
    ...plan,
    nodes: (plan.nodes || []).map(node => node.id === nodeId
      ? { ...node, status: 'waiting_input', blocked_reason: reason }
      : node),
  };
}

export function reopenPlanOutcomes(plan, outcomeIds = [], reason = 'outcome_evidence_incomplete') {
  if (!plan) return plan;
  const wanted = new Set(outcomeIds || []);
  return {
    ...plan,
    status: 'running',
    version: Number(plan.version || 0) + 1,
    revision_reason: reason,
    nodes: (plan.nodes || []).map(node => {
      if (!(node.outcome_ids || []).some(id => wanted.has(id))) return node;
      const candidates = (node.candidates || []).map(candidate => candidate.tool_slug === node.selected_candidate
        ? { ...candidate, status: 'exhausted', failure_code: reason }
        : candidate);
      const alternate = candidates.find(candidate => candidate.status === 'available');
      return {
        ...node,
        candidates,
        selected_candidate: alternate?.tool_slug || null,
        status: alternate ? 'ready' : 'blocked',
        blocked_reason: alternate ? null : reason,
      };
    }),
  };
}
