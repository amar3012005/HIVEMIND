// A Composio payload whose optional top-level field changed type is kept without that field; any other mismatch still fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { withoutMistypedOptionalFields } from '../../src/connectors/composio/hivemind-triggers.js';

const schema = { type: 'object', required: ['message_id'], properties: {
  message_id: { type: 'string' }, cc: { type: 'string' }, attachment_list: { type: 'array' }, payload: { type: 'object', properties: { size: { type: 'number' } } } } };
const check = new Ajv({ strict: false, allErrors: true }).compile(schema);

test('an optional field of the wrong type is dropped and the rest kept', () => {
  const data = { message_id: 'm1', cc: null, attachment_list: [], subject: 'Hello' };
  assert.equal(check(data), false);
  const repaired = withoutMistypedOptionalFields(data, schema, check.errors);
  assert.deepEqual(repaired, { message_id: 'm1', attachment_list: [], subject: 'Hello' });
  assert.equal(check(repaired), true);
});

test('a required field of the wrong type or a missing required field still fails', () => {
  const wrongRequired = { message_id: 42 };
  assert.equal(check(wrongRequired), false);
  assert.equal(withoutMistypedOptionalFields(wrongRequired, schema, check.errors), null);
  const missing = { cc: 'a@b.c' };
  assert.equal(check(missing), false);
  assert.equal(withoutMistypedOptionalFields(missing, schema, check.errors), null);
});

test('a nested optional field drops its whole top-level field', () => {
  const data = { message_id: 'm2', payload: { size: 'big' } };
  assert.equal(check(data), false);
  assert.deepEqual(withoutMistypedOptionalFields(data, schema, check.errors), { message_id: 'm2' });
});
