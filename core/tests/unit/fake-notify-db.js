const ORG = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const TURING = '44444444-4444-4444-8444-444444444444';

/** Notification table with the unique key (org, user, dedupe key) and Prisma's upsert, plus the employee and membership reads the helper makes. */
export function fakeNotifyDb({ employees = [{ id: TURING, orgId: ORG, name: 'Turing', createdBy: OWNER, archivedAt: null }], members = [[OWNER, ORG], [ACCOUNT, ORG]] } = {}) {
  const rows = [];
  const db = {
    digitalEmployee: { findFirst: async ({ where }) => employees.find(item => item.id === where.id && item.orgId === where.orgId && (where.archivedAt !== null || !item.archivedAt)) ?? null },
    userOrganization: { findUnique: async ({ where: { userId_orgId: key } }) => (members.some(([userId, orgId]) => userId === key.userId && orgId === key.orgId) ? { isActive: true, deactivatedAt: null } : null) },
    workspaceNotification: {
      upsert: async ({ where: { orgId_userId_dedupeKey: key }, create, update }) => {
        const found = rows.find(row => row.orgId === key.orgId && row.userId === key.userId && row.dedupeKey === key.dedupeKey);
        if (found) return Object.assign(found, update);
        const row = { id: `n${rows.length + 1}`, readAt: null, createdAt: new Date(1000), ...create };
        rows.push(row);
        return row;
      },
      create: async ({ data }) => { rows.push({ id: `n${rows.length + 1}`, ...data }); return rows.at(-1); },
    },
  };
  return { db, rows };
}
