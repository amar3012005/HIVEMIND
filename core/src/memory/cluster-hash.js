import crypto from 'crypto';

/**
 * Deterministic cluster identity hash.
 *
 * A "cluster" is keyed by a single tag (e.g. `canonical:<tag>`) or a tag-pair
 * (bridges). The hash is the stable primary key into hivemind.cluster_index.
 *
 * Shared by cognition-loop (synthesis) and graph-engine (ingest-time dirty
 * bump) so both sides agree on cluster identity — no duplicated hashing.
 *
 * @param {string} tagOrPair
 * @returns {string} 48-char hex
 */
export function clusterHash(tagOrPair) {
  return crypto.createHash('sha256').update(tagOrPair).digest('hex').slice(0, 48);
}
