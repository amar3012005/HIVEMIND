/**
 * HIVE-MIND — Qdrant container routing + provisioning
 *
 * One collection ("container") per ORG account, keyed by org_id. All members of
 * the org live inside that one collection; separation is by payload filter:
 *   - user_id     → who owns the memory
 *   - project_id  → which project (projects are SHARED across the org's members)
 *   - layer       → memory | evidence (one container holds both)
 *
 * Personal accounts (no org) route to the shared HIVEMIND_PERSONAL collection,
 * tenant-isolated by user_id filter.
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
 * Resolve the Qdrant collection a read/write should target.
 *
 * Routing is by org-presence, NOT memory.scope: an org account ALWAYS has an
 * orgId, a personal account never does. A personal-SCOPE memory belonging to an
 * org member still lives in the org container (separated by user_id filter) —
 * "all employees under the org inside this container". Only true personal
 * accounts (no org) land in the shared HIVEMIND_PERSONAL pool.
 *
 * @param {object} ctx
 * @param {string} [ctx.orgId]
 * @param {string} [ctx.vectorContainer]  org.vectorContainer if already loaded (skips name build)
 * @returns {string} collection name
 */
export function resolveCollection({ orgId, vectorContainer } = {}) {
  if (!PER_TENANT) return LEGACY_COLLECTION;
  if (vectorContainer) return vectorContainer;
  if (orgId) return orgContainerName(orgId);
  return PERSONAL_COLLECTION;
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
