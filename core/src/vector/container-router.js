/**
 * HIVE-MIND — Qdrant container routing + provisioning
 *
 * Account-type model (matches signup UI: Personal vs Enterprise):
 *   - ENTERPRISE org (plan !== 'free') → its OWN container `org_<orgId>`.
 *     Holds EVERYTHING for that org — team members, personal-scoped, and
 *     project-scoped memories — separated inside by user_id / project_id / layer.
 *   - PERSONAL account (plan === 'free', or no org) → the SHARED
 *     `HIVEMIND_PERSONAL` collection, tenant-isolated by user_id filter.
 *
 * Both account types have an org row (Personal = a private free-plan org), so
 * the discriminator is the PLAN, not org-presence.
 *
 * @module vector/container-router
 */

import { getQdrantCollections } from './collections.js';
import { logger } from '../utils/logger.js';

const PERSONAL_COLLECTION = process.env.QDRANT_PERSONAL_COLLECTION || 'HIVEMIND_PERSONAL';
const LEGACY_COLLECTION = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';

// Cutover gate. While false, everything resolves to the legacy collection so
// un-migrated tenants keep working. Flip to 'true' only once all live orgs are
// provisioned + backfilled.
const PER_TENANT = process.env.QDRANT_PER_TENANT === 'true';

// An org gets its own container only when on a paid (enterprise-class) plan.
// 'free' = personal account → pooled into HIVEMIND_PERSONAL.
export function isEnterprisePlan(plan) {
  return !!plan && plan !== 'free';
}

/**
 * Deterministic container name for an org. Keyed by org_id (NOT slug — slugs
 * change on rename; the id is stable for the life of the org).
 * @param {string} orgId
 * @returns {string}
 */
export function orgContainerName(orgId) {
  if (!orgId) throw new Error('orgContainerName: orgId required');
  return `org_${orgId}`;
}

/**
 * Resolve the target collection from ALREADY-KNOWN context (no DB).
 * @param {object} ctx
 * @param {string} [ctx.orgId]
 * @param {string} [ctx.plan]             org plan — drives personal vs enterprise
 * @param {string} [ctx.vectorContainer]  org.vectorContainer if loaded (wins)
 * @returns {string} collection name
 */
export function resolveCollection({ orgId, plan, vectorContainer } = {}) {
  if (!PER_TENANT) return LEGACY_COLLECTION;
  if (vectorContainer) return vectorContainer;
  if (orgId && isEnterprisePlan(plan)) return orgContainerName(orgId);
  // free plan, no plan, or no org → shared personal pool
  return PERSONAL_COLLECTION;
}

// orgId → { container, ts } cache so the hot path doesn't hit Postgres per call.
const _orgContainerCache = new Map();
const ORG_CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateOrgContainer(orgId) {
  _orgContainerCache.delete(orgId);
}

/**
 * Resolve the collection for a memory/search when only orgId is known (the
 * centralized qdrant-client path). Looks up the org's plan + vector_container
 * from Postgres, cached. Enterprise → org_<id>; free/unknown → HIVEMIND_PERSONAL.
 * @param {string|null} orgId
 * @returns {Promise<string>}
 */
export async function resolveCollectionForOrg(orgId) {
  if (!PER_TENANT) return LEGACY_COLLECTION;
  if (!orgId) return PERSONAL_COLLECTION;

  const cached = _orgContainerCache.get(orgId);
  if (cached && Date.now() - cached.ts < ORG_CACHE_TTL_MS) return cached.container;

  let container = PERSONAL_COLLECTION;
  try {
    const { getPrismaClient } = await import('../db/prisma.js');
    const prisma = getPrismaClient();
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true, vectorContainer: true },
    });
    if (org?.vectorContainer) container = org.vectorContainer;
    else if (org && isEnterprisePlan(org.plan)) container = orgContainerName(orgId);
    else container = PERSONAL_COLLECTION;
  } catch (err) {
    logger.warn('resolveCollectionForOrg lookup failed; defaulting to personal pool', { orgId, error: err.message });
  }
  _orgContainerCache.set(orgId, { container, ts: Date.now() });
  return container;
}

/**
 * Provision (idempotently create) an org's container in Qdrant. Safe to call on
 * every org creation; no-op if the collection already exists. Never throws to
 * the caller — provisioning failure must NOT fail org signup; it is logged and
 * the container is lazily created on first write via QdrantClient.ensureCollection.
 * @param {string} orgId
 * @returns {Promise<{ ok: boolean, collection: string, error?: string }>}
 */
export async function provisionOrgContainer(orgId) {
  const collection = orgContainerName(orgId);
  try {
    const collections = getQdrantCollections(process.env.QDRANT_URL, process.env.QDRANT_API_KEY);
    await collections.createOrgContainer(collection);
    logger.info('Org container provisioned', { orgId, collection });
    return { ok: true, collection };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Lazy-create on first write is the backstop — log and move on.
    logger.error('Org container provisioning failed (will lazy-create on first write)', {
      orgId, collection, error: msg
    });
    return { ok: false, collection, error: msg };
  }
}

export { PERSONAL_COLLECTION, LEGACY_COLLECTION, PER_TENANT };

/**
 * Provision the right destination for an org at creation/upgrade time.
 * Enterprise → create org_<id> container, return its name. Free → no container,
 * returns the shared personal pool name. Never throws.
 * @param {string} orgId
 * @param {string} plan
 * @returns {Promise<string>} the vector_container value to persist
 */
export async function provisionForPlan(orgId, plan) {
  if (isEnterprisePlan(plan)) {
    await provisionOrgContainer(orgId); // idempotent, never throws
    return orgContainerName(orgId);
  }
  return PERSONAL_COLLECTION;
}
