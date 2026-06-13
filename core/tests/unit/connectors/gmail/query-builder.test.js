import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailQuery, DEFAULT_BLOCK_SENDERS } from '../../../../src/connectors/providers/gmail/query-builder.js';

// The default sender blocklist is ALWAYS appended (legacy parity). To isolate
// other clauses, disable it. q() = build with defaults off + chats off.
const q = (cfg, opts) => buildGmailQuery({ exclude_chats: false, disable_default_blocklist: true, ...cfg }, opts);

test('null/undefined config → empty query', () => {
  assert.equal(buildGmailQuery(null), '');
  assert.equal(buildGmailQuery(undefined), '');
});

test('{} → exclude_chats default ON + default blocklist (legacy parity)', () => {
  const out = buildGmailQuery({});
  assert.match(out, /^-in:chats /);
  assert.match(out, /-from:substack\.com/);
});

test('exclude_categories → -category:c (only valid facets)', () => {
  assert.equal(q({ exclude_categories: ['promotions', 'social', 'bogus'] }), '-category:promotions -category:social');
});

test('date_range → after:YYYY/MM/DD zero-padded UTC', () => {
  assert.match(q({ date_range: '30d' }), /^after:\d{4}\/\d{2}\/\d{2}$/);
});

test("date_range 'all' → no after clause", () => {
  assert.equal(q({ date_range: 'all' }), '');
});

test('exclude_chats default ON unless explicitly false', () => {
  assert.equal(buildGmailQuery({ date_range: 'all', disable_default_blocklist: true }), '-in:chats');
  assert.equal(q({ date_range: 'all' }), '');
});

test('include_only_sent → in:sent', () => {
  assert.equal(q({ include_only_sent: true }), 'in:sent');
});

test('keywords: phrases quoted, bare words not (AND/NOT)', () => {
  assert.equal(
    q({ include_keywords: ['invoice', 'wire transfer'], exclude_keywords: ['spam', 'cold outreach'] }),
    'invoice "wire transfer" -spam -"cold outreach"',
  );
});

test('default blocklist applied; *@domain collapses to -from:domain', () => {
  const out = buildGmailQuery({ date_range: 'all', exclude_chats: false });
  assert.match(out, /-from:noreply@\*/);   // exact non-wildcard kept verbatim
  assert.match(out, /-from:substack\.com/); // *@substack.com → -from:substack.com
});

test('disable_default_blocklist skips defaults, keeps user blocks', () => {
  assert.equal(q({ date_range: 'all', block_senders: ['evil@x.com'] }), '-from:evil@x.com');
});

test('includeFolders opt-in → (in:a OR in:b); off by default (adapter path)', () => {
  const cfg = { folders: ['INBOX', 'SENT'], date_range: 'all' };
  assert.equal(q(cfg), '');
  assert.equal(q(cfg, { includeFolders: true }), '(in:inbox OR in:sent)');
});

test("folders=['ALL'] → no folder clause even with includeFolders", () => {
  assert.equal(q({ folders: ['ALL'], date_range: 'all' }, { includeFolders: true }), '');
});

test('include_only_with_attachments → has:attachment', () => {
  assert.equal(q({ include_only_with_attachments: true }), 'has:attachment');
});

test('DEFAULT_BLOCK_SENDERS non-empty', () => {
  assert.ok(Array.isArray(DEFAULT_BLOCK_SENDERS) && DEFAULT_BLOCK_SENDERS.length > 5);
});
