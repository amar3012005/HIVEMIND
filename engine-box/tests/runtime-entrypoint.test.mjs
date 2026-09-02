import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const entrypoint = new URL('../runtime/hm-engine-entrypoint', import.meta.url).pathname;

test('runtime entrypoint URL-encodes a database secret before exporting DATABASE_URL', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-engine-box-'));
  const secret = path.join(directory, 'postgres_password');
  fs.writeFileSync(secret, 'contains:/?@reserved');
  const output = execFileSync('sh', [entrypoint, 'node', '-e', 'process.stdout.write(process.env.DATABASE_URL)'], {
    env: { ...process.env, DATABASE_PASSWORD_FILE: secret, DATABASE_HOST: 'postgres', DATABASE_NAME: 'hivemind' },
    encoding: 'utf8',
  });
  assert.match(output, /contains%3A%2F%3F%40reserved@postgres/);
  fs.rmSync(directory, { recursive: true, force: true });
});
