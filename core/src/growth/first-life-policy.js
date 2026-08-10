import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CURRENT_POLICY_VERSION = 9;
const cachedPolicies = new Map();

export async function loadFirstLifePolicy(version = CURRENT_POLICY_VERSION) {
  const selectedVersion = Number(version || CURRENT_POLICY_VERSION);
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(selectedVersion)) throw new Error(`first_life_policy_version_unavailable:${selectedVersion}`);
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
    effect_class: item.effect_class,
    external_action_requested: item.effect_class === 'external',
    activation_sprint_id: id,
    activation_slot: String(item.id) === recommendedId ? 'recommended' : 'adaptive',
  }));
  plan.first_life = {
    id,
    policy_id: policy.policy_id,
    policy_version: policy.version,
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
