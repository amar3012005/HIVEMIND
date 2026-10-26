import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The recall router imports the mneme addon. On a platform without a prebuilt binary the addon
// load throws before any code under test runs. This shim substitutes an empty export only then;
// the lexical fallback path exercised here uses the injected store and never calls the addon.
const require = createRequire(import.meta.url);
const nativePath = require.resolve('../../src/vector/mneme/native.cjs');
try {
  require(nativePath);
} catch (error) {
  if (!/no prebuilt binary/.test(error.message)) throw error;
  require.cache[nativePath] = { id: nativePath, filename: nativePath, loaded: true, exports: {}, children: [], paths: [] };
}

process.env.RECALL_QUERY_EMBEDDING_TIMEOUT_MS = '25';
const { RecallRouter } = await import('../../src/memory/recall-router.js');

const ACCESS = { projectIds: [], teamIds: [] };
const CTX = { userId: 'user-1', orgId: 'org-1', projectId: null, accessContext: ACCESS };

function fakeStore({ lexicalRows = [], lexicalError = null } = {}) {
  const searchCalls = [];
  const store = new Proxy({}, {
    get(target, name) {
      if (name === 'searchMemories') {
        return async (args) => {
          searchCalls.push(args);
          if (lexicalError) throw lexicalError;
          return lexicalRows;
        };
      }
      if (name === 'searchCalls') return searchCalls;
      if (name in target) return target[name];
      return async () => [];
    },
  });
  return store;
}

function neverAnsweringEmbedder() {
  return {
    generateEmbedding: (_query, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
  };
}

const OPTIONS = { mode: 'fact', explicit_mode: true, structured_intent: true, limit: 15, trace_stages: false };

test('embedding timeout falls back to the lexical lane with tenant scope and no 503', async () => {
  const store = fakeStore({ lexicalRows: [{ id: 'mem-1', content: 'lexical match', org_id: 'org-1', user_id: 'user-1' }] });
  const router = new RecallRouter({ persistentMemoryStore: store, evidenceRetrieval: { qdrantClient: neverAnsweringEmbedder() }, prisma: null });
  const result = await router.recall('lexical question', { ...OPTIONS, signal: new AbortController().signal }, CTX);

  assert.equal(result.trace.embedding_unavailable, true);
  assert.equal(result.trace.embedding_status, 'timeout');
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].id, 'mem-1');

  const lexicalCall = store.searchCalls[0];
  assert.ok(lexicalCall, 'lexical lane must run when the embedding times out');
  assert.equal(lexicalCall.org_id, 'org-1');
  assert.equal(lexicalCall.user_id, 'user-1');
  assert.equal(lexicalCall.access_context, ACCESS);
  assert.equal(lexicalCall.lexical_only, true);
  assert.equal(lexicalCall.query_vector, undefined);
});

test('an empty lexical lane during an embedding outage never returns a successful absence', async () => {
  const store = fakeStore({ lexicalRows: [] });
  const router = new RecallRouter({ persistentMemoryStore: store, evidenceRetrieval: { qdrantClient: neverAnsweringEmbedder() }, prisma: null });
  await assert.rejects(
    router.recall('nothing matches', { ...OPTIONS, signal: new AbortController().signal }, CTX),
    (error) => error.code === 'MEMORY_RETRIEVAL_UNAVAILABLE',
  );
});

test('a failed lexical lane with reliability on still raises MEMORY_RETRIEVAL_UNAVAILABLE', async () => {
  const store = fakeStore({ lexicalError: Object.assign(new Error('lexical store down'), { code: 'X' }) });
  const router = new RecallRouter({ persistentMemoryStore: store, evidenceRetrieval: { qdrantClient: neverAnsweringEmbedder() }, prisma: null });
  await assert.rejects(
    router.recall('lexical question', { ...OPTIONS, reliability_v1: true, signal: new AbortController().signal }, CTX),
    (error) => error.code === 'MEMORY_RETRIEVAL_UNAVAILABLE',
  );
});
