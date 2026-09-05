import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { editProgressiveDraft, progressiveDraftArguments } from '../../src/agent/progressive-draft-contract.js';

const draft = () => ({ provider: 'composio', toolName: 'NOTION_CREATE_PAGE', toolArgs: {
  _harness_version: 'progressive-v1', _composio_slug: 'NOTION_CREATE_PAGE',
  _input_schema: { type: 'object', additionalProperties: false, required: ['title'], properties: {
    title: { type: 'string', minLength: 1 }, visible: { type: 'boolean' }, count: { type: 'integer' },
  } }, title: 'Plan', visible: false, count: 1,
} });

test('generic edits preserve types and schema without email defaults', () => {
  const row = draft();
  const edited = editProgressiveDraft(row, { title: 'Projekt', count: 2, visible: true });
  assert.equal(edited.title, 'Projekt');
  assert.equal(edited._input_schema, row.toolArgs._input_schema);
  assert.deepEqual(progressiveDraftArguments({ ...row, toolArgs: edited }), { title: 'Projekt', visible: true, count: 2 });
});

test('client cannot change tool, schema, tenant authority or undeclared fields', () => {
  for (const key of ['_composio_slug', '_input_schema', '_harness_version', 'org_id', 'from_email', 'constructor']) {
    assert.throws(() => editProgressiveDraft(draft(), { [key]: 'forged' }), /not_editable/);
  }
});

test('invalid values cannot be saved or approved', () => {
  for (const update of [{ title: '' }, { title: null }, { count: '2' }]) {
    assert.throws(() => editProgressiveDraft(draft(), update), /match_schema/);
  }
  const row = draft();
  row.toolArgs.count = '2';
  assert.throws(() => progressiveDraftArguments(row), /match_schema/);
});

test('approval route binds argument version and projects canonical receipts', () => {
  const server = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /progressiveArgs \? \{ argsHash: row\.argsHash \}/);
  assert.match(server, /if \(!progressiveArgs && !args\.from_email/);
  assert.match(server, /await projectProgressiveApproval\(prisma, final\)/);
  assert.match(server, /where: \{ userId, orgId, \.\.\.\(statusFilter/);
  assert.match(server, /if \(progressiveArgs && !final\)/);
});
