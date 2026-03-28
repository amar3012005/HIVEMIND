/**
 * Resident agent contract for CSI-style graph-native agents.
 *
 * This is intentionally small and explicit so backend and frontend work can
 * share the same field names without guessing.
 */

export const RESIDENT_AGENT_IDS = ['faraday', 'feynman', 'turing'];

export const RESIDENT_AGENT_ENDPOINTS = {
  listAgents: {
    method: 'GET',
    path: '/api/swarm/resident/agents',
    responseKeys: ['agents', 'count'],
  },
  runAgent: {
    method: 'POST',
    pathTemplate: '/api/swarm/resident/agents/:agent_id/run',
    requestKeys: ['scope', 'goal', 'project', 'region', 'dry_run'],
    responseKeys: ['run_id', 'agent_id', 'status', 'scope', 'started_at'],
  },
  getRun: {
    method: 'GET',
    pathTemplate: '/api/swarm/resident/runs/:run_id',
    responseKeys: [
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
    ],
  },
  listObservations: {
    method: 'GET',
    pathTemplate: '/api/swarm/resident/runs/:run_id/observations',
    responseKeys: ['observations', 'count'],
  },
  cancelRun: {
    method: 'POST',
    pathTemplate: '/api/swarm/resident/runs/:run_id/cancel',
    responseKeys: ['run_id', 'status', 'cancelled_at'],
  },
};

export const RESIDENT_RUN_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

export const FARADAY_OBSERVATION_KINDS = [
  'graph_observation',
  'anomaly_candidate',
  'code_smell',
  'risk_candidate',
  'reasoning_trail',
];

export const FARADAY_OBSERVATION_FIELDS = [
  'id',
  'agent_id',
  'kind',
  'content',
  'certainty',
  'source_event_id',
  'related_to_trail',
  'timestamp',
];
