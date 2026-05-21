import fs from 'node:fs/promises';
import path from 'node:path';

const TUNING_THRESHOLD = 20;
const CORE_PERSONAS = ['maya', 'jonah', 'lina', 'eli'];

function employeeLearningKey(employee = {}) {
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
  const cwd = process.cwd();
  return path.resolve(cwd, '..', 'archive');
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
  return {
    ...employee,
    hyper,
    active_prompt_version: hyper.active_prompt_version,
  };
}

export async function enrichEmployeesWithHyperState(employees = []) {
  return Promise.all((employees || []).map((employee) => enrichEmployeeWithHyperState(employee)));
}
