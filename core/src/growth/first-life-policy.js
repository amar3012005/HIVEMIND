import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CURRENT_POLICY_VERSION = 15;
const cachedPolicies = new Map();

export async function loadFirstLifePolicy(version = CURRENT_POLICY_VERSION) {
  const selectedVersion = Number(version || CURRENT_POLICY_VERSION);
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(selectedVersion)) throw new Error(`first_life_policy_version_unavailable:${selectedVersion}`);
  if (!cachedPolicies.has(selectedVersion)) {
    const policyUrl = new URL(`./fixtures/first-life-policy.v${selectedVersion}.json`, import.meta.url);
    cachedPolicies.set(selectedVersion, JSON.parse(await readFile(policyUrl, 'utf8')));
  }
  return structuredClone(cachedPolicies.get(selectedVersion));
}

function policyRunId(policy, context) {
  const identity = [policy.policy_id, policy.version, context?.baseline?.resource_id]
    .map(String).join('\u0000');
  return `${policy.policy_id}.v${policy.version}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

function hasEvidence(item, constraints, baselineId) {
  const constraint = constraints.find((row) => row?.id === item?.constraint_id);
  const refs = Array.isArray(constraint?.evidence_refs) ? constraint.evidence_refs : [];
  return Boolean(constraint && refs.length && (!baselineId || refs.includes(baselineId)));
}

export function applyFirstLifePolicy(plan, context, policy, lifecycleCatalog = []) {
  if (!plan || plan.mode !== 'initial_full') return plan;
  const baselineId = context?.baseline?.resource_id || null;
  const constraints = Array.isArray(plan.constraints) ? plan.constraints : [];
  const sourceQueue = Array.isArray(plan.operating_queue) ? plan.operating_queue : [];
  const maximum = Math.max(1, Number(policy.proposal_target || 4));
  const minimum = Math.max(1, Number(policy.proposal_minimum || 2));
  let queue = sourceQueue.filter((item) => hasEvidence(item, constraints, baselineId));
  const sequence = Array.isArray(policy.first_life_sequence) ? policy.first_life_sequence : [];
  if (sequence.length) {
    const sequenceByKind = new Map(sequence.map((entry, index) => [String(entry?.kind || '').trim(), { ...entry, index }])
      .filter(([kind]) => kind));
    const seenKinds = new Set();
    queue = queue.filter((item) => {
      const kind = String(item?.kind || '').trim();
      if (!sequenceByKind.has(kind) || !sequenceByKind.get(kind).unique) return true;
      if (seenKinds.has(kind)) return false;
      seenKinds.add(kind);
      return true;
    });
    for (const entry of sequence.filter((candidate) => candidate?.required === true)) {
      if (!queue.some((item) => String(item?.kind || '').trim() === String(entry.kind))) {
        throw new Error(`growth_plan_first_life_required_task_kind_missing:${entry.kind}`);
      }
    }
    queue.sort((left, right) => {
      const leftOrder = sequenceByKind.get(String(left?.kind || '').trim())?.index ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = sequenceByKind.get(String(right?.kind || '').trim())?.index ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder
        || Number(left?.position ?? left?.priority ?? 0) - Number(right?.position ?? right?.priority ?? 0);
    });
    queue = queue.map((item) => {
      const entry = sequenceByKind.get(String(item?.kind || '').trim());
      if (!entry) return item;
      return {
        ...item,
        objective: [item.objective, entry.workload_instruction].filter(Boolean).join('\n\n'),
        effect_class: entry.effect_class || item.effect_class,
        requested_terminal_outcome: entry.requested_terminal_outcome || item.requested_terminal_outcome,
      };
    });
    const recommended = queue.find((item) => sequenceByKind.get(String(item?.kind || '').trim())?.index === 0);
    if (recommended) {
      plan.stage = { ...plan.stage, name: recommended.title, objective: recommended.objective, queue_item_id: recommended.id };
      plan.primary_constraint_id = recommended.constraint_id;
    }
  }
  const selector = policy.initial_bootstrap_selector;
  if (selector?.metadata_flag) {
    const eligible = new Set(lifecycleCatalog.filter((entry) => entry?.[selector.metadata_flag] === true
      && (!selector.effect_class || entry.effect_class === selector.effect_class))
      .map((entry) => `${entry.playbook_id}@${Number(entry.version)}`));
    queue = queue.filter((item) => eligible.has(`${item.playbook_id}@${Number(item.playbook_version)}`));
    if (!queue.length) throw new Error('growth_plan_first_life_bootstrap_lifecycle_required');
  }
  queue = queue.slice(0, maximum);
  if (queue.length < minimum) throw new Error('first_life_evidenced_proposals_required');

  const recommendedId = String(plan.stage?.queue_item_id || '');
  if (!recommendedId || !queue.some((item) => String(item.id) === recommendedId)) {
    throw new Error('first_life_recommended_proposal_required');
  }

  const id = policyRunId(policy, context);
  plan.operating_queue = queue.map((item, index) => ({
    ...item,
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index + 1,
    position: index,
    first_life_policy_id: policy.policy_id,
    first_life_policy_version: policy.version,
    recommendation_rank: index + 1,
    proposal_kind: item.kind || null,
    effect_class: item.effect_class,
    external_action_requested: item.effect_class === 'external',
    execution_defaults: policy.execution_defaults || null,
    activation_sprint_id: id,
    activation_slot: String(item.id) === recommendedId ? 'recommended' : 'adaptive',
    ...(policy.runtime_selects_lifecycle === true ? {
      room_tag: null,
      playbook_id: null,
      playbook_version: null,
      requested_action: null,
    } : {}),
  }));
  plan.first_life = {
    id,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    runtime_selects_lifecycle: policy.runtime_selects_lifecycle === true,
    recommended_todo_source_id: recommendedId,
    proposal_count: plan.operating_queue.length,
  };
  // Temporary compatibility projection for clients that still read activation_sprint.
  plan.activation_sprint = {
    id,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    required_slots: [],
  };
  return plan;
}
