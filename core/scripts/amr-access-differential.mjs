#!/usr/bin/env node
/**
 * Access differential — the gate that must be clean before a `.amr` slot may serve evidence
 * without the Postgres access join.
 *
 * WHAT IT PROVES
 *   `documentAllowed()` (pure, shard-side) and `appendDocumentAccess()` (the live SQL) are run
 *   over the SAME real documents and the SAME real access contexts, and their allowed-id sets are
 *   compared exactly. Unit tests only show the predicate agrees with how its author READ the SQL;
 *   this shows it agrees with the SQL as Postgres actually executes it — including jsonb `?`
 *   semantics, NULL handling, and any tag shape real ingestion produced that a hand-written
 *   fixture would never think of.
 *
 * WHY A DIFFERENTIAL AND NOT A SPOT CHECK
 *   The failure being guarded against is asymmetric. A predicate that is too STRICT loses recall
 *   and someone notices. A predicate that is too LOOSE shows one tenant another tenant's
 *   documents and nobody notices. So mismatches are reported by DIRECTION, and any single
 *   over-permissive case is a hard failure regardless of the aggregate agreement rate.
 *
 * MEASUREMENT ONLY. Reads. Writes nothing, changes no behaviour, and is safe on production.
 *
 * Usage (inside the core container):
 *   node scripts/amr-access-differential.mjs [orgId ...]
 * Exit codes: 0 = identical everywhere, 1 = any mismatch, 2 = harness could not run.
 */
import { appendDocumentAccess } from '../src/vector/mneme/embedded-agent.mjs';
import { documentAllowed } from '../src/vector/mneme/doc-access.mjs';

const SCOPES = [null, 'organization', 'personal', 'project', 'team'];

async function main() {
  const { default: Pg } = await import('pg');
  const db = new Pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    options: '-c search_path=hm,public',
  });

  let orgs = process.argv.slice(2);
  if (!orgs.length) {
    const { rows } = await db.query(
      'SELECT DISTINCT org_id FROM knowledge_documents WHERE deleted_at IS NULL',
    );
    orgs = rows.map((r) => r.org_id);
  }
  if (!orgs.length) { console.log('no orgs with documents — nothing to compare'); return 0; }

  let checked = 0;
  let mismatched = 0;
  let overPermissive = 0;

  for (const org of orgs) {
    const { rows: docs } = await db.query(
      `SELECT id, user_id, deleted_at, coalesce(metadata->'tags', '[]'::jsonb) AS tags
         FROM knowledge_documents WHERE org_id = $1`,
      [org],
    );
    if (!docs.length) continue;

    // Build access contexts out of what this org's data actually contains, not out of invented
    // ids: a context nobody holds exercises nothing.
    const userIds = [...new Set(docs.map((d) => d.user_id).filter(Boolean))];
    const projectIds = new Set();
    const teamIds = new Set();
    for (const d of docs) {
      for (const t of (Array.isArray(d.tags) ? d.tags : [])) {
        if (typeof t !== 'string') continue;
        if (t.startsWith('scope-key:project:')) projectIds.add(t.slice('scope-key:project:'.length));
        if (t.startsWith('scope-key:team:')) teamIds.add(t.slice('scope-key:team:'.length));
      }
    }

    const contexts = [];
    for (const userId of userIds) {
      for (const scopeFilter of SCOPES) {
        contexts.push({ userId, scopeFilter });
        for (const p of projectIds) contexts.push({ userId, scopeFilter, projectId: p });
        if (teamIds.size) {
          contexts.push({ userId, scopeFilter, accessContext: { teamIds: [...teamIds] } });
        }
      }
    }
    // A caller with no identity: the branch that must deny everything.
    contexts.push({ userId: null, scopeFilter: null });

    for (const access of contexts) {
      const conds = ['d.org_id=$1', 'd.deleted_at IS NULL'];
      const args = [org];
      appendDocumentAccess(conds, args, 'd', org, access);
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await db.query(
        `SELECT id FROM knowledge_documents d WHERE ${conds.join(' AND ')}`,
        args,
      );
      const sqlSet = new Set(rows.map((r) => r.id));

      const jsSet = new Set(docs
        .filter((d) => documentAllowed(
          { userId: d.user_id, tags: Array.isArray(d.tags) ? d.tags : [], deleted: !!d.deleted_at },
          org,
          access,
        ))
        .map((d) => d.id));

      checked += 1;
      const jsOnly = [...jsSet].filter((id) => !sqlSet.has(id)); // predicate too LOOSE — a leak
      const sqlOnly = [...sqlSet].filter((id) => !jsSet.has(id)); // predicate too STRICT — lost recall
      if (jsOnly.length || sqlOnly.length) {
        mismatched += 1;
        if (jsOnly.length) overPermissive += 1;
        console.log(`MISMATCH org=${String(org).slice(0, 8)} access=${JSON.stringify(access)} `
          + `js_only=${jsOnly.length}${jsOnly.length ? ' (OVER-PERMISSIVE — would leak)' : ''} `
          + `sql_only=${sqlOnly.length}`);
      }
    }
  }

  await db.end();
  console.log(`\naccess-differential: contexts=${checked} mismatched=${mismatched} `
    + `over_permissive=${overPermissive}`);
  if (overPermissive) {
    console.log('VERDICT: BLOCKED — the shard-side predicate would expose documents the SQL denies.');
    return 1;
  }
  if (mismatched) {
    console.log('VERDICT: BLOCKED — predicate diverges (too strict). Recall would silently drop.');
    return 1;
  }
  console.log('VERDICT: CLEAN — shard-side gating is equivalent to the SQL on this corpus.');
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(`access-differential could not run: ${e.message}`);
  process.exit(2);
});
