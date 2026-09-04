import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUseToolsDurableAgentEnvEnabled,
  isUseToolsDurableAgentEnabled,
  USE_TOOLS_DURABLE_AGENT_FLAGSHIP_KEY,
} from '../../src/agent/use-tools-durable-agent-flag.js';
import {
  appsMatchingRequest,
  compactDurableObservation,
  composeBriefing,
  composeWriteToolArgs,
  conversationKey,
  draftSubject,
  emailsFromProviderData,
  fallbackNextDurableAction,
  getOrCreateAgentRun,
  governNextAction,
  governReadSlugs,
  isReadOnlyRequest,
  isReadThenWrite,
  isWriteSlug,
  namedPersonQuery,
  namedRepoQuery,
  pickRecipientEmail,
  shouldStartFreshRun,
  summarizeToolData,
  resetDurableAgentMemory,
  RETRY_CONNECT_VALUE,
  runDurableComposioAgent,
  saveAgentRun,
  selectReadSlugs,
  selectWriteSlug,
} from '../../src/agent/durable-composio-agent.js';

test('LinkedIn create-post is a write and last-post questions are read-only', () => {
  assert.equal(isWriteSlug('LINKEDIN_CREATE_LINKED_IN_POST'), true);
  assert.equal(isWriteSlug('LINKEDIN_GET_POST_CONTENT'), false);
  assert.equal(isReadOnlyRequest('what do u think about my last linkedin post'), true);
  assert.equal(isReadOnlyRequest('what was my last linkedin post about?'), true);
  assert.equal(isReadOnlyRequest('send rama, about information about the company'), false);
});

test('read-only LinkedIn questions do not execute create-post', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'linkedin', status: 'ACTIVE' }]; },
    async getToolRouterSession() { return { id: 'trs_li_read' }; },
    async discoverSessionTools() {
      return {
        sessionId: 'trs_li_read',
        primaryToolSlugs: ['LINKEDIN_CREATE_LINKED_IN_POST', 'LINKEDIN_GET_POST_CONTENT', 'LOCAL_HIVEMIND_HIVEMIND_RECALL'],
        relatedToolSlugs: [],
        toolkitConnectionStatuses: { linkedin: { has_active_connection: true } },
        tools: [
          { _composio: { slug: 'LINKEDIN_CREATE_LINKED_IN_POST' } },
          { _composio: { slug: 'LINKEDIN_GET_POST_CONTENT' } },
        ],
      };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map(() => ({ successful: false, error: '1 out of 1 tools failed', data: null }));
    },
  };
  const result = await runDurableComposioAgent({
    message: 'what was my last linkedin post about?',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-li-read',
      synthesizeDurableAnswer: async ({ evidence, failures }) => `synth:${failures || evidence || 'none'}`,
      _tracedDispatch: async () => ({ memories: [{ title: 'Note', content: 'not a linkedin post' }] }),
    },
    composio,
  });
  assert.equal(executed.includes('LINKEDIN_CREATE_LINKED_IN_POST'), false);
  assert.notEqual(result.summary, 'Completed durable agent steps.');
  assert.match(result.summary, /synth:/);
});

test('write-tool args follow the schema and do not paste the user command', async () => {
  const args = await composeWriteToolArgs({
    slug: 'GMAIL_CREATE_EMAIL_DRAFT',
    schema: {
      properties: {
        recipient_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
    },
    message: 'send rama, about information about the company',
    person: 'rama',
    to: 'rama@x.dev',
    facts: ['Singulance is a sovereign AI operating layer that runs inside an organization\'s memory.'],
    generateImpl: async () => ({
      recipient_email: 'wrong@x.dev',
      subject: 'Introducing Singulance',
      body: 'Hi Rama,\n\nSingulance is a sovereign AI operating layer that runs inside memory.\n\nBest regards',
    }),
  });
  assert.equal(args.recipient_email, 'rama@x.dev');
  assert.equal(args.subject, 'Introducing Singulance');
  assert.equal(args.subject.includes('send rama'), false);
  assert.equal(args.body.includes('Here is what I found'), false);
  assert.match(args.body, /Singulance is a sovereign AI operating layer/);
});

test('write-tool subject is rewritten when the model copies the user request', async () => {
  const args = await composeWriteToolArgs({
    slug: 'GMAIL_SEND_EMAIL',
    schema: { properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } },
    message: 'send rama, about information about the company',
    person: 'rama',
    to: 'rama@x.dev',
    facts: ['Singulance: AI workforce that runs inside memory'],
    generateImpl: async () => ({
      to: 'rama@x.dev',
      subject: 'send rama, about information about the company',
      body: 'Here is what I found:\n{json}',
    }),
  });
  assert.equal(args.to, 'rama@x.dev');
  assert.equal(args.subject.includes('send rama'), false);
  assert.equal(args.body.includes('Here is what I found'), false);
});

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
  assert.equal(selectWriteSlug(['YOUTUBE_CREATE_COMMENT_REPLY', 'GMAIL_CREATE_EMAIL_DRAFT'], ['youtube', 'gmail']), 'GMAIL_CREATE_EMAIL_DRAFT');
  assert.equal(namedPersonQuery('send important information about repo to rama via gmail'), 'rama');
  assert.equal(namedPersonQuery('send a mail to rama about it'), 'rama');
  assert.equal(namedPersonQuery('send Rama about my linkedin profile'), 'Rama');
  assert.equal(pickRecipientEmail(['amarsai2005@gmail.com', 'ramasantoshi1206@gmail.com'], 'rama'), 'ramasantoshi1206@gmail.com');
  assert.deepEqual(
    appsMatchingRequest('go through HIVEMIND git repo and send to rama via gmail', ['gmail', 'github', 'slack']),
    ['gmail', 'github'],
  );
  assert.deepEqual(
    appsMatchingRequest('send the list of my last 10 watch histories from youtube and send a mail to rama about it', ['gmail', 'youtube', 'github']),
    ['gmail', 'youtube'],
  );
  assert.deepEqual(
    appsMatchingRequest('what are my important emails from the last month?', ['gmail', 'github']),
    ['gmail'],
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
  assert.deepEqual(
    appsMatchingRequest('send Rama about my linkedin profile', ['gmail', 'youtube', 'github', 'notion']),
    ['linkedin'],
  );
  assert.equal(
    isReadThenWrite('send Rama about my linkedin profile', ['linkedin']),
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
  assert.equal(shouldStartFreshRun({ status: 'waiting_user' }, 'send Rama about my linkedin profile', null), true);
  assert.equal(shouldStartFreshRun({ status: 'waiting_user' }, 'Gmail', { option_id: 'gmail', value: 'gmail' }), false);
});

test('same conversation reuses the agent run id', async () => {
  resetDurableAgentMemory();
  const ctx = { orgId: 'o1', userId: 'u1', threadId: 'thread-a' };
  const first = await getOrCreateAgentRun({ prisma: null, ctx, message: 'first' });
  await saveAgentRun({ prisma: null, run: first });
  const second = await getOrCreateAgentRun({ prisma: null, ctx, message: 'continue' });
  assert.equal(second.id, first.id);
  assert.equal(conversationKey(ctx), 'user:u1:thread-a');
});

test('a new typed prompt does not reuse a waiting_user clarify run', async () => {
  resetDurableAgentMemory();
  const ctx = { orgId: 'o1', userId: 'u1', threadId: 'thread-clarify' };
  const first = await getOrCreateAgentRun({ prisma: null, ctx, message: 'do something' });
  first.status = 'waiting_user';
  await saveAgentRun({ prisma: null, run: first });
  const next = await getOrCreateAgentRun({ prisma: null, ctx, message: 'send Rama about my linkedin profile' });
  assert.notEqual(next.id, first.id);
  const resume = await getOrCreateAgentRun({
    prisma: null, ctx, message: 'Gmail', choice: { option_id: 'gmail', value: 'gmail' },
  });
  assert.equal(resume.id, first.id);
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
  assert.ok(created[0].toolArgs.subject);
  assert.equal(created[0].toolArgs.subject.toLowerCase().includes('send important'), false);
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
    factToolkits: ['github'],
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
  assert.equal(body.includes('HIVEMIND is the memory OS'), false);
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
  assert.equal(executed.includes('GMAIL_LIST_LABELS'), false);
  assert.deepEqual(executed, []);
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
  assert.ok(result.inputRequests[0].step_index >= 0);
  assert.equal(result.resumeState.kind, 'durable_agent');
});

test('durable production path uses Session search and Session execution, never catalog or direct execute', async () => {
  resetDurableAgentMemory();
  let searchPayload = null;
  let sessionExecutions = 0;
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession(_org, toolkits, options) {
      assert.deepEqual(toolkits, ['gmail']);
      assert.equal(options.allowDisconnected, true);
      return { id: 'trs_session' };
    },
    async discoverSessionTools(_org, input) {
      searchPayload = input.searchPayload;
      return {
        sessionId: 'trs_session',
        primaryToolSlugs: ['GMAIL_FETCH_EMAILS'],
        toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
        recommendedPlanSteps: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }],
        tools: [{ _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail' } }],
      };
    },
    async searchToolsByIntent() { throw new Error('catalog must not run'); },
    async executeTool() { throw new Error('direct execute must not run'); },
    async executeToolsParallel(_org, calls, options) {
      sessionExecutions += 1;
      assert.equal(options.sessionId, 'trs_session');
      assert.equal(options.allowDirectFallback, false);
      return calls.map((call) => ({ successful: true, slug: call.slug, data: { messages: [] } }));
    },
  };
  const result = await runDurableComposioAgent({
    message: 'Show my important Gmail emails from the last month.',
    ctx: { orgId: 'o1', userId: 'u1', threadId: 'session-only', _tracedDispatch: async () => ({ memories: [] }) },
    composio,
  });
  assert.equal(result.status, 'completed');
  assert.equal(sessionExecutions, 1);
  assert.equal(searchPayload.search_strategy, 'auto');
  assert.equal(searchPayload.session.generate_id, true);
  assert.equal(typeof searchPayload.queries[0].known_fields, 'string');
  assert.equal(searchPayload.queries[0].known_fields.includes('product_context'), false);
  assert.equal(searchPayload.queries[0].use_case, "fetch the authenticated user's latest gmail emails");
  assert.equal(searchPayload.queries[0].search_strategy, undefined);
  assert.deepEqual(result.run.scratch.primary_tool_slugs, ['GMAIL_FETCH_EMAILS']);
  assert.deepEqual(result.run.scratch.recommended_plan_steps, [{ tool_slug: 'GMAIL_FETCH_EMAILS' }]);
  assert.deepEqual(result.run.scratch.plan, ['GMAIL_FETCH_EMAILS']);
});

test('connect link uses the HIVEMIND callback origin so OAuth returns to chat', async () => {
  resetDurableAgentMemory();
  let captured = null;
  const composio = {
    async listConnectedAccounts() { return []; },
    async searchToolsByIntent() {
      return { tools: [{ _composio: { slug: 'LINKEDIN_GET_MY_INFO', toolkit: 'linkedin' } }], apps: [{ slug: 'linkedin' }] };
    },
    async createConnectLink(_toolkit, _org, opts = {}) {
      captured = opts;
      return { redirectUrl: 'https://connect.example/linkedin' };
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send Rama about my linkedin profile',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 'connect-li',
      composioCallbackOrigin: 'https://next.singulancelabs.com',
      _tracedDispatch: async () => ({}),
    },
    composio,
  });
  assert.equal(result.status, 'needs_input');
  assert.match(captured.callbackUrl, /\/hivemind\/app\/connect\/composio\/callback\?composio_toolkit=linkedin/);
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

test('fallback lists before retrying a GET that failed for missing id', () => {
  const next = fallbackNextDurableAction({
    searched: true,
    read_only: true,
    person: '',
    receipts: [{ slug: 'LINKEDIN_GET_POST_CONTENT', status: 'skipped', summary: 'needs more context' }],
    known: {
      connected: ['linkedin'],
      candidates: ['linkedin'],
      slugs: ['LINKEDIN_CREATE_LINKED_IN_POST', 'LINKEDIN_GET_POST_CONTENT', 'LINKEDIN_GET_MY_POSTS'],
      related: [],
      emails: [],
      statuses: { linkedin: { has_active_connection: true } },
      facts_toolkits: [],
    },
  });
  assert.equal(next.action, 'execute');
  assert.equal(next.slug, 'LINKEDIN_GET_MY_POSTS');
});

test('governNextAction never live-sends a write slug', () => {
  const obs = {
    searched: true,
    read_only: false,
    known: { slugs: ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'], related: [], connected: ['gmail'], candidates: ['gmail'], emails: ['a@x.dev'], facts_toolkits: ['gmail'], statuses: { gmail: { has_active_connection: true } } },
    receipts: [{ slug: 'GMAIL_FETCH_EMAILS', status: 'completed', summary: 'ok' }],
  };
  const next = governNextAction({ action: 'execute', slug: 'GMAIL_SEND_EMAIL' }, obs);
  assert.equal(next.action, 'draft');
  const skipped = governNextAction({ action: 'execute', slug: 'GMAIL_SEND_EMAIL' }, { ...obs, read_only: true });
  assert.equal(skipped.action, 'done');
});

test('compact observation stays small and tenant conversation keys isolate users', async () => {
  resetDurableAgentMemory();
  const run = {
    goal: 'what was my last linkedin post about?',
    composioSessionId: 'trs_1',
    steps: [
      { slug: 'COMPOSIO_SEARCH_TOOLS', status: 'completed', summary: 'Linkedin' },
      { slug: 'LINKEDIN_GET_POST_CONTENT', status: 'skipped', summary: 'needs more context' },
    ],
    scratch: {
      emails: [],
      primary_tool_slugs: ['LINKEDIN_GET_POST_CONTENT'],
      connected_toolkits: ['linkedin'],
      read_results: [],
    },
  };
  const obs = compactDurableObservation(run, { message: run.goal, connected: ['linkedin'], readOnly: true, candidates: ['linkedin'] });
  assert.ok(JSON.stringify(obs).length < 2500);
  assert.equal(obs.searched, true);
  const a = await getOrCreateAgentRun({ ctx: { orgId: 'o1', userId: 'u1', threadId: 'shared' }, message: 'hi' });
  await saveAgentRun({ run: a });
  const b = await getOrCreateAgentRun({ ctx: { orgId: 'o1', userId: 'u2', threadId: 'shared' }, message: 'hi' });
  assert.notEqual(a.id, b.id);
  assert.equal(conversationKey({ orgId: 'o1', userId: 'u1', threadId: 'shared' }), 'user:u1:shared');
});

test('OAuth resume still finds a pre-cutover agent_runs row keyed by thread id', async () => {
  resetDurableAgentMemory();
  const ctx = { orgId: 'o1', userId: 'u1', threadId: 'legacy-thread' };
  const prior = {
    id: 'run-legacy',
    orgId: 'o1',
    userId: 'u1',
    conversationId: 'legacy-thread',
    goal: 'send to slack',
    composioSessionId: 'trs_old',
    status: 'waiting_connection',
    steps: [{ slug: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }],
    scratch: { workflow_session_id: 'nice', primary_tool_slugs: ['SLACK_SEND_MESSAGE'] },
  };
  await saveAgentRun({ run: prior });
  const resumed = await getOrCreateAgentRun({
    ctx, message: 'continue', choice: { option_id: 'connected', value: RETRY_CONNECT_VALUE },
  });
  assert.equal(resumed.id, 'run-legacy');
  assert.equal(resumed.composioSessionId, 'trs_old');
  assert.equal(resumed.scratch.workflow_session_id, 'nice');
});

test('LinkedIn last-post adapts after GET-without-id instead of creating a post', async () => {
  resetDurableAgentMemory();
  const executed = [];
  let searchPayload = null;
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'linkedin', status: 'ACTIVE' }]; },
    async getToolRouterSession() { return { id: 'trs_adapt' }; },
    async discoverSessionTools(_org, input) {
      searchPayload = input.searchPayload;
      return {
        sessionId: 'trs_adapt',
        primaryToolSlugs: ['LINKEDIN_CREATE_LINKED_IN_POST', 'LINKEDIN_GET_POST_CONTENT', 'LINKEDIN_GET_MY_POSTS'],
        relatedToolSlugs: [],
        toolkitConnectionStatuses: { linkedin: { has_active_connection: true } },
        tools: [
          { _composio: { slug: 'LINKEDIN_CREATE_LINKED_IN_POST' } },
          { _composio: { slug: 'LINKEDIN_GET_POST_CONTENT' } },
          { _composio: { slug: 'LINKEDIN_GET_MY_POSTS' } },
        ],
      };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'LINKEDIN_GET_MY_POSTS') {
          return { successful: true, data: { items: [{ id: 'urn:li:share:1', commentary: 'Shipped the durable agent' }] } };
        }
        return { successful: false, error: 'Missing required fields for GMAIL_GET_PROFILE / post id', data: null };
      });
    },
  };
  const result = await runDurableComposioAgent({
    message: 'what was my last linkedin post about?',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-li-adapt',
      synthesizeDurableAnswer: async ({ evidence }) => `synth:${evidence || 'none'}`,
      _tracedDispatch: async () => ({ memories: [] }),
    },
    composio,
  });
  assert.equal(executed.includes('LINKEDIN_CREATE_LINKED_IN_POST'), false);
  assert.equal(executed.includes('LINKEDIN_GET_MY_POSTS'), true);
  assert.match(result.summary, /synth:/);
  assert.equal(result.status, 'completed');
  assert.ok(result.run.scratch.cursor);
  assert.equal(searchPayload.queries[0].known_fields, '');
  assert.equal(searchPayload.queries[0].use_case, "list the authenticated user's latest linkedin posts");
});


test('summarizeToolData decodes GitHub README base64', () => {
  const text = summarizeToolData({
    encoding: 'base64',
    content: Buffer.from('# HIVEMIND\nPersistent memory OS').toString('base64'),
  });
  assert.match(text, /# HIVEMIND/);
  assert.equal(text.includes('IyB'), false);
});

test('summarizeToolData uses profile fields instead of raw LinkedIn JSON', () => {
  const text = summarizeToolData({
    localizedFirstName: 'Amar',
    localizedLastName: 'Sai',
    localizedHeadline: 'Founder @SINGULANCE',
    vanityName: 'amar-sai-3067aa1aa',
    profileUrl: 'https://www.linkedin.com/in/amar-sai-3067aa1aa',
  });
  assert.match(text, /Amar Sai/);
  assert.match(text, /Founder @SINGULANCE/);
  assert.equal(text.includes('preferredLocale'), false);
});

test('composeBriefing drops ad-targeting JSON from the email body', () => {
  const body = composeBriefing({
    message: 'send Rama about my linkedin profile',
    person: 'rama',
    factToolkits: ['linkedin'],
    reads: [
      { slug: 'LINKEDIN_GET_MY_INFO', successful: true, data: { localizedFirstName: 'Amar', localizedLastName: 'Sai', localizedHeadline: 'Founder @SINGULANCE', vanityName: 'amar-sai-3067aa1aa' } },
      { slug: 'LINKEDIN_GET_AD_TARGETING_FACETS', successful: true, data: { elements: [{ adTargetingFacetUrn: 'urn:li:adTargetingFacet:industries' }] } },
    ],
  });
  assert.match(body, /Amar Sai/);
  assert.equal(body.includes('adTargetingFacet'), false);
  assert.equal(body.includes('preferredLocale'), false);
});

test('company email uses recall and does not execute unrelated connected apps', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() {
      return [
        { toolkit: 'gmail', status: 'ACTIVE' },
        { toolkit: 'youtube', status: 'ACTIVE' },
        { toolkit: 'linkedin', status: 'ACTIVE' },
      ];
    },
    async getToolRouterSession() { return { id: 'sess_co' }; },
    async searchToolsByIntent(_org, _message, opts = {}) {
      const tools = [
        { _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail' } },
        { _composio: { slug: 'GMAIL_CREATE_EMAIL_DRAFT', toolkit: 'gmail' } },
        { _composio: { slug: 'YOUTUBE_LIST_CAPTION_TRACK', toolkit: 'youtube' } },
        { _composio: { slug: 'YOUTUBE_CREATE_COMMENT_REPLY', toolkit: 'youtube' } },
      ];
      if (opts.toolkits) return { tools: tools.filter((tool) => opts.toolkits.includes(tool._composio.toolkit)) };
      return { tools };
    },
    async generateToolInputs() { return {}; },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'GMAIL_FETCH_EMAILS') {
          return { successful: true, data: { messages: [{ from: 'Rama <ramasantoshi1206@gmail.com>' }] } };
        }
        return { successful: true, data: {} };
      });
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send rama, about information about the company',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-company',
      polishBriefing: async ({ body }) => body,
      _tracedDispatch: async () => ({ memories: [{ title: 'Singulance', content: 'AI workforce inside memory' }] }),
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'DRAFT-CO' }; } } },
    },
    composio,
  });
  assert.equal(result.status, 'pending');
  assert.equal(executed.includes('YOUTUBE_LIST_CAPTION_TRACK'), false);
  assert.equal(executed.includes('YOUTUBE_CREATE_COMMENT_REPLY'), false);
  assert.ok(executed.includes('GMAIL_FETCH_EMAILS'));
  assert.equal(created[0].toolName, 'GMAIL_CREATE_EMAIL_DRAFT');
  assert.match(created[0].toolArgs.body, /AI workforce inside memory/);
  assert.equal(created[0].toolArgs.body.includes('I could not retrieve'), false);
});

test('precise Composio search uses related people lookup then drafts, never list-drafts', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const created = [];
  let searchPayload = null;
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession(_org, toolkits) {
      assert.deepEqual(toolkits, ['gmail']);
      return { id: 'trs_precise' };
    },
    async discoverSessionTools(_org, input) {
      searchPayload = input.searchPayload;
      return {
        sessionId: 'trs_precise',
        primaryToolSlugs: ['GMAIL_SEND_EMAIL'],
        relatedToolSlugs: [
          'GMAIL_CREATE_EMAIL_DRAFT',
          'GMAIL_SEND_DRAFT',
          'GMAIL_SEARCH_PEOPLE',
          'GMAIL_FETCH_EMAILS',
          'GMAIL_LIST_DRAFTS',
        ],
        toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
        tools: [{ _composio: { slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail' } }],
      };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'GMAIL_SEARCH_PEOPLE') {
          return { successful: true, data: { people: [{ email: 'ramasantoshi1206@gmail.com', name: 'Rama' }] } };
        }
        if (tool.slug === 'GMAIL_FETCH_EMAILS') {
          return { successful: true, data: { messages: [{ from: 'Rama <ramasantoshi1206@gmail.com>' }] } };
        }
        return { successful: true, data: {} };
      });
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send rama, about information about the company',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-precise',
      polishBriefing: async ({ body }) => body,
      _tracedDispatch: async () => ({ memories: [{ title: 'Singulance', content: 'AI workforce inside memory' }] }),
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'DRAFT-P' }; } } },
    },
    composio,
  });
  assert.equal(searchPayload.queries[0].use_case, 'send an email with company information');
  assert.equal(searchPayload.queries[0].known_fields, 'recipient_name:rama');
  assert.equal(result.status, 'pending');
  assert.equal(executed.includes('GMAIL_LIST_DRAFTS'), false);
  assert.equal(executed.includes('GMAIL_SEND_EMAIL'), false);
  assert.ok(executed.includes('GMAIL_SEARCH_PEOPLE'));
  assert.equal(created[0].toolName, 'GMAIL_CREATE_EMAIL_DRAFT');
  assert.equal(created[0].toolArgs.recipient_email, 'ramasantoshi1206@gmail.com');
  assert.match(created[0].toolArgs.body, /AI workforce inside memory/);
});

test('when search omits people tools, still resolves named recipient via Gmail lookup', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession() { return { id: 'trs_hm2' }; },
    async discoverSessionTools(_org, input) {
      const useCase = String(input.searchPayload?.queries?.[0]?.use_case || input.useCases?.[0] || '');
      if (/find a person email address|email address of a person called/i.test(useCase)) {
        return {
          sessionId: 'trs_hm2',
          primaryToolSlugs: ['GMAIL_SEARCH_PEOPLE'],
          relatedToolSlugs: ['GMAIL_FETCH_EMAILS'],
          toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
          tools: [{ _composio: { slug: 'GMAIL_SEARCH_PEOPLE', toolkit: 'gmail' } }],
        };
      }
      return {
        sessionId: 'trs_hm2',
        primaryToolSlugs: [
          'LOCAL_HIVEMIND_HIVEMIND_RECALL',
          'GMAIL_SEND_EMAIL',
          'GMAIL_SEND_DRAFT',
        ],
        relatedToolSlugs: ['GMAIL_LIST_DRAFTS', 'GMAIL_REPLY_TO_THREAD'],
        toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
        tools: [
          { _composio: { slug: 'LOCAL_HIVEMIND_HIVEMIND_RECALL' } },
          { _composio: { slug: 'GMAIL_SEND_EMAIL' } },
        ],
      };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'GMAIL_SEARCH_PEOPLE') {
          return { successful: true, data: { people: [{ email: 'ramasantoshi1206@gmail.com' }] } };
        }
        return { successful: true, data: {} };
      });
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send rama, about information about the company',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-rama-lookup',
      polishBriefing: async ({ body }) => body,
      _tracedDispatch: async () => ({ memories: [{ title: 'Singulance', content: 'AI workforce inside memory' }] }),
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'DRAFT-R' }; } } },
    },
    composio,
  });
  assert.equal(result.status, 'pending');
  assert.equal(executed.includes('GMAIL_LIST_DRAFTS'), false);
  assert.ok(executed.includes('GMAIL_SEARCH_PEOPLE'));
  assert.equal(created[0].toolArgs.recipient_email, 'ramasantoshi1206@gmail.com');
  assert.equal(created[0].toolName, 'GMAIL_SEND_EMAIL');
});

test('GMAIL_GET_PROFILE does not steal the recipient or skip Rama lookup', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession() { return { id: 'trs_prof' }; },
    async discoverSessionTools(_org, input) {
      const useCase = String(input.searchPayload?.queries?.[0]?.use_case || input.useCases?.[0] || '');
      if (/find a person email address|email address of a person called/i.test(useCase)) {
        return {
          sessionId: 'trs_prof',
          primaryToolSlugs: ['GMAIL_SEARCH_PEOPLE'],
          relatedToolSlugs: [],
          toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
          tools: [{ _composio: { slug: 'GMAIL_SEARCH_PEOPLE', toolkit: 'gmail' } }],
        };
      }
      return {
        sessionId: 'trs_prof',
        primaryToolSlugs: ['LOCAL_HIVEMIND_HIVEMIND_RECALL', 'GMAIL_GET_PROFILE', 'GMAIL_CREATE_EMAIL_DRAFT'],
        relatedToolSlugs: [],
        toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
        tools: [
          { _composio: { slug: 'GMAIL_GET_PROFILE' } },
          { _composio: { slug: 'GMAIL_CREATE_EMAIL_DRAFT' } },
        ],
      };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map((tool) => {
        if (tool.slug === 'GMAIL_GET_PROFILE') {
          return { successful: true, data: { emailAddress: 'amarsai2005@gmail.com' } };
        }
        if (tool.slug === 'GMAIL_SEARCH_PEOPLE') {
          return { successful: true, data: { people: [{ email: 'ramasantoshi1206@gmail.com' }] } };
        }
        return { successful: true, data: {} };
      });
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send rama, about information about the company',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-profile',
      polishBriefing: async ({ body }) => body,
      _tracedDispatch: async () => ({ memories: [{ title: 'Singulance', content: 'AI workforce inside memory' }] }),
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'DRAFT-PR' }; } } },
    },
    composio,
  });
  assert.equal(executed.includes('GMAIL_GET_PROFILE'), false);
  assert.ok(executed.includes('GMAIL_SEARCH_PEOPLE'));
  assert.equal(result.status, 'pending');
  assert.equal(created[0].toolArgs.recipient_email, 'ramasantoshi1206@gmail.com');
  assert.equal(created[0].toolArgs.recipient_email.includes('amarsai2005'), false);
});

test('instagram DM searches first then pauses to connect when disconnected', async () => {
  resetDurableAgentMemory();
  let searched = false;
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession(_org, toolkits) {
      assert.ok(toolkits.includes('instagram'));
      return { id: 'trs_ig' };
    },
    async discoverSessionTools(_org, input) {
      searched = true;
      assert.equal(input.searchPayload.session.generate_id, true);
      assert.equal(typeof input.searchPayload.queries[0].known_fields, 'string');
      return {
        sessionId: 'trs_ig',
        primaryToolSlugs: ['INSTAGRAM_SEND_DIRECT_MESSAGE'],
        relatedToolSlugs: [],
        toolkitConnectionStatuses: { instagram: { has_active_connection: false } },
        tools: [{ _composio: { slug: 'INSTAGRAM_SEND_DIRECT_MESSAGE', toolkit: 'instagram' } }],
      };
    },
    async createConnectLink() { return { redirectUrl: 'https://connect.example/instagram' }; },
    async executeToolsParallel() { throw new Error('must not execute disconnected instagram'); },
  };
  const result = await runDurableComposioAgent({
    message: 'send an instagram dm to rama',
    ctx: { orgId: 'o1', userId: 'u1', threadId: 'ig-connect' },
    composio,
  });
  assert.equal(searched, true);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.inputRequests[0].kind, 'connect_account');
  assert.equal(result.inputRequests[0].toolkit, 'instagram');
  assert.deepEqual(result.run.scratch.plan, ['INSTAGRAM_SEND_DIRECT_MESSAGE']);
});

test('walks primary HIVEMIND recall once then drafts, skipping extra hivemind slugs', async () => {
  resetDurableAgentMemory();
  const executed = [];
  const native = [];
  const created = [];
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async getToolRouterSession() { return { id: 'trs_hm' }; },
    async discoverSessionTools() {
      return {
        sessionId: 'trs_hm',
        primaryToolSlugs: [
          'LOCAL_HIVEMIND_RECALL',
          'LOCAL_HIVEMIND_LIST_MEMORIES',
          'LOCAL_HIVEMIND_LIST_PROJECTS',
          'GMAIL_CREATE_EMAIL_DRAFT',
        ],
        relatedToolSlugs: ['GMAIL_SEND_DRAFT'],
        toolkitConnectionStatuses: { gmail: { has_active_connection: true } },
        tools: [
          { _composio: { slug: 'LOCAL_HIVEMIND_RECALL' } },
          { _composio: { slug: 'LOCAL_HIVEMIND_LIST_MEMORIES' } },
          { _composio: { slug: 'LOCAL_HIVEMIND_LIST_PROJECTS' } },
          { _composio: { slug: 'GMAIL_CREATE_EMAIL_DRAFT' } },
        ],
      };
    },
    async executeToolsParallel(_org, tools) {
      executed.push(...tools.map((tool) => tool.slug));
      return tools.map(() => ({ successful: true, data: {} }));
    },
  };
  const result = await runDurableComposioAgent({
    message: 'send rama, about information about the company',
    ctx: {
      orgId: 'o1', userId: 'u1', threadId: 't-primary',
      polishBriefing: async ({ body }) => body,
      _tracedDispatch: async (name, args) => {
        native.push(name);
        assert.match(String(args.query || ''), /company/i);
        return { memories: [{ title: 'Singulance', content: 'AI workforce inside memory' }] };
      },
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'D1' }; } } },
    },
    composio,
  });
  assert.equal(native.includes('hivemind_recall'), true);
  assert.equal(native.filter((name) => name === 'hivemind_recall').length, 1);
  assert.equal(executed.includes('LOCAL_HIVEMIND_LIST_MEMORIES'), false);
  assert.equal(executed.includes('LOCAL_HIVEMIND_LIST_PROJECTS'), false);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.inputRequests[0].kind, 'field_input');
  assert.ok(result.run.scratch.recall_text.includes('AI workforce inside memory'));
});

test('resume after connect reuses plan and recall without searching again', async () => {
  resetDurableAgentMemory();
  let searches = 0;
  let linkedinConnected = false;
  const composio = {
    async listConnectedAccounts() {
      return linkedinConnected
        ? [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'linkedin', status: 'ACTIVE' }]
        : [{ toolkit: 'gmail', status: 'ACTIVE' }];
    },
    async getToolRouterSession() { return { id: 'trs_li' }; },
    async discoverSessionTools() {
      searches += 1;
      return {
        sessionId: 'trs_li',
        primaryToolSlugs: ['LINKEDIN_GET_MY_INFO', 'GMAIL_CREATE_EMAIL_DRAFT'],
        toolkitConnectionStatuses: {
          linkedin: { has_active_connection: linkedinConnected },
          gmail: { has_active_connection: true },
        },
        tools: [
          { _composio: { slug: 'LINKEDIN_GET_MY_INFO', toolkit: 'linkedin' } },
          { _composio: { slug: 'GMAIL_CREATE_EMAIL_DRAFT', toolkit: 'gmail' } },
        ],
      };
    },
    async createConnectLink() { return { redirectUrl: 'https://connect.example/li' }; },
    async executeToolsParallel(_org, tools) {
      return tools.map((tool) => {
        if (tool.slug === 'LINKEDIN_GET_MY_INFO') {
          return { successful: true, data: { localizedFirstName: 'Amar', localizedLastName: 'Sai', localizedHeadline: 'Founder' } };
        }
        return { successful: true, data: {} };
      });
    },
  };
  const ctx = {
    orgId: 'o1', userId: 'u1', threadId: 'resume-li',
    polishBriefing: async ({ body }) => body,
    _tracedDispatch: async () => ({ memories: [] }),
    prisma: { pendingWrite: { create: async () => ({ id: 'D' }) } },
  };
  const first = await runDurableComposioAgent({
    message: 'send Rama about my linkedin profile',
    ctx,
    composio,
  });
  assert.equal(first.status, 'needs_input');
  assert.equal(first.inputRequests[0].toolkit, 'linkedin');
  assert.equal(searches, 1);
  linkedinConnected = true;
  const second = await runDurableComposioAgent({
    message: 'send Rama about my linkedin profile',
    ctx,
    composio,
    choice: { option_id: 'connected', value: RETRY_CONNECT_VALUE },
  });
  assert.deepEqual(second.run.scratch.plan, ['LINKEDIN_GET_MY_INFO', 'GMAIL_CREATE_EMAIL_DRAFT']);
  assert.notEqual(second.status, 'error');
});

test('production continuation resumes from ctx.durableChoice without a top-level choice', async () => {
  resetDurableAgentMemory();
  let searches = 0;
  let linkedinConnected = false;
  const composio = {
    async listConnectedAccounts() {
      return linkedinConnected
        ? [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'linkedin', status: 'ACTIVE' }]
        : [{ toolkit: 'gmail', status: 'ACTIVE' }];
    },
    async getToolRouterSession() { return { id: 'trs_li_ctx' }; },
    async discoverSessionTools() {
      searches += 1;
      return {
        sessionId: 'trs_li_ctx',
        primaryToolSlugs: ['LINKEDIN_GET_MY_INFO', 'GMAIL_CREATE_EMAIL_DRAFT'],
        toolkitConnectionStatuses: {
          linkedin: { has_active_connection: linkedinConnected },
          gmail: { has_active_connection: true },
        },
        tools: [
          { _composio: { slug: 'LINKEDIN_GET_MY_INFO', toolkit: 'linkedin' } },
          { _composio: { slug: 'GMAIL_CREATE_EMAIL_DRAFT', toolkit: 'gmail' } },
        ],
      };
    },
    async createConnectLink() { return { redirectUrl: 'https://connect.example/li' }; },
    async executeToolsParallel(_org, tools) {
      return tools.map((tool) => {
        if (tool.slug === 'LINKEDIN_GET_MY_INFO') {
          return { successful: true, data: { localizedFirstName: 'Amar', localizedLastName: 'Sai', localizedHeadline: 'Founder' } };
        }
        return { successful: true, data: {} };
      });
    },
  };
  const ctx = {
    orgId: 'o1', userId: 'u1', threadId: 'resume-li-ctx',
    polishBriefing: async ({ body }) => body,
    _tracedDispatch: async () => ({ memories: [] }),
    prisma: { pendingWrite: { create: async () => ({ id: 'D-CTX' }) } },
  };
  const first = await runDurableComposioAgent({
    message: 'send Rama about my linkedin profile',
    ctx,
    composio,
  });
  assert.equal(first.status, 'needs_input');
  assert.equal(searches, 1);
  linkedinConnected = true;
  const second = await runDurableComposioAgent({
    message: 'send Rama about my linkedin profile',
    ctx: {
      ...ctx,
      durableChoice: { option_id: 'connected', value: RETRY_CONNECT_VALUE },
    },
    composio,
  });
  assert.equal(second.run.id, first.run.id);
  assert.equal(first.run.composioSessionId, second.run.composioSessionId);
  assert.notEqual(second.status, 'error');
});

test('emailsFromProviderData ignores example.com placeholders', () => {
  assert.deepEqual(
    emailsFromProviderData({ from: 'Rama <rama@x.dev>', extra: 'x@example.com' }),
    ['rama@x.dev'],
  );
});
