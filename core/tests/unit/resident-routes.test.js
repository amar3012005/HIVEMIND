import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentRoutes } from '../../src/resident/routes.js';

test('resident route dispatcher returns the expected API shapes', async () => {
  const manager = {
    async listAgents() {
      return [
        { agent_id: 'faraday', status: 'active' },
        { agent_id: 'feynman', status: 'active' },
        { agent_id: 'turing', status: 'active' },
      ];
    },
    async startRun(agentId, body) {
      return {
        run_id: 'run-1',
        agent_id: agentId,
        status: 'queued',
        scope: body.scope,
        goal: body.goal || null,
        project: body.project || null,
        region: body.region || null,
        started_at: '2026-03-28T10:00:00.000Z',
      };
    },
    async getRun(runId) {
      return runId === 'run-1'
        ? {
            run_id: 'run-1',
            agent_id: 'faraday',
            status: 'running',
            scope: 'project',
            goal: 'scan',
            project: 'bench/project-a',
            region: 'core/src/auth',
            started_at: '2026-03-28T10:00:00.000Z',
            updated_at: '2026-03-28T10:00:01.000Z',
            finished_at: null,
            current_step: 'graph_search',
            observations_count: 2,
            progress: { step: 2, total_steps: 4, percent: 50 },
          }
        : null;
    },
    async getRunObservations(runId) {
      return runId === 'run-1'
        ? {
            observations: [
              {
                id: 'obs-1',
                agent_id: 'faraday',
                kind: 'graph_observation',
                content: { summary: 'scanned', confidence: 0.66 },
                certainty: 0.66,
                source_event_id: 'run-1',
                related_to_trail: 'run-1',
                timestamp: '2026-03-28T10:00:01.000Z',
              },
            ],
            count: 1,
          }
        : null;
    },
    async cancelRun(runId) {
      return runId === 'run-1'
        ? {
            run_id: 'run-1',
            status: 'cancelled',
            cancelled_at: '2026-03-28T10:00:02.000Z',
          }
        : null;
    },
  };

  const routes = createResidentRoutes(manager);

  const agents = await routes.dispatch({ pathname: '/api/swarm/resident/agents', method: 'GET' });
  assert.equal(agents.statusCode, 200);
  assert.equal(agents.body.count, 3);
  assert.equal(agents.body.agents[0].agent_id, 'faraday');

  const started = await routes.dispatch({
    pathname: '/api/swarm/resident/agents/faraday/run',
    method: 'POST',
    body: { scope: 'project', goal: 'scan', project: 'bench/project-a', region: 'core/src/auth' },
    userId: 'user-1',
    orgId: 'org-1',
  });
  assert.equal(started.statusCode, 202);
  assert.equal(started.body.agent_id, 'faraday');
  assert.equal(started.body.scope, 'project');

  const run = await routes.dispatch({ pathname: '/api/swarm/resident/runs/run-1', method: 'GET' });
  assert.equal(run.statusCode, 200);
  assert.equal(run.body.current_step, 'graph_search');
  assert.equal(run.body.observations_count, 2);

  const observations = await routes.dispatch({ pathname: '/api/swarm/resident/runs/run-1/observations', method: 'GET' });
  assert.equal(observations.statusCode, 200);
  assert.equal(observations.body.count, 1);
  assert.equal(observations.body.observations[0].kind, 'graph_observation');

  const cancelled = await routes.dispatch({ pathname: '/api/swarm/resident/runs/run-1/cancel', method: 'POST' });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.cancelled_at, '2026-03-28T10:00:02.000Z');
});
