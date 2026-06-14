/**
 * WS5 step-5 — Persona vector store.
 *
 * Embeds dreamed persona facts into a SEPARATE per-tenant Qdrant collection
 * `profile_<orgId>` — deliberately NOT the main `org_<id>` memory collection — so
 * persona vectors never pollute memory/dream recall (and the dreams-first boost
 * never competes with persona). Points use a DETERMINISTIC UUIDv5 id from
 * `${userId}:${key}` so a re-dream UPDATES the same point in place (no dupes).
 * Search is always scoped by `user_id` (the per-user chokepoint) so one member's
 * persona can never leak into another's recall.
 *
 * All operations are best-effort + flag-gated by the caller; failures log + no-op
 * (persona vectors are an optimization, never a correctness dependency).
 */

import crypto from 'crypto';

const QDRANT_URL = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL || '';
const QDRANT_KEY = process.env.QDRANT_API_KEY || '';
// RFC-4122 v5 (sha1) — deterministic id so (userId,key) maps to one stable point.
const UUID_NS = '9f1a7c1e-0000-5000-8000-hivemindpersona'.replace(/[^0-9a-f]/g, '0').slice(0, 32);

export function personaPointId(userId, key) {
  const nsBytes = Buffer.from(UUID_NS.padEnd(32, '0').slice(0, 32), 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(`${userId}:${key}`)])).digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function personaCollection(orgId) {
  return `profile_${orgId}`;
}

async function qfetch(path, method, body) {
  return fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(QDRANT_KEY ? { 'api-key': QDRANT_KEY } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// Create profile_<org> with the right vector size if it doesn't exist yet.
async function ensureCollection(collection, dim, logger) {
  const head = await qfetch(`/collections/${encodeURIComponent(collection)}`, 'GET').catch(() => null);
  if (head && head.ok) return true;
  const resp = await qfetch(`/collections/${encodeURIComponent(collection)}`, 'PUT', {
    vectors: { size: dim, distance: 'Cosine' },
  }).catch((e) => { logger?.warn?.(`[persona-vector] create failed: ${e.message}`); return null; });
  return !!(resp && resp.ok);
}

/**
 * Embed + upsert one persona fact into profile_<org>. Returns true on success.
 * @param {{ orgId, userId, key, category, value, embedService, logger? }} args
 */
export async function upsertPersonaVector({ orgId, userId, key, category, value, embedService, logger = console }) {
  if (!QDRANT_URL || !orgId || !userId || !value) return false;
  try {
    const [vec] = await embedService.embed([value]);
    if (!Array.isArray(vec) || vec.length === 0) return false;
    const collection = personaCollection(orgId);
    if (!(await ensureCollection(collection, vec.length, logger))) return false;
    const resp = await qfetch(`/collections/${encodeURIComponent(collection)}/points?wait=true`, 'PUT', {
      points: [{
        id: personaPointId(userId, key),
        vector: vec,
        payload: { user_id: userId, org_id: orgId, key, category: category || 'dynamic', value },
      }],
    });
    if (!resp.ok) { logger?.warn?.(`[persona-vector] upsert HTTP ${resp.status}`); return false; }
    return true;
  } catch (err) {
    logger?.warn?.(`[persona-vector] upsert failed: ${err.message}`);
    return false;
  }
}

/** Remove a persona point (e.g. when a fact is decayed/deleted). */
export async function deletePersonaVector({ orgId, userId, key, logger = console }) {
  if (!QDRANT_URL || !orgId || !userId) return false;
  try {
    const resp = await qfetch(`/collections/${encodeURIComponent(personaCollection(orgId))}/points/delete?wait=true`, 'POST', {
      points: [personaPointId(userId, key)],
    });
    return !!(resp && resp.ok);
  } catch (err) {
    logger?.warn?.(`[persona-vector] delete failed: ${err.message}`);
    return false;
  }
}

/**
 * Search a member's persona by query vector. ALWAYS filtered by user_id (the
 * per-user chokepoint — no cross-member leakage). Returns [{key,value,category,score}].
 * @param {{ orgId, userId, queryVec, limit?, logger? }} args
 */
export async function searchPersona({ orgId, userId, queryVec, limit = 5, logger = console }) {
  if (!QDRANT_URL || !orgId || !userId || !Array.isArray(queryVec)) return [];
  try {
    const resp = await qfetch(`/collections/${encodeURIComponent(personaCollection(orgId))}/points/search`, 'POST', {
      vector: queryVec,
      limit,
      with_payload: true,
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    return (json?.result || []).map((p) => ({
      key: p.payload?.key, value: p.payload?.value, category: p.payload?.category, score: p.score,
    }));
  } catch (err) {
    logger?.warn?.(`[persona-vector] search failed: ${err.message}`);
    return [];
  }
}
