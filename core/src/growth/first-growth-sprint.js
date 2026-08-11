import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const policyUrl = new URL('./fixtures/first-growth-sprint.v3.json', import.meta.url);
let cachedPolicy = null;

export async function loadFirstGrowthSprintPolicy() {
  if (!cachedPolicy) cachedPolicy = JSON.parse(await readFile(policyUrl, 'utf8'));
  return structuredClone(cachedPolicy);
}

function constraintFor(slot, constraints, fallbackId) {
  for (const type of slot.constraint_preferences || []) {
    const match = constraints.find((item) => item?.type === type);
    if (match) return match.id;
  }
  return fallbackId;
}

function sprintId(policy, context) {
  const identity = [policy.policy_id, policy.version, context?.baseline?.resource_id].map(String).join('\u0000');
  return `${policy.policy_id}.v${policy.version}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

export function applyFirstGrowthSprintPolicy(plan, context, policy) {
  if (!plan || plan.mode !== 'initial_full') return plan;
  const constraints = Array.isArray(plan.constraints) ? plan.constraints : [];
  const existing = Array.isArray(plan.operating_queue) ? plan.operating_queue : [];
  const availableRooms = new Set((context?.available_rooms || []).map((room) => room.room_tag));
  const companyTarget = {
    location: context?.company?.location || null,
    audience: context?.company?.icp || null,
    sector: context?.company?.industry || null,
    quantity: null,
  };
  const id = sprintId(policy, context);
  const required = (policy.required_slots || []).filter((slot) => availableRooms.has(slot.room_tag)).map((slot, index) => {
    const matching = existing.find((item) => item.room_tag === slot.room_tag && item.kind === slot.kind);
    const constraintId = matching?.constraint_id || constraintFor(slot, constraints, plan.primary_constraint_id);
    return {
      ...(matching || {}),
      id: matching?.id || `${slot.id}_${id.slice(-8)}`,
      constraint_id: constraintId,
      title: slot.title,
      kind: slot.kind,
      room_tag: slot.room_tag,
      objective: slot.objective,
      deliverable: slot.deliverable,
      success_measure: slot.success_measure,
      skills: slot.skills,
      requested_action: slot.requested_action,
      requested_terminal_outcome: slot.requested_terminal_outcome,
      external_action_requested: slot.external_action_requested === true,
      required_capabilities: matching?.required_capabilities || [],
      acceptance_criteria: slot.acceptance_criteria,
      priority: index + 1,
      position: index,
      activation_condition: 'Activate immediately after the first full baseline and Growth Operating Plan are committed.',
      target: Object.fromEntries(Object.entries({
        ...companyTarget,
        ...(matching?.target || {}),
        ...(slot.target || {}),
      }).map(([key, value]) => [key, value == null ? companyTarget[key] ?? null : value])),
      activation_sprint_id: id,
      activation_slot: slot.id,
      activation_authority_policy_keys: Array.isArray(slot.authority_policy_keys) ? slot.authority_policy_keys : [],
    };
  });
  const requiredIds = new Set(required.map((item) => item.id));
  const requiredRooms = new Set(required.map((item) => item.room_tag));
  const adaptive = existing.filter((item) => !requiredIds.has(item.id) && !requiredRooms.has(item.room_tag))
    .slice(0, Math.max(0, Number(policy.max_items || 4) - required.length));
  plan.operating_queue = [...required, ...adaptive].map((item, index) => ({
    ...item,
    priority: index + 1,
    position: index,
    activation_sprint_id: id,
      activation_slot: item.activation_slot || 'adaptive',
  }));
  if (required[0]) {
    plan.primary_constraint_id = required[0].constraint_id;
    plan.stage = {
      ...(plan.stage || {}),
      name: 'First Growth Sprint',
      objective: 'Establish visible market momentum through one governed awareness campaign, one qualified outreach motion, and the highest-value evidence-selected company work.',
      queue_item_id: required[0].id,
      duration_days: Math.max(7, Number(plan.stage?.duration_days || 7)),
      checkpoint_day: Math.max(1, Math.min(7, Number(plan.stage?.checkpoint_day || 7))),
    };
  }
  plan.activation_sprint = { id, policy_id: policy.policy_id, policy_version: policy.version, required_slots: required.map((item) => item.activation_slot) };
  return plan;
}
