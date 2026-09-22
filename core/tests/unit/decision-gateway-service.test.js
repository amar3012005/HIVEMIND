import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRuntimeStage, decisionGatewayProviderConfig, decisionGatewayToolNames } from '../../src/agent/decision-gateway-service.js';

test('OpenRouter JEV uses its typed Decisions API through Cloudflare Gateway', () => {
  const config = decisionGatewayProviderConfig({
    CLOUDFLARE_AI_GATEWAY_ENABLED: 'true',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_AI_GATEWAY_ID: 'gateway',
    CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
    JEV_GATEWAY_PROVIDER: 'custom-openrouter',
  });
  assert.equal(config.endpoint, 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-openrouter/api/alpha/decisions');
  assert.equal(config.model, 'typesafe/jev-1.13');
});

test('configured decision JEV provider keeps its Cloudflare-owned credential binding', () => {
  const config = decisionGatewayProviderConfig({
    CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
    JEV_GATEWAY_PROVIDER: 'custom-decision-jev', JEV_GATEWAY_BYOK_ALIAS: 'default',
  });
  assert.equal(config.headers['cf-aig-byok-alias'], undefined);
  assert.match(config.endpoint, /custom-decision-jev\/api\/v1\/systemone$/);
});
import { CAPABILITY_OPTIONS } from '../../src/agent/decision-gateway.js';

function provider(choice = 'option_0', probabilities = { option_0: 0.96, option_1: 0.04 }) {
  return {
    async decideChoice() {
      const ids = CAPABILITY_OPTIONS.map(option => option.id);
      const selected = Number(choice.split('_')[1]);
      return {
        choice: ids[selected], probability: probabilities[choice],
        margin: probabilities[choice] - Math.max(0, ...Object.entries(probabilities).filter(([key]) => key !== choice).map(([, value]) => value)),
        probabilities: Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [ids[Number(key.split('_')[1])], value])),
      };
    },
  };
}

test('off mode deterministically defers to the current selector', async () => {
  const result = await decideRuntimeStage({ stage: 'capability', user_query: 'hello' }, { env: {} });
  assert.deepEqual(result, { status: 'defer', mode: 'off', stage: 'capability', reason: 'decision_gateway_off' });
});

test('capability mapping returns only the schema family for the next model step', () => {
  assert.deepEqual(decisionGatewayToolNames('direct_answer'), []);
  assert.deepEqual(decisionGatewayToolNames('hivemind_meta'), ['hivemind_meta']);
  assert.deepEqual(decisionGatewayToolNames('hivemind_memory_lookup'), ['hivemind_meta']);
  assert.deepEqual(decisionGatewayToolNames('hivemind_entity_lookup'), ['hivemind_meta']);
  assert.deepEqual(decisionGatewayToolNames('hivemind_profile_update'), ['hivemind_update_profile']);
  assert.deepEqual(decisionGatewayToolNames('hivemind_save'), ['hivemind_save_memory', 'hivemind_batch_save_memories']);
  assert.deepEqual(decisionGatewayToolNames('composio_search'), ['hivemind_connected_task']);
  assert.deepEqual(decisionGatewayToolNames('composio_read'), ['hivemind_connected_task']);
  assert.deepEqual(decisionGatewayToolNames('composio_action'), ['hivemind_connected_task']);
  assert.deepEqual(decisionGatewayToolNames('web_research'), ['hivemind_web_search']);
  assert.equal(decisionGatewayToolNames('multi_task'), undefined);
  assert.equal(decisionGatewayToolNames('composio_search', { connected: false }), null);
  assert.equal(decisionGatewayToolNames('fallback_harness'), null);
});

test('shadow mode records a confident decision but is not authoritative', async () => {
  const result = await decideRuntimeStage({ stage: 'capability', user_query: 'hello', actor_id: 'user-1' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'shadow', JEV_DECISION_GATEWAY_USER_IDS: 'user-1' }, provider: provider(),
  });
  assert.equal(result.status, 'defer');
  assert.equal(result.selected, 'direct_answer');
  assert.equal(result.authoritative, false);
  assert.equal(result.receipt.source, 'jev');
});

test('active mode returns one accepted capability selection', async () => {
  const result = await decideRuntimeStage({ stage: 'capability', user_query: 'Find my last email', app_mentions: ['gmail'], actor_id: 'user-1' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active', JEV_DECISION_GATEWAY_USER_IDS: 'USER-1' }, provider: provider('option_11', { option_11: 0.98, option_0: 0.02 }),
  });
  assert.equal(result.status, 'selected');
  assert.equal(result.selected, 'composio_search');
  assert.equal(result.authoritative, true);
});

test('active mode reviews schema-bound connected-app arguments after selection', async () => {
  const result = await decideRuntimeStage({
    stage: 'composio_argument_review',
    user_query: 'Find newest records from Griseldis and return one.',
    actor_id: 'user-1',
    selected_tool: { slug: 'ANY_APP_SEARCH_RECORDS', toolkit: 'any-app', authority: 'read', schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
    proposed_arguments: { query: 'Griseldis', limit: 1 },
  }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active', JEV_DECISION_GATEWAY_USER_IDS: 'user-1' },
    provider: { async decideChoice() { return { choice: 'execute', probability: 0.98, margin: 0.97, probabilities: { execute: 0.98, regenerate: 0.01, ask_user: 0.01 } }; } },
  });
  assert.equal(result.status, 'selected');
  assert.equal(result.selected, 'execute');
  assert.equal(result.authoritative, true);
});

test('provider errors and low confidence stay fail-open to the current selector', async () => {
  const unavailable = await decideRuntimeStage({ stage: 'capability', user_query: 'Find my last email', actor_id: 'user-1' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active', JEV_DECISION_GATEWAY_USER_IDS: 'user-1' },
    provider: { async decideChoice() { throw new Error('provider_down'); } },
  });
  assert.equal(unavailable.status, 'defer');
  assert.equal(unavailable.authoritative, false);
  assert.equal(unavailable.receipt.source, 'fallback');
  assert.match(unavailable.receipt.reason, /provider_down/);

  const uncertain = await decideRuntimeStage({ stage: 'capability', user_query: 'Find it', actor_id: 'user-1' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active', JEV_DECISION_GATEWAY_USER_IDS: 'user-1' },
    provider: provider('option_0', { option_0: 0.51, option_1: 0.49 }),
  });
  assert.equal(uncertain.status, 'defer');
  assert.equal(uncertain.receipt.reason, 'decision_probability_below_threshold');
});

test('active mode is fail-closed to the authenticated actor allowlist', async () => {
  const missing = await decideRuntimeStage({ stage: 'capability', user_query: 'hello' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active' }, provider: provider(),
  });
  assert.equal(missing.status, 'defer');
  assert.equal(missing.reason, 'decision_gateway_allowlist_required');

  const denied = await decideRuntimeStage({ stage: 'capability', user_query: 'hello', actor_id: 'user-2' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active', JEV_DECISION_GATEWAY_USER_IDS: 'user-1' }, provider: provider(),
  });
  assert.equal(denied.status, 'defer');
  assert.equal(denied.reason, 'decision_gateway_actor_not_allowed');
});
