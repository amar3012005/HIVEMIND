import crypto from 'node:crypto';
import fs from 'node:fs';

const DIGEST_IMAGE = /^[a-z0-9._-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/;
const RELEASE = /^[a-zA-Z0-9._-]{7,80}$/;
const SOURCE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KEY_ID = /^[a-zA-Z0-9._:-]{3,128}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const CHANNELS = new Set(['stable', 'canary']);
const V2_FIELDS = new Set([
  'version', 'release', 'channel', 'source_sha', 'created_at', 'valid_from', 'expires_at',
  'protocol_version', 'schema_version', 'image', 'required_capabilities', 'bundle_url',
  'bundle_sha256', 'key_id', 'public_key_sha256',
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalizeReleaseManifest(manifest) {
  return Buffer.from(`${JSON.stringify(canonicalValue(manifest))}\n`, 'utf8');
}

export function publicKeyFingerprint(key) {
  const publicKey = key instanceof crypto.KeyObject && key.type === 'public'
    ? key
    : crypto.createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('release signing key must be Ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function parseTimestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(`invalid ${field}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) fail(`invalid ${field}`);
  return timestamp;
}

function validateV1(manifest) {
  if (!RELEASE.test(manifest.release || '')) fail('invalid BYOD release identity');
  if (manifest.protocol_version !== 'memory-box.v1') fail('unsupported Memory Box protocol');
  if (!DIGEST_IMAGE.test(manifest.image || '')) fail('agent image must be pinned by sha256 digest');
  if (!Number.isFinite(Date.parse(manifest.created_at || ''))) fail('invalid release creation time');
  return manifest;
}

function validateV2(manifest, options) {
  const unknown = Object.keys(manifest).filter((field) => !V2_FIELDS.has(field));
  if (unknown.length) fail(`unknown BYOD release manifest field: ${unknown.sort()[0]}`);
  if (!RELEASE.test(manifest.release || '')) fail('invalid BYOD release identity');
  if (!CHANNELS.has(manifest.channel)) fail('invalid BYOD release channel');
  if (!SOURCE_SHA.test(manifest.source_sha || '')) fail('invalid BYOD source SHA');
  if (manifest.protocol_version !== 'memory-box.v1') fail('unsupported Memory Box protocol');
  if (!Number.isInteger(manifest.schema_version) || manifest.schema_version < 1) fail('invalid Memory Box schema version');
  if (!DIGEST_IMAGE.test(manifest.image || '')) fail('agent image must be pinned by sha256 digest');
  if (!SHA256.test(manifest.bundle_sha256 || '')) fail('invalid release bundle sha256');
  if (!KEY_ID.test(manifest.key_id || '')) fail('invalid release signing key id');
  if (!SHA256.test(manifest.public_key_sha256 || '')) fail('invalid release public key fingerprint');

  let bundleUrl;
  try { bundleUrl = new URL(manifest.bundle_url); } catch { fail('invalid release bundle URL'); }
  if (bundleUrl.protocol !== 'https:' || bundleUrl.username || bundleUrl.password || bundleUrl.hash) {
    fail('release bundle URL must be credential-free HTTPS');
  }

  if (!Array.isArray(manifest.required_capabilities) || manifest.required_capabilities.length === 0) {
    fail('required capabilities must be a non-empty array');
  }
  if (manifest.required_capabilities.some((item) => typeof item !== 'string' || !CAPABILITY.test(item))) {
    fail('invalid required capability');
  }
  const normalizedCapabilities = [...new Set(manifest.required_capabilities)].sort();
  if (normalizedCapabilities.length !== manifest.required_capabilities.length
      || normalizedCapabilities.some((item, index) => item !== manifest.required_capabilities[index])) {
    fail('required capabilities must be sorted and unique');
  }

  const createdAt = parseTimestamp(manifest.created_at, 'release creation time');
  const validFrom = manifest.valid_from === undefined
    ? createdAt
    : parseTimestamp(manifest.valid_from, 'release validity start');
  const expiresAt = manifest.expires_at === undefined
    ? null
    : parseTimestamp(manifest.expires_at, 'release expiry time');
  if (validFrom < createdAt) fail('release validity start predates creation');
  if (expiresAt !== null && expiresAt <= validFrom) fail('release expiry must follow validity start');

  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  if (!Number.isFinite(now)) fail('invalid verification time');
  if (options.enforceTime !== false && now < validFrom) fail('release is not yet valid');
  if (options.enforceTime !== false && expiresAt !== null && now >= expiresAt) fail('release has expired');
  if (options.allowedChannel !== undefined && manifest.channel !== options.allowedChannel) {
    fail(`release channel mismatch: expected ${options.allowedChannel}`);
  }

  const required = options.requiredCapabilities || [];
  if (!Array.isArray(required)) fail('verification requiredCapabilities must be an array');
  const offered = new Set(manifest.required_capabilities);
  const missing = required.filter((capability) => !offered.has(capability));
  if (missing.length) fail(`release is missing required capability: ${missing.sort()[0]}`);

  if (options.currentManifest) {
    const current = validateReleaseManifest(options.currentManifest, {
      ...options, currentManifest: undefined, enforceTime: false,
    });
    if (current.version === 2 && createdAt < Date.parse(current.created_at)) fail('release downgrade rejected');
    if (current.version === 2 && createdAt === Date.parse(current.created_at) && manifest.release !== current.release) {
      fail('conflicting release identity at current release time');
    }
  }
  return manifest;
}

export function validateReleaseManifest(manifest, options = {}) {
  if (!isObject(manifest)) fail('BYOD release manifest must be an object');
  if (manifest.version === 1 && options.allowLegacyV1 !== false) return validateV1(manifest);
  if (manifest.version !== 2) fail('unsupported BYOD release manifest version');
  return validateV2(manifest, options);
}

export function verifyReleaseManifest({
  manifestPath,
  signaturePath,
  publicKeyPath,
  allowLegacyV1 = true,
  allowedChannel,
  requiredCapabilities,
  currentManifest,
  now,
}) {
  const bytes = fs.readFileSync(manifestPath);
  const signature = fs.readFileSync(signaturePath);
  const publicKey = fs.readFileSync(publicKeyPath);
  if (!crypto.verify(null, bytes, publicKey, signature)) fail('BYOD release signature verification failed');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid BYOD release manifest JSON'); }
  const valid = validateReleaseManifest(manifest, {
    allowLegacyV1, allowedChannel, requiredCapabilities, currentManifest, now,
  });
  if (valid.version === 2) {
    const canonical = canonicalizeReleaseManifest(valid);
    if (bytes.length !== canonical.length || !crypto.timingSafeEqual(bytes, canonical)) {
      fail('release manifest is not canonical JSON');
    }
    if (valid.public_key_sha256 !== publicKeyFingerprint(publicKey)) {
      fail('release public key fingerprint mismatch');
    }
  }
  return valid;
}

export function signReleaseManifest(manifest, privateKey, options = {}) {
  const valid = validateReleaseManifest(manifest, { ...options, enforceTime: false });
  if (valid.version === 2 && valid.public_key_sha256 !== publicKeyFingerprint(privateKey)) {
    fail('release public key fingerprint does not match signing key');
  }
  const bytes = valid.version === 2
    ? canonicalizeReleaseManifest(valid)
    : Buffer.from(`${JSON.stringify(valid, null, 2)}\n`);
  return { bytes, signature: crypto.sign(null, bytes, privateKey) };
}
