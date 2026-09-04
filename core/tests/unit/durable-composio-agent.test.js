import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUseToolsDurableAgentEnvEnabled,
  isUseToolsDurableAgentEnabled,
  USE_TOOLS_DURABLE_AGENT_FLAGSHIP_KEY,
} from '../../src/agent/use-tools-durable-agent-flag.js';
import {
  appsMatchingRequest,
  composeBriefing,
  conversationKey,
  draftSubject,
  emailsFromProviderData,
  getOrCreateAgentRun,
  governReadSlugs,
  isReadThenWrite,
  namedPersonQuery,
  namedRepoQuery,
  pickRecipientEmail,
  shouldStartFreshRun,
  summarizeToolData,
  resetDurableAgentMemory,
  runDurableComposioAgent,
  saveAgentRun,
  selectReadSlugs,
  selectWriteSlug,
} from '../../src/agent/durable-composio-agent.js';

test('durable agent env gate is fail-closed', () => {
  assert.equal(isUseToolsDurableAgentEnvEnabled({}), false);
  assert.equal(isUseToolsDurableAgentEnvEnabled({ USE_TOOLS_DURABLE_AGENT: 'false' }), false);
  assert.equal(isUseToolsDurableAgentEnvEnabled({ USE_TOOLS_DURABLE_AGENT: 'true' }), true);
});

test('durable agent requires Flagship enabled:true from cloudflare-flagship', async () => {
  const env = { USE_TOOLS_DURABLE_AGENT: 'true', USE_TOOLS_DURABLE_AGENT_FLAG_URL: 'https://flags.test/use-tools-durable-agent' };
  assert.equal(await isUseToolsDurableAgentEnabled(env, { flagshipEnabled: false }), false);
  assert.equal(await isUseToolsDurableAgentEnabled(env, { flagshipEnabled: true }), true);
  const off = await isUseToolsDurableAgentEnabled(env, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ key: USE_TOOLS_DURABLE_AGENT_FLAGSHIP_KEY, enabled: false, source: 'cloudflare-flagship' }) }),
  });
  assert.equal(off, false);
  const on = await isUseToolsDurableAgentEnabled(env, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ key: USE_TOOLS_DURABLE_AGENT_FLAGSHIP_KEY, enabled: true, source: 'cloudflare-flagship' }) }),
  });
  assert.equal(on, true);
  const missing = await isUseToolsDurableAgentEnabled({ USE_TOOLS_DURABLE_AGENT: 'true' }, {
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.equal(missing, false);
});

test('search slugs pick fetch reads and send writes, never label or delete', () => {
  const slugs = ['GMAIL_CREATE_LABEL', 'GMAIL_BATCH_DELETE_MESSAGES', 'GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL', 'GITHUB_LIST_REPOS', 'GMAIL_GET_ATTACHMENT', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'];
  assert.deepEqual(selectReadSlugs(slugs, ['gmail', 'github']), ['GMAIL_FETCH_EMAILS', 'GITHUB_LIST_REPOS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID']);
  assert.deepEqual(selectReadSlugs(['AGILITY_CMS_GET_LOGS', 'GMAIL_FETCH_EMAILS'], ['gmail']), ['GMAIL_FETCH_EMAILS']);
  assert.equal(selectWriteSlug(slugs, ['gmail']), 'GMAIL_SEND_EMAIL');
  assert.equal(namedPersonQuery('send important information about repo to rama via gmail'), 'rama');
  assert.equal(namedPersonQuery('send a mail to rama about it'), 'rama');
  assert.equal(pickRecipientEmail(['amarsai2005@gmail.com', 'ramasantoshi1206@gmail.com'], 'rama'), 'ramasantoshi1206@gmail.com');
  assert.deepEqual(
    appsMatchingRequest('go through HIVEMIND git repo and send to rama via gmail', ['gmail', 'github', 'slack']),
    ['gmail', 'github'],
  );
  assert.deepEqual(
    appsMatchingRequest('send the list of my last 10 watch histories from youtube and send a mail to rama about it', ['gmail', 'youtube', 'github']),
    ['gmail', 'youtube'],
  );
  assert.equal(namedRepoQuery('go through HIVEMIND git repo'), 'HIVEMIND');
  assert.equal(
    isReadThenWrite('go through HIVEMIND git repo and send important information about repo to rama via gmail', ['gmail', 'github']),
    true,
  );
  assert.equal(
    isReadThenWrite('send the list of my last 10 watch histories from youtube and send a mail to rama about it', ['gmail', 'youtube']),
    true,
  );
  assert.equal(isReadThenWrite('send this on gmail and slack', ['gmail', 'slack']), false);
  assert.deepEqual(
    governReadSlugs([
      'GITHUB_LIST_REPOSITORIES',
      'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_GET_README',
      'GMAIL_FETCH_EMAILS',
    ], { readApps: ['github', 'gmail'], person: 'rama' }),
    ['GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'GMAIL_FETCH_EMAILS'],
  );
  assert.equal(
    shouldStartFreshRun({ status: 'waiting_approval' }, 'new request', null),
    true,
  );
  assert.equal(
    shouldStartFreshRun({ status: 'waiting_approval' }, 'new request', { option_id: 'approve' }),
    false,
  );
});

test('same conversation reuses the agent run id', async () => {
  resetDurableAgentMemory();
  const ctx = { orgId: 'o1', userId: 'u1', threadId: 'thread-a' };
  const first = await getOrCreateAgentRun({ prisma: null, ctx, message: 'first' });
  await saveAgentRun({ prisma: null, run: first });
  const second = await getOrCreateAgentRun({ prisma: null, ctx, message: 'continue' });
  assert.equal(second.id, first.id);
  assert.equal(conversationKey(ctx), 'thread-a');
});

test('durable agent executes Composio reads from search slugs and drafts send, never live send', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() {
      return [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'github', status: 'ACTIVE' }];
    },
    async getToolRouterSession() { return { id: 'sess_1' }; },
    async searchToolsByIntent() {
      return {
        connectedToolkits: ['gmail', 'github'],
        tools: [
          { _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail' } },
          { _composio: { slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail' } },
          { _composio: { slug: 'GMAIL_CREATE_LABEL', toolkit: 'gmail' } },
          { _composio: { slug: 'GITHUB_LIST_REPOS', toolkit: 'github' } },
        ],
      };
    },
    async generateToolInputs() { return {}; },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'GMAIL_FETCH_EMAILS') {
          return {
            successful: true,
            data: { messages: [{ from: 'Rama Santhoshi <ramasantoshi1206@gmail.com>', subject: 'Hi' }] },
          };
        }
        if (tool.slug === 'GITHUB_LIST_REPOS') {
          return {
            successful: true,
            data: { items: [{ full_name: 'amar/HIVEMIND', description: 'Memory OS for organizations', html_url: 'https://github.com/amar/HIVEMIND' }] },
          };
        }
        return { successful: true, data: { items: [] } };
      });
    },
  };
  const ctx = {
    orgId: 'o1', userId: 'u1', threadId: 't-durable',
    _trace: { traceId: 'tr1' },
    _tracedDispatch: async (_name, _args, passedCtx) => {
      assert.equal(passedCtx.orgId, 'o1');
      return { memories: [{ content: 'repo notes' }] };
    },
    polishBriefing: async ({ body }) => body,
    prisma: {
      pendingWrite: {
        create: async ({ data }) => { created.push(data); return { id: 'DRAFT-1' }; },
      },
    },
  };
  const events = [];
  const result = await runDurableComposioAgent({
    message: 'go through HIVEMIND git repo and send important information about repo to rama via gmail',
    ctx,
    composio,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, 'pending');
  assert.notEqual(result.run.id, (await getOrCreateAgentRun({ ctx, message: 'again' })).id);
  assert.equal(result.run.id, (await getOrCreateAgentRun({ ctx, message: 'again', choice: { option_id: 'approve' } })).id);
  assert.ok(!executed.includes('GMAIL_SEND_EMAIL'));
  assert.ok(!executed.includes('GMAIL_CREATE_LABEL'));
  assert.ok(executed.includes('GMAIL_FETCH_EMAILS'));
  assert.ok(executed.includes('GITHUB_LIST_REPOS'));
  assert.equal(created[0].toolName, 'GMAIL_SEND_EMAIL');
  assert.equal(created[0].toolArgs.recipient_email, 'ramasantoshi1206@gmail.com');
  assert.match(created[0].toolArgs.body, /HIVEMIND/);
  assert.match(created[0].toolArgs.body, /Hi Rama/);
  assert.equal(created[0].toolArgs.body.includes('GMAIL_FETCH_EMAILS'), false);
  assert.equal(created[0].toolArgs.body.includes('Hi'), true);
  assert.equal(created[0].toolArgs.body.includes('recall_plan'), false);
  assert.equal(created[0].toolArgs.subject, draftSubject('go through HIVEMIND git repo and send important information about repo to rama via gmail'));
  assert.equal(created[0].status, 'draft');
  assert.equal(result.run.composioSessionId, 'sess_1');
  assert.ok(events.some((event) => event.type === 'tool_started' && event.name === 'GITHUB_LIST_REPOS'));
  assert.ok(events.some((event) => event.type === 'tool_result' && event.name === 'GITHUB_LIST_REPOS' && event.status === 'completed'));
  assert.ok(result.steps.every((step) => step.tool || step.slug));
});

test('composeBriefing uses provider reads instead of the raw user prompt', () => {
  const body = composeBriefing({
    message: 'go through HIVEMIND git repo and send to rama via gmail',
    person: 'rama',
    repoHint: 'HIVEMIND',
    reads: [
      { slug: 'GITHUB_LIST_REPOS', successful: true, data: { items: [{ full_name: 'amar/HIVEMIND', name: 'HIVEMIND', owner: { login: 'amar' }, description: 'core', html_url: 'https://github.com/amar/HIVEMIND' }] } },
      { slug: 'GMAIL_FETCH_EMAILS', successful: true, data: { messages: [{ subject: 'Missing You' }] } },
      { slug: 'hivemind_recall', successful: false, data: { error: 'Cannot read properties of undefined (reading \'persistentMemoryStore\')' } },
    ],
    recallText: '{"mode":"fact","recall_plan":[],"memories":[]}',
    recallData: { memories: [{ title: 'Repo note', content: 'HIVEMIND is the memory OS' }] },
  });
  assert.match(body, /amar\/HIVEMIND/);
  assert.match(body, /Hi Rama/);
  assert.match(body, /HIVEMIND is the memory OS/);
  assert.equal(body.includes('Missing You'), false);
  assert.equal(body.includes('GMAIL_FETCH_EMAILS'), false);
  assert.equal(body.includes('persistentMemoryStore'), false);
  assert.equal(body.includes('recall_plan'), false);
  assert.equal(body.includes('Briefing from HIVEMIND for:'), false);
});

test('intent search plus a second-wave read drafts YouTube facts without live send', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const generatedFor = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() {
      return [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'youtube', status: 'ACTIVE' }];
    },
    async getToolRouterSession() { return { id: 'sess_yt' }; },
    async searchToolsByIntent(_org, _message, opts = {}) {
      const tools = [
        { _composio: { slug: 'YOUTUBE_LIST_USER_PLAYLISTS', toolkit: 'youtube' } },
        { _composio: { slug: 'YOUTUBE_LIST_PLAYLIST_ITEMS', toolkit: 'youtube' } },
        { _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail' } },
        { _composio: { slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail' } },
      ];
      if (opts.toolkits) {
        return { tools: tools.filter((tool) => opts.toolkits.includes(tool._composio.toolkit)) };
      }
      return { connectedToolkits: ['gmail', 'youtube'], tools };
    },
    async generateToolInputs(slug, text) {
      generatedFor.push(slug);
      if (slug === 'YOUTUBE_LIST_PLAYLIST_ITEMS') {
        assert.match(String(text), /History|Watch later|PL123/i);
        return { playlistId: 'PL123', maxResults: 10 };
      }
      return {};
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'YOUTUBE_LIST_USER_PLAYLISTS') {
          return {
            successful: true,
            data: { items: [{ id: 'PL123', snippet: { title: 'History' } }, { id: 'PL999', snippet: { title: 'Watch later' } }] },
          };
        }
        if (tool.slug === 'YOUTUBE_LIST_PLAYLIST_ITEMS') {
          return {
            successful: true,
            data: {
              items: [
                { snippet: { title: 'HIVEMIND walkthrough', channelTitle: 'Amar' } },
                { snippet: { title: 'Composio tools', channelTitle: 'Amar' } },
              ],
            },
          };
        }
        if (tool.slug === 'GMAIL_FETCH_EMAILS') {
          return {
            successful: true,
            data: { messages: [{ from: 'Rama Santhoshi <ramasantoshi1206@gmail.com>', subject: 'love note' }] },
          };
        }
        return { successful: true, data: { items: [] } };
      });
    },
  };
  const ctx = {
    orgId: 'o1', userId: 'u1', threadId: 't-youtube',
    polishBriefing: async ({ body }) => body,
    _tracedDispatch: async () => ({ memories: [] }),
    prisma: {
      pendingWrite: {
        create: async ({ data }) => { created.push(data); return { id: 'DRAFT-YT' }; },
      },
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send the list of my last 10 watch histories from youtube and send a mail to rama about it',
    ctx,
    composio,
  });
  assert.equal(result.status, 'pending');
  assert.ok(executed.includes('YOUTUBE_LIST_USER_PLAYLISTS'));
  assert.ok(executed.includes('YOUTUBE_LIST_PLAYLIST_ITEMS'));
  assert.ok(generatedFor.includes('YOUTUBE_LIST_PLAYLIST_ITEMS'));
  assert.ok(!executed.includes('GMAIL_SEND_EMAIL'));
  assert.equal(created[0].toolArgs.recipient_email, 'ramasantoshi1206@gmail.com');
  assert.match(created[0].toolArgs.body, /HIVEMIND walkthrough/);
  assert.equal(created[0].toolArgs.body.includes('love note'), false);
  assert.equal(created[0].status, 'draft');
});

test('later turns reuse persisted Composio session id and never recreate', async () => {
  resetDurableAgentMemory();
  let sessionCalls = 0;
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession() {
      sessionCalls += 1;
      return { id: `sess_live_${sessionCalls}` };
    },
    async searchToolsByIntent() {
      return { tools: [{ _composio: { slug: 'GMAIL_FETCH_EMAILS' } }] };
    },
    async executeToolsParallel() {
      return [{ successful: true, data: { messages: [] } }];
    },
  };
  const ctx = {
    orgId: 'o1', userId: 'u1', threadId: 'reuse-session',
    _tracedDispatch: async () => ({ memories: [] }),
  };
  const first = await runDurableComposioAgent({ message: 'fetch recent mail', ctx, composio });
  const second = await runDurableComposioAgent({ message: 'fetch again', ctx, composio });
  assert.equal(sessionCalls, 1);
  assert.equal(first.run.composioSessionId, 'sess_live_1');
  assert.equal(second.run.composioSessionId, first.run.composioSessionId);
});

test('does not execute or draft slugs that search did not return', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession() { return { id: 'sess_x' }; },
    async searchToolsByIntent() {
      return { tools: [{ _composio: { slug: 'GMAIL_LIST_LABELS', toolkit: 'gmail' } }] };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map(() => ({ successful: true, data: {} }));
    },
  };
  const ctx = {
    orgId: 'o1', userId: 'u1', threadId: 'no-inject',
    _tracedDispatch: async () => ({ memories: [] }),
    prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'NO' }; } } },
  };
  const result = await runDurableComposioAgent({
    message: 'send a summary to rama via gmail',
    ctx,
    composio,
  });
  assert.equal(executed.includes('GMAIL_FETCH_EMAILS'), false);
  assert.equal(executed.includes('GMAIL_SEND_EMAIL'), false);
  assert.deepEqual(executed, ['GMAIL_LIST_LABELS']);
  assert.equal(created.length, 0);
  assert.equal(result.status, 'completed');
});

test('disconnected named app pauses with a Connect continuation', async () => {
  resetDurableAgentMemory();
  const composio = {
    async listConnectedAccounts() { return []; },
    async searchToolsByIntent() {
      return { tools: [{ _composio: { slug: 'SLACK_SEND_MESSAGE', toolkit: 'slack' } }], apps: [{ slug: 'slack' }] };
    },
    async createConnectLink() { return { redirectUrl: 'https://connect.example/slack' }; },
  };
  const result = await runDurableComposioAgent({
    message: 'post a summary to slack',
    ctx: { orgId: 'o1', userId: 'u1', threadId: 'connect-slack', _tracedDispatch: async () => ({}) },
    composio,
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.inputRequests[0].kind, 'connect_account');
  assert.equal(result.inputRequests[0].toolkit, 'slack');
  assert.equal(result.resumeState.kind, 'durable_agent');
});

test('ambiguous apps ask do you mean this', async () => {
  resetDurableAgentMemory();
  const composio = {
    async listConnectedAccounts() {
      return [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'slack', status: 'ACTIVE' }];
    },
    async searchToolsByIntent() {
      return {
        tools: [
          { _composio: { slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail' } },
          { _composio: { slug: 'SLACK_SEND_MESSAGE', toolkit: 'slack' } },
        ],
      };
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send this on gmail and slack',
    ctx: { orgId: 'o1', userId: 'u1', threadId: 'clarify-apps', _tracedDispatch: async () => ({}) },
    composio,
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.inputRequests[0].kind, 'single_choice');
  assert.ok(result.inputRequests[0].options.some((option) => option.value === 'gmail'));
  assert.ok(result.inputRequests[0].options.some((option) => option.value === 'slack'));
});

test('summarizeToolData decodes GitHub README base64', () => {
  const text = summarizeToolData({
    encoding: 'base64',
    content: Buffer.from('# HIVEMIND\nPersistent memory OS').toString('base64'),
  });
  assert.match(text, /# HIVEMIND/);
  assert.equal(text.includes('IyB'), false);
});

test('emailsFromProviderData ignores example.com placeholders', () => {
  assert.deepEqual(
    emailsFromProviderData({ from: 'Rama <rama@x.dev>', extra: 'x@example.com' }),
    ['rama@x.dev'],
  );
});
