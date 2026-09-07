#!/usr/bin/env node
/**
 * Rebuild every searchable Qdrant projection from canonical PostgreSQL rows.
 *
 * The two child jobs are independently idempotent because point IDs equal the
 * canonical Memory/KnowledgeSegment UUIDs. A partial failure exits non-zero so
 * automation cannot report a successful rebuild with incomplete coverage.
 *
 * Usage (inside hm-core):
 *   node /app/scripts/rebuild-qdrant-from-postgres.mjs --dry-run
 *   node /app/scripts/rebuild-qdrant-from-postgres.mjs --commit
 *   ORG_ID=<uuid> node /app/scripts/rebuild-qdrant-from-postgres.mjs --commit
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const commit = process.argv.includes('--commit');
const scripts = [
  new URL('./reembed-pg-to-qdrant.mjs', import.meta.url),
  new URL('./reembed-segments-to-qdrant.mjs', import.meta.url),
];

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(script), commit ? '--commit' : '--dry-run'], {
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${fileURLToPath(script)} failed (${signal || code})`));
    });
  });
}

for (const script of scripts) await run(script);
console.log(`[qdrant-rebuild] ${commit ? 'complete' : 'dry-run complete'}: memories + evidence`);
