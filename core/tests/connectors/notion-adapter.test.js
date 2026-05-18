/**
 * T11 — NotionAdapter tests (RED state)
 * Framework: node:test (native runner)
 * Run: node --test tests/connectors/notion-adapter.test.js
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NotionAdapter } from '../../src/connectors/adapters/notion/notion-adapter.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAdapter(tokenValue = 'test-bearer-token') {
  return new NotionAdapter({
    providerKey: 'notion',
    tokenResolver: async () => tokenValue,
    prisma: {},
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });
}

function makePage(id, title) {
  return {
    id,
    object: 'page',
    last_edited_time: '2024-01-01T00:00:00.000Z',
    created_time: '2024-01-01T00:00:00.000Z',
    url: `https://notion.so/${id}`,
    parent: { type: 'workspace', workspace: true },
    properties: {
      title: {
        type: 'title',
        title: [{ plain_text: title }],
      },
    },
  };
}

function mockJsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => headers[key.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let originalFetch;
let fetchCalls;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ──────────────────────────────────────────────────────────────────

test('fetchBulk: sends correct Authorization and Notion-Version headers', async () => {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return mockJsonResponse({ results: [makePage('p1', 'Hello')], has_more: false, next_cursor: null });
  };

  const adapter = makeAdapter('my-secret-token');
  await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null });

  assert.equal(fetchCalls.length, 1);
  const { opts } = fetchCalls[0];
  assert.equal(opts.headers['Authorization'], 'Bearer my-secret-token');
  assert.equal(opts.headers['Notion-Version'], '2022-06-28');
  assert.match(fetchCalls[0].url, /api\.notion\.com\/v1\/search/);
});

test('fetchBulk: normalizes pages to NormalizedRecord shape', async () => {
  globalThis.fetch = async () =>
    mockJsonResponse({ results: [makePage('abc-123', 'My Page')], has_more: false, next_cursor: null });

  const adapter = makeAdapter();
  const { records } = await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null });

  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.id, 'abc-123');
  assert.equal(r.title, 'My Page');
  assert.equal(typeof r.body, 'string');
  assert.ok(r.ts);
  assert.ok(r.refs?.notion_id);
});

test('fetchBulk: paginates — passes cursor in body and surfaces nextCursor', async () => {
  let callCount = 0;
  globalThis.fetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    if (callCount === 1) {
      assert.equal(body.start_cursor, undefined, 'first call should have no cursor');
      return mockJsonResponse({ results: [makePage('p1', 'A')], has_more: true, next_cursor: 'cursor-XYZ' });
    }
    assert.equal(body.start_cursor, 'cursor-XYZ', 'second call should forward cursor');
    return mockJsonResponse({ results: [makePage('p2', 'B')], has_more: false, next_cursor: null });
  };

  const adapter = makeAdapter();
  const first = await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null });
  assert.equal(first.nextCursor, 'cursor-XYZ');

  const second = await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: 'cursor-XYZ' });
  assert.equal(second.nextCursor, null);
  assert.equal(second.records[0].id, 'p2');
});

test('fetchBulk: handles has_more=true with non-null next_cursor', async () => {
  globalThis.fetch = async () =>
    mockJsonResponse({ results: [makePage('x', 'X')], has_more: true, next_cursor: 'tok-abc' });

  const adapter = makeAdapter();
  const { nextCursor } = await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null });
  assert.equal(nextCursor, 'tok-abc');
});

test('fetchResource: fetches page then recurses block children', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('/pages/')) {
      return mockJsonResponse(makePage('page-1', 'Deep Page'));
    }
    if (url.includes('/blocks/')) {
      return mockJsonResponse({
        results: [
          {
            id: 'block-1',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: [{ plain_text: 'Hello block' }] },
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const adapter = makeAdapter();
  const record = await adapter.fetchResource({ userId: 'u1', orgId: 'o1', resourceId: 'page-1' });

  assert.equal(record.id, 'page-1');
  assert.match(record.body, /Hello block/);
});

test('fetchResource: returns body combining nested block text', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('/pages/')) return mockJsonResponse(makePage('p-deep', 'Nested'));
    // All block requests return a leaf with text
    return mockJsonResponse({
      results: [
        {
          id: 'b1',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [{ plain_text: 'Leaf text' }] },
        },
      ],
    });
  };

  const adapter = makeAdapter();
  const record = await adapter.fetchResource({ userId: 'u1', orgId: 'o1', resourceId: 'p-deep' });
  assert.equal(typeof record.body, 'string');
  assert.ok(record.body.length > 0);
});

test('fetchBulk: 429 — waits Retry-After then retries (single retry)', async () => {
  let callCount = 0;
  const delays = [];
  const origSetTimeout = globalThis.setTimeout;

  // Stub setTimeout so the test doesn't actually wait
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return origSetTimeout(fn, 0);
  };

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '2' : null) },
        json: async () => ({}),
        text: async () => '',
      };
    }
    return mockJsonResponse({ results: [], has_more: false, next_cursor: null });
  };

  const adapter = makeAdapter();
  await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null });

  assert.equal(callCount, 2, 'should have retried once after 429');
  assert.ok(delays.some(d => d >= 2000), 'should have waited at least Retry-After seconds');

  globalThis.setTimeout = origSetTimeout;
});

test('fetchBulk: throws when tokenResolver returns empty string (missing bearer)', async () => {
  globalThis.fetch = async () => mockJsonResponse({});

  const adapter = new NotionAdapter({
    providerKey: 'notion',
    tokenResolver: async () => '',
    prisma: {},
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  // The adapter must throw — either because getBearer throws or fetch is rejected
  // with an auth error. We assert the promise rejects.
  await assert.rejects(
    () => adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null }),
    (err) => {
      // Accept any Error (empty token should cause downstream failure)
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

test('fetchBulk: throws when tokenResolver is not injected', async () => {
  const adapter = new NotionAdapter({
    providerKey: 'notion',
    // no tokenResolver
    prisma: {},
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  await assert.rejects(
    () => adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null }),
    /tokenResolver not injected/,
  );
});

test('fetchBulk: throws on non-ok HTTP response from Notion', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => 'Forbidden',
  });

  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null }),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    },
  );
});
