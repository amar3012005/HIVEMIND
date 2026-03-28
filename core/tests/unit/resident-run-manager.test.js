import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryStore } from '../../src/executor/stores/in-memory-store.js';
import { ResidentRunManager } from '../../src/resident/run-manager.js';

function createMemoryStoreFixture() {
  const searchQueries = [];
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
    searchQueries,
    async listLatestMemories({ project }) {
      return memories.filter((memory) => !project || memory.project === project);
    },
    async searchMemories({ query, project }) {
      searchQueries.push(query);
      const q = String(query || '').toLowerCase();
      const pool = memories.filter((memory) => !project || memory.project === project);
      if (q.includes('auth') || q.includes('test') || q.includes('gap')) {
        return pool.filter((memory) => /auth|test|doc/i.test(`${memory.title} ${memory.content}`));
      }
      if (q.includes('anomal') || q.includes('duplicate') || q.includes('stale')) {
        return pool;
      }
      return pool.slice(0, 2);
    },
    async listRelationships() {
      return [{ id: 'rel-1' }];
    },
    async getRelatedMemories(memoryId) {
      if (memoryId === 'mem-1') {
        return [
          { from_id: 'mem-1', to_id: 'mem-2', confidence: 0.8 },
          { from_id: 'mem-1', to_id: 'mem-3', confidence: 0.6 },
        ];
      }
      return [];
    },
    async getMemory(id) {
      return memories.find((memory) => memory.id === id) || null;
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
  const graphStore = createMemoryStoreFixture();
  const manager = new ResidentRunManager({
    store: executorStore,
    graphStore,
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
  assert.ok(Array.isArray(finished.result?.semantic_probes));
  assert.ok(finished.result.semantic_probes.length >= 3);
  assert.ok(Array.isArray(finished.result?.semantic_clusters));
  assert.ok(finished.result.semantic_clusters.length >= 1);
  assert.equal(finished.result.trail_mark.kind, 'resident_mark');
  assert.ok(finished.result.trail_mark.semantic_probes.length >= 3);
  assert.ok(graphStore.searchQueries.length >= 3);
  assert.ok(graphStore.searchQueries.some((query) => query !== 'inspect code/test gaps'));

  const observations = manager.getRunObservations(run.run_id);
  assert.equal(observations.count, finished.observations_count);
  assert.ok(observations.observations.length >= 1);
  assert.equal(observations.observations[0].kind, 'graph_observation');
  assert.ok(observations.observations.some((observation) => observation.kind === 'reasoning_trail'));

  const stored = await executorStore.listObservations({ agentId: 'faraday' });
  assert.ok(stored.length >= 1);
  assert.equal(stored[0].kind, observations.observations[0].kind);

  const storedTrail = await executorStore.getTrail(finished.result.trail_mark.trail_id);
  assert.ok(storedTrail);
  assert.equal(storedTrail.kind, 'resident_mark');
  assert.equal(storedTrail.blueprintMeta.resident_mark, true);
  assert.ok(storedTrail.blueprintMeta.semantic_probes.length >= 3);
});

test('resident run manager executes Feynman against the latest Faraday trail mark', async () => {
  const executorStore = new InMemoryStore();
  const graphStore = createMemoryStoreFixture();
  const manager = new ResidentRunManager({
    store: executorStore,
    graphStore,
    logger: { warn() {}, log() {} },
  });

  await manager.seedAgents();

  const faraday = await manager.runAgent('faraday', {
    project: 'proj-a',
    scope: 'project',
    goal: 'inspect code/test gaps',
    region: 'core/src/auth',
  });
  const completedFaraday = await waitForRun(manager, faraday.run_id);
  assert.equal(completedFaraday.status, 'completed');

  const feynman = await manager.runAgent('feynman', {
    project: 'proj-a',
    scope: 'project',
    goal: 'explain the strongest resident signals',
    region: 'core/src/auth',
  });
  const completedFeynman = await waitForRun(manager, feynman.run_id);

  assert.equal(completedFeynman.status, 'completed');
  assert.ok(completedFeynman.observations_count >= 1);
  assert.equal(completedFeynman.result.observations[0].kind, 'hypothesis');
  assert.ok(Array.isArray(completedFeynman.result?.hypotheses));
  assert.ok(completedFeynman.result.hypotheses.length >= 1);
  assert.equal(completedFeynman.result.trail_mark.kind, 'resident_hypothesis_mark');
  assert.match(completedFeynman.result.trail_mark.next_agent_prompt, /Turing/i);
  assert.ok(Array.isArray(completedFeynman.result.hypotheses[0].verification_checks));
  assert.ok(completedFeynman.result.hypotheses[0].verification_checks.length >= 2);
  assert.ok(completedFeynman.result.hypotheses[0].supporting_evidence_summary || completedFeynman.result.trail_mark.hypotheses[0].supporting_evidence_summary);

  const storedTrail = await executorStore.getTrail(completedFeynman.result.trail_mark.trail_id);
  assert.ok(storedTrail);
  assert.equal(storedTrail.kind, 'resident_hypothesis_mark');
  assert.equal(storedTrail.blueprintMeta.resident_hypothesis_mark, true);

  const storedObservations = await executorStore.listObservations({ agentId: 'feynman' });
  assert.ok(storedObservations.length >= 1);
  assert.equal(storedObservations[0].kind, 'hypothesis');
});

test('resident run manager executes Turing against the latest Feynman hypotheses', async () => {
  const executorStore = new InMemoryStore();
  const graphStore = createMemoryStoreFixture();
  const manager = new ResidentRunManager({
    store: executorStore,
    graphStore,
    logger: { warn() {}, log() {} },
  });

  await manager.seedAgents();

  const faraday = await manager.runAgent('faraday', {
    project: 'proj-a',
    scope: 'project',
    goal: 'inspect code/test gaps',
    region: 'core/src/auth',
  });
  const completedFaraday = await waitForRun(manager, faraday.run_id);
  assert.equal(completedFaraday.status, 'completed');

  const feynman = await manager.runAgent('feynman', {
    project: 'proj-a',
    scope: 'project',
    goal: 'explain the strongest resident signals',
    region: 'core/src/auth',
  });
  const completedFeynman = await waitForRun(manager, feynman.run_id);
  assert.equal(completedFeynman.status, 'completed');

  const turing = await manager.runAgent('turing', {
    project: 'proj-a',
    scope: 'project',
    goal: 'verify the strongest resident hypotheses',
    region: 'core/src/auth',
  });
  const completedTuring = await waitForRun(manager, turing.run_id);

  assert.equal(completedTuring.status, 'completed');
  assert.ok(completedTuring.observations_count >= 1);
  assert.equal(completedTuring.result.observations[0].kind, 'verification');
  assert.ok(Array.isArray(completedTuring.result?.verification_results));
  assert.ok(completedTuring.result.verification_results.length >= 1);
  assert.equal(completedTuring.result.trail_mark.kind, 'resident_verification_mark');
  assert.ok(
    completedTuring.result.verification_results.some((item) => ['likely_true', 'uncertain', 'weak'].includes(item.verdict)),
  );

  const storedTrail = await executorStore.getTrail(completedTuring.result.trail_mark.trail_id);
  assert.ok(storedTrail);
  assert.equal(storedTrail.kind, 'resident_verification_mark');
  assert.equal(storedTrail.blueprintMeta.resident_verification_mark, true);

  const storedObservations = await executorStore.listObservations({ agentId: 'turing' });
  assert.ok(storedObservations.length >= 1);
  assert.equal(storedObservations[0].kind, 'verification');
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
  const failedFeynman = await waitForRun(manager, unsupported.run_id);
  assert.equal(failedFeynman.status, 'failed');
  assert.match(failedFeynman.error, /No completed Faraday run/);

  const unsupportedTuring = await manager.runAgent('turing', { project: 'proj-a' });
  const failedTuring = await waitForRun(manager, unsupportedTuring.run_id);
  assert.equal(failedTuring.status, 'failed');
  assert.match(failedTuring.error, /No completed Feynman run/);

  const unsupportedAgent = await manager.runAgent('unknown-agent', { project: 'proj-a' });
  assert.equal(unsupportedAgent.status, 'failed');
  assert.match(unsupportedAgent.error, /Faraday, Feynman, and Turing/);
});
