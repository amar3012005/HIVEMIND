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
  await assert.rejects(remoteRecall('org', [0.1], {}, 5, 0), { code: 'REMOTE_MEMORY_UNAVAILABLE' });
  const firstMs = Date.now() - firstStarted;
  const secondStarted = Date.now();
  await assert.rejects(remoteRecall('org', [0.1], {}, 5, 0), { code: 'REMOTE_MEMORY_UNAVAILABLE' });
  const secondMs = Date.now() - secondStarted;

  assert.ok(firstMs >= 40, `first call should observe the transport timeout, got ${firstMs}ms`);
  assert.ok(secondMs < 30, `circuit should fail the repeated hop immediately, got ${secondMs}ms`);
  assert.equal(requests, 1);
});

test('the per-tenant read bulkhead queues bounded excess work instead of self-rejecting', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-bulkhead-'));
  const registry = join(directory, 'agents.json');
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    setTimeout(() => {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ results: [] }));
    }, 80);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  process.env.MNEME_REMOTE_TIMEOUT_MS = '500';
  process.env.MNEME_REMOTE_MAX_INFLIGHT_PER_ORG = '2';
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const { remoteRecall } = await import(`../../src/vector/mneme/remote-backend.js?bulkhead=${Date.now()}`);

  const first = remoteRecall('org', [0.1], {}, 5, 0);
  const second = remoteRecall('org', [0.2], {}, 5, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const third = remoteRecall('org', [0.3], {}, 5, 0);
  assert.deepEqual(await Promise.all([first, second, third]), [[], [], []]);
  assert.equal(requests, 3);
});

test('identical interactive recall requests share one bounded Memory Box operation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-coalesce-'));
  const registry = join(directory, 'agents.json');
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ id: 'same' }] }));
    }, 35);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  process.env.MNEME_REMOTE_TIMEOUT_MS = '500';
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const { remoteRecall } = await import(`../../src/vector/mneme/remote-backend.js?coalesce=${Date.now()}`);

  const results = await Promise.all([
    remoteRecall('org', [0.1, 0.2], { user: 'u' }, 5, 0),
    remoteRecall('org', [0.1, 0.2], { user: 'u' }, 5, 0),
    remoteRecall('org', [0.1, 0.2], { user: 'u' }, 5, 0),
  ]);
  assert.deepEqual(results, [[{ id: 'same' }], [{ id: 'same' }], [{ id: 'same' }]]);
  assert.equal(requests, 1);
});

test('maintenance failures use a separate circuit and cannot open chat recall', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-maintenance-'));
  const registry = join(directory, 'agents.json');
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/vector-status') {
      setTimeout(() => {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: true }));
      }, 150);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ id: 'interactive' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  process.env.MNEME_REMOTE_TIMEOUT_MS = '35';
  process.env.MNEME_REMOTE_FAILURE_COOLDOWN_MS = '1000';
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const { remoteRecall, remoteVectorStatus } = await import(`../../src/vector/mneme/remote-backend.js?maintenance=${Date.now()}`);

  assert.equal(await remoteVectorStatus('org', { transportClass: 'maintenance' }), null);
  assert.deepEqual(await remoteRecall('org', [0.1], {}, 5, 0), [{ id: 'interactive' }]);
});

test('meeting recovery polling cannot consume the interactive recall slot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-meeting-maintenance-'));
  const registry = join(directory, 'agents.json');
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/meeting-session-pending') {
      setTimeout(() => {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ sessions: [] }));
      }, 120);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ id: 'interactive' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  process.env.MNEME_REMOTE_MAX_INFLIGHT_PER_ORG = '1';
  process.env.MNEME_REMOTE_MAX_MAINTENANCE_INFLIGHT_PER_ORG = '1';
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const { remoteMeetingSessionPending, remoteRecall } = await import(
    `../../src/vector/mneme/remote-backend.js?meeting-maintenance=${Date.now()}`
  );

  const pending = remoteMeetingSessionPending('org', 5);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const startedAt = Date.now();
  assert.deepEqual(await remoteRecall('org', [0.1], {}, 5, 0), [{ id: 'interactive' }]);
  assert.ok(Date.now() - startedAt < 80, 'interactive recall must not queue behind meeting recovery');
  assert.deepEqual(await pending, []);
});

test('an upstream stage deadline aborts remote IO without poisoning the transport circuit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-parent-deadline-'));
  const registry = join(directory, 'agents.json');
  let requests = 0;
  let closedRequests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.on('close', () => { if (!res.writableEnded) closedRequests += 1; });
    setTimeout(() => {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ results: [] }));
    }, requests === 1 ? 300 : 5);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  process.env.MNEME_REMOTE_TIMEOUT_MS = '1000';
  process.env.MNEME_REMOTE_FAILURE_COOLDOWN_MS = '1000';
  await writeFile(registry, JSON.stringify({ org: { url: `http://127.0.0.1:${server.address().port}`, token: 'token' } }));
  const [{ remoteRecall }, { runWithStageDeadline }] = await Promise.all([
    import(`../../src/vector/mneme/remote-backend.js?parent-deadline=${Date.now()}`),
    import('../../src/runtime/stage-deadline.js'),
  ]);

  const bounded = await runWithStageDeadline(
    () => remoteRecall('org', [0.1], {}, 5, 0),
    { timeoutMs: 35, fallback: null, label: 'remote-parent-test' },
  );
  assert.equal(bounded, null);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(closedRequests, 1, 'the abandoned HTTP request should be actively closed');

  const recovered = await remoteRecall('org', [0.1], {}, 5, 0);
  assert.deepEqual(recovered, []);
  assert.equal(requests, 2, 'upstream cancellation must not open the Memory Box circuit');
});

test('reconciler repairs legacy unsynced memory rows without truncating content', async () => {
  const longContent = 'complete sovereign memory '.repeat(40);
  const writes = [];
  const { reconcileRemoteVectors } = await import('../../src/vector/mneme/vector-reconciler.js');
  const result = await reconcileRemoteVectors('org-1', {
    commit: true,
    deps: {
      remoteCapabilities: async () => null,
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
      remoteCapabilities: async () => ({ capabilities: ['vector.status', 'vector.pending', 'vector.repair'] }),
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

test('a persistently stale box is quarantined from scheduled maintenance without disabling user traffic', async () => {
  const {
    recordRemoteMaintenanceFailure,
    recordRemoteMaintenanceSuccess,
    remoteMaintenanceStatus,
  } = await import('../../src/vector/mneme/vector-reconciler.js');
  const org = `stale-${Date.now()}`;
  recordRemoteMaintenanceFailure(org, { now: 1_000, threshold: 3, quarantineMs: 10_000 });
  recordRemoteMaintenanceFailure(org, { now: 2_000, threshold: 3, quarantineMs: 10_000 });
  assert.equal(remoteMaintenanceStatus(org, 2_500).quarantined, false);
  const third = recordRemoteMaintenanceFailure(org, { now: 3_000, threshold: 3, quarantineMs: 10_000 });
  assert.equal(third.quarantined_until, 13_000);
  assert.equal(remoteMaintenanceStatus(org, 4_000).quarantined, true);
  assert.equal(remoteMaintenanceStatus(org, 13_001).quarantined, false, 'quarantine must allow a later recovery probe');
  recordRemoteMaintenanceSuccess(org);
  assert.deepEqual(remoteMaintenanceStatus(org, 14_000), {
    failures: 0,
    quarantined: false,
    quarantined_until: null,
  });
});

test('maintenance quarantine is persisted in the agent registry and survives module reloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-durable-quarantine-'));
  const registry = join(directory, 'agents.json');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  await writeFile(registry, JSON.stringify({
    org: { url: 'http://100.64.0.1:8787', token: 'token', kind: 'selfhost' },
  }));

  const first = await import(`../../src/vector/mneme/remote-backend.js?durable-a=${Date.now()}`);
  assert.deepEqual(first.remoteAgentOrgIds(), ['org']);
  assert.equal(first.quarantineRemoteAgentMaintenance('org', Date.now() + 60_000), true);

  const second = await import(`../../src/vector/mneme/remote-backend.js?durable-b=${Date.now()}`);
  assert.deepEqual(second.remoteAgentOrgIds(), []);
  assert.ok(second.agentFor('org'), 'interactive routing must retain the registered agent');
  assert.equal(second.clearRemoteAgentMaintenanceQuarantine('org'), true);
  assert.deepEqual(second.remoteAgentOrgIds(), ['org']);
});

test('agent routing refreshes an existing tenant after the broker rewrites its projection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-remote-projection-refresh-'));
  const registry = join(directory, 'agents.json');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  await writeFile(registry, JSON.stringify({
    org: { url: 'http://100.64.0.1:8787', token: 'old-token', kind: 'selfhost' },
  }));

  const backend = await import(`../../src/vector/mneme/remote-backend.js?projection-refresh=${Date.now()}`);
  assert.equal(backend.agentFor('org').token, 'old-token');

  // The production loader intentionally limits stat calls to one every two seconds.
  await new Promise((resolve) => setTimeout(resolve, 2_050));
  await writeFile(registry, JSON.stringify({
    org: { url: 'https://mb-org.example.com', token: 'new-token', kind: 'selfhost', transport: 'cloudflare' },
  }));

  assert.deepEqual(backend.agentFor('org'), {
    url: 'https://mb-org.example.com',
    token: 'new-token',
    fallbackTokens: [],
    pgUrl: '',
    qdrantUrl: '',
    kind: 'selfhost',
    maintenanceQuarantinedUntil: 0,
    releaseStatus: null,
  });
});

test('meeting recovery enumerates embedded and self-host agents independently of vector-maintenance quarantine', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hm-meeting-agent-enumeration-'));
  const registry = join(directory, 'agents.json');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  process.env.MNEME_AGENT_REGISTRY_FILE = registry;
  await writeFile(registry, JSON.stringify({
    embedded: { url: 'local:', kind: 'amr-central' },
    external: { url: 'http://100.64.0.2:8787', token: 'token', kind: 'selfhost', maintenanceQuarantinedUntil: Date.now() + 60_000 },
  }));
  const backend = await import(`../../src/vector/mneme/remote-backend.js?meeting-orgs=${Date.now()}`);
  assert.deepEqual(backend.remoteAgentOrgIds(), []);
  assert.deepEqual(backend.meetingAgentOrgIds().sort(), ['embedded', 'external']);
});
