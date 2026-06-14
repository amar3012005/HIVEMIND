/**
 * Per-scope cognition activation — DB-driven toggles.
 *
 * The cognitive layer ships for EVERY org/project but does nothing until an
 * admin opts in. Three independent switches (migration 20260606193000):
 *   organizations.cognition_org_enabled       — synthesize org-visible memories
 *   organizations.cognition_personal_enabled  — ALSO include members' personal/private memories
 *   projects.self_evolve_enabled               — per-project card toggle
 *
 * Read via raw SQL (avoids prisma-client-lag on prod, same pattern as
 * retrieval-config.js) and cached for 60s so the hourly cron doesn't hammer the
 * DB. A global env kill-switch (COGNITION_GLOBAL_DISABLE=true) force-disables
 * everything regardless of toggles.
 *
 * @module resident/cognition-pilot
 */

const _cache = new Map(); // orgId -> { value:{org,personal}, expiresAt }
const TTL_MS = 60_000;

/** Hard global kill-switch. When set, no org runs cognition regardless of toggles. */
function globallyDisabled() {
  return process.env.COGNITION_GLOBAL_DISABLE === 'true';
}

async function readOrgSettings(prisma, orgId) {
  if (!orgId || !prisma) return { org: false, personal: false, crossProject: false };
  const now = Date.now();
  const cached = _cache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;
  let value = { org: false, personal: false, crossProject: false };
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT cognition_org_enabled, cognition_personal_enabled, cognition_cross_project_enabled
         FROM hivemind.organizations WHERE id = $1::uuid LIMIT 1`,
      orgId,
    );
    if (rows?.[0]) {
      value = {
        org: !!rows[0].cognition_org_enabled,
        personal: !!rows[0].cognition_personal_enabled,
        crossProject: !!rows[0].cognition_cross_project_enabled,
      };
    }
  } catch {
    /* columns missing pre-migration → defaults off */
  }
  _cache.set(orgId, { value, expiresAt: now + TTL_MS });
  return value;
}

/** @returns {Promise<boolean>} org-scope cognition (org-visible memories) is on. */
export async function cognitionOrgScopeEnabled(prisma, orgId) {
  if (globallyDisabled()) return false;
  return (await readOrgSettings(prisma, orgId)).org;
}

/** @returns {Promise<boolean>} Faraday should also scan members' private memories. */
export async function includePersonalForOrg(prisma, orgId) {
  if (globallyDisabled()) return false;
  return (await readOrgSettings(prisma, orgId)).personal;
}

/**
 * Should this org be processed by the cron at all? True if org-scope OR personal
 * OR any project self-evolve is enabled. Lets the scheduler skip fully-off orgs.
 * @returns {Promise<boolean>}
 */
export async function cognitionEnabledForOrg(prisma, orgId) {
  if (globallyDisabled() || !prisma || !orgId) return false;
  const s = await readOrgSettings(prisma, orgId);
  if (s.org || s.personal) return true;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM hivemind.projects
        WHERE org_id = $1::uuid AND self_evolve_enabled = true LIMIT 1`,
      orgId,
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

/** @returns {Promise<boolean>} cross-project dreaming (bridges may span projects) is on. */
export async function crossProjectEnabledForOrg(prisma, orgId) {
  if (globallyDisabled()) return false;
  return (await readOrgSettings(prisma, orgId)).crossProject;
}

/** @returns {Promise<boolean>} self-evolve toggle for a single project. */
export async function selfEvolveEnabledForProject(prisma, projectId) {
  if (globallyDisabled() || !prisma || !projectId) return false;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT self_evolve_enabled FROM hivemind.projects WHERE id = $1::uuid LIMIT 1`,
      projectId,
    );
    return !!rows?.[0]?.self_evolve_enabled;
  } catch {
    return false;
  }
}

/** Drop cached settings for an org (call after a toggle write). */
export function invalidateCognitionSettings(orgId) {
  if (orgId) _cache.delete(orgId);
  else _cache.clear();
}
