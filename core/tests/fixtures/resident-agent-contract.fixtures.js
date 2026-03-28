import { RESIDENT_AGENT_IDS } from '../../src/resident/contract.js';

const now = '2026-03-28T10:00:00.000Z';

export function makeFaradayObservationFixture(overrides = {}) {
  return {
    id: 'obs-1',
    agent_id: 'faraday',
    kind: 'anomaly_candidate',
    content: {
      summary: 'Auth module changed frequently without matching tests.',
      region: 'core/src/auth',
      evidence_refs: ['trail-17', 'mem-22'],
      related_files: ['core/src/auth/index.js'],
      related_memory_ids: ['mem-22'],
      related_relationship_ids: ['rel-9'],
      signal_type: 'test_gap',
      severity: 'medium',
      confidence: 0.82,
      next_action: 'verify_missing tests',
    },
    certainty: 0.82,
    source_event_id: 'event-1',
    related_to_trail: 'trail-17',
    timestamp: now,
    ...overrides,
  };
}

export function makeResidentAgentListFixture(overrides = {}) {
  return {
    agents: [
      {
        agent_id: RESIDENT_AGENT_IDS[0],
        role: 'explorer',
        status: 'active',
        source: 'explicit',
        skills: ['graph_walk', 'anomaly_detect', 'write_observation'],
        last_seen_at: now,
      },
    ],
    count: 1,
    ...overrides,
  };
}

export function makeResidentRunFixture(overrides = {}) {
  return {
    run_id: 'run-123',
    agent_id: 'faraday',
    status: 'running',
    scope: 'project',
    goal: 'scan high-churn code regions',
    project: 'bench/longmemeval/gpt4_76048e76',
    region: 'core/src/memory',
    started_at: now,
    updated_at: now,
    finished_at: null,
    current_step: 'graph_scan',
    observations_count: 3,
    progress: {
      step: 1,
      total_steps: 4,
      percent: 25,
    },
    ...overrides,
  };
}

export function makeResidentObservationsFixture(overrides = {}) {
  return {
    observations: [makeFaradayObservationFixture()],
    count: 1,
    ...overrides,
  };
}

export function makeResidentCancelFixture(overrides = {}) {
  return {
    run_id: 'run-123',
    status: 'cancelled',
    cancelled_at: now,
    ...overrides,
  };
}
