// A note-to-self or forward from the connected mailbox (Gmail label SENT) has no Authentication-Results header; its sender is the
// mailbox owner. Live 31 Oct 2026: such a forward with an @mention was skipped as unverified_sender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventFacts, routingConfig } from '../../src/connectors/employee-event-routing.js';

const data = (labels) => ({ sender: 'AMAR SAI GADDE <support@singulancelabs.com>', to: 'support@singulancelabs.com', subject: 'Fwd: final call',
  message_text: '@QA ns-B please check the deadline', message_id: 'm1', label_ids: labels });

test('a SENT-labelled Gmail message from the mailbox counts as verified; without the label it does not', () => {
  const config = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1' });
  assert.equal(eventFacts('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', data(['SENT', 'INBOX']), config).senderEmailVerified, true);
  assert.equal(eventFacts('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', data(['INBOX']), config).senderEmailVerified, false);
});
