import assert from 'node:assert/strict';
import test from 'node:test';
import { assertActivationRecord, createSetupRecord, redactSetupRecord, validateSetupInput } from '../lib/setup-contract.mjs';

function validInput() {
  return {
    oidc: {
      issuer: 'https://id.customer.example', client_id: 'engine-box', client_secret: 'secret',
      redirect_url: 'https://engine.customer.example/oauth2/callback', group_mapping: { owner: ['hivemind-owners'] },
    },
    model_routes: {
      embedding: { execution: 'local', base_url: 'https://models.customer.example/v1', model: 'embed-v1', dimension: 1024, api_key: 'embed-secret' },
      rerank: { execution: 'local', base_url: 'https://models.customer.example/v1', model: 'rerank-v1', api_key: 'rerank-secret' },
      chat: { execution: 'local', base_url: 'https://models.customer.example/v1', model: 'chat-v1', api_key: 'chat-secret' },
    },
    backup: { destination: 's3://customer-backups/hivemind', encryption_key_reference: 'kms://customer/engine-box' },
  };
}

test('local setup requires OIDC, three local model capabilities, and encrypted backups', () => {
  assert.equal(validateSetupInput(validInput()), true);
  assert.throws(() => validateSetupInput({ ...validInput(), model_routes: { ...validInput().model_routes, chat: { ...validInput().model_routes.chat, execution: 'cloudflare_gateway' } } }), /must be local/);
});

test('setup records redact credentials and cannot activate without a functional canary receipt', () => {
  const record = createSetupRecord(validInput());
  const redacted = redactSetupRecord(record);
  assert.equal(JSON.stringify(redacted).includes('embed-secret'), false);
  assert.throws(() => assertActivationRecord(record, {}), /functional canary/);
  assert.equal(assertActivationRecord(record, { state: 'passed', receipt_id: 'canary-1' }), true);
});
