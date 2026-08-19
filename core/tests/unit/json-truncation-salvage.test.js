import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _salvageArrayObjects,
  parseJsonCompletion,
  TruncatedJsonCompletionError,
} from '../../src/knowledge/enterprise/litellm-client.js';

test('recovers all complete objects from a truncated facts array (finish=length)', () => {
  // Response cut off mid-third-object — the first two fully serialized.
  const truncated = '{"facts":[{"t":"a","f":"first fact"},{"t":"b","f":"second fact"},{"t":"c","f":"third fact that got cut o';
  const got = _salvageArrayObjects(truncated);
  assert.equal(got.length, 2);
  assert.equal(got[0].f, 'first fact');
  assert.equal(got[1].t, 'b');
});

test('braces/brackets inside string values do not miscount', () => {
  const s = '{"facts":[{"t":"x","f":"uses {curly} and [square] and a quote \\" inside"},{"t":"y","f":"ok"}, {"t":"z","f":"tru';
  const got = _salvageArrayObjects(s);
  assert.equal(got.length, 2);
  assert.equal(got[0].f, 'uses {curly} and [square] and a quote " inside');
  assert.equal(got[1].t, 'y');
});

test('complete array returns every object', () => {
  const s = '{"facts":[{"t":"a","f":"1"},{"t":"b","f":"2"},{"t":"c","f":"3"}]}';
  assert.equal(_salvageArrayObjects(s).length, 3);
});

test('no complete object yields empty (single truncated object)', () => {
  assert.deepEqual(_salvageArrayObjects('{"facts":[{"t":"only","f":"never clos'), []);
});

test('empty / non-object input is safe', () => {
  assert.deepEqual(_salvageArrayObjects(''), []);
  assert.deepEqual(_salvageArrayObjects('not json at all'), []);
});

test('provider-confirmed truncation is not accepted as a complete extraction', () => {
  const truncated = '{"facts":[{"t":"a","f":"first fact"},{"t":"b","f":"cut';
  assert.throws(
    () => parseJsonCompletion(truncated, 'length', { rejectTruncated: true }),
    (error) => {
      assert.ok(error instanceof TruncatedJsonCompletionError);
      assert.equal(error.code, 'LLM_JSON_TRUNCATED');
      assert.equal(error.partial.facts.length, 1);
      return true;
    },
  );
});

test('normal complete JSON remains a one-pass success', () => {
  const value = parseJsonCompletion('{"facts":[{"t":"a","f":"complete"}]}', 'stop', {
    rejectTruncated: true,
  });
  assert.equal(value.facts.length, 1);
});
