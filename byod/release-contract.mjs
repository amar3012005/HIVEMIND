import crypto from 'node:crypto';
import fs from 'node:fs';

// OCI/Docker image reference pinned by digest. A private registry may use an
// explicit numeric port (for example registry.customer.example:5000).
const DIGEST_IMAGE = /^[a-z0-9._-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/;
const RELEASE = /^[a-zA-Z0-9._-]{7,80}$/;

export function validateReleaseManifest(manifest) {
  if (manifest?.version !== 1) throw new Error('unsupported BYOD release manifest version');
  if (!RELEASE.test(manifest.release || '')) throw new Error('invalid BYOD release identity');
  if (manifest.protocol_version !== 'memory-box.v1') throw new Error('unsupported Memory Box protocol');
  if (!DIGEST_IMAGE.test(manifest.image || '')) throw new Error('agent image must be pinned by sha256 digest');
  if (!Number.isFinite(Date.parse(manifest.created_at || ''))) throw new Error('invalid release creation time');
  return manifest;
}

export function verifyReleaseManifest({ manifestPath, signaturePath, publicKeyPath }) {
  const bytes = fs.readFileSync(manifestPath);
  const signature = fs.readFileSync(signaturePath);
  const publicKey = fs.readFileSync(publicKeyPath);
  if (!crypto.verify(null, bytes, publicKey, signature)) throw new Error('BYOD release signature verification failed');
  return validateReleaseManifest(JSON.parse(bytes.toString('utf8')));
}

export function signReleaseManifest(manifest, privateKey) {
  const valid = validateReleaseManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(valid, null, 2)}\n`);
  return { bytes, signature: crypto.sign(null, bytes, privateKey) };
}
