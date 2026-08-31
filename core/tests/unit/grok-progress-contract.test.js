import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Grok assignment progress persists heartbeats and immediate receipts', () => {
  const control = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const employees = fs.readFileSync(
    new URL('../../../employees-service/src/hivemind_employees/api_hyper_rooms.py', import.meta.url),
    'utf8',
  );
  const browser = fs.readFileSync(
    new URL('../../../employees-service/src/hivemind_employees/agents/agentscope_tools.py', import.meta.url),
    'utf8',
  );

  assert.match(control, /agent_assignment_heartbeat/);
  assert.match(control, /last_heartbeat_at=now\(\)/);
  assert.match(employees, /HYPER_GROK_HEARTBEAT_SECONDS/);
  assert.match(employees, /receipt_callback=_persist_live_receipt/);
  assert.match(employees, /HYPER_GROK_INLINE_DELEGATION_ENABLED/);
  assert.match(browser, /await receipt_callback\(dict\(receipt\)\)/);
});
