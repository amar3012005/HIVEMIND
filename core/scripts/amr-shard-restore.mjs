#!/usr/bin/env node
// Offline restore of one org's .amr shard from a snapshot produced by shard-backup.js's
// snapshotAllOpenShards/snapshotOrg (dir name pattern: <orgDirName>-<timestampMs>/).
//
// This is deliberately an OFFLINE recovery operation, not a live-swap: run it against a dataRoot
// no running hm-core process is currently serving ORG_ID from (stop the server, or evict/restart
// after a targeted eviction — restoreOrg() itself refuses if the shard is open in the CALLING
// process, but cannot see or stop a *different* process holding the flock).
//
//   ORG_ID=<org> SNAPSHOT_DIR=/path/to/backup/org_xyz-1734000000000 node amr-shard-restore.mjs
//   ORG_ID=<org> SNAPSHOT_DIR=... node amr-shard-restore.mjs --commit   # actually writes; default is dry-run
import fs from 'node:fs';
import { restoreOrg } from '../src/vector/mneme/shard-backup.js';

const orgId = process.env.ORG_ID;
const srcSnapshotDir = process.env.SNAPSHOT_DIR;
const dataRoot = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const commit = process.argv.includes('--commit');

if (!orgId) throw new Error('ORG_ID is required');
if (!srcSnapshotDir) throw new Error('SNAPSHOT_DIR is required');
if (!fs.existsSync(srcSnapshotDir)) throw new Error(`SNAPSHOT_DIR does not exist: ${srcSnapshotDir}`);

const files = fs.readdirSync(srcSnapshotDir);
console.log(`[amr-restore] org=${orgId} snapshot=${srcSnapshotDir} files=${files.join(',')}`);
console.log(`[amr-restore] target dataRoot=${dataRoot}`);

if (!commit) {
  console.log('[amr-restore] DRY RUN — no files written. Re-run with --commit to actually restore.');
  console.log('[amr-restore] Before --commit: confirm no live hm-core process currently serves this org.');
  process.exit(0);
}

const result = restoreOrg(orgId, { dataRoot, srcSnapshotDir });
console.log(`[amr-restore] restored org=${result.orgId} -> ${result.destDir}`);
console.log('[amr-restore] Next: (re)start the process that serves this org, then verify via /api/security or a recall smoke test.');
