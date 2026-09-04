import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Tool Router caches session discovery and executes the selected provider read once', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method, body });
    const json = (payload) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    if (String(url).includes('/api/v3.1/connected_accounts?')) {
      return json({ items: [{ id: 'ca_gmail', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] });
    }
    if (String(url).endsWith('/api/v3/tool_router/session')) return json({ session_id: 'trs_test' });
    if (body?.slug === 'COMPOSIO_SEARCH_TOOLS') {
      return json({
        data: {
          results: [{
            primary_tool_slugs: ['GMAIL_GET_CURRENT_TIME', 'GMAIL_FETCH_EMAILS'],
            related_tool_slugs: ['GMAIL_LIST_LABELS'],
          }],
          tool_schemas: { GMAIL_LIST_LABELS: { tool_slug: 'GMAIL_LIST_LABELS' } },
        },
        log_id: 'search_log',
      });
    }
    if (body?.slug === 'COMPOSIO_GET_TOOL_SCHEMAS') {
      return json({
        data: {
          tool_schemas: {
            GMAIL_GET_CURRENT_TIME: {
              toolkit: 'GMAIL', description: 'Get current time.',
              input_schema: { type: 'object', properties: {} },
            },
            GMAIL_FETCH_EMAILS: {
              toolkit: 'GMAIL', description: 'Fetch email messages.',
              input_schema: { type: 'object', properties: { max_results: { type: 'integer' } } },
            },
          },
        },
        log_id: 'schema_log',
      });
    }
    if (body?.slug === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
      return json({
        data: { results: [{ response: { successful: true, data: { messages: [{ subject: 'Latest' }] }, error: null } }] },
        log_id: 'execute_log',
      });
    }
    return new Response('unexpected request', { status: 500 });
  };

  try {
    const service = await import(`../../src/connectors/composio/composio-service.js?session-test=${Date.now()}`);
    const request = {
      toolkits: ['gmail'], useCases: ['Fetch my latest email'],
      searchPayload: {
        queries: [{ use_case: 'Fetch my latest email', known_fields: 'destination_apps:gmail' }],
        session: { generate_id: true },
        search_strategy: 'auto',
        model: 'test-model',
      },
    };
    const first = await service.discoverSessionTools('org-1', request);
    const second = await service.discoverSessionTools('org-1', request);
    const executed = await service.executeSessionTool(first.sessionId, 'GMAIL_FETCH_EMAILS', { max_results: 1 });

    assert.equal(first.sessionCacheHit, false);
    assert.equal(first.discoveryCacheHit, false);
    assert.equal(second.sessionCacheHit, true);
    assert.equal(second.discoveryCacheHit, true);
    assert.deepEqual(second.tools.map((tool) => tool._composio.slug), ['GMAIL_GET_CURRENT_TIME', 'GMAIL_FETCH_EMAILS']);
    assert.equal(second.tools.length, 2, 'primary tools remain available while related tools stay excluded');
    assert.equal(executed.successful, true);
    assert.equal(executed.data.messages[0].subject, 'Latest');
    assert.equal(calls.filter((call) => call.body?.slug === 'COMPOSIO_SEARCH_TOOLS').length, 1);
    assert.equal(calls.filter((call) => call.body?.slug === 'COMPOSIO_GET_TOOL_SCHEMAS').length, 1);
    assert.equal(calls.filter((call) => call.body?.slug === 'COMPOSIO_MULTI_EXECUTE_TOOL').length, 1);
    const searchCall = calls.find((call) => call.body?.slug === 'COMPOSIO_SEARCH_TOOLS');
    assert.equal(searchCall.body.arguments.search_strategy, 'auto');
    assert.equal(searchCall.body.arguments.session.generate_id, true);
    assert.equal(typeof searchCall.body.arguments.queries[0].known_fields, 'string');
    assert.match(searchCall.body.arguments.queries[0].known_fields, /gmail/);
    assert.equal(searchCall.body.arguments.queries[0].search_strategy, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = originalKey;
  }
});
