#!/usr/bin/env node
/**
 * Eval-harness regression gate.
 *
 * Usage:
 *   node scripts/eval-gate.mjs                  # run harness, compare vs baseline.json
 *   node scripts/eval-gate.mjs --baseline       # write current run as new baseline
 *   node scripts/eval-gate.mjs --tolerance 1    # allow N fewer passes
 *
 * Exit codes:
 *   0 — no regression vs baseline (passes >= baseline.passes - tolerance,
 *       cost <= baseline.cost * 1.25, p95 <= baseline.p95 * 1.50)
 *   1 — regression detected (CI block)
 *   2 — eval-harness failed to run
 *
 * Baseline written to: scripts/eval-baseline.json
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, 'eval-baseline.json');
const HARNESS_PATH  = resolve(__dirname, 'eval-harness.mjs');

const args = process.argv.slice(2);
const writeBaseline = args.includes('--baseline');
const tolIdx = args.indexOf('--tolerance');
const tolerance = tolIdx >= 0 ? Math.max(0, parseInt(args[tolIdx + 1] || '0', 10)) : 0;

function runHarness() {
  // Harness exits non-zero when individual cases fail; we still want its
  // summary lines. spawnSync returns stdout regardless of exit code.
  const result = spawnSync('node', [HARNESS_PATH], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  const raw = (result.stdout || '') + '\n' + (result.stderr || '');
  if (result.error) throw result.error;
  // Parse summary lines from harness output
  const lines = raw.split('\n');
  let passed = null, total = null, cost = null, p95 = null;
  for (const l of lines) {
    const mPass = l.match(/Passed:\s*(\d+)\s*\/\s*(\d+)/);
    if (mPass) { passed = parseInt(mPass[1], 10); total = parseInt(mPass[2], 10); }
    const mCost = l.match(/Total cost:\s*\$?([\d.]+)/);
    if (mCost) cost = parseFloat(mCost[1]);
    const mP95 = l.match(/P95 latency:\s*(\d+)ms/);
    if (mP95) p95 = parseInt(mP95[1], 10);
  }
  if (passed === null || total === null) {
    throw new Error(`could not parse harness output:\n${raw.slice(-500)}`);
  }
  return { passed, total, cost: cost ?? 0, p95: p95 ?? 0, raw };
}

function compareToBaseline(current, baseline) {
  const failures = [];
  if (current.passed < baseline.passed - tolerance) {
    failures.push(`passes: ${current.passed} < ${baseline.passed} - ${tolerance}`);
  }
  if (current.cost > baseline.cost * 1.25) {
    failures.push(`cost: $${current.cost.toFixed(4)} > 1.25 × baseline $${baseline.cost.toFixed(4)}`);
  }
  if (current.p95 > baseline.p95 * 1.5) {
    failures.push(`p95: ${current.p95}ms > 1.5 × baseline ${baseline.p95}ms`);
  }
  return failures;
}

(async () => {
  let current;
  try {
    current = runHarness();
  } catch (err) {
    console.error('[eval-gate] harness failed:', err.message);
    process.exit(2);
  }

  if (writeBaseline) {
    const payload = {
      recorded_at: new Date().toISOString(),
      passed: current.passed,
      total: current.total,
      cost: current.cost,
      p95: current.p95,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2));
    console.log(`[eval-gate] baseline written → ${BASELINE_PATH}`);
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`[eval-gate] no baseline at ${BASELINE_PATH} — run with --baseline first`);
    process.exit(2);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  const failures = compareToBaseline(current, baseline);

  console.log(`[eval-gate] current: ${current.passed}/${current.total} pass, $${current.cost.toFixed(4)}, p95 ${current.p95}ms`);
  console.log(`[eval-gate] baseline: ${baseline.passed}/${baseline.total} pass, $${baseline.cost.toFixed(4)}, p95 ${baseline.p95}ms (tolerance ${tolerance})`);

  if (failures.length === 0) {
    console.log('[eval-gate] ✅ no regression');
    process.exit(0);
  }
  console.error('[eval-gate] ❌ regression detected:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
})();
