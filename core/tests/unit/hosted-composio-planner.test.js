import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogFromDiscovery,
  connectedProvidersFromAccounts,
  decisionToHostedPlan,
  intentPlanToSubtasks,
  parseIntentPlanJson,
  planComposioIntentWorkflow,
  planHostedComposioWorkflow,
} from '../../src/agent/hosted-composio-planner.js';
import { isUseToolsUnifiedDagEnabled } from '../../src/agent/use-tools-unified-flag.js';

test('connected provider discovery uses active tenant accounts only', () => {
  assert.deepEqual(connectedProvidersFromAccounts([
    { toolkit: 'gmail', status: 'ACTIVE' },
    { toolkit: 'googlecalendar', status: 'ACTIVE' },
    { toolkit: 'slack', status: 'EXPIRED' },
    { toolkit: 'gmail', status: 'ACTIVE' },
    { toolkit: 'unmapped', status: 'ACTIVE' },
  ]), ['gmail', 'google-calendar', 'unmapped']);
});

test('hosted plan preserves a validated sequential dependency graph', () => {
  const steps = decisionToHostedPlan({
    operation: 'compound',
    subtasks: [
      { operation: 'recall', authority: 'read', tool_groups: ['hivemind-recall'], message: 'Recall handbag details' },
      { operation: 'resolve_recipient', authority: 'read', tool_groups: ['gmail'], depends_on: [0], message: 'Resolve Amar from contacts and email history' },
      { operation: 'create_email_draft', authority: 'write', tool_groups: ['gmail'], depends_on: [0, 1], message: 'Create a dedicated email draft' },
    ],
  }, { request: 'Recall the handbag and email Amar', connectedProviders: ['gmail'] });
  assert.deepEqual(steps.map((step) => step.tool_groups[0]), ['hivemind-recall', 'gmail', 'gmail']);
  assert.deepEqual(steps[1].depends_on, [0]);
  assert.deepEqual(steps[2].depends_on, [0, 1]);
  assert.deepEqual(steps.map((step) => step.authority), ['read', 'read', 'write']);
});

test('hosted plan resolves a connected-action recipient through its live provider, not memory recall', () => {
  const steps = decisionToHostedPlan({
    operation: 'compound',
    subtasks: [
      {
        operation: 'resolve_recipient', authority: 'read', output_kind: 'recipient',
        tool_groups: ['hivemind-recall'], message: 'Resolve the named recipient',
      },
      {
        operation: 'send_message', authority: 'write', output_kind: 'message',
        tool_groups: ['gmail'], depends_on: [0], message: 'Send to the resolved recipient',
      },
    ],
  }, { request: 'Email the named person', connectedProviders: ['gmail'] });

  assert.deepEqual(steps[0].tool_groups, ['gmail']);
  assert.deepEqual(steps[1].depends_on, [0]);
});

test('hosted plan fails closed when the planner selects an unavailable connector', () => {
  assert.throws(() => decisionToHostedPlan({
    operation: 'compound',
    subtasks: [{ operation: 'post', tool_groups: ['slack'], message: 'Post it' }],
  }, { request: 'Post it', connectedProviders: ['gmail'], unifiedDag: false }), /planner_selected_unavailable_tool_group:slack/);
});

test('flag-off still rejects a disconnected named catalog app', () => {
  assert.throws(() => decisionToHostedPlan({
    operation: 'compound',
    subtasks: [
      { operation: 'recall', tool_groups: ['hivemind-recall'], message: 'notes' },
      { operation: 'gmail_search', tool_groups: ['gmail'], message: 'emails' },
    ],
  }, { request: 'emails and notes', connectedProviders: [], unifiedDag: false }), /planner_selected_unavailable_tool_group:gmail/);
});

test('intent DAG maps Composio slugs and HIVEMIND recall without a 1000-app catalog', () => {
  const catalog = catalogFromDiscovery({
    tools: [{
      function: { description: 'Search Gmail' },
      _composio: { toolkit: 'gmail', slug: 'GMAIL_FETCH_EMAILS' },
    }],
    connectedToolkits: ['gmail'],
  });
  assert.equal(catalog.hivemind[0].tool, 'hivemind_recall');
  assert.equal(catalog.composio[0].tool_slug, 'GMAIL_FETCH_EMAILS');
  const plan = parseIntentPlanJson(JSON.stringify({
    goal: 'Find Rama email and recall notes',
    steps: [
      { id: 'find_rama', executor: 'composio', toolkit: 'gmail', tool_slug: 'GMAIL_FETCH_EMAILS', subtask: 'Find Rama', depends_on: [], operation_type: 'read' },
      { id: 'notes', executor: 'hivemind', tool: 'hivemind_recall', subtask: 'Project notes', depends_on: ['find_rama'], operation_type: 'read' },
    ],
  }));
  const subtasks = intentPlanToSubtasks(plan);
  assert.equal(subtasks[0].tool_slug, 'GMAIL_FETCH_EMAILS');
  assert.deepEqual(subtasks[0].tool_groups, ['gmail']);
  assert.deepEqual(subtasks[1].tool_groups, ['hivemind-recall']);
  assert.deepEqual(subtasks[1].depends_on, [0]);
});

test('intent planner searches Composio then returns a compound DAG', async () => {
  const result = await planComposioIntentWorkflow({
    request: 'Find emails from Rama and check HIVEMIND notes',
    orgId: 'org-1',
    apiKey: 'k',
    composio: {
      async searchToolsByIntent() {
        return {
          connectedToolkits: ['gmail'],
          tools: [{
            function: { name: 'composio_gmail_fetch_emails', description: 'search mail', parameters: {} },
            _composio: { toolkit: 'gmail', slug: 'GMAIL_FETCH_EMAILS' },
          }],
        };
      },
    },
    proposePlan: async () => ({
      steps: [
        { id: 'gmail', executor: 'composio', toolkit: 'gmail', tool_slug: 'GMAIL_FETCH_EMAILS', subtask: 'Find Rama', depends_on: [] },
        { id: 'recall', executor: 'hivemind', subtask: 'notes', depends_on: ['gmail'] },
      ],
    }),
  });
  assert.equal(result.version, 'hivemind-composio-intent-planner.v1');
  assert.equal(result._decision.operation, 'compound');
  assert.equal(result.steps[0].tool_slug, 'GMAIL_FETCH_EMAILS');
  assert.equal(result.steps[1].tool_groups[0], 'hivemind-recall');
});

test('unified DAG keeps any named external toolkit without a catalog whitelist', () => {
  const steps = decisionToHostedPlan({
    operation: 'compound',
    subtasks: [
      { operation: 'github', tool_groups: ['github'], message: 'TARA on github' },
      { operation: 'recall', tool_groups: ['hivemind-recall'], message: 'TARA in memory' },
      { operation: 'email', authority: 'write', tool_groups: ['gmail'], depends_on: [0, 1], message: 'email rama' },
    ],
  }, { request: 'github hivemind gmail', connectedProviders: [], unifiedDag: true });
  assert.deepEqual(steps.map((step) => step.tool_groups[0]), ['github', 'hivemind-recall', 'gmail']);
  assert.equal(steps[0].connection_required, true);
  assert.equal(steps[1].connection_required, false);
  assert.equal(steps[2].connection_required, true);
});

test('hivemind-context is native recall, never a Composio connect app', () => {
  const steps = decisionToHostedPlan({
    operation: 'compound',
    subtasks: [
      { operation: 'github', tool_groups: ['github'], message: 'TARA on github' },
      { operation: 'context', tool_groups: ['hivemind-context'], message: 'TARA in memory' },
      { operation: 'email', authority: 'write', tool_groups: ['gmail'], depends_on: [0, 1], message: 'email rama' },
    ],
  }, { request: 'github and hivemind then email', connectedProviders: ['github'], unifiedDag: true });
  assert.deepEqual(steps.map((step) => step.tool_groups[0]), ['github', 'hivemind-recall', 'gmail']);
  assert.equal(steps[1].connection_required, false);
  assert.equal(steps[2].connection_required, true);
});

test('unified DAG keeps a disconnected catalog app beside native recall', () => {
  const steps = decisionToHostedPlan({
    operation: 'compound',
    subtasks: [
      { operation: 'recall', authority: 'read', tool_groups: ['hivemind-recall'], message: 'project notes' },
      { operation: 'gmail_search', authority: 'read', tool_groups: ['gmail'], depends_on: [], message: 'important emails last month' },
      { operation: 'compare', authority: 'read', tool_groups: ['hivemind-recall'], depends_on: [0, 1], message: 'compare risks' },
    ],
  }, { request: 'emails and project notes', connectedProviders: [], unifiedDag: true });
  assert.deepEqual(steps.map((step) => step.tool_groups[0]), ['hivemind-recall', 'gmail', 'hivemind-recall']);
  assert.equal(steps[1].connection_required, true);
  assert.equal(steps[0].connection_required, false);
  assert.ok(!steps.some((step) => step.tool_groups[0] === 'hivemind-recall' && step.operation === 'gmail_search'));
});

test('hosted planner lists accounts only and never searches Composio tools while disconnected', async () => {
  const previous = process.env.USE_TOOLS_UNIFIED_DAG;
  process.env.USE_TOOLS_UNIFIED_DAG = 'true';
  let searched = 0;
  let executed = 0;
  try {
    const result = await planHostedComposioWorkflow({
      request: 'Go through HIVEMIND git repo and send important information about repo to rama via gmail',
      orgId: 'org-1',
      apiKey: 'test-key',
      parseIntent: async () => ({
        decision: {
          operation: 'compound',
          subtasks: [
            { operation: 'recall', tool_groups: ['hivemind-recall'], message: 'repo notes' },
            { operation: 'gmail_send', authority: 'write', tool_groups: ['gmail'], message: 'email rama' },
          ],
        },
        usage: {},
      }),
      composio: {
        async listConnectedAccounts() { return []; },
        async discoverSessionTools() { searched += 1; throw new Error('planner must not search tools'); },
        async executeTool() { executed += 1; throw new Error('planner must not execute'); },
      },
    });
    assert.equal(searched, 0);
    assert.equal(executed, 0);
    assert.deepEqual(result.steps.map((step) => step.tool_groups[0]), ['hivemind-recall', 'gmail']);
    assert.equal(result.steps[1].connection_required, true);
  } finally {
    if (previous === undefined) delete process.env.USE_TOOLS_UNIFIED_DAG;
    else process.env.USE_TOOLS_UNIFIED_DAG = previous;
  }
});

test('fail-closed flag is off unless USE_TOOLS_UNIFIED_DAG is the string true', () => {
  assert.equal(isUseToolsUnifiedDagEnabled({}), false);
  assert.equal(isUseToolsUnifiedDagEnabled({ USE_TOOLS_UNIFIED_DAG: 'false' }), false);
  assert.equal(isUseToolsUnifiedDagEnabled({ USE_TOOLS_UNIFIED_DAG: 'true' }), true);
});



test('hosted planner gives the semantic router only tenant-active providers', async () => {
  let parserInput = null;
  const result = await planHostedComposioWorkflow({
    request: 'Recall the handbag and prepare an email to Amar',
    orgId: 'org-1',
    apiKey: 'test-key',
    composio: {
      listConnectedAccounts: async () => [
        { toolkit: 'gmail', status: 'ACTIVE' },
        { toolkit: 'slack', status: 'EXPIRED' },
      ],
    },
    parseIntent: async (input) => {
      parserInput = input;
      return {
        decision: {
          operation: 'compound',
          subtasks: [
            { operation: 'recall', tool_groups: ['hivemind-recall'], message: 'Recall handbag' },
            { operation: 'resolve_amar', tool_groups: ['gmail'], depends_on: [0], message: 'Resolve Amar' },
          ],
        },
        usage: { total_tokens: 10 },
      };
    },
  });
  assert.deepEqual(parserInput.connectedProviders, ['gmail']);
  assert.equal(parserInput.useTools, true);
  assert.equal(result.execution.side_effects_executed, false);
  assert.equal(result.execution.writes_require_approval, true);
  assert.match(result.plan_id, /^hp_[a-f0-9]{24}$/);
});

test('hosted planner audits a one-step proposal and restores an omitted terminal action', async () => {
  const parserInputs = [];
  const result = await planHostedComposioWorkflow({
    request: 'Recall company information, then put it into a new document.',
    orgId: 'org-1',
    apiKey: 'test-key',
    composio: {
      listConnectedAccounts: async () => [{ toolkit: 'googledocs', status: 'ACTIVE' }],
    },
    parseIntent: async (input) => {
      parserInputs.push(input);
      if (parserInputs.length === 1) {
        return {
          decision: {
            operation: 'compound',
            subtasks: [{
              operation: 'recall', authority: 'read', output_kind: 'knowledge',
              tool_groups: ['hivemind-recall'], message: 'Recall company information',
            }],
          },
          usage: { total_tokens: 10 },
        };
      }
      return {
        decision: {
          operation: 'compound',
          subtasks: [
            {
              operation: 'recall', authority: 'read', output_kind: 'knowledge',
              tool_groups: ['hivemind-recall'], message: 'Recall company information',
            },
            {
              operation: 'create_doc', authority: 'write', output_kind: 'document',
              tool_groups: ['google-docs'], depends_on: [0], message: 'Create the requested document',
            },
          ],
        },
        usage: { total_tokens: 12 },
      };
    },
  });
  assert.equal(result.planner_attempts, 2);
  assert.deepEqual(result.steps.map((step) => step.operation), ['recall', 'create_doc']);
  assert.deepEqual(result.steps[1].depends_on, [0]);
  assert.match(parserInputs[1].history.at(-1).content, /every requested retrieval and terminal action/i);
});

test('audits a structurally complete plan and repairs a substituted connector action', async () => {
  const parserInputs = [];
  const result = await planHostedComposioWorkflow({
    request: 'Recall my company information and put it in a new Google Doc',
    orgId: 'org-1',
    composio: {
      listConnectedAccounts: async () => [
        { toolkit: 'gmail', status: 'ACTIVE' },
        { toolkit: 'googledocs', status: 'ACTIVE' },
      ],
    },
    parseIntent: async (input) => {
      parserInputs.push(input);
      const action = parserInputs.length === 1
        ? { operation: 'create_draft', output_kind: 'message', tool_groups: ['gmail'], message: 'Draft an email' }
        : { operation: 'create_doc', output_kind: 'document', tool_groups: ['google-docs'], message: 'Create the requested Google Doc' };
      return {
        decision: {
          operation: 'compound',
          subtasks: [
            { operation: 'recall', authority: 'read', output_kind: 'knowledge', tool_groups: ['hivemind-recall'], message: 'Recall company information' },
            { ...action, authority: 'write', depends_on: [0] },
          ],
        },
        usage: { total_tokens: parserInputs.length * 10 },
      };
    },
  });

  assert.equal(result.planner_attempts, 2);
  assert.equal(result.steps[1].tool_groups[0], 'google-docs');
  assert.equal(result.steps[1].output_kind, 'document');
  assert.match(parserInputs[1].history.at(-1).content, /never substitute/i);
});
