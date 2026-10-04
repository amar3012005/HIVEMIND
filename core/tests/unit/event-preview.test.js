import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedEventPreview } from '../../src/connectors/composio/event-preview.js';
test('Gmail object preview falls through to plain message_text', () => {
  assert.equal(connectedEventPreview({ preview: { body: 'short' }, message_text: 'Real plain text' }, 900), 'Real plain text');
});
test('existing string preview remains preferred and bounded', () => {
  assert.equal(connectedEventPreview({ preview: '  preview\ntext ', message_text: 'body' }, 7), 'preview');
});
test('known object-preview body is a safe fallback without arbitrary serialization', () => {
  assert.equal(connectedEventPreview({ preview: { body: 'body text', credentials: 'secret' } }, 900), 'body text');
  assert.equal(connectedEventPreview({ preview: { nested: { text: 'secret' } }, message_text: {}, text: 5, body: [] }, 900), '');
});
