import crypto from 'crypto';

export function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function buildPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBase64Url(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
