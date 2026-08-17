#!/usr/bin/env node
import { verifyReleaseManifest } from './release-contract.mjs';

try {
  const [manifestPath, signaturePath, publicKeyPath] = process.argv.slice(2);
  if (!manifestPath || !signaturePath || !publicKeyPath) {
    throw new Error('usage: verify-release.mjs MANIFEST SIGNATURE PUBLIC_KEY');
  }
  const row = verifyReleaseManifest({ manifestPath, signaturePath, publicKeyPath });
  process.stdout.write(`${JSON.stringify(row)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
