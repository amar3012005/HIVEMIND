import test from 'node:test';
import assert from 'node:assert/strict';
import { actionableToolkitRows } from '../../src/connectors/composio/actionable-connections.js';

const org = 'org-1';
const reconnect = (toolkit) => ({ toolkit, status: 'reconnect', origin: null, accountId: null });

test('expired workspace-subject accounts list as available, not reconnect', () => {
  const rows = new Map([['hubspot', reconnect('hubspot')], ['salesforce', reconnect('salesforce')]]);
  const accounts = [
    { toolkit: 'hubspot', status: 'EXPIRED', subject: org },
    { toolkit: 'salesforce', status: 'FAILED', subject: org },
  ];
  assert.equal(actionableToolkitRows(org, accounts, rows).size, 0);
});

test('an expired account on this person subject keeps reconnect', () => {
  const rows = new Map([['github', reconnect('github')]]);
  const accounts = [{ toolkit: 'github', status: 'EXPIRED', subject: 'hivemind:user-1' }];
  assert.equal(actionableToolkitRows(org, accounts, rows).get('github').status, 'reconnect');
});

test('connected rows are untouched', () => {
  const connected = { toolkit: 'gmail', status: 'connected', origin: 'personal', accountId: 'ca_1' };
  const out = actionableToolkitRows(org, [], new Map([['gmail', connected]]));
  assert.equal(out.get('gmail'), connected);
});
