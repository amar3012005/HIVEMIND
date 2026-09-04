import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  destinationAppsForEnableTools,
  enableToolsRequest,
} from '../../src/agent/chat-enable-tools-gate.js';

test('company question does not require connector tools', () => {
  assert.deepEqual(destinationAppsForEnableTools('what do we know about the company?'), []);
  assert.deepEqual(destinationAppsForEnableTools('who am I and what is our mission'), []);
  assert.deepEqual(destinationAppsForEnableTools('go through the HIVEMIND git repo'), []);
});

test('send to a named person implies Gmail', () => {
  assert.deepEqual(
    destinationAppsForEnableTools('send rama, about information about the company'),
    ['gmail'],
  );
});

test('named Instagram or Slack is detected', () => {
  assert.ok(destinationAppsForEnableTools('send rama a message on instagram about the company').includes('instagram'));
  assert.ok(destinationAppsForEnableTools('post a summary to slack').includes('slack'));
});

test('LinkedIn read questions still require enabling tools', () => {
  assert.ok(destinationAppsForEnableTools('what was my last linkedin post about?').includes('linkedin'));
  assert.ok(destinationAppsForEnableTools('what do u think about my last linkedin post').includes('linkedin'));
});

test('enable_tools request is HITL with enable and decline', () => {
  const request = enableToolsRequest(['gmail', 'instagram']);
  assert.equal(request.kind, 'enable_tools');
  assert.equal(request.blocking, true);
  assert.deepEqual(request.toolkits, ['gmail', 'instagram']);
  assert.match(request.prompt, /Gmail/);
  assert.deepEqual(request.options.map((option) => option.id), ['enable', 'decline']);
});
