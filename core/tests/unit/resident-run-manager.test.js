import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryStore } from '../../src/executor/stores/in-memory-store.js';
import { ResidentRunManager } from '../../src/resident/run-manager.js';

function createMemoryStoreFixture() {
  const memories = [
    {
      id: 'mem-1',
      title: 'core/src/auth/index.js',
      content: 'Auth module changed frequently without matching tests.',
      project: 'proj-a',
      metadata: { filepath: 'core/src/auth/index.js' },
      tags: ['code'],
    },
    {
      id: 'mem-2',
      title: 'core/src/auth/index.js',
      content: 'Auth module changed frequently without matching tests.',
      project: 'proj-a',
      metadata: { filepath: 'core/src/auth/index.js' },
      tags: ['code'],
    },
    {
      id: 'mem-3',
      title: 'core/src/auth/readme.md',
      content: 'Design note without current test updates.',
      project: 'proj-a',
      metadata: { filepath: 'core/src/auth/readme.md' },
      tags: ['doc'],
    },
  ];

  return {
    async listLatestMemories({ project }) {
      return memories.filter((memory) => !project || memory.project === project);
    },
    async listRelationships() {
      return [{ id: 'rel-1' }];
    },
  };
}

async function waitForRun(manager, runId, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = manager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return manager.getRun(runId);
}

test('resident run manager executes Faraday and records structured observations', async () => {
  const executorStore = new InMemoryStore();
  const manager = new ResidentRunManager({
    store: executorStore,
    graphStore: createMemoryStoreFixture(),
    logger: { warn() {}, log() {} },
  });

  await manager.seedAgents();

  const agents = manager.listAgents();
  assert.ok(agents.some((agent) => agent.agent_id === 'faraday'));

  const run = await manager.runAgent('faraday', {
    project: 'proj-a',
    scope: 'project',
    goal: 'inspect code/test gaps',
    region: 'core/src/auth',
  });

  assert.ok(['queued', 'running'].includes(run.status));
  assert.equal(run.agent_id, 'faraday');

  const finished = await waitForRun(manager, run.run_id);
  assert.equal(finished.status, 'completed');
  assert.ok(finished.observations_count >= 1);

  const observations = manager.getRunObservations(run.run_id);
  assert.equal(observations.count, finished.observations_count);
  assert.ok(observations.observations.length >= 1);
  assert.equal(observations.observations[0].kind, 'graph_observation');

  const stored = await executorStore.listObservations({ agentId: 'faraday' });
  assert.ok(stored.length >= 1);
  assert.equal(stored[0].kind, observations.observations[0].kind);
});

test('resident run manager can cancel a queued run and exposes failure for unsupported agents', async () => {
  const executorStore = new InMemoryStore();
  const manager = new ResidentRunManager({
    store: executorStore,
    graphStore: createMemoryStoreFixture(),
    logger: { warn() {}, log() {} },
  });

  const cancelled = await manager.cancelRun('missing-run');
  assert.equal(cancelled, null);

  const unsupported = await manager.runAgent('feynman', { project: 'proj-a' });
  assert.equal(unsupported.status, 'failed');
  assert.match(unsupported.error, /Only Faraday/);
});
