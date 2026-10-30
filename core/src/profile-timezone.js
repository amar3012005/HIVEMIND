/**
 * The person's IANA timezone for schedules that run on their clock (an employee's nightly review): the newest zone of their proactive
 * schedule in this organization, else their account timezone unless it is the untouched UTC default, else null.
 * @param {object} prisma - Prisma client.
 * @param {string} userId - The person.
 * @param {string} orgId - Their organization.
 * @returns {Promise<string|null>} A valid IANA zone, or null when none is known.
 */
export async function profileTimezone(prisma, userId, orgId) {
  const valid = (zone) => {
    if (typeof zone !== 'string' || !zone.trim() || zone.length > 64) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() }); return zone.trim(); } catch { return null; }
  };
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT timezone FROM "hivemind"."proactive_user_schedules" WHERE user_id::text = $1 AND org_id::text = $2 AND timezone IS NOT NULL ORDER BY updated_at DESC LIMIT 5`,
      String(userId), String(orgId));
    for (const row of rows ?? []) { const zone = valid(row?.timezone); if (zone) return zone; }
  } catch { /* an unreadable schedule falls back to the account timezone */ }
  try {
    const account = await prisma.user?.findUnique?.({ where: { id: userId }, select: { timezone: true } });
    const zone = valid(account?.timezone);
    return zone && zone !== 'UTC' ? zone : null;
  } catch { return null; }
}
