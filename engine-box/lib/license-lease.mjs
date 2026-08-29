import crypto from 'node:crypto';
import { evaluateLease } from './runtime-contract.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function verifyLicenseLease({ lease, signature, publicKey, installationId, now = Date.now() }) {
  if (!lease || lease.installation_id !== installationId) return { valid: false, mode: 'read_only', reason: 'installation_binding_invalid' };
  const verified = crypto.verify(null, Buffer.from(canonicalize(lease)), publicKey, Buffer.from(signature, 'base64'));
  if (!verified) return { valid: false, mode: 'read_only', reason: 'signature_invalid' };
  return evaluateLease({ expiresAt: lease.expires_at }, now);
}

export function authorizeLeaseOperation(leaseState, operation) {
  const protectedReadOnlyOperations = new Set(['recall', 'export', 'erase', 'backup', 'admin_status']);
  if (leaseState?.mode === 'full') return true;
  if (protectedReadOnlyOperations.has(operation)) return true;
  throw new Error(`license is read-only; ${operation} is unavailable until renewal`);
}
