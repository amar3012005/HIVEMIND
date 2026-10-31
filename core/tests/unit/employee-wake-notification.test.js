import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyEmployeeWake, toolkitLabel } from '../../src/connectors/employee-wake-notification.js';
import { fakeNotifyDb } from './fake-notify-db.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const TURING = '44444444-4444-4444-8444-444444444444';
const wake = { orgId: ORG, employeeId: TURING, fallbackUserId: ACCOUNT, toolkit: 'gmail', title: 'Invoice 42', count: 1, reason: 'mention', wakeId: 'wk_abc' };

test('the employee wake notification carries the app, the employee, the reason and a link to that employee\'s chat', async () => {
  const { db, rows } = fakeNotifyDb();
  await notifyEmployeeWake(db, wake);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row.orgId, row.userId, row.type, row.title, row.resourceType, row.resourceId], [ORG, OWNER, 'employee.wake', 'Gmail → Turing', 'employee', TURING]);
  assert.equal(row.body, '“Invoice 42” — mentioned them');
  assert.equal(row.dedupeKey, 'employee-wake:wk_abc');
  assert.deepEqual(row.data, { employeeId: TURING, wakeId: 'wk_abc', toolkit: 'gmail', reason: 'mention', eventCount: 1, icon: 'gmail', href: `/hivemind/app/employee/dots/employee/${TURING}` });
});

test('a merged burst is one notification that counts its events; other apps carry no Gmail mark', async () => {
  const { db, rows } = fakeNotifyDb();
  await notifyEmployeeWake(db, { ...wake, toolkit: 'github', count: 3, reason: 'watch' });
  assert.equal(rows[0].title, 'GitHub → Turing: 3 events');
  assert.equal(rows[0].body, '3 events “Invoice 42” — matches their watch');
  assert.equal('icon' in rows[0].data, false);
});

test('a retried delivery leaves the existing notification as it is: no duplicate, still read, same time', async () => {
  const { db, rows } = fakeNotifyDb();
  await notifyEmployeeWake(db, wake);
  Object.assign(rows[0], { readAt: new Date(5000), createdAt: new Date(2000) });
  await notifyEmployeeWake(db, { ...wake, title: 'changed' });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].readAt, rows[0].createdAt, rows[0].body], [new Date(5000), new Date(2000), '“Invoice 42” — mentioned them']);
  await notifyEmployeeWake(db, { ...wake, wakeId: 'wk_other' });
  assert.equal(rows.length, 2, 'a different wake is a different notification');
});

test('an employee without an owner notifies the account owner; the recipient must be an active member of the same company', async () => {
  const ownerless = [{ id: TURING, orgId: ORG, name: 'Turing', createdBy: null, archivedAt: null }];
  const { db, rows } = fakeNotifyDb({ employees: ownerless });
  await notifyEmployeeWake(db, wake);
  assert.equal(rows[0].userId, ACCOUNT);
  const outsider = fakeNotifyDb({ members: [[OWNER, OTHER_ORG]] });
  assert.equal(await notifyEmployeeWake(outsider.db, wake), null, 'a user of another company is never notified');
  assert.equal(outsider.rows.length, 0);
});

test('an employee of another company, an archived one or a missing id notifies nobody; a failing store never throws', async () => {
  const { db, rows } = fakeNotifyDb({ employees: [{ id: TURING, orgId: OTHER_ORG, name: 'Turing', createdBy: OWNER, archivedAt: null }] });
  assert.equal(await notifyEmployeeWake(db, wake), null);
  const archived = fakeNotifyDb({ employees: [{ id: TURING, orgId: ORG, name: 'Turing', createdBy: OWNER, archivedAt: new Date() }] });
  assert.equal(await notifyEmployeeWake(archived.db, wake), null);
  assert.equal(await notifyEmployeeWake(db, { ...wake, employeeId: '>opendot' }), null);
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await notifyEmployeeWake({ ...db, digitalEmployee: { findFirst: async () => { throw new Error('db down'); } } }, wake), null); } finally { console.warn = warn; }
  assert.equal(rows.length + archived.rows.length, 0);
});

test('toolkitLabel uses the catalog name, else the slug in words', () => {
  assert.deepEqual(['gmail', 'google_calendar', 'slack', ''].map(toolkitLabel), ['Gmail', 'Google calendar', 'Slack', 'App']);
});
