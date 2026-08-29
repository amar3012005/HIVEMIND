#!/usr/bin/env node
// CI-only bundler. Customer machines receive only this small operational bundle
// and immutable OCI layers; this never includes a git checkout or source tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [outputPath, catalogPath, catalogSignaturePath] = process.argv.slice(2);
if (!outputPath || !catalogPath || !catalogSignaturePath) throw new Error('usage: node build-bundle.mjs bundle.tar.gz model-catalog.json model-catalog.sig');
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-box-bundle-'));
try {
  for (const file of ['compose.yaml', '.env.example']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  fs.cpSync(path.join(root, 'edge'), path.join(temp, 'edge'), { recursive: true });
  fs.copyFileSync(catalogPath, path.join(temp, 'model-catalog.json'));
  fs.copyFileSync(catalogSignaturePath, path.join(temp, 'model-catalog.sig'));
  // release.pub is supplied by the offline signer after build; an empty bundle
  // must not pass release verification and is intentionally rejected by install.
  const entries = fs.readdirSync(temp).sort();
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', path.resolve(outputPath), ...entries], { cwd: temp, stdio: 'inherit' });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
