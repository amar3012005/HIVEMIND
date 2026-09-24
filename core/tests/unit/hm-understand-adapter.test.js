import test from 'node:test';
import assert from 'node:assert/strict';
import { HmUnderstandAdapter, createHmUnderstandShadowAnalyzer, hmUnderstandBlocksFromSegments, hmUnderstandShadowReceipt } from '../../src/knowledge/enterprise/hm-understand-adapter.js';

test('adapter sends the bounded contract and returns a typed response', async () => {
  let seen;
  const client = new HmUnderstandAdapter({
    baseUrl: 'http://hm-understand:8090/',
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ schema_version: '1', blocks: [], complete: true }), { status: 200 });
    },
  });
  const result = await client.analyze({ source: { id: 'doc', revision: '1' }, blocks: [{ id: 'p1', text: 'Evidence' }] });
  assert.equal(result.ok, true);
  assert.equal(seen.url, 'http://hm-understand:8090/v1/analyze');
  assert.equal(seen.body.blocks[0].text, 'Evidence');
});

test('adapter fails closed on malformed or unavailable service results', async () => {
  const absent = await new HmUnderstandAdapter({ baseUrl: '' }).analyze({});
  assert.deepEqual(absent, { ok: false, code: 'HM_UNDERSTAND_UNAVAILABLE', retryable: true });
  const malformed = new HmUnderstandAdapter({ baseUrl: 'http://hm-understand',
    fetchImpl: async () => new Response('{"blocks":[]}', { status: 200 }) });
  assert.equal((await malformed.analyze({ source: { id: 'doc', revision: '1' }, blocks: [{ id: 'b', text: 'evidence' }] })).code, 'HM_UNDERSTAND_BAD_RESPONSE');
});

test('adapter enforces a hard timeout and aborts a stalled service request', async () => {
  let requestSignal;
  const client = new HmUnderstandAdapter({
    baseUrl: 'http://hm-understand', timeoutMs: 1_000, logger: { warn() {} },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        const error = new Error('request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  const result = await client.analyze({ source: { id: 'doc', revision: '1' }, blocks: [{ id: 'b', text: 'evidence' }] });
  assert.deepEqual(result, { ok: false, code: 'HM_UNDERSTAND_TIMEOUT', retryable: true });
  assert.equal(requestSignal.aborted, true);
});

test('parser segment locations survive the adapter mapping', () => {
  const blocks = hmUnderstandBlocksFromSegments([{
    id: 'segment-a', content: 'Original evidence', startPage: 4, startOffset: 120, endOffset: 137,
    segmentType: 'paragraph', segmentIndex: 3,
    metadata: { heading_path: ['Finance', 'Budget'], language: 'de' },
  }]);
  assert.deepEqual(blocks[0].locator, { page: 4, heading_path: ['Finance', 'Budget'], sheet: null, row: null, cell: null });
  assert.equal(blocks[0].language, 'de');
  assert.equal(blocks[0].metadata.segment_index, 3);
  assert.equal(blocks[0].source_start, 120);
  assert.equal(blocks[0].source_end, 137);
});

test('adapter batches large documents without dropping parser blocks', async () => {
  const seen = [];
  const client = new HmUnderstandAdapter({
    baseUrl: 'http://hm-understand:8090',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      seen.push(body.blocks.length);
      return new Response(JSON.stringify({
        schema_version: '1', complete: true, model_versions: { entity: 'fixture@1' },
        blocks: body.blocks.map((block) => ({ block_id: block.id, mentions: [], candidates: [] })),
        totals: { blocks: body.blocks.length, mentions: 0, candidates: 0, processing_ms: 4 },
      }), { status: 200 });
    },
  });
  const blocks = Array.from({ length: 205 }, (_, index) => ({ id: `b${index}`, text: 'short block' }));
  const result = await client.analyze({ source: { id: 'doc', revision: '1' }, blocks });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [100, 100, 5]);
  assert.equal(result.result.blocks.length, 205);
  assert.equal(result.result.totals.blocks, 205);
});

test('shadow receipt stores bounded metrics, not candidate text or evidence', () => {
  const receipt = hmUnderstandShadowReceipt({ ok: true, result: {
    complete: true, content_hash: 'hash', pipeline_version: 'v1', model_versions: { entity: 'm@r' },
    totals: { blocks: 1, mentions: 1, candidates: 1 },
    blocks: [{ language: { primary: 'hi' }, quality: { refinement_required: true,
      refinement_reasons: ['language_outside_smoke_set'] },
      mentions: [{ text: 'private name', label: 'person' }],
      candidates: [{ kind: 'decision', text: 'private decision' }] }],
  } }, { sourceRevision: 'r1' });
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(receipt.entity_label_counts, { person: 1 });
  assert.deepEqual(receipt.candidate_kind_counts, { decision: 1 });
  assert.equal(receipt.refinement_required_blocks, 1);
  assert.deepEqual(receipt.refinement_reason_counts, { language_outside_smoke_set: 1 });
  assert.equal(JSON.stringify(receipt).includes('private name'), false);
  assert.equal(JSON.stringify(receipt).includes('private decision'), false);
});

test('Flagship shadow and assisted modes invoke local analysis without a second model call', async () => {
  let calls = 0;
  let canonicalModeCalls = 0;
  const flagClient = {
    modeFor: async () => { canonicalModeCalls += 1; return 'shadow'; },
    hmUnderstandModeFor: async ({ orgId, userId }) => {
      assert.equal(orgId, 'org-1'); assert.equal(userId, 'user-1'); return mode;
    },
  };
  const adapter = { configured: () => true, analyze: async ({ source, blocks }) => {
    calls += 1;
    assert.equal(source.id, 'doc-1');
    assert.equal(source.revision, 'revision-1');
    assert.equal(blocks[0].id, 'segment-1');
    return { ok: true, result: { schema_version: '1', complete: true, blocks: [] } };
  } };
  let mode = 'shadow';
  const analyze = createHmUnderstandShadowAnalyzer({ flagClient, adapter, logger: { warn() {} } });
  const input = { orgId: 'org-1', userId: 'user-1', documentId: 'doc-1', sourceRevision: 'revision-1',
    segments: [{ id: 'segment-1', content: 'evidence' }] };
  const result = await analyze(input);
  assert.equal(result.enabled, true);
  assert.equal(result.mode, 'shadow');
  assert.equal(calls, 1);
  assert.equal(canonicalModeCalls, 0);

  mode = 'assisted';
  const assisted = await analyze(input);
  assert.equal(assisted.enabled, true);
  assert.equal(assisted.mode, 'assisted');
  assert.equal(calls, 2);

  const off = createHmUnderstandShadowAnalyzer({ flagClient: { hmUnderstandModeFor: async () => 'off' }, adapter });
  assert.deepEqual(await off(input), { enabled: false, mode: 'off' });
  assert.equal(calls, 2);
  assert.equal(canonicalModeCalls, 0);
});

test('Flagship evaluation failure fails closed without calling the analyzer', async () => {
  let called = false;
  const analyze = createHmUnderstandShadowAnalyzer({
    flagClient: { hmUnderstandModeFor: async () => { throw new Error('offline'); } },
    adapter: { configured: () => true, analyze: async () => { called = true; } }, logger: { warn() {} },
  });
  const result = await analyze({ orgId: 'org-1', userId: 'user-1', segments: [] });
  assert.deepEqual(result, { enabled: false, mode: 'off' });
  assert.equal(called, false);
});
