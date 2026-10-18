import test from 'node:test';
import assert from 'node:assert/strict';

process.env.COMPOSIO_API_KEY = 'fixture-only';
const account = (id, toolkit = 'gmail') => ({ id, status: 'ACTIVE', toolkit: { slug: toolkit } });
async function fixture(run) {
  const original = globalThis.fetch;
  const catalogs = new Map(); const calls = []; let generation = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url); const body = options.body && JSON.parse(options.body);
    calls.push({ url: parsed, body, method: options.method });
    let result;
    if (parsed.pathname.endsWith('/connected_accounts')) {
      const owner = parsed.searchParams.get('user_ids');
      if (catalogs.get(owner) instanceof Error) throw catalogs.get(owner);
      result = { items: catalogs.get(owner) || [] };
    } else if (parsed.pathname.endsWith('/tool_router/session')) result = { session_id: `session-${++generation}` };
    else if (parsed.pathname.includes('/tool_router/session/')) result = { user_id: 'hivemind:other-user' };
    else throw new Error(`unexpected fixture call ${parsed.pathname}`);
    return new Response(JSON.stringify(result));
  };
  try {
    const service = await import(`../../src/connectors/composio/composio-service.js?owner=${Math.random()}`);
    await run({ service, catalogs, calls });
  } finally { globalThis.fetch = original; }
}

test('list and discovery bind the same legacy shared workspace Gmail, without querying another owner', () => fixture(async ({ service, catalogs, calls }) => {
  catalogs.set('sakana', [account('legacy-gmail')]);
  const rows = await service.listConnectedAccounts('sakana', { userId: 'amar' });
  const session = await service.getToolRouterSession('sakana', ['gmail'], { userId: 'amar', includeCustomToolkit: false });
  assert.equal(rows[0].connectionScope, 'org');
  assert.equal(session.subject, 'sakana');
  assert.equal(session.connectedAccounts.gmail, rows[0].id);
  const create = calls.find(call => call.method === 'POST');
  assert.equal(create.body.user_id, 'sakana');
  assert.equal(create.body.connected_accounts.gmail, 'legacy-gmail');
  assert.deepEqual(new Set(calls.filter(c => c.method === 'GET').map(c => c.url.searchParams.get('user_ids'))), new Set(['hivemind:amar', 'sakana:amar', 'sakana']));
  assert.deepEqual(await service.listConnectedAccounts('other-workspace', { userId: 'other-user' }), []);
}));

test('personal account wins, other users cannot see it, and OAuth completion replaces a stale empty session', () => fixture(async ({ service, catalogs }) => {
  const options = { userId: 'amar', includeCustomToolkit: false, allowDisconnected: true };
  const empty = await service.getToolRouterSession('sakana', ['gmail'], options);
  catalogs.set('hivemind:amar', [account('private-gmail')]);
  catalogs.set('sakana', [account('shared-gmail')]);
  const connected = await service.getToolRouterSession('sakana', ['gmail'], options);
  assert.notEqual(connected.id, empty.id);
  assert.equal(connected.subject, 'hivemind:amar');
  assert.equal(connected.connectedAccounts.gmail, 'private-gmail');
  const other = await service.listConnectedAccounts('sakana', { userId: 'colleague' });
  assert.deepEqual(other.map(row => row.id), ['shared-gmail']);
  assert.equal((await service.getToolRouterSession('sakana', ['gmail'], options)).cacheHit, true);
}));

test('provider failure stays unknown; it cannot fall through to another account or report disconnected', () => fixture(async ({ service, catalogs, calls }) => {
  catalogs.set('hivemind:amar', new Error('provider unavailable'));
  catalogs.set('sakana', [account('shared-gmail')]);
  await assert.rejects(service.getToolRouterSession('sakana', ['gmail'], { userId: 'amar', includeCustomToolkit: false }), /provider unavailable/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
}));

test('a stored session for another user is rejected before execution', () => fixture(async ({ service }) => {
  await assert.rejects(service.getToolRouterSession('sakana', ['gmail'], { userId: 'amar', sessionId: 'foreign', includeCustomToolkit: false }), /subject mismatch/);
}));
