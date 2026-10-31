// A company that sees every connected-app event while Runtime is off: the classifier's rejection is recorded, not applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routingConfig } from '../../src/connectors/employee-event-routing.js';

test('the deliver-all list is read per company and ignores anything that is not a company id', () => {
  const config = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1', HIVEMIND_EMPLOYEE_EVENT_DELIVER_ALL_ORGS: '8DE2085E-45d4-452b-878e-37ffc751c193, nope' });
  assert.deepEqual([...config.deliverAllOrgs], ['8de2085e-45d4-452b-878e-37ffc751c193']);
  assert.equal(routingConfig({}).deliverAllOrgs.size, 0, 'empty by default');
});

test('only a Runtime-off company on the list has a rejection turned into a delivery', () => {
  const source = fs.readFileSync(new URL('../../src/connectors/composio/activity-relevance.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!runtimeOn && receipt\.status === 'rejected' && routing\.deliverAllOrgs\?\.has\(String\(ctx\.orgId\)\.toLowerCase\(\)\)\) \{\n\s*receipt = \{ \.\.\.receipt, status: 'approved', deliveredAll: true, classifierStatus: 'rejected' \};/);
});
