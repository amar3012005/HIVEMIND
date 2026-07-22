// Connector Runtime V1 — shared approval hashing (SINGLE SOURCE).
//
// These helpers are ported VERBATIM from core/src/agent/middleware/draft-
// approval.js so the runtime's PendingWrite rows are byte-identical to the ones
// the live chat middleware produces. This is deliberately NOT a second approval
// system — it is the shared formula the runtime uses now and that draft-
// approval.js will import at the Phase 8 chat cutover (its inline copies then
// deleted). A test pins runtime output to the exact expected hash so the two
// can never silently drift while both exist.
//
// Language- and tenant-neutral: pure structural hashing, no locale, no English.

import { createHash } from 'node:crypto';

/** Deterministic JSON with sorted object keys (stable across key order). */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the stable-JSON of args. Identical to draft-approval.hashArgs. */
export function hashArgs(args) {
  return createHash('sha256').update(stableJson(args || {})).digest('hex');
}

/**
 * Idempotency key. Identical formula to draft-approval.js:
 *   sha256(`${orgId}:${userId}:${projectId||''}:${toolGroup}:${toolName}:${argsHash}:${traceId||''}`)
 * toolGroup is the connector id in the runtime (== provider group in chat).
 */
export function idempotencyKeyFor({ orgId, userId, projectId, toolGroup, toolName, argsHash, traceId }) {
  return createHash('sha256')
    .update(`${orgId}:${userId}:${projectId || ''}:${toolGroup}:${toolName}:${argsHash}:${traceId || ''}`)
    .digest('hex');
}

/** Draft TTL in ms (env-tunable, identical default to chat). */
export function draftTtlMs() {
  return Number(process.env.CHAT_DRAFT_TTL_MS || 15 * 60_000);
}
