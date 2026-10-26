import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVALUATION_STATUS,
  combineEvaluationStatus,
  evaluationStatusFromError,
  readTimeoutMsEnv,
  recallOutcomeLogLine,
} from '../../src/memory/recall-degradation.js';
import { boundedRecallEmbedding } from '../../src/embeddings/recall-deadline.js';
import { CloudflareRecallQualityClient } from '../../src/memory/cloudflare-recall-quality-client.js';
import { CloudflareRecallReliabilityClient } from '../../src/memory/cloudflare-recall-reliability-client.js';
import { CloudflareWorkersAIEmbedService } from '../../src/embeddings/cloudflare-workers-ai.js';

const SILENT = { warn() {} };

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  const restore = () => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const FLAGSHIP_ENV = {
  CANONICAL_PROJECTION_WORKFLOW_URL: 'https://flags.example.test',
  CANONICAL_PROJECTION_WORKFLOW_SECRET: 'test-secret',
  RECALL_PARALLEL_RELIABILITY_ENABLED: 'true',
};

test('timeout env is optional, validated and fails loud on a bad value', () => {
  assert.equal(readTimeoutMsEnv('X_TIMEOUT', 1500, {}, {}), 1500);
  assert.equal(readTimeoutMsEnv('X_TIMEOUT', 1500, {}, { X_TIMEOUT: '  ' }), 1500);
  assert.equal(readTimeoutMsEnv('X_TIMEOUT', 1500, {}, { X_TIMEOUT: '250' }), 250);
  for (const bad of ['abc', '0', '-5', '1.5', '60001']) {
    assert.throws(() => readTimeoutMsEnv('X_TIMEOUT', 1500, {}, { X_TIMEOUT: bad }), /X_TIMEOUT must be an integer/);
  }
});

test('evaluation error classification separates timeouts from other failures', () => {
  assert.equal(evaluationStatusFromError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), EVALUATION_STATUS.SKIPPED_TIMEOUT);
  assert.equal(evaluationStatusFromError(Object.assign(new Error('aborted'), { name: 'AbortError' })), EVALUATION_STATUS.SKIPPED_TIMEOUT);
  assert.equal(evaluationStatusFromError(new Error('socket hang up')), EVALUATION_STATUS.SKIPPED_ERROR);
});

test('combined evaluation status ranks timeout over error over ok over not configured', () => {
  assert.equal(combineEvaluationStatus(['ok', 'skipped_timeout']), 'skipped_timeout');
  assert.equal(combineEvaluationStatus(['skipped_error', 'ok']), 'skipped_error');
  assert.equal(combineEvaluationStatus(['not_configured', 'ok']), 'ok');
  assert.equal(combineEvaluationStatus(['not_configured', 'not_configured']), 'not_configured');
});

test('recall log line carries route, retrieval, embedding, evaluation and latency only', () => {
  const line = recallOutcomeLogLine({
    route: '/api/recall', retrieval: 'lexical_fallback', embedding: 'timeout',
    evaluation: 'skipped_timeout', status: 200, latencyMs: 1234,
  });
  assert.equal(line, '[recall] route=/api/recall retrieval=lexical_fallback embedding=timeout '
    + 'evaluation=skipped_timeout status=200 latency_ms=1234');
});

test('bounded query embedding reports timeout, unavailable and ok outcomes', async () => {
  const outcomes = [];
  const record = (outcome) => outcomes.push(outcome);

  // Provider that honours the deadline signal and returns null, as QdrantClient.generateEmbedding does.
  await boundedRecallEmbedding({ generateEmbedding: (_q, o) => new Promise((resolve) => {
    o.signal.addEventListener('abort', () => resolve(null), { once: true });
  }) }, 'q', { timeoutMs: 10, onOutcome: record });

  await boundedRecallEmbedding({ generateEmbedding: async () => null }, 'q', { timeoutMs: 1000, onOutcome: record });
  await boundedRecallEmbedding({ generateEmbedding: async () => [0.1, 0.2] }, 'q', { timeoutMs: 1000, onOutcome: record });
  await assert.rejects(boundedRecallEmbedding({ generateEmbedding: async () => { throw new Error('boom'); } }, 'q', {
    timeoutMs: 1000, onOutcome: record,
  }), /boom/);

  assert.deepEqual(outcomes, ['timeout', 'unavailable', 'ok', 'unavailable']);
});

test('quality evaluation timeout returns mode off with skipped_timeout and no request failure', async () => {
  await withEnv(FLAGSHIP_ENV, async () => {
    const client = new CloudflareRecallQualityClient({
      timeoutMs: 20,
      logger: SILENT,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    });
    const result = await client.evaluate({ orgId: 'org-1', userId: 'user-1' });
    assert.equal(result.mode, 'off');
    assert.equal(result.status, EVALUATION_STATUS.SKIPPED_TIMEOUT);
    assert.equal(await client.modeFor({ orgId: 'org-1', userId: 'user-1' }), 'off');
  });
});

test('quality evaluation reports ok, error and not_configured explicitly', async () => {
  await withEnv(FLAGSHIP_ENV, async () => {
    const ok = new CloudflareRecallQualityClient({
      logger: SILENT,
      fetchImpl: async () => ({ ok: true, json: async () => ({ mode: 'shadow' }) }),
    });
    assert.deepEqual(await ok.evaluate({ orgId: 'o', userId: 'u' }), { mode: 'shadow', status: 'ok' });

    const failed = new CloudflareRecallQualityClient({
      logger: SILENT,
      fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.deepEqual(await failed.evaluate({ orgId: 'o', userId: 'u' }), { mode: 'off', status: 'skipped_error' });
  });

  await withEnv({ ...FLAGSHIP_ENV, CANONICAL_PROJECTION_WORKFLOW_URL: undefined }, async () => {
    let called = false;
    const client = new CloudflareRecallQualityClient({ fetchImpl: async () => { called = true; } });
    assert.deepEqual(await client.evaluate({ orgId: 'o', userId: 'u' }), { mode: 'off', status: 'not_configured' });
    assert.equal(called, false);
  });
});

test('reliability evaluation timeout returns enabled=false with skipped_timeout', async () => {
  await withEnv(FLAGSHIP_ENV, async () => {
    const client = new CloudflareRecallReliabilityClient({
      timeoutMs: 20,
      logger: SILENT,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    });
    assert.deepEqual(await client.evaluate({ orgId: 'o', userId: 'u' }), { enabled: false, status: 'skipped_timeout' });
    assert.equal(await client.enabledFor({ orgId: 'o', userId: 'u' }), false);
  });

  await withEnv({ ...FLAGSHIP_ENV, RECALL_PARALLEL_RELIABILITY_ENABLED: 'false' }, async () => {
    const client = new CloudflareRecallReliabilityClient({ fetchImpl: async () => { throw new Error('must not call'); } });
    assert.deepEqual(await client.evaluate({ orgId: 'o', userId: 'u' }), { enabled: false, status: 'not_configured' });
  });
});

test('evaluation timeouts are env-backed and invalid values fail at construction', () => {
  withEnv({ RECALL_QUALITY_MODE_TIMEOUT_MS: 'soon' }, () => {
    assert.throws(() => new CloudflareRecallQualityClient({ fetchImpl: async () => null }), /RECALL_QUALITY_MODE_TIMEOUT_MS/);
  });
  withEnv({ RECALL_RELIABILITY_TIMEOUT_MS: '0' }, () => {
    assert.throws(() => new CloudflareRecallReliabilityClient({ fetchImpl: async () => null }), /RECALL_RELIABILITY_TIMEOUT_MS/);
  });
  withEnv({ RECALL_QUALITY_MODE_TIMEOUT_MS: undefined, RECALL_RELIABILITY_TIMEOUT_MS: undefined }, () => {
    assert.equal(new CloudflareRecallQualityClient({ fetchImpl: async () => null }).timeoutMs, 1500);
    assert.equal(new CloudflareRecallReliabilityClient({ fetchImpl: async () => null }).timeoutMs, 3000);
  });
});

test('embedding provider timeout keeps its 8000 ms default and rejects invalid env values', () => {
  withEnv({ CLOUDFLARE_EMBED_TIMEOUT_MS: undefined }, () => {
    assert.equal(new CloudflareWorkersAIEmbedService({ fetchImpl: async () => null }).timeoutMs, 8000);
  });
  withEnv({ CLOUDFLARE_EMBED_TIMEOUT_MS: '2500' }, () => {
    assert.equal(new CloudflareWorkersAIEmbedService({ fetchImpl: async () => null }).timeoutMs, 2500);
  });
  withEnv({ CLOUDFLARE_EMBED_TIMEOUT_MS: 'fast' }, () => {
    assert.throws(() => new CloudflareWorkersAIEmbedService({ fetchImpl: async () => null }), /CLOUDFLARE_EMBED_TIMEOUT_MS/);
  });
});
