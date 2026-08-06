import test from 'node:test';
import assert from 'node:assert/strict';
import { documentAllowed } from '../../src/vector/mneme/doc-access.mjs';

const ORG = 'org-1';
const USER = 'user-1';
const OTHER = 'user-2';
const doc = (over = {}) => ({ userId: null, tags: [], deleted: false, ...over });

test('denies when the caller has no identity', () => {
  // SQL equivalent: conds.push('FALSE'). An unauthenticated caller must see nothing, and this is
  // the branch where a "default open" mistake would expose every document in the org.
  assert.equal(documentAllowed(doc({ userId: USER }), ORG, {}), false);
  assert.equal(documentAllowed(doc({ tags: [`scope-key:org:${ORG}`] }), ORG, { userId: null }), false);
});

test('denies deleted documents regardless of grant', () => {
  const d = doc({ userId: USER, tags: [`scope-key:org:${ORG}`], deleted: true });
  assert.equal(documentAllowed(d, ORG, { userId: USER }), false);
});

test('owner sees their own document with no tags at all', () => {
  assert.equal(documentAllowed(doc({ userId: USER }), ORG, { userId: USER }), true);
  assert.equal(documentAllowed(doc({ userId: OTHER }), ORG, { userId: USER }), false);
});

test('unscoped: any single grant suffices, and the legacy org tag still counts', () => {
  const a = { userId: USER };
  assert.equal(documentAllowed(doc({ tags: [`scope-key:org:${ORG}`] }), ORG, a), true);
  assert.equal(documentAllowed(doc({ tags: ['scope-key:organization'] }), ORG, a), true);
  assert.equal(documentAllowed(doc({ tags: [`scope-key:personal:${USER}`] }), ORG, a), true);
  // Another org's grant must never satisfy this org.
  assert.equal(documentAllowed(doc({ tags: ['scope-key:org:org-2'] }), ORG, a), false);
  // Another user's personal grant must not leak.
  assert.equal(documentAllowed(doc({ tags: [`scope-key:personal:${OTHER}`] }), ORG, a), false);
});

test('unscoped: project and team grants only apply when the caller carries them', () => {
  const tagged = doc({ tags: ['scope-key:project:p1', 'scope-key:team:t1'] });
  assert.equal(documentAllowed(tagged, ORG, { userId: USER }), false, 'no project/team context → no grant');
  assert.equal(documentAllowed(tagged, ORG, { userId: USER, projectId: 'p1' }), true);
  assert.equal(documentAllowed(tagged, ORG, { userId: USER, accessContext: { teamIds: ['t1'] } }), true);
  assert.equal(documentAllowed(tagged, ORG, { userId: USER, projectId: 'p9' }), false);
});

test('scopeFilter=organization ignores ownership — only the org grants count', () => {
  const a = { userId: USER, scopeFilter: 'organization' };
  assert.equal(documentAllowed(doc({ tags: [`scope-key:org:${ORG}`] }), ORG, a), true);
  assert.equal(documentAllowed(doc({ tags: ['scope-key:organization'] }), ORG, a), true);
  // Owning the document does NOT make it organization-scoped.
  assert.equal(documentAllowed(doc({ userId: USER }), ORG, a), false);
});

test('scopeFilter=project/team deny outright when the caller has no such ids', () => {
  // SQL equivalent: conds.push('FALSE') before any tag comparison.
  assert.equal(documentAllowed(doc({ tags: ['scope-key:project:p1'] }), ORG, { userId: USER, scopeFilter: 'project' }), false);
  assert.equal(documentAllowed(doc({ tags: ['scope-key:team:t1'] }), ORG, { userId: USER, scopeFilter: 'team' }), false);
});

test('scopeFilter=personal accepts ownership or the personal grant, nothing else', () => {
  const a = { userId: USER, scopeFilter: 'personal' };
  assert.equal(documentAllowed(doc({ userId: USER }), ORG, a), true);
  assert.equal(documentAllowed(doc({ tags: [`scope-key:personal:${USER}`] }), ORG, a), true);
  assert.equal(documentAllowed(doc({ tags: [`scope-key:org:${ORG}`] }), ORG, a), false);
});

test('malformed tag payloads fail closed instead of throwing', () => {
  const a = { userId: USER };
  assert.equal(documentAllowed(doc({ tags: null }), ORG, a), false);
  assert.equal(documentAllowed(doc({ tags: 'scope-key:organization' }), ORG, a), false, 'a bare string is not a tag list');
  assert.equal(documentAllowed(doc({ tags: [null, 42, {}] }), ORG, a), false);
  assert.equal(documentAllowed(null, ORG, a), false);
});
