import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOpsToolsManifest,
  invokeOpsTool,
} from '../../src/mcp/ops-release-gateway.js';

const env = {
  SINGULANCE_OPS_GATEWAY_URL: 'https://ops.example.test',
  SINGULANCE_OPS_GATEWAY_TOKEN: 'test-token',
};
const SHA = 'a'.repeat(40);
const DIGEST = `registry.example/hivemind/harness-chat@sha256:${'b'.repeat(64)}`;
const OPEN_DOT_IMAGE = `ghcr.io/amar3012005/open-dot-cloud@sha256:${'c'.repeat(64)}`;
const OPEN_DOT_SOURCE_SHA = 'd'.repeat(40);

test('Ops deployment tools are exposed only to configured operator MCP tokens', () => {
  assert.equal(getOpsToolsManifest({ isOperator: false, env }).length, 0);
  assert.equal(getOpsToolsManifest({ isOperator: true, env: {} }).length, 0);
  assert.deepEqual(
    getOpsToolsManifest({ isOperator: true, env }).map((tool) => tool.name),
    ['deploy_cloudflare_frontend', 'deploy_core_services', 'deploy_harness_runner', 'get_release_status'],
  );
});

test('Ops deployment calls forward exact release data to the gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ instanceId: 'release_123' }), { status: 202 });
  };
  const result = await invokeOpsTool('deploy_harness_runner', { sha: SHA, image: DIGEST }, {
    env,
    requestedBy: 'mcp:test',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.instanceId, 'release_123');
  assert.equal(calls[0].url, 'https://ops.example.test/v1/release');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    artifact: 'harness-runner', sha: SHA, image: DIGEST, requested_by: 'mcp:test',
  });
});

test('Open Dot deployment forwards an isolated immutable image and exact source SHA', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ instanceId: 'open_dot_123' }), { status: 202 });
  };
  const result = await invokeOpsTool('deploy_core_services', {
    sha: SHA, services: ['open-dot'], open_dot_image: OPEN_DOT_IMAGE,
    open_dot_source_sha: OPEN_DOT_SOURCE_SHA, note: 'Open Dot image update',
  }, { env, requestedBy: 'mcp:test', fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    artifact: 'open-dot', sha: SHA, services: ['open-dot'],
    open_dot_image: OPEN_DOT_IMAGE, open_dot_source_sha: OPEN_DOT_SOURCE_SHA,
    note: 'Open Dot image update', requested_by: 'mcp:test',
  });
});

test('existing Core service deployment request remains unchanged', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ instanceId: 'core_123' }), { status: 202 });
  };
  await invokeOpsTool('deploy_core_services', { sha: SHA, services: ['core', 'employees'] }, { env, fetchImpl });
  assert.deepEqual(JSON.parse(calls[0].body), {
    artifact: 'core-services', sha: SHA, services: ['core', 'employees'], requested_by: 'mcp-operator',
  });
});

test('Open Dot deployment rejects mixed services, missing or malformed image inputs, and unrelated inputs', async () => {
  const invoke = (args) => invokeOpsTool('deploy_core_services', { sha: SHA, ...args }, { env });
  for (const args of [
    { services: ['open-dot', 'core'], open_dot_image: OPEN_DOT_IMAGE, open_dot_source_sha: OPEN_DOT_SOURCE_SHA },
    { services: ['open-dot'], open_dot_image: OPEN_DOT_IMAGE },
    { services: ['open-dot'], open_dot_source_sha: OPEN_DOT_SOURCE_SHA },
    { services: ['open-dot'], open_dot_image: 'open-dot:latest', open_dot_source_sha: OPEN_DOT_SOURCE_SHA },
    { services: ['open-dot'], open_dot_image: OPEN_DOT_IMAGE, open_dot_source_sha: 'D'.repeat(40) },
    { services: ['core'], open_dot_image: OPEN_DOT_IMAGE, open_dot_source_sha: OPEN_DOT_SOURCE_SHA },
    { services: ['open-dot'], open_dot_image: OPEN_DOT_IMAGE, open_dot_source_sha: OPEN_DOT_SOURCE_SHA, image: DIGEST },
  ]) {
    const result = await invoke(args);
    assert.equal(result.ok, false, JSON.stringify(args));
  }
});

test('Ops deployment rejects mutable or malformed release identifiers', async () => {
  const result = await invokeOpsTool('deploy_cloudflare_frontend', { sha: 'main' }, { env });
  assert.equal(result.ok, false);
  assert.match(result.error, /40-character/);
  const runner = await invokeOpsTool('deploy_harness_runner', { sha: SHA, image: 'hivemind/harness:latest' }, { env });
  assert.equal(runner.ok, false);
  assert.match(runner.error, /immutable/);
});
