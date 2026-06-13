import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThread, getHeader, getThreadLabels } from '../../../../src/connectors/providers/gmail/normalizer.js';

// Build a minimal Gmail message with plain-text body.
function msg({ id, from, to, subject, date, text, labels = ['INBOX'] }) {
  const b64 = Buffer.from(text, 'utf-8').toString('base64url');
  return {
    id,
    labelIds: labels,
    snippet: text.slice(0, 50),
    payload: {
      headers: [
        from && { name: 'From', value: from },
        to && { name: 'To', value: to },
        subject && { name: 'Subject', value: subject },
        date && { name: 'Date', value: date },
      ].filter(Boolean),
      parts: [{ mimeType: 'text/plain', body: { data: b64 } }],
    },
  };
}

const CTX = { user_id: 'u1', org_id: 'o1', user_account_ref: 'me@acme.com' };
const LONG = 'This is a sufficiently long email body that clears the 50-char low-signal quality gate easily.';

test('thread mode (default) → ONE consolidated payload', () => {
  const thread = {
    id: 'T1',
    messages: [
      msg({ id: 'm1', from: 'alice@x.com', to: 'me@acme.com', subject: 'Hi', date: 'Tue, 26 May 2026 10:00:00 +0000', text: LONG }),
      msg({ id: 'm2', from: 'me@acme.com', to: 'alice@x.com', subject: 'Re: Hi', date: 'Tue, 26 May 2026 11:00:00 +0000', text: LONG }),
    ],
  };
  const out = normalizeThread(thread, CTX, { defaultTags: ['gmail'] });
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.source_metadata.source_id, 'gmail:thread:T1');
  assert.equal(p.memory_type, 'event');
  assert.equal(p.metadata.type, 'gmail_thread');
  assert.equal(p.metadata.message_count, 2);
  assert.ok(p.tags.includes('gmail-thread'));
  assert.ok(p.tags.includes('gmail_thread'));
  assert.ok(p.metadata.force_entity_linking);
  // document_date = LAST message date (most recent) for chronological ordering
  assert.equal(p.document_date, new Date('Tue, 26 May 2026 11:00:00 +0000').toISOString());
});

test('document_date from email Date header, not ingest time', () => {
  const thread = { id: 'T2', messages: [msg({ id: 'm1', from: 'a@x.com', to: 'me@acme.com', subject: 'S', date: 'Mon, 01 Jan 2024 00:00:00 +0000', text: LONG })] };
  const [p] = normalizeThread(thread, CTX, { defaultTags: ['gmail'] });
  assert.equal(p.document_date, '2024-01-01T00:00:00.000Z');
});

test('low-signal inbound skipped; same body sent-by-user kept', () => {
  // 31 chars: clears the <20 empty-body noise gate, but trips the <50
  // low-signal gate — which sent-by-user bypasses (records the relationship).
  const short = 'Thanks, will review this today.';
  const inbound = { id: 'T3', messages: [msg({ id: 'm1', from: 'a@x.com', to: 'me@acme.com', subject: 'S', date: 'Tue, 26 May 2026 10:00:00 +0000', text: short })] };
  assert.equal(normalizeThread(inbound, CTX, { defaultTags: ['gmail'] }).length, 0);

  const outbound = { id: 'T4', messages: [msg({ id: 'm1', from: 'me@acme.com', to: 'a@x.com', subject: 'S', date: 'Tue, 26 May 2026 10:00:00 +0000', text: short })] };
  assert.equal(normalizeThread(outbound, CTX, { defaultTags: ['gmail'] }).length, 1);
});

test('newsletter inbound skipped by default; sent-by-user newsletter-ish kept', () => {
  const news = `Subscribe to our newsletter! unsubscribe here. ${LONG}`;
  const inbound = { id: 'T5', messages: [msg({ id: 'm1', from: 'noreply@news.com', to: 'me@acme.com', subject: 'Promo', date: 'Tue, 26 May 2026 10:00:00 +0000', text: news })] };
  assert.equal(normalizeThread(inbound, CTX, { defaultTags: ['gmail'] }).length, 0);

  const sent = { id: 'T6', messages: [msg({ id: 'm1', from: 'me@acme.com', to: 'a@x.com', subject: 'About the newsletter', date: 'Tue, 26 May 2026 10:00:00 +0000', text: news })] };
  assert.equal(normalizeThread(sent, CTX, { defaultTags: ['gmail'] }).length, 1);
});

test('org scope skips purely-internal personal outgoing mail', () => {
  const ctxOrg = { ...CTX, target_scope: 'organization' };
  const internal = { id: 'T7', messages: [msg({ id: 'm1', from: 'me@acme.com', to: 'colleague@acme.com', subject: 'lunch', date: 'Tue, 26 May 2026 10:00:00 +0000', text: LONG })] };
  assert.equal(normalizeThread(internal, ctxOrg, { defaultTags: ['gmail'] }).length, 0);

  const external = { id: 'T8', messages: [msg({ id: 'm1', from: 'me@acme.com', to: 'client@other.com', subject: 'deal', date: 'Tue, 26 May 2026 10:00:00 +0000', text: LONG })] };
  assert.equal(normalizeThread(external, ctxOrg, { defaultTags: ['gmail'] }).length, 1);
});

test('per-message mode → one payload per message + Extends on replies', () => {
  const ctxPM = { ...CTX, gmail_thread_mode: 'per-message' };
  const thread = {
    id: 'T9',
    messages: [
      msg({ id: 'm1', from: 'a@x.com', to: 'me@acme.com', subject: 'Hi', date: 'Tue, 26 May 2026 10:00:00 +0000', text: LONG }),
      msg({ id: 'm2', from: 'me@acme.com', to: 'a@x.com', subject: 'Re: Hi', date: 'Tue, 26 May 2026 11:00:00 +0000', text: LONG }),
    ],
  };
  const out = normalizeThread(thread, ctxPM, { defaultTags: ['gmail'] });
  assert.equal(out.length, 2);
  assert.equal(out[0].source_metadata.source_id, 'm1');
  assert.equal(out[1].relationship?.type, 'Extends');
});

test('empty thread → no payloads', () => {
  assert.deepEqual(normalizeThread({ id: 'T0', messages: [] }, CTX, {}), []);
});

test('helpers: getHeader case-insensitive, getThreadLabels strips CATEGORY_/inbox', () => {
  const m = msg({ id: 'm', from: 'a@x.com', subject: 'Z', text: 'x', labels: ['INBOX', 'CATEGORY_PROMOTIONS', 'IMPORTANT'] });
  assert.equal(getHeader(m, 'from'), 'a@x.com');
  const labels = getThreadLabels([m]);
  assert.ok(labels.includes('promotions'));
  assert.ok(labels.includes('important'));
  assert.ok(!labels.includes('inbox'));
});
