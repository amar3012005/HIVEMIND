import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FARADAY_OBSERVATION_FIELDS,
  FARADAY_OBSERVATION_KINDS,
  RESIDENT_AGENT_ENDPOINTS,
  RESIDENT_AGENT_IDS,
  RESIDENT_RUN_STATES,
} from '../../src/resident/contract.js';
import {
  makeFaradayObservationFixture,
  makeResidentAgentListFixture,
  makeResidentCancelFixture,
  makeResidentObservationsFixture,
  makeResidentRunFixture,
} from '../fixtures/resident-agent-contract.fixtures.js';

test('resident agent contract exposes stable endpoint names for the frontend', () => {
  assert.deepEqual(RESIDENT_AGENT_IDS, ['faraday', 'feynman', 'turing']);

  assert.equal(RESIDENT_AGENT_ENDPOINTS.listAgents.method, 'GET');
  assert.equal(RESIDENT_AGENT_ENDPOINTS.listAgents.path, '/api/swarm/resident/agents');
  assert.deepEqual(RESIDENT_AGENT_ENDPOINTS.listAgents.responseKeys, ['agents', 'count']);

  assert.equal(RESIDENT_AGENT_ENDPOINTS.runAgent.method, 'POST');
  assert.equal(RESIDENT_AGENT_ENDPOINTS.runAgent.pathTemplate, '/api/swarm/resident/agents/:agent_id/run');
  assert.deepEqual(RESIDENT_AGENT_ENDPOINTS.runAgent.requestKeys, ['scope', 'goal', 'project', 'region', 'dry_run']);
  assert.deepEqual(RESIDENT_AGENT_ENDPOINTS.runAgent.responseKeys, ['run_id', 'agent_id', 'status', 'scope', 'started_at']);

  assert.equal(RESIDENT_AGENT_ENDPOINTS.getRun.pathTemplate, '/api/swarm/resident/runs/:run_id');
  assert.equal(RESIDENT_AGENT_ENDPOINTS.listObservations.pathTemplate, '/api/swarm/resident/runs/:run_id/observations');
  assert.equal(RESIDENT_AGENT_ENDPOINTS.cancelRun.pathTemplate, '/api/swarm/resident/runs/:run_id/cancel');
  assert.deepEqual(RESIDENT_AGENT_ENDPOINTS.getRun.responseKeys, [
    'run_id',
    'agent_id',
    'status',
    'scope',
    'goal',
    'project',
    'region',
    'started_at',
    'updated_at',
    'finished_at',
    'current_step',
    'observations_count',
    'progress',
  ]);
});

test('Faraday observation payload is structured and stays operational rather than canonical', () => {
  const faradayObservation = makeFaradayObservationFixture();

  assert.deepEqual(Object.keys(faradayObservation).sort(), [
    'agent_id',
    'certainty',
    'content',
    'id',
    'kind',
    'related_to_trail',
    'source_event_id',
    'timestamp',
  ]);
  assert.equal(faradayObservation.kind, 'anomaly_candidate');
  assert.equal(faradayObservation.content.region, 'core/src/auth');
  assert.equal(faradayObservation.content.signal_type, 'test_gap');
  assert.equal(faradayObservation.content.confidence, 0.82);
  assert.ok(!('memory_type' in faradayObservation), 'Faraday V1 should not write canonical memories directly');
});

test('resident run lifecycle has explicit states and explicit observation kinds', () => {
  assert.deepEqual(RESIDENT_RUN_STATES, ['queued', 'running', 'completed', 'failed', 'cancelled']);
  assert.deepEqual(FARADAY_OBSERVATION_KINDS, [
    'graph_observation',
    'anomaly_candidate',
    'code_smell',
    'risk_candidate',
    'reasoning_trail',
  ]);
  assert.deepEqual(FARADAY_OBSERVATION_FIELDS, [
    'id',
    'agent_id',
    'kind',
    'content',
    'certainty',
    'source_event_id',
    'related_to_trail',
    'timestamp',
  ]);
});

test('resident fixtures are frontend-consumable without guessing field names', () => {
  const listResponse = makeResidentAgentListFixture();
  const runResponse = makeResidentRunFixture();
  const observationsResponse = makeResidentObservationsFixture();
  const cancelResponse = makeResidentCancelFixture();

  assert.deepEqual(Object.keys(listResponse).sort(), ['agents', 'count']);
  assert.deepEqual(Object.keys(runResponse).sort(), [
    'agent_id',
    'current_step',
    'finished_at',
    'goal',
    'observations_count',
    'progress',
    'project',
    'region',
    'run_id',
    'scope',
    'started_at',
    'status',
    'updated_at',
  ]);
  assert.deepEqual(Object.keys(observationsResponse).sort(), ['count', 'observations']);
  assert.deepEqual(Object.keys(cancelResponse).sort(), ['cancelled_at', 'run_id', 'status']);
  assert.equal(runResponse.agent_id, 'faraday');
  assert.equal(observationsResponse.observations[0].kind, 'anomaly_candidate');
  assert.equal(cancelResponse.status, 'cancelled');
});
