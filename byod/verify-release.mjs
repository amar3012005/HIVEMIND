#!/usr/bin/env node
import fs from 'node:fs';
import { verifyReleaseManifest } from './release-contract.mjs';

try {
  const [manifestPath, signaturePath, publicKeyPath] = process.argv.slice(2);
  if (!manifestPath || !signaturePath || !publicKeyPath) {
    throw new Error('usage: verify-release.mjs MANIFEST SIGNATURE PUBLIC_KEY');
  }
  const currentPath = process.env.BYOD_CURRENT_RELEASE_MANIFEST;
  const currentManifest = currentPath ? JSON.parse(fs.readFileSync(currentPath, 'utf8')) : undefined;
  const requiredCapabilities = process.env.BYOD_REQUIRED_CAPABILITIES
    ? JSON.parse(process.env.BYOD_REQUIRED_CAPABILITIES)
    : undefined;
  const row = verifyReleaseManifest({
    manifestPath,
    signaturePath,
    publicKeyPath,
    allowLegacyV1: process.env.BYOD_ALLOW_LEGACY_RELEASE_V1 !== 'false',
    allowedChannel: process.env.BYOD_RELEASE_CHANNEL,
    requiredCapabilities,
    currentManifest,
    now: process.env.BYOD_RELEASE_NOW,
  });
  process.stdout.write(`${JSON.stringify(row)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
