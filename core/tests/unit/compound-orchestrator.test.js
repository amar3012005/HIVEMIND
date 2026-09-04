import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompoundSynthesisPayload,
  projectConnectorDataForSynthesis,
  compoundSynthesisResultsLabel,
  buildCompoundUserSummary,
  buildGroundedWriteFallbackPrompt,
  buildGroundedWriteFallbackPayload,
  buildSubtaskArgumentPrompt,
  buildSubtaskExecutionMessage,
  buildToolInputSystemPrompt,
  applyConnectorRetrievalPolicy,
  applyConnectorResultPolicy,
  buildToolSelectionCards,
  buildToolCardSelectionPrompt,
  backfillMissingGroundedContentArgs,
  classifyComposioToolAuthority,
  filterComposioToolsByAuthority,
  filterProviderDraftToolsForTerminalOperation,
  exactGroundedDependencyContent,
  formatGroundedMessageBody,
  looksLikeRecallDump,
  collapseAdjacentNativeRecalls,
  normalizeCompoundDependencies,
  normalizeEmailDestinationArgs,
  rankToolSelectionCards,
  resolveSelectedTool,
  runCompoundOrchestrator,
  RETRY_CONNECT_VALUE,
  contactLookupTool,
  namedRecipientQuery,
  shouldOpenConnectHref,
  unresolvedGroundedWriteFields,
  validateSemanticStepOutput,
} from '../../src/agent/compound-orchestrator.js';

// ── Test harness ─────────────────────────────────────────────────────────────
// A deterministic tool-selector replaces the model call. The Composio service
// is stubbed via the `composio` override so no real API is hit.

function makeComposio({ tools, executeImpl, generateImpl = null }) {
  // tools: [{ name, slug, description }]
  return {
    async getToolkitTools() {
      return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: { type: 'object', properties: {} } },
        _composio: { toolkit: 'mock', slug: t.slug },
      }));
    },
    async executeTool(orgId, slug, args) {
      return executeImpl(slug, args);
    },
    ...(generateImpl ? { async generateToolInputs(slug, text) { return generateImpl(slug, text); } } : {}),
  };
}

test('recipient output contract resolves one address and rejects ambiguity', () => {
  const one = validateSemanticStepOutput('recipient', { contacts: [{ email: 'Only@Example.com' }] });
  assert.equal(one.status, 'completed');
  assert.equal(one.outputFields.recipient_email, 'only@example.com');

  const many = validateSemanticStepOutput('recipient', {
    contacts: [{ email: 'one@example.com' }, { nested: { value: 'two@example.com' } }],
  });
  assert.equal(many.status, 'needs_input');
  assert.deepEqual(many.candidates, ['one@example.com', 'two@example.com']);
});

test('a successful connector envelope with null provider data fails safely', () => {
  const result = validateSemanticStepOutput('record', null);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /returned no result data/i);
  assert.deepEqual(result.outputFields, {});
});

test('compound connector read reports null provider data without throwing', async () => {
  const composio = makeComposio({
    tools: [{ name: 'composio_instagram_list_posts', slug: 'INSTAGRAM_GET_IG_USER_MEDIA', description: 'list posts' }],
    executeImpl: async () => ({ successful: true, data: null, error: null }),
  });
  const result = await runCompoundOrchestrator({
    subtasks: [{
      operation: 'list_posts', authority: 'read', output_kind: 'record',
      tool_groups: ['instagram'], message: 'list all posts',
    }],
    ctx: { userId: 'u1', orgId: 'o1', _trace: { traceId: 'instagram-null' } },
    apiKey: 'k', composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_instagram_list_posts', args: { ig_user_id: 'me', limit: 100 },
      schema: { properties: { ig_user_id: { type: 'string' }, limit: { type: 'integer' } } },
    })),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.steps[0].status, 'failed');
  assert.match(result.steps[0].summary, /returned no result data/i);
});

test('email destination normalization rejects display names and uses one governed lookup address', () => {
  const schema = {
    type: 'object', required: ['recipient_email'],
    properties: { recipient_email: { type: 'string' } },
  };
  const unresolved = normalizeEmailDestinationArgs(
    'message', schema, { recipient_email: 'AmarSai' }, {},
  );
  assert.deepEqual(unresolved.invalidFields, ['recipient_email']);
  assert.equal(unresolved.args.recipient_email, 'AmarSai');

  const resolved = normalizeEmailDestinationArgs(
    'message', schema, { recipient_email: 'AmarSai' },
    { recipient_email: 'AmarSai <amarsai2005@gmail.com>' },
  );
  assert.deepEqual(resolved.invalidFields, []);
  assert.equal(resolved.args.recipient_email, 'amarsai2005@gmail.com');

  const notResolvedFromContent = normalizeEmailDestinationArgs(
    'message', schema, { recipient_email: 'AmarSai' },
    { recall: 'Company contact is unrelated@example.com' },
  );
  assert.deepEqual(notResolvedFromContent.invalidFields, ['recipient_email']);

  const explicit = normalizeEmailDestinationArgs(
    'message', schema, { recipient_email: 'amarsai2005@gmail.com' }, {},
    'Send this to amarsai2005@gmail.com',
  );
  assert.deepEqual(explicit.invalidFields, []);
  assert.equal(explicit.args.recipient_email, 'amarsai2005@gmail.com');

  const invented = normalizeEmailDestinationArgs(
    'message', schema, { recipient_email: 'different@example.com' }, {},
    'Send this to amarsai2005@gmail.com',
  );
  assert.deepEqual(invented.invalidFields, []);
  assert.equal(invented.args.recipient_email, 'amarsai2005@gmail.com');
});

function makeSelector(pick) {
  return async ({ message }) => {
    const p = pick(message);
    if (!p) throw new Error('no tool selected');
    return { toolName: p.toolName, args: p.args || {}, schema: p.schema || { type: 'object', properties: {} } };
  };
}

test('compound orchestrator: semantic selection cards omit provider JSON schemas', () => {
  const cards = buildToolSelectionCards([{
    function: {
      name: 'GOOGLEDOCS_CREATE_DOCUMENT',
      description: 'Create a Google Document from supplied text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  }]);
  assert.deepEqual(cards, [{ name: 'GOOGLEDOCS_CREATE_DOCUMENT', description: 'Create a Google Document from supplied text.' }]);
  assert.equal(JSON.stringify(cards).includes('parameters'), false);
  assert.equal(JSON.stringify(cards).includes('required'), false);
});

test('tool-card identifiers resolve case-insensitively by function name or Composio slug', () => {
  const tools = [{ function: { name: 'composio_googlecalendar_find_events' }, _composio: { slug: 'GOOGLECALENDAR_FIND_EVENTS' } }];
  assert.equal(resolveSelectedTool(tools, 'COMPOSIO_GOOGLECALENDAR_FIND_EVENTS'), tools[0]);
  assert.equal(resolveSelectedTool(tools, 'googlecalendar_find_events'), tools[0]);
  assert.equal(resolveSelectedTool(tools, 'composio-googlecalendar-find-events'), tools[0]);
  assert.equal(resolveSelectedTool(tools, 'missing'), null);
});

test('tool cards are generically ranked by the planner canonical operation', () => {
  const ranked = rankToolSelectionCards([
    { name: 'calendar_current_date_time', description: 'Get current date and time.' },
    { name: 'calendar_events_list', description: 'List calendar events in a time range.' },
  ], 'count_today_events');
  assert.equal(ranked[0].name, 'calendar_events_list');
});

test('tool selection treats addressed communication as governed send unless draft is terminal intent', () => {
  const prompt = buildToolCardSelectionPrompt([
    { name: 'composio_gmail_send_email', description: 'Send an email.' },
    { name: 'composio_gmail_create_email_draft', description: 'Create a Gmail draft.' },
  ]);
  assert.match(prompt, /any language/i);
  assert.match(prompt, /addressed to a recipient has send\/deliver as its terminal result/i);
  assert.match(prompt, /only when the requested result is specifically to save or create a draft/i);
});

test('structured terminal operation excludes provider draft without inspecting user language', () => {
  const tools = [
    { function: { name: 'composio_gmail_send_email' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL' } },
    { function: { name: 'composio_gmail_create_email_draft' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_CREATE_EMAIL_DRAFT' } },
  ];
  assert.deepEqual(
    filterProviderDraftToolsForTerminalOperation(tools, 'email').map((tool) => tool._composio.slug),
    ['GMAIL_SEND_EMAIL'],
  );
  assert.deepEqual(
    filterProviderDraftToolsForTerminalOperation(tools, 'create_email_draft').map((tool) => tool._composio.slug),
    ['GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT'],
  );
});

test('Composio authority comes from controlled manifest actions, not user-language keywords', () => {
  const read = { function: { name: 'composio_gmail_fetch_emails' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_FETCH_EMAILS' } };
  const labelRead = { function: { name: 'composio_gmail_get_label' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_GET_LABEL' } };
  const labelWrite = { function: { name: 'composio_gmail_add_label_to_email' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_ADD_LABEL_TO_EMAIL' } };
  assert.equal(classifyComposioToolAuthority(read), 'read');
  assert.equal(classifyComposioToolAuthority(labelRead), 'read', 'resource noun label must not turn GET into a write');
  assert.equal(classifyComposioToolAuthority(labelWrite), 'write');
});

test('generic read operation exposes Gmail fetch but excludes modifying capabilities in any request language', () => {
  const tools = [
    { function: { name: 'composio_gmail_add_label_to_email' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_ADD_LABEL_TO_EMAIL' } },
    { function: { name: 'composio_gmail_fetch_emails' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_FETCH_EMAILS' } },
    { function: { name: 'composio_gmail_send_email' }, _composio: { toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL' } },
  ];
  const eligible = filterComposioToolsByAuthority(tools, 'read');
  assert.deepEqual(eligible.map((tool) => tool._composio.slug), ['GMAIL_FETCH_EMAILS']);
});

test('argument generation separates relative ordering from provider content filters', () => {
  const prompt = buildSubtaskArgumentPrompt();
  assert.match(prompt, /any language/i);
  assert.match(prompt, /ordering from content filtering/i);
  assert.match(prompt, /do not copy those ordering words into a provider search query/i);
  assert.match(prompt, /explicit sender, entity, date, or content filters/i);
});

test('dependent argument generation receives bounded prior output data', () => {
  const message = buildSubtaskExecutionMessage('Create the draft', {
    recall: 'Brand is G ROCHER and logo is JL.',
    results: [{ name: 'Amar A' }, { name: 'Amar B' }],
  });
  assert.match(message, /PRIOR_OUTPUTS/);
  assert.match(message, /untrusted conversation context/i);
  assert.match(message, /G ROCHER/);
  assert.match(message, /Amar A/);
  assert.ok(message.length < 14_100);
});

test('structured newest policy removes invented search text and requests a metadata candidate window', () => {
  const schema = { properties: {
    query: { type: 'string' }, max_results: { type: 'integer' }, verbose: { type: 'boolean' },
    include_payload: { type: 'boolean' }, ids_only: { type: 'boolean' },
  } };
  const args = applyConnectorRetrievalPolicy(
    { query: 'last email', max_results: 20, verbose: false, include_payload: false, ids_only: true },
    schema,
    { result_order: 'newest', result_limit: 1, has_explicit_filter: false },
  );
  assert.equal('query' in args, false);
  assert.equal(args.max_results, 10, 'unordered providers need a bounded candidate window before sorting');
  assert.equal(args.verbose, false);
  assert.equal(args.include_payload, false);
  assert.equal(args.ids_only, false);
});

test('structured newest policy preserves a real sender/content filter', () => {
  const schema = { properties: { query: { type: 'string' }, max_results: { type: 'integer' } } };
  const args = applyConnectorRetrievalPolicy(
    { query: 'from:alice@example.com' }, schema,
    { result_order: 'newest', result_limit: 1, has_explicit_filter: true },
  );
  assert.equal(args.query, 'from:alice@example.com');
  assert.equal(args.max_results, 10);
});

test('soonest-upcoming policy anchors provider arguments and removes past events', () => {
  const schema = { properties: {
    timeMin: { type: 'string' }, orderBy: { type: 'string' },
    singleEvents: { type: 'boolean' }, maxResults: { type: 'integer' },
  } };
  const args = applyConnectorRetrievalPolicy({}, schema, {
    result_order: 'soonest_upcoming', result_limit: 1,
  });
  assert.ok(Number.isFinite(Date.parse(args.timeMin)));
  assert.equal(args.orderBy, 'startTime');
  assert.equal(args.singleEvents, true);
  assert.equal(args.maxResults, 10);

  const future = new Date(Date.now() + 86_400_000).toISOString();
  const later = new Date(Date.now() + 172_800_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const projected = applyConnectorResultPolicy({ items: [
    { id: 'past', start: { dateTime: past } },
    { id: 'later', start: { dateTime: later } },
    { id: 'next', start: { dateTime: future } },
  ] }, { result_order: 'soonest_upcoming', result_limit: 1 });
  assert.deepEqual(projected.items.map((item) => item.id), ['next']);
});

test('connector result policy sorts provider candidates and exposes only the requested newest row', () => {
  const data = { messages: [
    { subject: 'third', messageTimestamp: '2026-08-08T19:19:09Z' },
    { subject: 'newest', messageTimestamp: '2026-08-08T19:45:00Z' },
    { subject: 'second', messageTimestamp: '2026-08-08T19:30:00Z' },
  ], nextPageToken: 'opaque' };
  const result = applyConnectorResultPolicy(data, {
    result_order: 'newest', result_limit: 1, has_explicit_filter: false,
  });
  assert.deepEqual(result.messages.map((row) => row.subject), ['newest']);
  assert.equal(data.messages.length, 3, 'provider receipt is not mutated in place');
});

test('connector result policy leaves unstructured results unchanged rather than guessing', () => {
  const data = { messages: [{ subject: 'a' }, { subject: 'b' }] };
  assert.equal(applyConnectorResultPolicy(data, { result_order: 'newest', result_limit: 1 }), data);
});

test('compound synthesis payload retains complete rank-one recall alongside connector data', () => {
  const content = `${'context '.repeat(300)}Brand is G ROCHER.`;
  const payload = buildCompoundSynthesisPayload({
    recallResults: [{ memories: [{ id: 'm1', title: 'Handbag', content }] }],
    readResults: [{ operation: 'read', data: { event_count: 2 } }],
  });
  assert.equal(payload.recall[0].ranked_context[0].content, content);
  assert.equal(payload.recall[0].ranked_context[0].kind, 'memory');
  assert.equal(payload.connectors[0].data.event_count, 2);
});

test('compound synthesis payload preserves the canonical mixed memory and evidence order', () => {
  const payload = buildCompoundSynthesisPayload({
    recallResults: [{
      memories: [{ id: 'm1', content: 'summary memory' }],
      evidence: [{ segment_id: 'e1', content: 'exact PDF fact' }],
      ranked_candidates: [
        { kind: 'evidence', segment_id: 'e1', rank: 1 },
        { kind: 'memory', memory_id: 'm1', rank: 2 },
      ],
    }],
    visibleLimit: 5,
  });
  assert.deepEqual(payload.recall[0].ranked_context.map((row) => row.kind), ['evidence', 'memory']);
  assert.match(payload.recall[0].ranked_context[0].content, /exact PDF fact/);
});

test('connector synthesis projection preserves records while removing volatile URL query bloat', () => {
  const projected = projectConnectorDataForSynthesis({
    data: [{
      caption: 'A complete grounded caption',
      permalink: 'https://www.instagram.com/p/example/?utm_source=large',
      media_url: `https://cdn.example.com/video.mp4?token=${'x'.repeat(20_000)}`,
      like_count: 53,
    }],
  });
  assert.equal(projected.data.length, 1);
  assert.equal(projected.data[0].caption, 'A complete grounded caption');
  assert.equal(projected.data[0].permalink, 'https://www.instagram.com/p/example/');
  assert.equal(projected.data[0].media_url, 'https://cdn.example.com/video.mp4');
  assert.equal(projected.data[0].like_count, 53);
  assert.ok(JSON.stringify(projected).length < 500);
});

test('connector-only synthesis does not imply a recall rank count', () => {
  assert.equal(
    compoundSynthesisResultsLabel({ recallResults: [], visibleLimit: 15 }),
    'COMPLETED GOVERNED CONNECTOR RESULTS',
  );
  assert.equal(
    compoundSynthesisResultsLabel({ recallResults: [{}], visibleLimit: 5 }),
    'COMPLETED GOVERNED RESULTS (recall ranks 1-5)',
  );
});

test('compound orchestrator: native hivemind-recall step runs via dispatchTool', async () => {
  const dispatched = [];
  const recallPacket = { content: 'Amar leads HIVEMIND', recall_packet: { citations: [{ id: 'C1' }], sourceSections: [{ segment_id: 'S1', content: 'full evidence' }] } };
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _originalUserMessage: 'What is Amar responsible for?',
    _tracedDispatch: async (name, args) => { dispatched.push({ name, args }); return recallPacket; },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'recall', tool_groups: ['hivemind-recall'], depends_on: null, message: 'Recall Amar' }],
    ctx, apiKey: 'k', signal: null,
  });
  assert.equal(res.status, 'completed');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].name, 'hivemind_recall');
  assert.equal(dispatched[0].args._structured_intent, true);
  assert.equal(dispatched[0].args.query_original, 'Recall Amar');
  assert.equal(dispatched[0].args.query_canonical_en, 'Recall Amar');
  assert.equal(dispatched[0].args.semantic_recovery, true);
  assert.equal(dispatched[0].args._include_full_memory_content, true,
    'compound synthesis must receive full authorized recall rows, not public previews');
  assert.equal(res.recallResults[0], recallPacket, 'full canonical recall result is retained without truncation');
});

test('compound recall retries once with a semantic rewrite after zero coverage', async () => {
  const dispatched = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _originalUserMessage: 'mixed request',
    _rewriteCompoundRecallQuery: async () => 'handbag brand',
    _tracedDispatch: async (name, args) => {
      dispatched.push({ name, args });
      return dispatched.length === 1
        ? { memories: [], evidence: [] }
        : { memories: [{ id: 'm1', content: 'Brand is G ROCHER.' }], evidence: [] };
    },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'recall_handbag_brand', tool_groups: ['hivemind-recall'], message: 'Recall handbag brand' }],
    ctx, apiKey: 'k', signal: null,
  });
  assert.equal(res.status, 'completed');
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].args.query, 'handbag brand');
  assert.match(res.synthesisPayload.recall[0].ranked_context[0].content, /G ROCHER/);
});

test('compound orchestrator: composio read step executes and reports completed', async () => {
  const calls = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_search', slug: 'GMAIL_SEARCH', description: 'search emails' }],
    executeImpl: async (slug, args) => { calls.push({ slug, args }); return { successful: true, data: { results: ['m1'] }, error: null }; },
  });
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' } };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search emails' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_gmail_search', args: { query: 'x' } })),
  });
  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, 'GMAIL_SEARCH');
  assert.deepEqual(res.readResults, [{
    index: 0,
    operation: 'search',
    instruction: 'search emails',
    tool: 'composio_gmail_search',
    data: { results: ['m1'] },
  }]);
});

test('compound orchestrator: composio write creates a pendingWrite draft (never done)', async () => {
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const created = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    prisma: { pendingWrite: { create: async (d) => { created.push(d.data); return { id: 'DRAFT1' }; } } },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'send_email', tool_groups: ['gmail'], depends_on: null, message: 'send email to boss' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_gmail_send_email', args: { to: 'boss@x.com' } })),
  });
  // A write must be reported as pending (draft), never done.
  assert.equal(res.status, 'pending');
  assert.equal(res.draftIds.length, 1);
  assert.equal(res.draftIds[0], 'DRAFT1');
  assert.equal(created.length, 1);
  assert.equal(created[0].toolName, 'GMAIL_SEND_EMAIL');
  assert.deepEqual(res.pendingActions, [{
    id: 'DRAFT1', provider: 'composio', tool_name: 'composio_gmail_send_email',
    tool_args: { to: 'boss@x.com' }, status: 'draft', step_index: 0,
  }]);
  assert.match(created[0].argsHash, /^[a-f0-9]{64}$/);
  assert.match(res.summary, /approval is required/i);
  assert.match(res.summary, /Nothing has been sent/i);
  assert.ok(!res.summary.includes('done'));
});

test('content artifact keeps prior assistant context even if planner authority is malformed', async () => {
  const created = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const res = await runCompoundOrchestrator({
    subtasks: [{
      operation: 'write_email', authority: 'read', output_kind: 'message',
      tool_groups: ['gmail'], depends_on: [], message: 'Write the requested email',
    }],
    conversationContext: 'DLLMs denoise many token positions in parallel and reduce warmed inference latency.',
    ctx: {
      userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
      _originalUserMessage: 'Write an email to amar@example.com about DLLMs',
      prisma: { pendingWrite: { create: async (data) => { created.push(data.data); return { id: 'DRAFT-CONTEXT' }; } } },
    },
    apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_gmail_send_email', args: { recipient_email: 'amar@example.com' },
      schema: { type: 'object', required: ['recipient_email', 'body'], properties: { recipient_email: { type: 'string' } } },
    })),
  });
  assert.equal(res.status, 'pending');
  assert.match(created[0].toolArgs.body, /denoise many token positions in parallel/);
});

test('human-input summaries explain progress, safety pause, and resumability', () => {
  const pending = buildCompoundUserSummary({
    subtasks: [{}, {}], status: 'pending',
    results: [{ status: 'completed' }, { status: 'draft_created' }],
  });
  assert.match(pending, /completed 1 of 2/i);
  assert.match(pending, /Nothing has been sent, published, created, or changed/i);

  const needsInput = buildCompoundUserSummary({
    subtasks: [{}, {}], status: 'needs_input',
    results: [{ status: 'completed' }, { status: 'needs_input', error: 'Choose one recipient' }],
  });
  assert.match(needsInput, /Choose one recipient/);
  assert.match(needsInput, /will not be repeated/);
});

test('tool input policy requires complete grounded content instead of placeholders', () => {
  const prompt = buildToolInputSystemPrompt();
  assert.match(prompt, /fields needed to answer the full instruction/i);
  assert.match(prompt, /largest safe bounded page/i);
  assert.match(prompt, /Do not add a content filter/i);
  assert.match(prompt, /readable final artifact/i);
  assert.match(prompt, /Never paste memory IDs/);
  assert.match(prompt, /Do not execute/);
});

test('grounded write validation rejects unresolved templates and accepts detailed dependency content', () => {
  assert.match(buildGroundedWriteFallbackPrompt(), /strict JSON/i);
  assert.match(buildGroundedWriteFallbackPrompt(), /complete, useful content/i);
  assert.match(buildGroundedWriteFallbackPrompt(), /Do not execute/i);
  const schema = {
    type: 'object',
    properties: {
      recipient_email: { type: 'string' },
      body: { type: 'string' },
    },
  };
  const prior = {
    recall: JSON.stringify({ memories: [{ content: 'The handbag brand is G ROCHER. Its front has a gold JL logo and the bag is dark brown.' }] }),
  };
  assert.deepEqual(
    unresolvedGroundedWriteFields('message', schema, {
      recipient_email: 'amar@example.com',
      body: 'Please find the handbag details below: [Add the specific handbag details here].',
    }, prior),
    ['body'],
  );
  assert.deepEqual(
    unresolvedGroundedWriteFields('message', schema, {
      recipient_email: 'amar@example.com',
      body: 'The handbag is dark brown, is associated with G ROCHER, and has a gold JL logo.',
    }, prior),
    [],
  );
});

test('exact governed dependency content may contain bracketed source notation', () => {
  const content = 'Singulance builds sovereign memory. [Source section omitted in this projection] It also provides governed HyperAgents.';
  const prior = { recall: JSON.stringify({ memories: [{ content }] }) };
  const schema = {
    type: 'object',
    properties: { body: { type: 'string' } },
  };
  const exact = exactGroundedDependencyContent(prior);
  assert.equal(exact, content);
  assert.deepEqual(unresolvedGroundedWriteFields('document', schema, { body: exact }, prior), []);
});

test('grounded fallback payload keeps evidence visible ahead of a compact provider schema', () => {
  const evidence = 'G ROCHER handbag with a gold JL logo. '.repeat(200);
  const payload = buildGroundedWriteFallbackPayload({
    message: 'Write the email',
    args: { recipient_email: 'amar@example.com' },
    priorOutputs: { recall: evidence },
    schema: {
      type: 'object',
      required: ['recipient_email', 'body'],
      properties: {
        recipient_email: { type: 'string', description: 'x'.repeat(20_000) },
        body: { type: 'string', description: 'y'.repeat(20_000) },
      },
    },
  });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.prior_outputs_data.recall, evidence);
  assert.equal(parsed.tool_schema.properties.body.type, 'string');
  assert.equal(Object.hasOwn(parsed.tool_schema.properties.body, 'description'), false);
  assert.ok(payload.indexOf('prior_outputs_data') < payload.indexOf('tool_schema'));
});

test('email body backfill drops memory ids and formats a readable briefing', () => {
  const dump = [
    '5f6742b8-0ab1-462c-a04e-d8292beb7598',
    'COMPANY: Singulance',
    'WEBSITE: https://singulancelabs.com',
    'TAGLINE: AI Workforce That Runs Inside Memory',
    'source:hyperagents-onboarding',
    'platform:hyperagents-onboarding',
    '0480eb42-9bd9-45dc-b324-04258d9c1679',
    'Lecture_09.1_-_RKGs.pdf',
  ].join('\n');
  assert.equal(looksLikeRecallDump(dump), true);
  const prior = {
    recall: JSON.stringify({
      memories: [
        { id: '5f6742b8-0ab1-462c-a04e-d8292beb7598', content: 'COMPANY: Singulance\nWEBSITE: https://singulancelabs.com\nTAGLINE: AI Workforce That Runs Inside Memory' },
        { id: '0480eb42-9bd9-45dc-b324-04258d9c1679', content: 'Lecture_09.1_-_RKGs.pdf' },
      ],
    }),
  };
  const filled = backfillMissingGroundedContentArgs('message', {
    type: 'object',
    required: ['body'],
    properties: { body: { type: 'string' } },
  }, { body: dump }, prior);
  assert.equal(looksLikeRecallDump(filled.body), false);
  assert.match(filled.body, /Hi,/);
  assert.match(filled.body, /Singulance/);
  assert.match(filled.body, /Best regards/);
  assert.equal(filled.body.includes('5f6742b8-0ab1-462c-a04e-d8292beb7598'), false);
  assert.equal(formatGroundedMessageBody([dump, 'COMPANY: Singulance']).includes('Hi,'), true);
});

test('exact dependency fallback extracts complete grounded content instead of a placeholder', () => {
  const first = 'The handbag brand is G ROCHER and it has a gold JL logo.';
  const second = 'The bag is dark brown with a zipper, chain strap, and white flower charm.';
  const content = exactGroundedDependencyContent({
    recall: JSON.stringify({ memories: [{ content: first }, { content: second }] }),
  });
  assert.match(content, /G ROCHER/);
  assert.match(content, /white flower charm/);
  assert.equal(content.includes('memories'), false);
});

test('missing provider body is backfilled from an existing grounded dependency', () => {
  const prior = {
    recall: JSON.stringify({ memories: [{ content: 'DLLMs denoise token positions in parallel and can reduce warmed inference latency.' }] }),
  };
  const args = backfillMissingGroundedContentArgs('message', {
    type: 'object',
    required: ['recipient_email', 'body'],
    properties: {
      recipient_email: { type: 'string' },
      is_html: { type: 'boolean' },
    },
  }, { recipient_email: 'amar@example.com' }, prior);
  assert.equal(args.recipient_email, 'amar@example.com');
  assert.match(args.body, /denoise token positions in parallel/);
  assert.equal(args.is_html, false);
});

test('plan validation attaches earlier reads to a governed write when planner omits the edge', () => {
  const normalized = normalizeCompoundDependencies([
    { operation: 'recall', authority: 'read', tool_groups: ['hivemind-recall'], depends_on: [] },
    { operation: 'send_email', authority: 'write', tool_groups: ['gmail'], depends_on: [] },
  ]);
  assert.deepEqual(normalized[1].depends_on, [0]);
  const explicit = normalizeCompoundDependencies([
    { operation: 'recall', authority: 'read', tool_groups: ['hivemind-recall'], depends_on: [] },
    { operation: 'search', authority: 'read', tool_groups: ['gmail'], depends_on: [] },
    { operation: 'send_email', authority: 'write', tool_groups: ['gmail'], depends_on: [1] },
  ]);
  assert.deepEqual(explicit[2].depends_on, [1], 'explicit planner dependencies remain authoritative');
});

test('plan validation attaches earlier reads to semantic artifacts despite malformed authority', () => {
  const normalized = normalizeCompoundDependencies([
    {
      operation: 'recall', authority: 'read', output_kind: 'knowledge',
      tool_groups: ['hivemind-recall'], depends_on: [],
    },
    {
      operation: 'send_email', authority: 'read', output_kind: 'message',
      tool_groups: ['gmail'], depends_on: [],
    },
  ]);
  assert.deepEqual(normalized[1].depends_on, [0]);
});

test('plan validation retains native recall for a generic connector step with malformed authority', () => {
  const normalized = normalizeCompoundDependencies([
    {
      operation: 'recall', authority: 'read', output_kind: 'knowledge',
      tool_groups: ['hivemind-recall'], depends_on: [],
    },
    {
      operation: 'connector_action', authority: 'read', output_kind: 'generic',
      tool_groups: ['gmail'], depends_on: [],
    },
  ]);
  assert.deepEqual(normalized[1].depends_on, [0]);
});

test('adjacent native recall steps collapse to one DAG node', () => {
  const collapsed = collapseAdjacentNativeRecalls([
    { operation: 'recall', tool_groups: ['hivemind-recall'], message: 'TARA in memory' },
    { operation: 'recall', tool_groups: ['hivemind-context'], message: 'TARA again' },
    { operation: 'send_email', authority: 'write', tool_groups: ['gmail'], depends_on: [0, 1], message: 'email rama' },
  ]);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].tool_groups[0], 'hivemind-recall');
  assert.deepEqual(collapsed[1].depends_on, [0]);
});

test('composio write reuses a draft when idempotency collides', async () => {
  const schema = {
    type: 'object', required: ['recipient_email', 'body'],
    properties: { recipient_email: { type: 'string' }, body: { type: 'string' } },
  };
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send' }],
    executeImpl: async () => ({ successful: false, error: 'must remain approval gated' }),
  });
  const err = Object.assign(new Error('Unique constraint failed on the fields: (`idempotency_key`)'), { code: 'P2002' });
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 'draft-1' },
    prisma: {
      pendingWrite: {
        create: async () => { throw err; },
        findUnique: async () => ({ id: 'EXISTING-DRAFT' }),
      },
    },
  };
  const result = await runCompoundOrchestrator({
    subtasks: [{
      operation: 'send_email', authority: 'write', output_kind: 'message',
      tool_groups: ['gmail'], message: 'email rama',
    }],
    ctx: { ...ctx, _originalUserMessage: 'send a detailed email to rama@example.com' },
    apiKey: 'k', composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_gmail_send_email',
      args: { recipient_email: 'rama@example.com', body: 'Hi Rama, here is TARA.' },
      schema,
    })),
  });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.draftIds, ['EXISTING-DRAFT']);
});

test('missing write fields produce a resumable generalized field-input request', async () => {
  const created = [];
  const schema = {
    type: 'object',
    properties: { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
    required: ['recipient_email', 'subject', 'body'],
  };
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send' }],
    executeImpl: async () => ({ successful: false, error: 'must remain approval gated' }),
  });
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 'field-1' },
    prisma: { pendingWrite: { create: async (data) => { created.push(data.data); return { id: 'FIELD-DRAFT' }; } } },
  };
  const selectTool = makeSelector((message) => ({
    toolName: 'composio_gmail_send_email', schema,
    args: message.includes('person@example.com')
      ? { recipient_email: 'person@example.com', subject: 'Ready', body: 'Complete grounded message.' }
      : { subject: 'Ready', body: 'Complete grounded message.' },
  }));
  const paused = await runCompoundOrchestrator({
    subtasks: [{ operation: 'send_email', authority: 'write', output_kind: 'message', tool_groups: ['gmail'], message: 'Prepare the email' }],
    ctx, apiKey: 'k', composio, selectTool,
  });
  assert.equal(paused.status, 'needs_input');
  assert.deepEqual(paused.inputRequests[0].fields.map((field) => field.name), ['recipient_email']);

  const resumed = await runCompoundOrchestrator({
    subtasks: paused.resumeState.subtasks,
    ctx: { ...ctx, _trace: { traceId: 'field-2' } }, apiKey: 'k', composio, selectTool,
    resumeState: {
      ...paused.resumeState,
      choice: { stepIndex: 0, retryStep: true, values: { recipient_email: 'person@example.com' } },
    },
  });
  assert.equal(resumed.status, 'pending');
  assert.equal(created[0].toolArgs.recipient_email, 'person@example.com');
});

test('namedRecipientQuery keeps a display name and skips long prose', () => {
  assert.equal(namedRecipientQuery('rama'), 'rama');
  assert.equal(namedRecipientQuery('rama@example.com'), '');
  assert.equal(namedRecipientQuery('go through HIVEMIND git repo and send important information about repo to rama via gmail'), '');
  assert.equal(contactLookupTool([
    { function: { name: 'composio_gmail_send_email' }, _composio: { slug: 'GMAIL_SEND_EMAIL' } },
    { function: { name: 'composio_gmail_get_contacts', description: 'search contacts' }, _composio: { slug: 'GMAIL_GET_CONTACTS' } },
  ])?.slug, 'GMAIL_GET_CONTACTS');
});

test('gmail write resolves a named recipient through connected contact lookup', async () => {
  const created = [];
  const schema = {
    type: 'object', required: ['recipient_email', 'subject', 'body'],
    properties: {
      recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
    },
  };
  const composio = makeComposio({
    tools: [
      { name: 'composio_gmail_get_contacts', slug: 'GMAIL_GET_CONTACTS', description: 'search people contacts' },
      { name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send' },
    ],
    executeImpl: async (slug) => {
      if (slug === 'GMAIL_GET_CONTACTS') {
        return { successful: true, data: { contacts: [{ email: 'rama@singulance.com', name: 'Rama' }] }, error: null };
      }
      throw new Error('must not execute send');
    },
  });
  const result = await runCompoundOrchestrator({
    subtasks: [{
      operation: 'send_email', authority: 'write', output_kind: 'message',
      tool_groups: ['gmail'], message: 'email rama',
    }],
    ctx: {
      userId: 'u1', orgId: 'o1', _trace: { traceId: 'rama-lookup' },
      _originalUserMessage: 'send important information about repo to rama via gmail',
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'RAMA-DRAFT' }; } } },
    },
    apiKey: 'k', composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_gmail_send_email',
      args: { recipient_email: 'rama', subject: 'HIVEMIND repo', body: 'Important notes from recall.' },
      schema,
    })),
  });
  assert.equal(result.status, 'pending');
  assert.equal(created[0].toolArgs.recipient_email, 'rama@singulance.com');
});

test('email write pauses before draft persistence when generated recipient is only a name', async () => {
  const created = [];
  const schema = {
    type: 'object', required: ['recipient_email', 'subject', 'body'],
    properties: {
      recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
    },
  };
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send' }],
    executeImpl: async () => ({ successful: false, error: 'must not execute' }),
  });
  const result = await runCompoundOrchestrator({
    subtasks: [{
      operation: 'send_email', authority: 'write', output_kind: 'message',
      tool_groups: ['gmail'], message: 'send the prepared message',
    }],
    ctx: {
      userId: 'u1', orgId: 'o1', _trace: { traceId: 'invalid-recipient' },
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'INVALID' }; } } },
    },
    apiKey: 'k', composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_gmail_send_email',
      args: { recipient_email: 'AmarSai', subject: 'Hello', body: 'Complete message.' },
      schema,
    })),
  });

  assert.equal(result.status, 'needs_input');
  assert.equal(created.length, 0);
  assert.deepEqual(result.inputRequests[0].fields.map((field) => field.name), ['recipient_email']);
});

test('compound orchestrator: a write missing a required provider field asks before creating a draft', async () => {
  const created = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_googledocs_create', slug: 'GOOGLEDOCS_CREATE_DOCUMENT', description: 'create document' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    prisma: { pendingWrite: { create: async (d) => { created.push(d.data); return { id: 'DRAFT1' }; } } },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'write', tool_groups: ['google-docs'], depends_on: null, message: 'create a document titled Notes' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_googledocs_create', args: { title: 'Notes' },
      schema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
    })),
  });
  assert.equal(res.status, 'needs_input');
  assert.equal(created.length, 0);
  assert.match(res.steps[0].summary, /text/i);
});

test('compound orchestrator: Composio Query Mode completes empty write arguments before drafting', async () => {
  const created = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' }],
    executeImpl: async () => ({ successful: false, data: null, error: 'must not execute' }),
    generateImpl: async (slug, text) => {
      assert.equal(slug, 'GMAIL_SEND_EMAIL');
      assert.match(text, /G ROCHER/);
      return { recipient_email: 'amar@example.com', subject: 'Handbag', body: 'The brand is G ROCHER.' };
    },
  });
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't-query' },
    _originalUserMessage: 'Recall the handbag and email amar@example.com',
    _tracedDispatch: async () => ({ memories: [{ id: 'm1', title: 'Handbag', content: 'The brand is G ROCHER.' }], evidence: [] }),
    prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'DQUERY' }; } } },
  };
  const result = await runCompoundOrchestrator({
    subtasks: [{ operation: 'recall', authority: 'read', output_kind: 'knowledge', tool_groups: ['hivemind-recall'], message: 'handbag' },
      { operation: 'email', authority: 'write', output_kind: 'message', tool_groups: ['gmail'], message: 'Email Amar', depends_on: [0] }],
    ctx, apiKey: 'k', composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_gmail_send_email', args: {},
      schema: { properties: { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } },
    })),
  });
  assert.equal(result.status, 'pending');
  assert.equal(created.length, 1);
  assert.equal(created[0].toolArgs.recipient_email, 'amar@example.com');
  assert.match(created[0].toolArgs.body, /G ROCHER/);
});

test('compound orchestrator: recalled facts fill an email body when planner authority is malformed', async () => {
  const created = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' }],
    executeImpl: async () => ({ successful: false, error: 'must remain approval gated' }),
  });
  const result = await runCompoundOrchestrator({
    subtasks: [
      {
        operation: 'recall', authority: 'read', output_kind: 'knowledge',
        tool_groups: ['hivemind-recall'], message: 'all company information',
      },
      {
        operation: 'send_email', authority: 'read', output_kind: 'message',
        tool_groups: ['gmail'], message: 'write the requested email', depends_on: [],
      },
    ],
    ctx: {
      userId: 'u1', orgId: 'o1', _trace: { traceId: 'company-email' },
      _originalUserMessage: 'Email all company information to amar@example.com',
      _tracedDispatch: async () => ({
        memories: [{ id: 'company-1', title: 'Company', content: 'Singulance builds governed organizational memory and HyperAgents.' }],
        evidence: [],
      }),
      prisma: { pendingWrite: { create: async ({ data }) => { created.push(data); return { id: 'COMPANY-DRAFT' }; } } },
    },
    apiKey: 'k', composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_gmail_send_email',
      args: { recipient_email: 'amar@example.com', subject: 'Company information' },
      schema: {
        type: 'object', required: ['recipient_email', 'subject', 'body'],
        properties: { recipient_email: { type: 'string' }, subject: { type: 'string' } },
      },
    })),
  });

  assert.equal(result.status, 'pending');
  assert.equal(created.length, 1);
  assert.match(created[0].toolArgs.body, /governed organizational memory and HyperAgents/);
});

test('compound orchestrator: dependent subtask receives prior typed output fields', async () => {
  const calls = [];
  const composio = makeComposio({
    tools: [
      { name: 'composio_googledocs_get_document', slug: 'GOOGLEDOCS_GET_DOCUMENT', description: 'get document' },
      { name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' },
    ],
    executeImpl: async (slug, args) => {
      calls.push({ slug, args });
      if (slug === 'GOOGLEDOCS_GET_DOCUMENT') return { successful: true, data: { documentId: 'DOC123', url: 'https://docs/x' }, error: null };
      return { successful: true, data: {}, error: null };
    },
  });
  const created = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    prisma: { pendingWrite: { create: async (d) => { created.push(d.data); return { id: 'D1' }; } } },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'create_doc', tool_groups: ['google-docs'], depends_on: null, message: 'create doc' },
      { operation: 'send_email', tool_groups: ['gmail'], depends_on: [0], message: 'email it' },
    ],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector((m) => m.startsWith('create')
      ? { toolName: 'composio_googledocs_get_document', args: { id: 'x' }, schema: { type: 'object', properties: { id: { type: 'string' } } } }
      : { toolName: 'composio_gmail_send_email', args: { to: 'boss@x.com' }, schema: { type: 'object', properties: { documentId: { type: 'string' }, url: { type: 'string' }, to: { type: 'string' } } } }),
  });
  assert.equal(res.status, 'pending');
  // The email draft must have received documentId injected from the prior step.
  const draft = created.find((d) => d.toolName === 'GMAIL_SEND_EMAIL');
  assert.ok(draft, 'email draft created');
  assert.equal(draft.toolArgs.documentId, 'DOC123', 'documentId injected from prior result');
  assert.equal(draft.toolArgs.to, 'boss@x.com', 'explicit args preserved');
});

test('compound orchestrator stops an ambiguous dependent write instead of guessing a recipient', async () => {
  const created = [];
  const composio = makeComposio({
    tools: [
      { name: 'composio_gmail_search_people', slug: 'GMAIL_SEARCH_PEOPLE', description: 'search contacts' },
      { name: 'composio_gmail_create_email_draft', slug: 'GMAIL_CREATE_EMAIL_DRAFT', description: 'create draft' },
    ],
    executeImpl: async (slug) => slug === 'GMAIL_SEARCH_PEOPLE'
      ? { successful: true, data: { results: [
          { name: 'Amar Marvel studios', email: 'amar@example.com' },
          { name: 'AMAR SAI', email: 'amar.sai@example.edu' },
        ] }, error: null }
      : { successful: false, data: null, error: 'write must not execute' },
  });
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    _tracedDispatch: async () => ({ memories: [{ id: 'm1', title: 'Handbag', content: 'Brand is G ROCHER. Logo is JL.' }], evidence: [] }),
    prisma: { pendingWrite: { create: async (data) => { created.push(data); return { id: 'D1' }; } } },
  };
  const selector = async ({ message }) => {
    if (message.includes('Resolve Amar')) {
      return { toolName: 'composio_gmail_search_people', args: { query: 'Amar' }, schema: { properties: { query: { type: 'string' } } } };
    }
    throw new Error(`dependent write must not select a tool: ${message}`);
  };
  const result = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'recall_handbag', authority: 'read', tool_groups: ['hivemind-recall'], message: 'Recall handbag' },
      { operation: 'resolve_amar', authority: 'read', output_kind: 'recipient', tool_groups: ['gmail'], depends_on: [0], message: 'Resolve Amar' },
      { operation: 'draft_email', authority: 'write', tool_groups: ['gmail'], depends_on: [0, 1], message: 'Create the email draft' },
    ],
    ctx, apiKey: 'k', signal: null, composio, selectTool: selector,
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(created.length, 0);
  assert.match(result.summary, /Multiple recipient addresses matched/);
  assert.equal(result.steps[2].status, 'needs_input');
  assert.deepEqual(result.inputRequests[0].options.map((option) => option.value), [
    'amar@example.com', 'amar.sai@example.edu',
  ]);
  assert.ok(result.resumeState, 'paused state is available for server-side continuation storage');

  const resumed = await runCompoundOrchestrator({
    subtasks: result.resumeState.subtasks,
    ctx: { ...ctx, _trace: { traceId: 't2' } }, apiKey: 'k', signal: null, composio,
    resumeState: {
      ...result.resumeState,
      choice: { stepIndex: 1, field: 'recipient_email', value: 'amar@example.com' },
    },
    selectTool: async ({ message }) => {
      assert.match(message, /amar@example\.com/);
      return {
        toolName: 'composio_gmail_create_email_draft',
        args: { to: 'amar@example.com', subject: 'Handbag', body: 'Brand is G ROCHER.' },
        schema: { properties: { to: {}, subject: {}, body: {} }, required: ['to', 'subject', 'body'] },
      };
    },
  });
  assert.equal(resumed.status, 'pending');
  assert.equal(created.length, 1, 'resume executes only the blocked dependent write');
  assert.equal(created[0].data.toolArgs.to, 'amar@example.com');
});

test('compound orchestrator: independent subtasks run in parallel (fan-out)', async () => {
  const calls = [];
  const composio = makeComposio({
    tools: [
      { name: 'composio_github_list', slug: 'GITHUB_LIST', description: 'list issues' },
      { name: 'composio_linear_list', slug: 'LINEAR_LIST', description: 'list tickets' },
    ],
    executeImpl: async (slug, args) => {
      calls.push({ slug, t: Date.now() });
      await new Promise((r) => setTimeout(r, 200));
      return { successful: true, data: {}, error: null };
    },
  });
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' } };
  const t0 = Date.now();
  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'github', tool_groups: ['github'], depends_on: null, message: 'check github' },
      { operation: 'linear', tool_groups: ['linear'], depends_on: null, message: 'check linear' },
    ],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector((m) => m.includes('github') ? { toolName: 'composio_github_list', args: {} } : { toolName: 'composio_linear_list', args: {} }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 2);
  const delta = Math.abs(calls[0].t - calls[1].t);
  assert.ok(delta < 100, `github+linear should start together (delta ${delta}ms)`);
  assert.ok(elapsed < 350, `fan-out should be ~200ms not ~400ms (got ${elapsed}ms)`);
});

test('compound orchestrator: emits tool_call/tool_result SSE events', async () => {
  const events = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_search', slug: 'GMAIL_SEARCH', description: 'search' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' } };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_gmail_search', args: {} })),
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(res.status, 'completed');
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 1);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 1);
  assert.equal(events.filter((e) => e.type === 'orchestration_plan').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'orchestration_step').map((e) => e.phase), ['started', 'completed']);
});

test('hivemind-context never opens a Composio connect link', async () => {
  process.env.USE_TOOLS_UNIFIED_DAG = 'true';
  let linked = 0;
  const composio = {
    async getToolkitStatus() { return 'available'; },
    async createConnectLink(toolkit) {
      if (String(toolkit).includes('hivemind')) {
        linked += 1;
        throw new Error('must not connect hivemind-context');
      }
      return { redirectUrl: 'https://connect.composio.dev/github' };
    },
    async getToolkitTools() { return []; },
    async executeTool() { throw new Error('must not execute composio'); },
  };
  const result = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'recall', tool_groups: ['hivemind-context'], depends_on: null, message: 'TARA' },
      { operation: 'github', tool_groups: ['github'], depends_on: null, message: 'TARA on github' },
    ],
    ctx: {
      userId: 'u1', orgId: 'o1', unifiedDag: true, _trace: { traceId: 'ctx-1' },
      _tracedDispatch: async () => ({ memories: [{ id: 'm1', title: 'TARA', content: 'voice agent' }], evidence: [] }),
    },
    apiKey: 'k', composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_github_search', args: {} })),
  });
  assert.equal(linked, 0);
  assert.equal(result.steps[0].status, 'completed');
  assert.equal(result.inputRequests[0]?.toolkit, 'github');
});

test('unified DAG pauses a required disconnected toolkit and still runs independent native recall', async () => {
  const previous = process.env.USE_TOOLS_UNIFIED_DAG;
  process.env.USE_TOOLS_UNIFIED_DAG = 'true';
  let executed = 0;
  const composio = {
    ...makeComposio({
      tools: [{ name: 'composio_gmail_fetch_emails', slug: 'GMAIL_FETCH_EMAILS', description: 'fetch' }],
      executeImpl: async () => {
        executed += 1;
        return { successful: true, data: { messages: [{ id: '1' }] }, error: null };
      },
    }),
    async getToolkitStatus() { return 'available'; },
    async createConnectLink(_toolkit, _orgId, opts = {}) {
      assert.deepEqual(opts.toolkitMeta?.composioManagedAuthSchemes, ['OAUTH2']);
      return { redirectUrl: 'https://connect.composio.dev/link/gmail-test' };
    },
    async discoverSessionTools() { throw new Error('must not discover session tools while disconnected'); },
  };
  const ctx = {
    userId: 'u1', orgId: 'o1', unifiedDag: true, _trace: { traceId: 't1' },
    _tracedDispatch: async () => ({ memories: [{ id: 'm1', title: 'Notes', content: 'risk: delay' }], evidence: [] }),
  };
  try {
    const result = await runCompoundOrchestrator({
      subtasks: [
        { operation: 'recall', tool_groups: ['hivemind-recall'], depends_on: null, message: 'project notes' },
        { operation: 'gmail_search', tool_groups: ['gmail'], depends_on: null, message: 'important emails' },
        { operation: 'compare', tool_groups: ['hivemind-recall'], depends_on: [0, 1], message: 'compare' },
      ],
      ctx, apiKey: 'k', signal: null, composio,
      selectTool: makeSelector(() => ({ toolName: 'composio_gmail_fetch_emails', args: {} })),
    });
    assert.equal(executed, 0);
    assert.equal(result.status, 'needs_input');
    assert.equal(result.steps[0].status, 'completed');
    assert.equal(result.inputRequests[0].kind, 'connect_account');
    assert.equal(result.inputRequests[0].blocking, true);
    assert.equal(result.inputRequests[0].options[0].href, 'https://connect.composio.dev/link/gmail-test');
    assert.equal(result.inputRequests[0].options[0].open_url, true);
    assert.equal(result.inputRequests[0].toolkit, 'gmail');
    assert.match(result.inputRequests[0].logo_url, /gmail/);
    assert.equal(result.inputRequests[0].options[1].value, RETRY_CONNECT_VALUE);
    assert.equal(shouldOpenConnectHref(result.inputRequests[0].options[0]), true);
    assert.match(result.summary, /Connect Gmail/);

    composio.getToolkitStatus = async () => 'connected';
    const resumed = await runCompoundOrchestrator({
      subtasks: result.resumeState.subtasks,
      ctx: { ...ctx, _trace: { traceId: 't2' } },
      apiKey: 'k', signal: null, composio,
      resumeState: { ...result.resumeState, choice: { stepIndex: 1, value: RETRY_CONNECT_VALUE } },
      selectTool: makeSelector(() => ({ toolName: 'composio_gmail_fetch_emails', args: {} })),
    });
    assert.equal(executed, 1);
    assert.ok(['completed', 'needs_input', 'pending'].includes(resumed.status));
  } finally {
    if (previous === undefined) delete process.env.USE_TOOLS_UNIFIED_DAG;
    else process.env.USE_TOOLS_UNIFIED_DAG = previous;
  }
});

test('unified DAG fail-closes status throw with zero Composio search or execute', async () => {
  const previous = process.env.USE_TOOLS_UNIFIED_DAG;
  process.env.USE_TOOLS_UNIFIED_DAG = 'true';
  let executed = 0;
  let discovered = 0;
  const composio = {
    ...makeComposio({
      tools: [{ name: 'composio_gmail_search', slug: 'GMAIL_SEARCH', description: 'search' }],
      executeImpl: async () => {
        executed += 1;
        return { successful: true, data: {}, error: null };
      },
    }),
    async getToolkitStatus() { throw new Error('status_unavailable'); },
    async createConnectLink() { return { redirectUrl: 'https://connect.composio.dev/link/gmail-failclosed' }; },
    async discoverSessionTools() {
      discovered += 1;
      throw new Error('must not discover after status throw');
    },
    async getToolkitTools() { throw new Error('must not load tools after status throw'); },
  };
  try {
    const result = await runCompoundOrchestrator({
      subtasks: [{ operation: 'gmail_search', tool_groups: ['gmail'], depends_on: null, message: 'emails' }],
      ctx: { userId: 'u1', orgId: 'o1', unifiedDag: true, _trace: { traceId: 't1' } },
      apiKey: 'k', signal: null, composio,
      selectTool: makeSelector(() => ({ toolName: 'composio_gmail_search', args: {} })),
    });
    assert.equal(executed, 0);
    assert.equal(discovered, 0);
    assert.equal(result.status, 'needs_input');
    assert.equal(result.inputRequests[0].kind, 'connect_account');
    assert.equal(shouldOpenConnectHref(result.inputRequests[0].options[0]), true);
    assert.equal(result.inputRequests[0].options[1].value, RETRY_CONNECT_VALUE);
  } finally {
    if (previous === undefined) delete process.env.USE_TOOLS_UNIFIED_DAG;
    else process.env.USE_TOOLS_UNIFIED_DAG = previous;
  }
});

test('flag off does not invent a connect pause for disconnected toolkits', async () => {
  const previous = process.env.USE_TOOLS_UNIFIED_DAG;
  delete process.env.USE_TOOLS_UNIFIED_DAG;
  let executed = 0;
  const composio = {
    ...makeComposio({
      tools: [{ name: 'composio_gmail_search', slug: 'GMAIL_SEARCH', description: 'search' }],
      executeImpl: async () => {
        executed += 1;
        return { successful: true, data: {}, error: null };
      },
    }),
    async getToolkitStatus() { return 'available'; },
    async createConnectLink() { throw new Error('must not create connect link when flag off'); },
  };
  try {
    const res = await runCompoundOrchestrator({
      subtasks: [{ operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search' }],
      ctx: { userId: 'u1', orgId: 'o1', unifiedDag: false, _trace: { traceId: 't1' } },
      apiKey: 'k', signal: null, composio,
      selectTool: makeSelector(() => ({ toolName: 'composio_gmail_search', args: {} })),
    });
    assert.equal(res.status, 'completed');
    assert.equal(executed, 1);
  } finally {
    if (previous === undefined) delete process.env.USE_TOOLS_UNIFIED_DAG;
    else process.env.USE_TOOLS_UNIFIED_DAG = previous;
  }
});
