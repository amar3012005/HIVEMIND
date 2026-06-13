import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSyncConfig, safeParseSyncConfig, SyncConfigSchema } from '../../../../src/connectors/providers/gmail/schema.js';

test('empty config → defaults applied', () => {
  const c = parseSyncConfig({});
  assert.equal(c.date_range, '30d');
  assert.deepEqual(c.folders, ['INBOX', 'SENT']);
  assert.deepEqual(c.exclude_categories, []);
  assert.deepEqual(c.block_senders, []);
  assert.equal(c.max_emails, 500);
});

test('valid config passes through', () => {
  const c = parseSyncConfig({ date_range: '7d', exclude_categories: ['promotions'], max_emails: 100 });
  assert.equal(c.date_range, '7d');
  assert.deepEqual(c.exclude_categories, ['promotions']);
  assert.equal(c.max_emails, 100);
});

test('invalid date_range rejected', () => {
  assert.throws(() => parseSyncConfig({ date_range: '2y' }));
});

test('invalid category rejected', () => {
  assert.throws(() => parseSyncConfig({ exclude_categories: ['bogus'] }));
});

test('max_emails capped (>5000 rejected)', () => {
  assert.throws(() => parseSyncConfig({ max_emails: 99999 }));
});

test('safeParse returns success flag, never throws', () => {
  assert.equal(safeParseSyncConfig({ date_range: 'bad' }).success, false);
  assert.equal(safeParseSyncConfig({ date_range: '90d' }).success, true);
});

test('null/undefined → defaults via nullish coalesce', () => {
  assert.equal(parseSyncConfig(null).date_range, '30d');
  assert.equal(parseSyncConfig(undefined).max_emails, 500);
});

test('schema is exported for reuse', () => {
  assert.ok(SyncConfigSchema);
});
