#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const legacyRolloutKeys = new Map([
  ['ENABLE_TOOLS_HITL', 'enable-tools-hitl'],
  ['USE_TOOLS_DURABLE_AGENT', 'use-tools-durable-agent'],
  ['PARTNER_REFERRALS_ENABLED', 'partner_referrals_v1'],
]);

const secretPattern = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|DSN)$/i;
const infrastructurePattern = /(?:URL|HOST|PORT|DATABASE|REDIS|QDRANT|S3|BUCKET|REGION|DOMAIN|ORIGIN|TIMEOUT|CACHE|LIMIT|WORKERS|CONCURRENCY|ENABLED)$/i;

function usage() {
  console.error('Usage: node scripts/audit-production-env.mjs <env-file>');
  process.exitCode = 64;
}

function keyFromLine(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1] || null;
}

function categoryFor(key) {
  if (legacyRolloutKeys.has(key)) return 'legacy_rollout_gate';
  if (secretPattern.test(key)) return 'secret';
  if (infrastructurePattern.test(key)) return 'infrastructure';
  return 'review';
}

const [envPath] = process.argv.slice(2);
if (!envPath) usage();
else {
  const source = await readFile(envPath, 'utf8');
  const categories = new Map();

  for (const line of source.split(/\r?\n/)) {
    const key = keyFromLine(line);
    if (!key) continue;
    const category = categoryFor(key);
    const entries = categories.get(category) || [];
    entries.push(key);
    categories.set(category, entries);
  }

  for (const [category, keys] of [...categories.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${category}: ${keys.length}`);
    for (const key of keys.sort()) {
      const flagshipKey = legacyRolloutKeys.get(key);
      console.log(flagshipKey ? `  ${key} -> Cloudflare Flagship: ${flagshipKey}` : `  ${key}`);
    }
  }

  const deprecated = categories.get('legacy_rollout_gate') || [];
  if (deprecated.length) {
    console.error(`\nRemove these boolean gates from the release env after this release is deployed: ${deprecated.join(', ')}`);
    process.exitCode = 2;
  }
}
