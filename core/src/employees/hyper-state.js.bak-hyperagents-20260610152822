import fs from 'node:fs/promises';
import path from 'node:path';

const TUNING_THRESHOLD = 20;
const CORE_PERSONAS = ['maya', 'jonah', 'lina', 'eli'];

const ROLE_LANE_MAP = {
  coordinator: 'Strategist',
  strategist: 'Strategist',
  operator: 'Strategist',
  synthesizer: 'Strategist',
  investigator: 'Researcher',
  researcher: 'Researcher',
  analyst: 'Researcher',
  skeptic: 'Skeptic',
  critic: 'Skeptic',
  challenger: 'Skeptic',
  auditor: 'Skeptic',
  builder: 'Builder',
  engineer: 'Builder',
  developer: 'Builder',
  architect: 'Builder',
  communicator: 'Communicator',
  writer: 'Communicator',
  marketer: 'Communicator',
  advocate: 'Communicator',
  fact_checker: 'Researcher',
};

const PERSONA_CONTRACTS = {
  Strategist: {
    decision_style: 'Sequences choices, forces tradeoffs, and keeps the room pointed at a clear next move.',
    stance: 'Keeps direction, sequencing, and execution pressure visible.',
    blind_spots: ['Can over-smooth dissent', 'May privilege alignment over hard risk'],
    challenge_targets: ['Skeptic', 'Builder'],
    future_skills: ['scenario planning', 'portfolio prioritization', 'facilitated decision making'],
    quality_gate: ['Requires a concrete goal, owner, and decision path before committing.'],
  },
  Builder: {
    decision_style: 'Decomposes ideas into shippable steps, dependencies, and implementation risks.',
    stance: 'Pushes the room toward a buildable answer.',
    blind_spots: ['Can underweight ambiguity', 'May compress tradeoffs too early'],
    challenge_targets: ['Skeptic', 'Strategist'],
    future_skills: ['system design', 'delivery planning', 'operational hardening'],
    quality_gate: ['Requires clear scope, interfaces, and the smallest useful next step.'],
  },
  Skeptic: {
    decision_style: 'Red-teams assumptions, hunts for failure modes, and makes hidden risk explicit.',
    stance: 'Challenges weak evidence and pushes back on wishful thinking.',
    blind_spots: ['Can over-index on failure', 'May slow momentum if the room is already aligned'],
    challenge_targets: ['Strategist', 'Builder', 'Communicator'],
    future_skills: ['adversarial review', 'risk modeling', 'enterprise diligence'],
    quality_gate: ['Requires a concrete claim to challenge and evidence to support the pushback.'],
  },
  Researcher: {
    decision_style: 'Pulls together context, memory, and evidence before the room commits.',
    stance: 'Anchors discussion in what has already been learned.',
    blind_spots: ['Can over-collect evidence', 'May stall on uncertainty'],
    challenge_targets: ['Strategist', 'Communicator'],
    future_skills: ['source synthesis', 'market analysis', 'memory reasoning'],
    quality_gate: ['Requires a specific question and enough context to compare evidence.'],
  },
  Communicator: {
    decision_style: 'Translates the room into clear language for customers, partners, and the broader org.',
    stance: 'Keeps the answer legible and usable by real people.',
    blind_spots: ['Can soften hard calls', 'May oversimplify the tradeoffs'],
    challenge_targets: ['Strategist', 'Builder'],
    future_skills: ['executive framing', 'customer storytelling', 'stakeholder alignment'],
    quality_gate: ['Requires an audience and an outcome to frame the message correctly.'],
  },
};

function normalizeContractValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (value == null) {
    return [];
  }
  return [String(value).trim()].filter(Boolean);
}

function roleToLane(roleArchetype = '', employee = {}) {
  const existing = String(roleArchetype || '').trim().toLowerCase();
  if (ROLE_LANE_MAP[existing]) return ROLE_LANE_MAP[existing];
  const haystack = [
    employee.name || '',
    employee.slug || '',
    employee.persona || '',
    roleArchetype || '',
  ].join(' ').toLowerCase();
  if (/(finance|cfo|budget|runway|margin|pricing)/.test(haystack)) return 'Strategist';
  if (/(sales|market|customer|support|story|copy|brand|partner)/.test(haystack)) return 'Communicator';
  if (/(risk|security|compliance|audit|critic|challenge|skeptic)/.test(haystack)) return 'Skeptic';
  if (/(research|evidence|analy|insight|study|data|market)/.test(haystack)) return 'Researcher';
  if (/(build|ship|engineer|code|infra|platform|product)/.test(haystack)) return 'Builder';
  return 'Strategist';
}

export function buildPersonaContract(employee = {}) {
  const roleArchetype = String(employee.roleArchetype || '').trim().toLowerCase();
  const lane = roleToLane(roleArchetype, employee);
  const preset = PERSONA_CONTRACTS[lane] || PERSONA_CONTRACTS.Strategist;
  const policyRules = typeof employee.policyRules === 'object' && employee.policyRules
    ? employee.policyRules
    : {};
  const policyContract = typeof policyRules.persona_contract === 'object' && policyRules.persona_contract
    ? policyRules.persona_contract
    : {};
  const peerReviewTargets = normalizeContractValue(
    employee.peerReviewTargets || policyRules.peer_review_targets || policyContract.challenge_targets,
  );
  const challengeTargets = normalizeContractValue(
    policyContract.challenge_targets?.length ? policyContract.challenge_targets : peerReviewTargets,
  );
  const allowedScope = String(
    policyContract.allowed_scope || employee.scope || 'organization',
  ).toLowerCase();
  const contextHome = String(
    policyContract.context_home || (allowedScope === 'organization' ? 'org' : allowedScope),
  ).toLowerCase();

  return {
    persona_name: employee.name || employee.slug || 'employee',
    role_archetype: roleArchetype || null,
    lane,
    decision_style: policyContract.decision_style || preset.decision_style,
    stance: policyContract.stance || preset.stance,
    blind_spots: normalizeContractValue(policyContract.blind_spots?.length ? policyContract.blind_spots : preset.blind_spots),
    challenge_targets: challengeTargets.length ? challengeTargets : preset.challenge_targets,
    context_home: contextHome,
    allowed_scope: allowedScope,
    future_skills: normalizeContractValue(policyContract.future_skills?.length ? policyContract.future_skills : preset.future_skills),
    quality_gate: normalizeContractValue(policyContract.quality_gate?.length ? policyContract.quality_gate : preset.quality_gate),
    peer_review_targets: peerReviewTargets,
  };
}

export function formatPersonaContract(contract = {}) {
  const stance = contract.stance ? `- Stance: ${contract.stance}` : '';
  const style = contract.decision_style ? `- Decision style: ${contract.decision_style}` : '';
  const blindSpots = Array.isArray(contract.blind_spots) && contract.blind_spots.length
    ? `- Blind spots: ${contract.blind_spots.join('; ')}`
    : '';
  const targets = Array.isArray(contract.challenge_targets) && contract.challenge_targets.length
    ? `- Challenge targets: ${contract.challenge_targets.join(', ')}`
    : '';
  const context = contract.context_home ? `- Context home: ${contract.context_home}` : '';
  const scope = contract.allowed_scope ? `- Allowed scope: ${contract.allowed_scope}` : '';
  const gate = Array.isArray(contract.quality_gate) && contract.quality_gate.length
    ? `- Quality gate: ${contract.quality_gate.join(' | ')}`
    : '';
  return [
    'PERSONA CONTRACT',
    stance,
    style,
    blindSpots,
    targets,
    context,
    scope,
    gate,
  ].filter(Boolean).join('\n');
}

export function employeeLearningKey(employee = {}) {
  const slug = String(employee.slug || '').toLowerCase();
  const name = String(employee.name || '').toLowerCase();
  const firstToken = name.split(/\s+/).filter(Boolean)[0] || '';

  for (const key of CORE_PERSONAS) {
    if (slug.startsWith(key) || firstToken === key || slug.includes(`${key}-`)) {
      return key;
    }
  }

  return slug || firstToken || 'employee';
}

function archiveRoot() {
  return process.env.HIVEMIND_ARCHIVE_DIR || path.resolve(process.cwd(), 'archive');
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeReadFile(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function countEvaluations(key) {
  const file = path.join(archiveRoot(), 'evaluations', `${key}_evals.jsonl`);
  const raw = await safeReadFile(file);
  if (!raw) return 0;
  return raw.split('\n').filter((line) => line.trim()).length;
}

async function latestVariantFor(key) {
  const dir = path.join(archiveRoot(), 'prompt_variants');
  const files = (await safeReaddir(dir))
    .filter((name) => name.startsWith(`${key}_tuning_`) && name.endsWith('.json'))
    .sort()
    .reverse();

  for (const file of files) {
    const raw = await safeReadFile(path.join(dir, file));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      return {
        file,
        timestamp: parsed.timestamp || null,
        optimizedPrompt: parsed.optimized_prompt || null,
        initialPrompt: parsed.initial_prompt || null,
        metrics: parsed.metrics || {},
        optimizationLevel: parsed.optimization_level || null,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function buildState({ evaluationCount, variant }) {
  if (variant?.optimizedPrompt) return 'optimized';
  if (evaluationCount >= TUNING_THRESHOLD) return 'ready_for_tuning';
  if (evaluationCount > 0) return 'collecting_feedback';
  return 'baseline';
}

function buildVersionLabel({ variant }) {
  if (!variant?.optimizedPrompt) return 'v0';
  const match = String(variant.file || '').match(/_v(\d+)_/i);
  if (match) return `v${match[1]}`;
  return 'v1';
}

export async function deriveEmployeeHyperState(employee = {}) {
  const key = employeeLearningKey(employee);
  const [evaluationCount, variant] = await Promise.all([
    countEvaluations(key),
    latestVariantFor(key),
  ]);

  const state = buildState({ evaluationCount, variant });
  const progressPct = Math.min(100, Math.round((evaluationCount / TUNING_THRESHOLD) * 100));
  const activePrompt = variant?.optimizedPrompt || employee.persona || '';

  return {
    learning_key: key,
    state,
    state_label: {
      baseline: 'Baseline',
      collecting_feedback: 'Collecting feedback',
      ready_for_tuning: 'Ready for tuning',
      optimized: 'Optimized',
    }[state],
    evaluation_count: evaluationCount,
    tuning_threshold: TUNING_THRESHOLD,
    progress_pct: progressPct,
    source: variant?.optimizedPrompt ? 'prompt_tune' : 'seed',
    active_prompt_version: {
      version_label: buildVersionLabel({ variant }),
      source: variant?.optimizedPrompt ? 'prompt_tune' : 'seed',
      timestamp: variant?.timestamp || null,
      optimization_level: variant?.optimizationLevel || null,
      system_prompt: activePrompt,
      metrics: variant?.metrics || {},
    },
  };
}

export async function enrichEmployeeWithHyperState(employee = {}) {
  const hyper = await deriveEmployeeHyperState(employee);
  const persona_contract = buildPersonaContract(employee);
  return {
    ...employee,
    hyper: {
      ...hyper,
      persona_contract,
    },
    persona_contract,
    active_prompt_version: hyper.active_prompt_version,
  };
}

export async function enrichEmployeesWithHyperState(employees = []) {
  return Promise.all((employees || []).map((employee) => enrichEmployeeWithHyperState(employee)));
}
