import test from 'node:test';
import assert from 'node:assert/strict';
import { redactParsedDocument, redactSecrets } from '../src/knowledge/content-secret-redaction.js';

test('redacts labelled credentials and authenticated URLs while preserving useful identity', () => {
  const input = [
    'Contact marketing@solvis.de',
    'Accountname: marketing@solvis.de PW: Jg&BoKnteBnA(KWKddm%$um@',
    'Open https://solvis:KZWEJ5GO8Fia4cJL8MVLaRElClBkk5@staging.solvis.de/soladmin',
  ].join('\n');
  const out = redactSecrets(input);
  assert.equal(out.redacted, true);
  assert.match(out.text, /marketing@solvis\.de/);
  assert.doesNotMatch(out.text, /Jg&BoKnte/);
  assert.doesNotMatch(out.text, /KZWEJ5GO/);
  assert.match(out.text, /https:\/\/\[REDACTED_SECRET\]@staging\.solvis\.de\/soladmin/);
});

test('redacts nested parser outputs before any downstream consumer can persist them', () => {
  const out = redactParsedDocument({
    text: 'API key: sk-abcdefghijklmnopqrstuvwxyz123456',
    markdown: 'Password = hunter2-long',
    metadata: { hybridChunks: [{ text: 'Authorization: Bearer abcdefghijklmnop' }] },
    tables: [{ rows: [['client_secret: secret-value']] }],
  });
  assert.doesNotMatch(JSON.stringify(out), /hunter2|abcdefghijklmnopqrstuvwxyz|abcdefghijklmnop|secret-value/);
  assert.equal(out.metadata.secret_redaction.applied, true);
  assert.equal(out.metadata.secret_redaction.total, 4);
});

test('does not alter ordinary prose, names, dates, or email addresses', () => {
  const input = 'Eric wrote on 19.01.2026. Contact amar@example.com about the Solvis roadmap.';
  const out = redactSecrets(input);
  assert.equal(out.text, input);
  assert.equal(out.redacted, false);
});
