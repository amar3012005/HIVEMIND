#!/usr/bin/env node
import { reconcileRemoteVectors } from '../src/vector/mneme/vector-reconciler.js';

const orgId = process.env.ORG_ID || process.argv.find((arg) => arg.startsWith('--org='))?.slice(6);
const commit = process.argv.includes('--commit');
const batchArg = process.argv.find((arg) => arg.startsWith('--batch='));
if (!orgId) {
  console.error('Usage: ORG_ID=<uuid> node scripts/reconcile-remote-vectors.mjs [--commit] [--batch=20]');
  process.exit(2);
}

const result = await reconcileRemoteVectors(orgId, {
  commit,
  batchSize: batchArg ? Number(batchArg.slice(8)) : undefined,
});
console.log(JSON.stringify(result, null, 2));
if (commit && (result.memory.failed.length || result.evidence.failed.length)) process.exitCode = 1;
