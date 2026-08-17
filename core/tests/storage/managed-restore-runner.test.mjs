import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(TEST_DIR, '../../../infra/scripts/singulance-restore-drill.sh');

test('scheduled managed restore runner records a receipt only after a successful isolated drill', { skip: process.platform !== 'linux' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-managed-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); const scripts = path.join(repo, 'scripts');
  const backups = path.join(root, 'backups'); const receipts = path.join(root, 'receipts');
  fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(backups);
  const bundle = path.join(backups, 'test.hmstorage'); fs.writeFileSync(bundle, 'ciphertext');
  const keyFile = path.join(root, 'key.env');
  fs.writeFileSync(keyFile, `STORAGE_BACKUP_ENCRYPTION_KEY=${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(scripts, 'storage-bundle-crypto.mjs'), `
import fs from 'node:fs'; fs.mkdirSync(process.argv[4],{recursive:true});
`);
  fs.writeFileSync(path.join(scripts, 'storage-restore-drill.sh'), `#!/usr/bin/env bash
printf '%s\\n' '{"ok":true,"mode":"managed","postgres_tables":2,"qdrant_collections":1}'
`, { mode: 0o700 });
  const output = execFileSync('bash', [RUNNER], {
    env: {
      ...process.env,
      REPO_ROOT: repo,
      BACKUP_DIR: backups,
      RESTORE_DRILL_RECEIPT_DIR: receipts,
      MANAGED_BACKUP_KEY_FILE: keyFile,
      RESTORE_DRILL_LOCK_FILE: path.join(root, 'runner.lock'),
    },
    encoding: 'utf8',
  });
  assert.match(output, /"ok":true/);
  const files = fs.readdirSync(receipts).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(receipts, files[0]), 'utf8'));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.result.postgres_tables, 2);
  assert.match(receipt.bundle_sha256, /^[a-f0-9]{64}$/);
});
