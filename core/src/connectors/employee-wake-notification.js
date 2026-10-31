/**
 * The bell notification for an employee wake: the same workspace notification row Runtime's attention verdict creates, so the person
 * sees which connected app woke which employee and can open that employee's chat. Created by Core where the outcome is known, after
 * OpenDot admitted the wake (forwarded events: the `route-event` receipt; Core-routed events: the delivered wake).
 */
import { createWorkspaceNotification } from '../workspace/notifications.js';
import { CONNECTOR_BY_ID } from './catalog.js';

const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why an employee woke, in the words of the bell. Unknown reasons say nothing rather than guess. */
const WHY = Object.freeze({
  mention: 'mentioned them',
  watch: 'matches their watch',
  'mention+watch': 'mentioned them and matches their watch',
  attention: 'fits their role',
});

/**
 * Display name of a connected app: the catalog name, else the slug in words.
 * @param {string} toolkit Toolkit slug.
 * @returns {string} Display name.
 */
export function toolkitLabel(toolkit) {
  const slug = clip(toolkit, 60).toLowerCase();
  if (!slug) return 'App';
  const known = CONNECTOR_BY_ID[slug]?.name;
  if (known) return known;
  const words = slug.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Creates the one notification for one admitted employee wake. Best effort: the wake has already happened, so a failure here is
 * logged and never fails or repeats the delivery. The notification goes to the employee's owner (the account owner when the
 * employee has none), only while that person is an active member of the same organization, and the employee is looked up inside
 * that organization, so a notification never reaches another company's users. The wake id is the idempotency key and an existing
 * notification is left untouched, so a retried delivery neither duplicates it nor marks it unread again.
 * @param {object} db Prisma client.
 * @param {{orgId:string,employeeId:string,fallbackUserId?:string,toolkit:string,title?:string,count?:number,reason?:string,wakeId:string}} wake The admitted wake: `count` is the number of events merged into it, `reason` is mention, watch, mention+watch or attention.
 * @returns {Promise<object|null>} The notification, or null when none was created.
 */
export async function notifyEmployeeWake(db, wake) {
  try {
    if (!db?.workspaceNotification || !UUID.test(String(wake?.employeeId)) || !wake.orgId || !wake.wakeId) return null;
    const employee = await db.digitalEmployee.findFirst({ where: { id: wake.employeeId, orgId: wake.orgId, archivedAt: null }, select: { name: true, createdBy: true } });
    const userId = employee?.createdBy || wake.fallbackUserId;
    if (!employee || !userId) return null;
    const membership = await db.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId: wake.orgId } }, select: { isActive: true, deactivatedAt: true } });
    if (!membership?.isActive || membership.deactivatedAt) return null;
    const app = toolkitLabel(wake.toolkit);
    const count = Number.isInteger(wake.count) && wake.count > 1 ? wake.count : 1;
    const subject = clip(wake.title, 120);
    const why = WHY[wake.reason];
    const body = [count > 1 ? `${count} events` : '', subject ? `“${subject}”` : '', why ? `— ${why}` : ''].filter(Boolean).join(' ') || 'Woken by a connected app event.';
    return await createWorkspaceNotification(db, {
      orgId: wake.orgId, userId, type: 'employee.wake', title: `${app} → ${clip(employee.name, 60)}${count > 1 ? `: ${count} events` : ''}`, body,
      resourceType: 'employee', resourceId: wake.employeeId, dedupeKey: `employee-wake:${wake.wakeId}`, once: true,
      data: { employeeId: wake.employeeId, wakeId: wake.wakeId, toolkit: clip(wake.toolkit, 60), reason: clip(wake.reason, 20), eventCount: count,
        // The bell draws the Gmail mark from `icon`; other apps get its generic glyph until the frontend knows their logos.
        ...(String(wake.toolkit).toLowerCase() === 'gmail' ? { icon: 'gmail' } : {}),
        href: `/hivemind/app/employee/dots/employee/${wake.employeeId}` },
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'employee_wake_notification_failed', orgId: wake?.orgId, employeeId: wake?.employeeId, code: clip(error?.message, 80) }));
    return null;
  }
}
