import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  isSealedOutboxPayload, openOutboxPayload, redactedOutboxPayload, sealOutboxPayload,
} from '../../src/memory/outbox-crypto.js';

test('outbox replay envelopes are authenticated and contain no plaintext content', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const payload = { record: { id: 'm1', content: 'unique sovereign plaintext' }, vector: [0.1, 0.2] };
  const sealed = sealOutboxPayload(payload, { key, requireEncryption: true });
  assert.equal(isSealedOutboxPayload(sealed), true);
  assert.equal(JSON.stringify(sealed).includes('unique sovereign plaintext'), false);
  assert.deepEqual(openOutboxPayload(sealed, { keys: [key] }), payload);

  const tampered = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}AA` };
  assert.throws(() => openOutboxPayload(tampered, { keys: [key] }));
});

test('key rotation decrypts with retained keys and acknowledgement removes replay content', () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  const newKey = crypto.randomBytes(32).toString('base64');
  const payload = { patch: { content: 'rotatable' } };
  const sealed = sealOutboxPayload(payload, { key: oldKey, requireEncryption: true });
  assert.deepEqual(openOutboxPayload(sealed, { keys: [newKey, oldKey] }), payload);
  assert.deepEqual(redactedOutboxPayload(), { v: 1, redacted: true });
});

test('required encryption fails closed without a configured key', () => {
  const previousPrimary = process.env.PUSH_OUTBOX_ENCRYPTION_KEY;
  const previousFallbacks = process.env.PUSH_OUTBOX_DECRYPTION_KEYS;
  delete process.env.PUSH_OUTBOX_ENCRYPTION_KEY;
  delete process.env.PUSH_OUTBOX_DECRYPTION_KEYS;
  try {
    assert.throws(
      () => sealOutboxPayload({ content: 'never plaintext' }, { requireEncryption: true }),
      /no key is configured/,
    );
  } finally {
    if (previousPrimary === undefined) delete process.env.PUSH_OUTBOX_ENCRYPTION_KEY;
    else process.env.PUSH_OUTBOX_ENCRYPTION_KEY = previousPrimary;
    if (previousFallbacks === undefined) delete process.env.PUSH_OUTBOX_DECRYPTION_KEYS;
    else process.env.PUSH_OUTBOX_DECRYPTION_KEYS = previousFallbacks;
  }
});
