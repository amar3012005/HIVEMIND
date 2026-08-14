import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('remote write rejects an HTTP 200 operation failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-ack-'));
  const registry = join(directory, 'agents.json');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'qdrant upsert 500' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const { remoteWrite } = await import(`../../src/vector/mneme/remote-backend.js?ack=${Date.now()}`);
  assert.equal(await remoteWrite('org', { id: 'memory-1' }, [0.1]), null);
});

test('remote read transport circuit bounds repeated recall timeouts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-circuit-'));
  const registry = join(directory, 'agents.json');
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    setTimeout(() => {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ results: [] }));
    }, 250);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  process.env.MNEME_REMOTE_TIMEOUT_MS = '50';
  process.env.MNEME_REMOTE_FAILURE_COOLDOWN_MS = '1000';
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const { remoteRecall } = await import(`../../src/vector/mneme/remote-backend.js?circuit=${Date.now()}`);

  const firstStarted = Date.now();
  assert.equal(await remoteRecall('org', [0.1], {}, 5, 0), null);
  const firstMs = Date.now() - firstStarted;
  const secondStarted = Date.now();
  assert.equal(await remoteRecall('org', [0.1], {}, 5, 0), null);
  const secondMs = Date.now() - secondStarted;

  assert.ok(firstMs >= 40, `first call should observe the transport timeout, got ${firstMs}ms`);
  assert.ok(secondMs < 30, `circuit should fail the repeated hop immediately, got ${secondMs}ms`);
  assert.equal(requests, 1);
});

test('reconciler repairs legacy unsynced memory rows without truncating content', async () => {
  const longContent = 'complete sovereign memory '.repeat(40);
  const writes = [];
  const { reconcileRemoteVectors } = await import('../../src/vector/mneme/vector-reconciler.js');
  const result = await reconcileRemoteVectors('org-1', {
    commit: true,
    deps: {
      remoteVectorStatus: async () => null,
      remoteVectorPending: async () => null,
      remoteList: async () => ({ memories: [{
        id: '11111111-1111-4111-8111-111111111111',
        content: longContent,
        layer: 'memory',
        is_latest: true,
        vector_synced: false,
      }], cursor: null }),
      embedService: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
      remoteWrite: async (_org, record, vector) => { writes.push({ record, vector }); return true; },
      remoteVectorRepair: async () => { throw new Error('legacy repair endpoint should not run'); },
      remoteKbSegment: async () => true,
    },
  });
  assert.equal(result.compatibility_mode, true);
  assert.equal(result.memory.repaired, 1);
  assert.equal(writes[0].record.content, longContent);
  assert.deepEqual(writes[0].vector, [0.1, 0.2]);
});

test('reconciler repairs memory and evidence returned by an upgraded agent', async () => {
  const calls = [];
  const { reconcileRemoteVectors } = await import('../../src/vector/mneme/vector-reconciler.js');
  const result = await reconcileRemoteVectors('org-2', {
    commit: true,
    deps: {
      remoteVectorStatus: async () => ({ ok: true }),
      remoteVectorPending: async (_org, { kind }) => ({ items: kind === 'memory'
        ? [{ id: '22222222-2222-4222-8222-222222222222', content: 'memory', layer: 'memory' }]
        : [{ id: '33333333-3333-4333-8333-333333333333', document_id: '44444444-4444-4444-8444-444444444444', content: 'evidence' }], cursor: null }),
      remoteList: async () => { throw new Error('legacy fallback should not run'); },
      embedService: { embed: async (texts) => texts.map(() => [0.3, 0.4]) },
      remoteWrite: async () => { calls.push('memory'); return true; },
      remoteVectorRepair: async (_org, { kind }) => { calls.push(kind); return true; },
      remoteKbSegment: async () => { calls.push('evidence'); return true; },
    },
  });
  assert.deepEqual(calls, ['memory', 'evidence']);
  assert.equal(result.memory.repaired, 1);
  assert.equal(result.evidence.repaired, 1);
});
