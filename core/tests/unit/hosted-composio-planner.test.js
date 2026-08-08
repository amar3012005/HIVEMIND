import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectedProvidersFromAccounts,
  decisionToHostedPlan,
  planHostedComposioWorkflow,
} from '../../src/agent/hosted-composio-planner.js';

test('connected provider discovery uses active tenant accounts only', () => {
  assert.deepEqual(connectedProvidersFromAccounts([
    { toolkit: 'gmail', status: 'ACTIVE' },
    { toolkit: 'googlecalendar', status: 'ACTIVE' },
    { toolkit: 'slack', status: 'EXPIRED' },
    { toolkit: 'gmail', status: 'ACTIVE' },
    { toolkit: 'unmapped', status: 'ACTIVE' },
  ]), ['gmail', 'google-calendar']);
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

test('hosted plan fails closed when the planner selects an unavailable connector', () => {
  assert.throws(() => decisionToHostedPlan({
    operation: 'compound',
    subtasks: [{ operation: 'post', tool_groups: ['slack'], message: 'Post it' }],
  }, { request: 'Post it', connectedProviders: ['gmail'] }), /planner_selected_unavailable_tool_group:slack/);
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
