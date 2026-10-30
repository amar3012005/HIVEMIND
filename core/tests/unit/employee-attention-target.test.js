import test from 'node:test';
import assert from 'node:assert/strict';
const { decideEmployeeTarget, employeeRole, loadEmployeeRoster, TARGET_THRESHOLDS } = await import('../../src/connectors/composio/employee-attention-target.js');
const { attentionSignal, attentionEvidence, attentionProviderRef, signalToolSlugs } = await import('../../src/connectors/attention-signal.js');

const roster = [
  { id: 'a1', name: 'Momo', role: 'GTM Partner Manager', recent: ['Partner intro deck for Acme'] },
  { id: 'b2', name: 'Turing', role: 'CTO and Head of AI', recent: [] },
];
const provider = result => ({ decideChoice: async ({ options, state, instructions }) => { provider.seen = { options, state, instructions }; return result; } });

test('the attention layer picks an employee from role and recent work, or none below the thresholds', async () => {
  const p = provider({ choice: 'employee:a1', probability: 0.82, margin: 0.4 });
  const target = await decideEmployeeTarget({ event: { app: 'gmail', title: 'Partner pilot' }, roster, provider: p });
  assert.deepEqual([target.employeeId, target.name], ['a1', 'Momo']);
  assert.match(target.because, /GTM Partner Manager/); assert.match(target.because, /Partner intro deck/);
  assert.equal(provider.seen.options.length, 3); assert.equal(provider.seen.options.at(-1).id, 'none');
  assert.match(provider.seen.options[0].criteria, /Momo, GTM Partner Manager\. Recently: Partner intro deck for Acme\./);
  assert.equal(provider.seen.state.source_is_untrusted, true);
  assert.equal(await decideEmployeeTarget({ event: {}, roster, provider: provider({ choice: 'none', probability: 0.9, margin: 0.5 }) }), null);
  assert.equal(await decideEmployeeTarget({ event: {}, roster, provider: provider({ choice: 'employee:a1', probability: TARGET_THRESHOLDS.probability - 0.01, margin: 0.5 }) }), null);
  assert.equal(await decideEmployeeTarget({ event: {}, roster, provider: provider({ choice: 'employee:zz', probability: 0.9, margin: 0.5 }) }), null, 'an unknown id is not routed');
  assert.equal(await decideEmployeeTarget({ event: {}, roster, provider: { decideChoice: async () => { throw new Error('down'); } } }), null);
  assert.equal(await decideEmployeeTarget({ event: {}, roster: [], provider: p }), null);
});

test('roles come from the archetype or the persona, recent work from operating memory', async () => {
  assert.equal(employeeRole({ role_archetype: 'CTO and Head of AI' }), 'CTO and Head of AI');
  assert.equal(employeeRole({ persona: '# Role\nGTM Partner Manager\n\n# Mission\n…' }), 'GTM Partner Manager');
  assert.equal(employeeRole({}), 'Specialist');
  const db = { $queryRawUnsafe: async sql => sql.includes('digital_employees') ? [{ id: 'a1', persona: '', role_archetype: 'GTM Partner Manager' }]
    : [{ agent_slug: 'employee-a1', title: 'Task closeout (completed): Partner intro deck' }] };
  const loaded = await loadEmployeeRoster(db, 'org', [{ id: 'a1', name: 'Momo', slug: 'employee-a1' }]);
  assert.deepEqual(loaded, [{ id: 'a1', name: 'Momo', role: 'GTM Partner Manager', recent: ['Partner intro deck'] }]);
});

test('the signal matches what Runtime builds: bounded evidence, allow-listed ids, toolkit-scoped tools', () => {
  const data = { subject: 'Hi', message_text: 'Body\nOn Mon, X wrote:\n> old', sender: 'a@b.c', message_id: 'm', secret_token: 'never', label_ids: ['INBOX'] };
  assert.deepEqual(attentionEvidence(data), { title: 'Hi', preview: 'Body\nOn Mon, X wrote:\n> old', currentMessage: 'Body', quotedMessage: 'On Mon, X wrote:\n> old' });
  assert.deepEqual(attentionProviderRef('gmail', data), { toolkit: 'gmail', sender: 'a@b.c', message_id: 'm' });
  assert.deepEqual(signalToolSlugs('slack'), []);
  const signal = attentionSignal({ toolkit: 'gmail', data, decision: { choice: 'useful_company_work', probability: 0.9 }, routedBecause: 'fits' });
  assert.equal(signal.assessment.need, 'useful_company_work'); assert.equal(signal.routedBecause, 'fits');
  assert.deepEqual(signal.signal, { app: 'gmail', from: 'a@b.c', subject: 'Hi', labels: ['INBOX'], excerptComplete: true });
  assert.doesNotMatch(JSON.stringify(signal), /never/, 'no unlisted payload field leaks');
});
