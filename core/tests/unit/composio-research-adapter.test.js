import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverGovernedSessionReads, executeGovernedResearchTool, executeGovernedSessionRead,
  governedResearchCapability, isGovernedReadTool, issueGovernedReadGrant,
  resolveGovernedReadGrant } from '../../src/connectors/composio/runtime-adapter.js';

test('Parallel research surface is fixed and unknown capabilities fail closed', () => {
  assert.equal(governedResearchCapability('parallel_findall').tool, 'PARALLEL_FIND_ALL');
  assert.deepEqual(governedResearchCapability('parallel_findall_status'), {
    toolkit: 'parallel', tool: 'PARALLEL_RETRIEVE_FIND_ALL_RUN_STATUS', effect: 'read',
  });
  assert.deepEqual(governedResearchCapability('parallel_findall_result'), {
    toolkit: 'parallel', tool: 'PARALLEL_GET_FIND_ALL_RUN_RESULT', effect: 'read',
  });
  assert.throws(() => governedResearchCapability('gmail_send'), /capability_denied/);
});

test('shadow mode cannot execute a Composio provider call', async () => {
  const result = await executeGovernedResearchTool('org-1', 'parallel_task', { input: 'research' }, { mode: 'shadow' });
  assert.deepEqual(result, { shadow: true, capability: 'parallel_task', toolkit: 'parallel', tool: 'PARALLEL_CREATE_TASK_RUN', effect: 'research_compute' });
});

test('session discovery keeps compact reads and removes write tools', async () => {
  const discovered = await discoverGovernedSessionReads('org-1', {
    toolkits: ['gmail'], useCases: ['find messages about invoices'],
  }, { discoverSessionTools: async () => ({ sessionId: 'session-1', searchedLogId: 'search-log', tools: [
    { function: { name: 'composio_gmail_fetch_emails', description: 'Fetch matching emails', parameters: { type: 'object', properties: { query: { type: 'string' } } } }, _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail' } },
    { function: { name: 'composio_gmail_send_email', description: 'Send an email', parameters: {} }, _composio: { slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail' } },
  ] }) });
  assert.equal(discovered.tools.length, 1);
  assert.equal(discovered.tools[0].toolSlug, 'GMAIL_FETCH_EMAILS');
  assert.equal(isGovernedReadTool({ slug: 'GMAIL_SEND_EMAIL' }), false);
  assert.equal(isGovernedReadTool({ slug: 'SLACK_LIKE_MESSAGE' }), false);
  assert.equal(isGovernedReadTool({ slug: 'VENDOR_UNCLASSIFIED_ACTION' }), false);
});

test('read grants bind opaque session authority to one tenant and expire closed', () => {
  const issued = issueGovernedReadGrant({
    orgId: 'org-1', userId: 'user-1', toolkit: 'gmail',
    sessionId: 'secret-session', toolSlug: 'GMAIL_FETCH_EMAILS',
  }, { now: 1_000, secret: 'test-secret' });
  assert.notEqual(issued.grantId, 'secret-session');
  assert.equal(issued.grantId.includes('secret-session'), false);
  assert.equal(resolveGovernedReadGrant({
    grantId: issued.grantId, orgId: 'org-1', userId: 'user-1', toolSlug: 'GMAIL_FETCH_EMAILS',
  }, { now: 2_000, secret: 'test-secret' }).sessionId, 'secret-session');
  assert.throws(() => resolveGovernedReadGrant({
    grantId: issued.grantId, orgId: 'org-2', userId: 'user-1', toolSlug: 'GMAIL_FETCH_EMAILS',
  }, { now: 2_000, secret: 'test-secret' }), /scope_denied/);
  assert.throws(() => resolveGovernedReadGrant({
    grantId: issued.grantId, orgId: 'org-1', userId: 'user-1', toolSlug: 'GMAIL_FETCH_EMAILS',
  }, { now: issued.expiresAt + 1, secret: 'test-secret' }), /grant_expired/);
  assert.throws(() => resolveGovernedReadGrant({
    grantId: issued.grantId, orgId: 'org-1', userId: 'user-1', toolSlug: 'GMAIL_FETCH_EMAILS',
  }, { now: 2_000, secret: 'wrong-secret' }), /grant_invalid/);
});

test('session execution rejects writes and returns a read receipt', async () => {
  await assert.rejects(executeGovernedSessionRead({ sessionId: 's', toolSlug: 'GMAIL_SEND_EMAIL', args: {} }), /read_denied/);
  const result = await executeGovernedSessionRead({ sessionId: 's', toolSlug: 'GMAIL_FETCH_EMAILS', args: { query: 'invoice' } }, {
    executeSessionTool: async () => ({ successful: true, data: { messages: [{ id: 'm1' }] }, session_log_id: 'log-1' }),
  });
  assert.equal(result.data.messages[0].id, 'm1');
  assert.deepEqual(result.receipt, { provider: 'composio', transport: 'tool_router_session', tool_slug: 'GMAIL_FETCH_EMAILS', session_log_id: 'log-1', effect: 'read' });
});
