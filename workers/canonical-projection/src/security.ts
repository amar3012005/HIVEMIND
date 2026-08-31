const encoder = new TextEncoder();

export type SignedRequest = {
  body: string;
  headers: Record<string, string>;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signCoreRequest(
  secret: string,
  pathname: string,
  payload: unknown,
  timestamp = String(Math.floor(Date.now() / 1000)),
  nonce: string = crypto.randomUUID(),
): Promise<SignedRequest> {
  if (!secret) throw new Error('canonical_projection_hmac_secret_missing');
  const body = JSON.stringify(payload);
  const bodyDigest = await sha256(body);
  const canonical = `${timestamp}\n${nonce}\nPOST\n${pathname}\n${bodyDigest}`;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical));
  const signatureHex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-hivemind-timestamp': timestamp,
      'x-hivemind-nonce': nonce,
      'x-hivemind-content-sha256': bodyDigest,
      'x-hivemind-signature': `sha256=${signatureHex}`,
    },
  };
}
