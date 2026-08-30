import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signCoreRequest } from '../src/security';

describe('Core callback authentication', () => {
  it('signs timestamp, nonce, method, path, and exact body digest', async () => {
    const path = '/internal/canonical-projection/v1/memories/74fb72fc-08da-41cc-8c56-598eae67bfee/stages/load';
    const signed = await signCoreRequest('test-secret', path, { memory_id: '74fb72fc-08da-41cc-8c56-598eae67bfee' }, '1788112800', 'nonce-1');
    const digest = createHash('sha256').update(signed.body).digest('hex');
    const expected = createHmac('sha256', 'test-secret').update(`1788112800\nnonce-1\nPOST\n${path}\n${digest}`).digest('hex');
    expect(signed.headers['x-hivemind-content-sha256']).toBe(digest);
    expect(signed.headers['x-hivemind-signature']).toBe(`sha256=${expected}`);
  });

  it('refuses to issue unsigned callbacks', async () => {
    await expect(signCoreRequest('', '/callback', {})).rejects.toThrow('canonical_projection_hmac_secret_missing');
  });
});
