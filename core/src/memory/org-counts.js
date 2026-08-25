/**
 * Uniform org counts — THE single seam for "how many memories / relationships does this org have".
 *
 * Endpoints (Profile, Overview, Usage, …) call getOrgCounts() with NO knowledge of the org's type.
 * The ONLY place org-type matters is HERE: route the count to wherever the data lives —
 *   • central (personal / managed)  → count central Postgres (org_id-scoped, latest, non-hidden)
 *   • agent   (self-host / remote)   → ask the agent (/v1/stats via amrStats)
 * Mirrors the write path's single routing seam (memoryBackend). No `if (orgIsRemote)` ever leaks into
 * a feature/endpoint — that was the per-type sprawl we are removing.
 */
import { orgIsRemote, amrStats } from '../vector/mneme/driver.js';

/**
 * @param {object} prisma  central Prisma client (used only for central orgs)
 * @param {string} orgId
 * @param {string} [userId]  optional user scope (Profile is per-user)
 * @returns {Promise<{memories:number, relationships:number}>}
 */
export async function getOrgCounts(prisma, orgId, userId = null) {
  if (!orgId) return { memories: 0, relationships: 0 };

  // Remote (self-host): data lives on the agent.
  if (orgIsRemote(orgId)) {
    const s = await amrStats(orgId, userId ? { user_id: userId } : {});
    return { memories: Number(s?.memories) || 0, relationships: Number(s?.relationships) || 0 };
  }

  // Central (personal / managed): count what the list/graph show — latest, non-hidden, org-scoped
  // (+ user-scoped for the per-user Profile view).
  let memories = 0;
  let relationships = 0;
  try {
    const where = { orgId, deletedAt: null, isLatest: true, layer: { in: ['memory', 'cognitive'] } };
    if (userId) where.userId = userId;
    memories = await prisma.memory.count({ where });
  } catch { /* keep 0 */ }
  try {
    const r = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM "relationships" rel
         JOIN "memories" m ON rel."from_id" = m."id"
        WHERE m."org_id" = $1::uuid AND m."deleted_at" IS NULL AND m."is_latest" = true${userId ? ' AND m."user_id" = $2::uuid' : ''}`,
      ...(userId ? [orgId, userId] : [orgId]),
    );
    relationships = r?.[0]?.c || 0;
  } catch { /* keep 0 */ }
  return { memories, relationships };
}
