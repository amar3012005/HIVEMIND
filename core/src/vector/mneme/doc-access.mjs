/**
 * Document access predicate — the pure mirror of `appendDocumentAccess`'s SQL.
 *
 * WHY THIS EXISTS
 *   Evidence recall for `.amr` orgs is gated by a `knowledge_documents` join: the shard produces
 *   candidate ids, Postgres decides which of them the caller may actually see. That join is the
 *   single reason the shard can contribute candidates safely without the scope rules being ported
 *   into it — and it is therefore the last thing standing between a `.amr` slot and serving
 *   evidence on its own.
 *
 *   Porting an access rule by re-implementing it from memory is how tenants end up seeing each
 *   other's documents. So this module does not re-derive the policy: it mirrors the SQL branch for
 *   branch, and `tests/unit/doc-access.test.js` pins each branch. The companion differential
 *   harness (`scripts/amr-access-differential.mjs`) runs BOTH implementations over real documents
 *   and real access contexts and asserts the allowed sets are byte-identical. Nothing may read
 *   evidence through this predicate instead of the SQL until that harness is clean.
 *
 * FAIL CLOSED. Every uncertain path denies. A missing userId denies outright, exactly as the SQL's
 * `conds.push('FALSE')` does — a caller with no identity sees nothing rather than everything.
 *
 * @module src/vector/mneme/doc-access
 */

/**
 * Facts about one document, as the shard record carries them.
 * @typedef {object} DocFacts
 * @property {string|null} userId    document owner (`knowledge_documents.user_id`)
 * @property {string[]}    tags      `metadata.tags` — the `scope-key:*` grants
 * @property {boolean}     [deleted] true when `deleted_at IS NOT NULL`
 */

const asArray = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string') : []);
const overlaps = (tags, wanted) => wanted.some((w) => tags.includes(w));

/**
 * Does `access` permit reading this document? Mirrors appendDocumentAccess exactly.
 *
 * @param {DocFacts} doc
 * @param {string} org organization id (for the `scope-key:org:<id>` grant)
 * @param {object} access caller context: {userId, scopeFilter, projectId, accessContext}
 * @returns {boolean}
 */
export function documentAllowed(doc, org, access = {}) {
  if (!doc) return false;
  // The SQL carries `d.deleted_at IS NULL` as a separate condition on every call site; folding it
  // in here keeps a shard-side reader from forgetting it.
  if (doc.deleted) return false;

  const userId = access.userId || access.user_id || null;
  if (!userId) return false; // SQL: conds.push('FALSE')

  const tags = asArray(doc.tags);
  const orgTag = `scope-key:org:${org}`;
  const organizationTag = 'scope-key:organization'; // legacy grant, still honoured
  const personalTag = `scope-key:personal:${userId}`;
  const projectIds = access.projectId ? [access.projectId] : (access.accessContext?.projectIds || []);
  const teamIds = access.accessContext?.teamIds || [];
  const projectTags = projectIds.map((id) => `scope-key:project:${id}`);
  const teamTags = teamIds.map((id) => `scope-key:team:${id}`);
  const scope = access.scopeFilter || null;

  if (scope === 'organization') return tags.includes(orgTag) || tags.includes(organizationTag);
  if (scope === 'project') return projectTags.length ? overlaps(tags, projectTags) : false;
  if (scope === 'team') return teamTags.length ? overlaps(tags, teamTags) : false;
  if (scope === 'personal') return doc.userId === userId || tags.includes(personalTag);

  // Unscoped: any single grant is sufficient.
  return doc.userId === userId
    || tags.includes(orgTag)
    || tags.includes(organizationTag)
    || tags.includes(personalTag)
    || (projectTags.length > 0 && overlaps(tags, projectTags))
    || (teamTags.length > 0 && overlaps(tags, teamTags));
}

export default documentAllowed;
