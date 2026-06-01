#!/usr/bin/env node
/**
 * HIVEMIND Digital-Employee prompt tuner (AgentScope tune_prompt analogue,
 * our Groq stack).
 *
 * Pipeline:
 *   1. Load the employee from Prisma (persona = seed/init prompt, slug,
 *      roleArchetype) and derive the learning key.
 *   2. Read archive/evaluations/<key>_evals.jsonl, take the lowest-scoring
 *      rows as failure exemplars.
 *   3. PROPOSE: a Groq teacher (llama-3.3-70b-versatile) rewrites the persona
 *      into an improved system prompt, conditioned on the low-score examples
 *      and the role.
 *   4. A/B: run ~10 role tasks through Groq for BOTH the baseline persona and
 *      the candidate prompt, score each response with scoreResponse(), average.
 *   5. PROMOTE iff (variant_avg - baseline_avg > 0.03) AND variant_avg > 0.65:
 *      write the next-version VARIANT FILE per the shared contract. Always
 *      write an ab_test_results record. Print the JSON contract.
 *
 * Run via:
 *   node core/scripts/prompt-tune.mjs --employee <id>
 *
 * Env:
 *   DATABASE_URL   — required (Prisma)
 *   GROQ_API_KEY   — required (teacher + A/B completions)
 *   HIVEMIND_ARCHIVE_DIR — optional archive root override
 *
 * Best-effort with clear logs. Exit 0 on success, non-zero on hard failure.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getPrismaClient } from '../src/db/prisma.js';
// employeeLearningKey is NOT exported from hyper-state.js (module-local
// there); autonomous-scorer.js re-exports the identical logic. Import from
// there so the key derivation stays single-sourced.
import { employeeLearningKey, scoreResponse } from '../src/employees/autonomous-scorer.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const PROMOTE_DELTA = 0.03;
const PROMOTE_FLOOR = 0.65;
const N_LOW_EXAMPLES = 3;

// ── Shared-contract archive paths ───────────────────────────────────────
function archiveRoot() {
  return process.env.HIVEMIND_ARCHIVE_DIR || path.resolve(process.cwd(), 'archive');
}
function evalsFile(key) {
  return path.join(archiveRoot(), 'evaluations', `${key}_evals.jsonl`);
}
function variantsDir() {
  return path.join(archiveRoot(), 'prompt_variants');
}
function abResultsDir() {
  return path.join(archiveRoot(), 'ab_test_results');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// ── A/B role tasks (slim inline subset of tuning/task_generator.py) ─────
// 10 plausible role questions keyed by learning-key. Default falls back to
// the maya/coordinator set for non-core personas.
const ROLE_TASKS = {
  maya: [
    'The team disagrees: spend 2 months polishing feature X or launch now and iterate? What do you recommend?',
    'We have $100k budget. Do we invest in infrastructure, hire 2 engineers, or split both ways?',
    'Three projects compete for the same engineer. How do we decide?',
    'Launch with known bugs vs delay 2 weeks for fixes? What factors matter most?',
    'Incremental rollout (1% then 10% then 100%) or big bang? Your call?',
    'A core engineer is leaving mid-project. Backfill, redistribute, or delay?',
    'Two senior leads want opposite architectures. How do you broker a decision?',
    'Q4 deadline is tight and morale is dropping. How do you re-prioritise the roadmap?',
    'Beta with 100 users vs 1000 users — what are the trade-offs?',
    'Budget reverts at year end. Spend it on tooling, training, or contractors?',
  ],
  jonah: [
    'Everyone agrees we should expand internationally next quarter. What is your biggest concern?',
    'The team is unanimous that this architecture is sound. What could we be missing?',
    'Consensus says go all-in on machine learning. What is the downside?',
    'We are moving fast on payments integration. What could break in production?',
    'A 2-hour database migration window is planned. What is risky here?',
    'Leadership is enthusiastic and budget is allocated. What assumptions worry you?',
    'External advisors all agree with the plan. Where might they be wrong?',
    'We project 3x growth next year. What has to be true for that to hold?',
    'The vendor promises 99.99% uptime. What would you verify before trusting it?',
    'We are about to sign a 3-year contract. What is the worst case?',
  ],
  lina: [
    'What patterns in our churn data should drive the next retention experiment?',
    'Based on past launches, what predicts a successful feature rollout for us?',
    'Two cohorts behave differently. What does the evidence suggest is causing it?',
    'What similar companies have tried this, and what were the outcomes?',
    'Our conversion dipped 8% last month. What does the data point to?',
    'What historical trend should inform our pricing change?',
    'Which metric best correlates with long-term account expansion, and why?',
    'Given the A/B results so far, is the lift real or noise?',
    'What does the usage data say about which feature to deprecate?',
    'Summarise the evidence for and against entering the SMB segment.',
  ],
  eli: [
    'How would you implement a phased rollout of the new billing system?',
    'Lay out the timeline, resources, and dependencies to ship feature X in 6 weeks.',
    'What are the concrete steps to migrate the database with zero downtime?',
    'We need an MVP in 3 weeks. What is the build plan and what gets cut?',
    'Map the dependencies for integrating the third-party payments API.',
    'What resources and milestones are required to reach the Q3 launch?',
    'Break the platform rebuild into shippable increments with owners.',
    'How do you sequence the work so the critical path stays unblocked?',
    'Estimate the engineering effort and key risks for the search rewrite.',
    'Define the deployment steps and rollback plan for the next release.',
  ],
};

function tasksForKey(key) {
  return ROLE_TASKS[key] || ROLE_TASKS.maya;
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--employee') {
      out.employee = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

// ── Groq helpers ────────────────────────────────────────────────────────
async function groqComplete({ apiKey, system, user, temperature, maxTokens }) {
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: typeof temperature === 'number' ? temperature : 0.6,
      max_tokens: maxTokens || 512,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Groq ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// PROPOSE: ask the teacher to rewrite the persona using low-score examples.
async function proposeImprovedPrompt({ apiKey, persona, role, lowExamples }) {
  const sys = `You improve system prompts for AI digital employees. Output ONLY the improved persona system-prompt as plain text — no preamble, no markdown, no headers. Keep the employee's identity and role intact. Strengthen the instructions so responses are more consistent with the role, more complete, clearer, and deeper in reasoning. Address the employee in second person ("You are ...").`;

  const examplesBlock = lowExamples.length
    ? lowExamples
        .map((ex, i) => `Example ${i + 1} (score ${ex.score.toFixed(2)}):\nUser: ${String(ex.query || '').slice(0, 400)}\nWeak response: ${String(ex.response || '').slice(0, 600)}`)
        .join('\n\n')
    : '(no low-scoring evaluations available — improve generically for the role)';

  const user = `Role / archetype: ${role || 'generalist'}

Current persona system-prompt:
"""
${persona}
"""

The following past responses scored poorly. Diagnose what they lack (role consistency, completeness, clarity, depth) and rewrite the persona so future responses avoid these weaknesses:

${examplesBlock}

Write the improved persona now.`;

  return groqComplete({ apiKey, system: sys, user, temperature: 0.5, maxTokens: 600 });
}

// A/B: run all tasks through a given system prompt, score, return average.
async function runVariant({ apiKey, key, systemPrompt, tasks, label }) {
  const scores = [];
  for (const task of tasks) {
    let response = '';
    try {
      response = await groqComplete({
        apiKey,
        system: systemPrompt,
        user: task,
        temperature: 0.6,
        maxTokens: 512,
      });
    } catch (err) {
      console.error(`  [${label}] task failed (scored 0): ${err.message}`);
      scores.push(0);
      continue;
    }
    const { score } = scoreResponse({ key, query: task, response });
    scores.push(score);
  }
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return { avg, n: scores.length, scores };
}

// ── Evaluations ─────────────────────────────────────────────────────────
async function readLowEvals(key, limit) {
  let raw;
  try {
    raw = await fs.readFile(evalsFile(key), 'utf8');
  } catch {
    return [];
  }
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && typeof row.score === 'number');
  rows.sort((a, b) => a.score - b.score);
  return rows.slice(0, limit);
}

// ── Variant versioning ──────────────────────────────────────────────────
async function nextVariantVersion(key) {
  let files = [];
  try {
    files = await fs.readdir(variantsDir());
  } catch {
    files = [];
  }
  let max = 0;
  for (const name of files) {
    if (!name.startsWith(`${key}_tuning_v`) || !name.endsWith('.json')) continue;
    const m = name.match(/_v(\d+)_/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.employee) {
    console.error('Usage: node core/scripts/prompt-tune.mjs --employee <id>');
    process.exit(2);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY env var required');
    process.exit(2);
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    console.error('DATABASE_URL env var required (Prisma client unavailable)');
    process.exit(2);
  }

  let employee;
  try {
    employee = await prisma.digitalEmployee.findUnique({
      where: { id: args.employee },
      select: { id: true, name: true, slug: true, persona: true, roleArchetype: true },
    });
  } catch (err) {
    console.error(`Failed to load employee: ${err.message}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  if (!employee) {
    console.error(`Employee not found: ${args.employee}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  const key = employeeLearningKey(employee);
  const persona = String(employee.persona || '').trim();
  const role = employee.roleArchetype || key;
  const date = new Date().toISOString().slice(0, 10);

  console.log(`[prompt-tune] employee=${employee.name} (${employee.slug}) key=${key} role=${role}`);

  if (!persona) {
    console.error('Employee has empty persona — nothing to tune.');
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  // Step 2: low-scoring exemplars.
  const lowExamples = await readLowEvals(key, N_LOW_EXAMPLES);
  console.log(`[prompt-tune] loaded ${lowExamples.length} low-scoring evaluation example(s)`);

  // Step 3: PROPOSE candidate.
  let candidate;
  try {
    candidate = await proposeImprovedPrompt({ apiKey, persona, role, lowExamples });
  } catch (err) {
    console.error(`PROPOSE step failed: ${err.message}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
  if (!candidate) {
    console.error('Teacher returned empty candidate prompt.');
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
  console.log(`[prompt-tune] proposed candidate prompt (${candidate.length} chars)`);

  // Step 4: A/B over role tasks.
  const tasks = tasksForKey(key);
  console.log(`[prompt-tune] A/B over ${tasks.length} role tasks...`);
  let baseline;
  let variant;
  try {
    baseline = await runVariant({ apiKey, key, systemPrompt: persona, tasks, label: 'baseline' });
    variant = await runVariant({ apiKey, key, systemPrompt: candidate, tasks, label: 'variant' });
  } catch (err) {
    console.error(`A/B step failed: ${err.message}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  const baselineAvg = Number(baseline.avg.toFixed(4));
  const variantAvg = Number(variant.avg.toFixed(4));
  const delta = Number((variantAvg - baselineAvg).toFixed(4));
  const nTasks = tasks.length;
  console.log(`[prompt-tune] baseline=${baselineAvg} variant=${variantAvg} delta=${delta}`);

  // Step 5: PROMOTE decision.
  const promoted = delta > PROMOTE_DELTA && variantAvg > PROMOTE_FLOOR;
  const timestamp = new Date().toISOString();

  // Optimization level inferred from observed lift.
  const optimizationLevel = delta > 0.12 ? 'heavy' : delta > 0.06 ? 'medium' : 'light';

  let variantFile = null;
  if (promoted) {
    await ensureDir(variantsDir());
    const version = await nextVariantVersion(key);
    const fileName = `${key}_tuning_v${version}_${date}.json`;
    variantFile = path.join(variantsDir(), fileName);
    const variantRecord = {
      optimized_prompt: candidate,
      initial_prompt: persona,
      metrics: {
        baseline: baselineAvg,
        variant: variantAvg,
        delta,
        n_tasks: nTasks,
      },
      timestamp,
      optimization_level: optimizationLevel,
    };
    await fs.writeFile(variantFile, `${JSON.stringify(variantRecord, null, 2)}\n`, 'utf8');
    console.log(`[prompt-tune] PROMOTED — wrote ${variantFile}`);
  } else {
    console.log('[prompt-tune] NOT promoted (delta/floor gate not met)');
  }

  // Always write an ab_test_results record.
  await ensureDir(abResultsDir());
  const abFile = path.join(abResultsDir(), `${key}_${date}.json`);
  const abRecord = {
    key,
    employee_id: employee.id,
    slug: employee.slug,
    role,
    timestamp,
    promoted,
    baseline: baselineAvg,
    variant: variantAvg,
    delta,
    n_tasks: nTasks,
    promote_gate: { delta_min: PROMOTE_DELTA, floor: PROMOTE_FLOOR },
    optimization_level: optimizationLevel,
    low_example_count: lowExamples.length,
    initial_prompt: persona,
    optimized_prompt: candidate,
    baseline_scores: baseline.scores,
    variant_scores: variant.scores,
    variant_file: variantFile,
  };
  await fs.writeFile(abFile, `${JSON.stringify(abRecord, null, 2)}\n`, 'utf8');
  console.log(`[prompt-tune] wrote A/B record ${abFile}`);

  await prisma.$disconnect().catch(() => {});

  // Print contract.
  console.log(
    JSON.stringify({
      promoted,
      baseline: baselineAvg,
      variant: variantAvg,
      delta,
      variant_file: variantFile,
    }),
  );
}

main().catch(async (err) => {
  console.error(err);
  try {
    const p = getPrismaClient();
    if (p) await p.$disconnect();
  } catch {}
  process.exit(1);
});
