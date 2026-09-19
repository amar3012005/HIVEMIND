import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyHqResponseDepth, resolveHqTurnRoute } from '../../src/hyper/hq-turn-routing.js';

test('HQ keeps explicit employee mentions local regardless of work keywords', () => {
  const route = resolveHqTurnRoute('@priya give me a plan for social media for the next 2 weeks');
  assert.deepEqual(route, { kind: 'content', responseDepth: 'direct', dispatch: false });
});

test('HQ keeps conversational and advisory questions local as direct lead answers', () => {
  assert.equal(classifyHqResponseDepth('hello'), 'direct');
  assert.deepEqual(resolveHqTurnRoute('What do you think about our social strategy?'), {
    kind: 'content', responseDepth: 'direct', dispatch: false,
  });
});

test('HQ dispatches only bounded focused or operating work', () => {
  assert.deepEqual(resolveHqTurnRoute('Create a two-week social media plan'), {
    kind: 'content', responseDepth: 'focused', dispatch: true,
  });
  assert.deepEqual(resolveHqTurnRoute('Launch a complete multi-channel campaign'), {
    kind: 'outreach', responseDepth: 'operating', dispatch: true,
  });
});

