// Tenant-scoped lexical entity discovery. This is a chooser before recall,
// not another retrieval lane: callers select a canonical entity, then pass its
// name into the existing RetrievalSpec entity predicate.

const MAX_CANDIDATES = 1000;
const MAX_LIMIT = 25;
const ENTITY_SCOPE_FILTERS = new Set(['personal', 'project', 'team', 'organization']);

const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
const words = (value) => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const entitySlug = (value) => normalize(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

function editDistance(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function fuzzyWordMatch(queryWord, candidateWord) {
  if (queryWord.length < 4 || candidateWord.length < 4) return false;
  const allowance = Math.max(queryWord.length, candidateWord.length) >= 8 ? 2 : 1;
  return editDistance(queryWord, candidateWord) <= allowance;
}

// Entity discovery is an authorized inventory browser.  An omitted scope is
// deliberately the whole authorized organization; an explicit scope narrows
// that inventory before matching and ranking.  Do not silently turn an
// unrecognised requested scope into an organization-wide search.
export function normalizeEntityScope(scope) {
  if (scope === undefined || scope === null || String(scope).trim() === '') {
    return { scopeFilter: null, error: null };
  }
  const scopeFilter = String(scope).trim().toLowerCase();
  return ENTITY_SCOPE_FILTERS.has(scopeFilter)
    ? { scopeFilter, error: null }
    : { scopeFilter: null, error: 'invalid_scope' };
}

function effectiveMemoryScope(memory) {
  const explicit = String(memory?.scope || '').toLowerCase();
  if (ENTITY_SCOPE_FILTERS.has(explicit)) return explicit;
  if (memory?.project_id || memory?.projectId || (Array.isArray(memory?.project_ids) && memory.project_ids.length)) return 'project';
  if (memory?.primary_team_id || memory?.primaryTeamId) return 'team';
  if (memory?.visibility === 'private') return 'personal';
  if (memory?.visibility === 'organization') return 'organization';
  return null;
}

function memoryMatchesEntityScope(memory, { scopeFilter, userId, accessContext = {}, projectId = null }) {
  if (!scopeFilter) return true;
  const scope = effectiveMemoryScope(memory);
  if (scope !== scopeFilter) return false;
  if (scope === 'personal') return String(memory?.user_id || memory?.userId || '') === String(userId);
  if (scope === 'organization') return String(accessContext?.orgRole || '').toLowerCase() !== 'guest';
  if (scope === 'project') {
    const permitted = projectId ? [projectId] : (accessContext?.projectIds || []);
    const assigned = [memory?.project_id, memory?.projectId, ...(memory?.project_ids || memory?.projectIds || [])].filter(Boolean);
    return assigned.some((id) => permitted.includes(id));
  }
  if (scope === 'team') return (accessContext?.teamIds || []).includes(memory?.primary_team_id || memory?.primaryTeamId);
  return false;
}

function filterMemoryInventory(memories, options) {
  return (memories || []).filter((memory) => memoryMatchesEntityScope(memory, options));
}

function displayTagEntity(slug, memory) {
  const extracted = memory?.metadata?.extracted_facts?.entities;
  const exact = Array.isArray(extracted) && extracted.find((name) => entitySlug(name) === slug);
  if (exact) return String(exact);
  return slug.split('-').filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

function matchKind(entity, query) {
  const q = normalize(query);
  if (!q) return null;
  const canonical = normalize(entity.canonicalName);
  const aliases = (entity.aliases || []).map(normalize).filter(Boolean);
  if (canonical === q) return 'canonical_exact';
  if (aliases.includes(q)) return 'alias_exact';

  const queryWords = words(query).filter((word) => word.length >= 2);
  const canonicalWords = words(entity.canonicalName);
  const aliasWords = aliases.flatMap(words);
  if (queryWords.some((queryWord) => canonicalWords.some((word) => word.startsWith(queryWord)))) return 'canonical_prefix';
  if (queryWords.some((queryWord) => aliasWords.some((word) => word.startsWith(queryWord)))) return 'alias_prefix';
  if (q.length >= 4 && (canonical.includes(q) || aliases.some((alias) => alias.includes(q)))) return 'substring';
  const candidates = [...canonicalWords, ...aliasWords];
  if (queryWords.some((queryWord) => candidates.some((word) => fuzzyWordMatch(queryWord, word)))) return 'fuzzy';
  return null;
}

const MATCH_ORDER = Object.freeze({
  canonical_exact: 0,
  alias_exact: 1,
  canonical_prefix: 2,
  alias_prefix: 3,
  substring: 4,
  fuzzy: 5,
});

export function rankEntityMatches(entities, query, limit = MAX_LIMIT) {
  return (entities || [])
    .map((entity) => ({ entity, match: matchKind(entity, query) }))
    .filter((row) => row.match)
    .sort((a, b) => (
      MATCH_ORDER[a.match] - MATCH_ORDER[b.match]
      || Number(b.entity.mentionCount || 0) - Number(a.entity.mentionCount || 0)
      || new Date(b.entity.lastSeenAt || 0) - new Date(a.entity.lastSeenAt || 0)
      || String(a.entity.canonicalName).localeCompare(String(b.entity.canonicalName))
      || String(a.entity.id).localeCompare(String(b.entity.id))
    ))
    .slice(0, Math.max(1, Math.min(Number(limit) || 12, MAX_LIMIT)))
    .map(({ entity, match }) => ({
      entity_id: entity.id,
      entity_ids: entity.entityIds || [entity.id],
      canonical_name: entity.canonicalName,
      entity_type: entity.entityType,
      aliases: entity.aliases || [],
      match,
      mention_count: Number(entity.mentionCount || 0),
      last_seen_at: entity.lastSeenAt || null,
    }));
}

// Candidate generation for canonical entities must remain index-driven. The
// alias projection is synchronized by a database trigger, so this path covers
// every canonical-entity writer. Authorization is applied inside the same
// query before an entity can be returned.
async function authorizedIndexedCanonicalRows({
  prisma,
  orgId,
  userId,
  accessContext = {},
  projectId = null,
  scopeFilter = null,
  entityTypes = [],
  query,
  limit = MAX_LIMIT,
}) {
  if (typeof prisma?.$queryRawUnsafe !== 'function') return null;
  const normalizedQuery = entitySlug(query);
  if (!normalizedQuery) return [];

  const role = String(accessContext?.orgRole || '').toLowerCase();
  const projectIds = projectId
    ? [String(projectId)]
    : [...new Set((accessContext?.projectIds || []).map(String).filter(Boolean))];
  const teamIds = [...new Set((accessContext?.teamIds || []).map(String).filter(Boolean))];
  const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
  const candidateLimit = Math.max(25, Math.min(Number(limit) * 8 || 100, 250));

  try {
    const rows = await prisma.$queryRawUnsafe(`
      WITH candidate_aliases AS MATERIALIZED (
        SELECT candidate.entity_id,
               min(candidate.match_rank) AS match_rank,
               max(candidate.similarity_score) AS similarity_score
        FROM (
          SELECT alias.entity_id,
                 min(CASE
                   WHEN alias.normalized_alias = $3 THEN CASE WHEN alias.is_canonical THEN 0 ELSE 1 END
                   WHEN alias.normalized_alias LIKE $3 || '%' THEN CASE WHEN alias.is_canonical THEN 2 ELSE 3 END
                   ELSE 5
                 END) AS match_rank,
                 max(public.similarity(alias.normalized_alias, $3)) AS similarity_score
          FROM hivemind.canonical_entity_search_aliases alias
          JOIN hivemind.canonical_entities entity ON entity.id = alias.entity_id
          WHERE alias.organization_id = $1::uuid
            AND (cardinality($4::text[]) = 0 OR lower(entity.entity_kind) = ANY($4::text[]))
            AND (
              alias.normalized_alias = $3
              OR alias.normalized_alias LIKE $3 || '%'
              OR alias.normalized_alias OPERATOR(public.%) $3
            )
          GROUP BY alias.entity_id
          UNION ALL
          SELECT entity.id AS entity_id, 0 AS match_rank, 1::real AS similarity_score
          FROM hivemind.canonical_entities entity
          WHERE entity.organization_id = $1::uuid
            AND lower(trim(entity.primary_email)) = lower(trim($13))
            AND (cardinality($4::text[]) = 0 OR lower(entity.entity_kind) = ANY($4::text[]))
        ) candidate
        GROUP BY candidate.entity_id
        ORDER BY match_rank ASC, similarity_score DESC, candidate.entity_id ASC
        LIMIT $11
      ), visible_entity_stats AS (
        SELECT link.entity_id,
               count(DISTINCT memory.id)::int AS mention_count,
               max(memory.created_at) AS last_seen_at
        FROM candidate_aliases candidate
        JOIN hivemind.memory_entity_links link ON link.entity_id = candidate.entity_id
        JOIN hivemind.memories memory ON memory.id = link.memory_id
        WHERE memory.org_id = $1::uuid
          AND memory.deleted_at IS NULL
          AND coalesce(memory.is_latest, true) = true
          AND NOT (
            ($9::boolean OR NOT $10::boolean)
            AND 'scope:cross-project' = ANY(coalesce(memory.tags, ARRAY[]::text[]))
          )
          AND (
            (memory.scope::text = 'personal' AND memory.user_id = $2::uuid)
            OR (memory.scope::text = 'organization' AND $10::boolean)
            OR (memory.scope::text = 'team' AND memory.primary_team_id = ANY($6::uuid[]))
            OR (
              memory.scope::text = 'project'
              AND (
                memory.project_id = ANY($5::uuid[])
                OR EXISTS (
                  SELECT 1 FROM hivemind.memory_projects mp
                  WHERE mp.memory_id = memory.id AND mp.project_id = ANY($5::uuid[])
                )
              )
            )
          )
          AND ($7::text IS NULL OR memory.scope::text = $7)
          AND (
            $8::uuid IS NULL
            OR memory.project_id = $8::uuid
            OR EXISTS (
              SELECT 1 FROM hivemind.memory_projects selected_mp
              WHERE selected_mp.memory_id = memory.id AND selected_mp.project_id = $8::uuid
            )
          )
        GROUP BY link.entity_id
      )
      SELECT entity.id,
             entity.canonical_name AS "canonicalName",
             entity.entity_kind AS "entityType",
             entity.aliases,
             entity.primary_email AS "primaryEmail",
             stats.mention_count AS "mentionCount",
             coalesce(stats.last_seen_at, entity.updated_at) AS "lastSeenAt"
      FROM candidate_aliases candidate
      JOIN hivemind.canonical_entities entity ON entity.id = candidate.entity_id
      JOIN visible_entity_stats stats ON stats.entity_id = entity.id
      ORDER BY candidate.match_rank ASC,
               candidate.similarity_score DESC,
               stats.mention_count DESC,
               stats.last_seen_at DESC,
               entity.id ASC
      LIMIT $12
    `,
    orgId,
    userId,
    normalizedQuery,
    types,
    projectIds,
    teamIds,
    scopeFilter,
    projectId,
    accessContext?.crossProject === false,
    role !== 'guest',
    candidateLimit,
    candidateLimit,
    String(query || ''));
    return rows.map((row) => ({
      ...row,
      aliases: [...new Set([...(row.aliases || []), row.primaryEmail].filter(Boolean))],
      _canonical: true,
    }));
  } catch (error) {
    // During a rolling release Core may briefly precede this projection's
    // migration. Null means "retain the existing path", not "no matches".
    console.warn('[entity-discovery] indexed canonical lookup unavailable:', error.message);
    return null;
  }
}

function visibilityWhere({ orgId, userId, accessContext = {}, projectId = null, scopeFilter = null }) {
  const role = String(accessContext?.orgRole || '').toLowerCase();
  const privileged = role === 'owner' || role === 'admin';
  const projectTags = (accessContext?.projectIds || []).map((id) => `scope-key:project:${id}`);
  const teamTags = (accessContext?.teamIds || []).map((id) => `scope-key:team:${id}`);
  const documentScope = scopeFilter === 'personal'
    ? { tags: { has: `scope-key:personal:${userId}` } }
    : scopeFilter === 'organization'
      ? { tags: { hasSome: [`scope-key:org:${orgId}`, 'scope-key:organization'] } }
      : scopeFilter === 'project'
        ? { tags: { hasSome: projectTags } }
        : scopeFilter === 'team'
          ? { tags: { hasSome: teamTags } }
          : null;
  const document = {
    orgId,
    archivedAt: null,
    ...(projectId && (!scopeFilter || scopeFilter === 'project') ? { tags: { has: `scope-key:project:${projectId}` } } : {}),
    ...(documentScope && (!projectId || scopeFilter !== 'project') ? documentScope : {}),
    ...(!projectId && !privileged ? { OR: [
      { userId },
      { tags: { hasSome: [`scope-key:org:${orgId}`, 'scope-key:organization'] } },
      { tags: { has: `scope-key:personal:${userId}` } },
      ...(projectTags.length ? [{ tags: { hasSome: projectTags } }] : []),
      ...(teamTags.length ? [{ tags: { hasSome: teamTags } }] : []),
    ] } : {}),
  };
  const effectiveAccess = projectId && (!scopeFilter || scopeFilter === 'project')
    ? { ...accessContext, projectIds: [projectId] }
    : accessContext;
  const projectIds = Array.isArray(effectiveAccess?.projectIds) ? effectiveAccess.projectIds : [];
  const teamIds = Array.isArray(effectiveAccess?.teamIds) ? effectiveAccess.teamIds : [];
  const tiers = [{ userId, scope: 'personal' }];
  if (effectiveAccess?.orgRole !== 'guest') tiers.push({ scope: 'organization', orgId });
  if (projectIds.length) tiers.push({ scope: 'project', memoryProjects: { some: { projectId: { in: projectIds } } } });
  if (teamIds.length) tiers.push({ scope: 'team', primaryTeamId: { in: teamIds } });
  const memory = {
    orgId,
    deletedAt: null,
    OR: scopeFilter ? tiers.filter((tier) => tier.scope === scopeFilter) : tiers,
    ...((effectiveAccess?.orgRole === 'guest' || effectiveAccess?.crossProject === false)
      ? { NOT: { tags: { has: 'scope:cross-project' } } } : {}),
  };
  return { OR: [{ document }, { memory }] };
}

// CanonicalEntity/MemoryEntityLink is the entity registry populated by the
// canonical memory-ingest path.  The older Entity/EntityMention registry is
// still populated by document extraction, so discovery must query both.  A
// chooser that only checks Entity silently returns no matches for memories
// saved through the normal /api/memories path.
function visibleMemoryWhere({ orgId, userId, accessContext = {}, projectId = null, scopeFilter = null }) {
  const effectiveAccess = projectId && (!scopeFilter || scopeFilter === 'project')
    ? { ...accessContext, projectIds: [projectId] }
    : accessContext;
  const projectIds = Array.isArray(effectiveAccess?.projectIds) ? effectiveAccess.projectIds : [];
  const teamIds = Array.isArray(effectiveAccess?.teamIds) ? effectiveAccess.teamIds : [];
  const tiers = [{ userId, scope: 'personal' }];
  if (effectiveAccess?.orgRole !== 'guest') tiers.push({ scope: 'organization', orgId });
  if (projectIds.length) tiers.push({ scope: 'project', memoryProjects: { some: { projectId: { in: projectIds } } } });
  if (teamIds.length) tiers.push({ scope: 'team', primaryTeamId: { in: teamIds } });
  return {
    orgId,
    deletedAt: null,
    OR: scopeFilter ? tiers.filter((tier) => tier.scope === scopeFilter) : tiers,
    ...((effectiveAccess?.orgRole === 'guest' || effectiveAccess?.crossProject === false)
      ? { NOT: { tags: { has: 'scope:cross-project' } } } : {}),
  };
}

function dedupeRows(rows = []) {
  const winners = new Map();
  for (const row of rows) {
    // Collapse only exact canonical-name duplicates or records with the same
    // verified primary email. Similar/substring names are not identity proof.
    const key = row._member
      ? `member:${row.id}`
      : (row.primaryEmail ? `email:${normalize(row.primaryEmail)}` : `name:${entitySlug(row.canonicalName)}`);
    const previous = winners.get(key);
    if (!previous) {
      winners.set(key, {
        ...row,
        entityIds: [...new Set([...(row.entityIds || []), row.id].filter(Boolean))],
        canonicalEntityIds: [...new Set([...(row.canonicalEntityIds || []), ...(row._canonical && row.id ? [row.id] : [])])],
      });
      continue;
    }
    const preferred = row._canonical && !previous._canonical ? row : previous;
    const secondary = preferred === row ? previous : row;
    winners.set(key, {
      ...secondary,
      ...preferred,
      aliases: [...new Set([
        ...(previous.aliases || []), previous.canonicalName,
        ...(row.aliases || []), row.canonicalName,
        previous.primaryEmail, row.primaryEmail,
      ].filter(Boolean))].filter((alias) => normalize(alias) !== normalize(preferred.canonicalName)),
      entityIds: [...new Set([...(previous.entityIds || [previous.id]), ...(row.entityIds || [row.id])].filter(Boolean))],
      canonicalEntityIds: [...new Set([...(previous.canonicalEntityIds || []), ...(row.canonicalEntityIds || []), ...(row._canonical && row.id ? [row.id] : [])])],
      mentionCount: Math.max(Number(previous.mentionCount || 0), Number(row.mentionCount || 0)),
      lastSeenAt: [previous.lastSeenAt, row.lastSeenAt].filter(Boolean).sort().at(-1) || null,
    });
  }
  return [...winners.values()];
}

async function authorizedCanonicalRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityIds, entityTypes }) {
  if (!prisma?.canonicalEntity || !prisma?.memoryEntityLink || !prisma?.memory) return [];
  const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
  const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
  const entities = await prisma.canonicalEntity.findMany({
    where: {
      organizationId: orgId,
      ...(ids.length ? { id: { in: ids } } : {}),
      ...(types.length ? { entityKind: { in: types } } : {}),
    },
    select: { id: true, canonicalName: true, normalizedName: true, entityKind: true, aliases: true, primaryEmail: true, updatedAt: true },
    orderBy: [{ updatedAt: 'desc' }, { canonicalName: 'asc' }, { id: 'asc' }],
    take: ids.length ? ids.length : MAX_CANDIDATES,
  });
  if (!entities.length) return [];

  // Memory rows can be resident in the tenant-aware graph store (including
  // the legacy `hm` schema), while canonical entities live in the canonical
  // registry schema.  Ask the store for the authorized inventory first so
  // this chooser never assumes both models share one Prisma schema.
  const listed = memoryStore?.listMemories
    ? await memoryStore.listMemories({
        user_id: userId,
        org_id: orgId,
        project_id: projectId || undefined,
        is_latest: true,
        limit: MAX_CANDIDATES,
        scope: scopeFilter ? `tier:${scopeFilter}` : 'all',
        access_context: accessContext,
      })
    : null;
  const visibleMemories = listed?.memories
    ? filterMemoryInventory(listed.memories, { scopeFilter, userId, accessContext, projectId })
      .map((memory) => ({ id: memory.id, createdAt: memory.created_at || memory.createdAt || null }))
    : await prisma.memory.findMany({
        where: visibleMemoryWhere({ orgId, userId, accessContext, projectId, scopeFilter }),
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_CANDIDATES,
      });
  if (!visibleMemories.length) return [];
  const memoryTimes = new Map(visibleMemories.map((memory) => [memory.id, memory.createdAt]));
  const links = await prisma.memoryEntityLink.findMany({
    where: {
      entityId: { in: entities.map((entity) => entity.id) },
      memoryId: { in: visibleMemories.map((memory) => memory.id) },
    },
    select: { entityId: true, memoryId: true },
  });
  const stats = new Map();
  for (const link of links) {
    const seen = stats.get(link.entityId) || { mentionCount: 0, lastSeenAt: null };
    seen.mentionCount += 1;
    const occurredAt = memoryTimes.get(link.memoryId);
    if (occurredAt && (!seen.lastSeenAt || occurredAt > seen.lastSeenAt)) seen.lastSeenAt = occurredAt;
    stats.set(link.entityId, seen);
  }
  return entities
    .filter((entity) => stats.has(entity.id))
    .map((entity) => ({
      id: entity.id,
      canonicalName: entity.canonicalName,
      entityType: entity.entityKind,
      aliases: [...new Set([...(entity.aliases || []), entity.primaryEmail].filter(Boolean))],
      primaryEmail: entity.primaryEmail || null,
      mentionCount: stats.get(entity.id).mentionCount,
      lastSeenAt: stats.get(entity.id).lastSeenAt || entity.updatedAt,
      _canonical: true,
    }));
}

async function authorizedTagRows({ memoryStore, orgId, userId, accessContext, projectId, scopeFilter, tagSlugs = [], entityTypes = [] }) {
  if (!memoryStore?.listMemories) return [];
  if (entityTypes.length && !entityTypes.includes('entity')) return [];
  const listed = await memoryStore.listMemories({
    user_id: userId,
    org_id: orgId,
    project_id: projectId || undefined,
    is_latest: true,
    limit: MAX_CANDIDATES,
    scope: scopeFilter ? `tier:${scopeFilter}` : 'all',
    access_context: accessContext,
  });
  const wanted = new Set(tagSlugs);
  const stats = new Map();
  for (const memory of filterMemoryInventory(listed?.memories, { scopeFilter, userId, accessContext, projectId })) {
    for (const tag of memory?.tags || []) {
      if (typeof tag !== 'string' || !tag.startsWith('entity:')) continue;
      const slug = entitySlug(tag.slice('entity:'.length));
      if (!slug || (wanted.size && !wanted.has(slug))) continue;
      const current = stats.get(slug) || {
        id: `tag:${slug}`,
        canonicalName: displayTagEntity(slug, memory),
        entityType: 'entity',
        aliases: [],
        mentionCount: 0,
        lastSeenAt: null,
        _tag: true,
      };
      current.mentionCount += 1;
      const occurredAt = memory.created_at || memory.createdAt || null;
      if (occurredAt && (!current.lastSeenAt || new Date(occurredAt) > new Date(current.lastSeenAt))) current.lastSeenAt = occurredAt;
      stats.set(slug, current);
    }
  }
  return [...stats.values()];
}

async function authorizedMemberRows({ prisma, orgId, memberIds = [], entityTypes = [], scopeFilter = null }) {
  if (!prisma?.userOrganization) return [];
  if (scopeFilter && scopeFilter !== 'organization' && scopeFilter !== 'team' && scopeFilter !== 'project') return [];
  const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
  if (types.length && !types.includes('person') && !types.includes('user')) return [];
  const ids = [...new Set((memberIds || []).map(String).filter(Boolean))];
  const memberships = await prisma.userOrganization.findMany({
    where: {
      orgId,
      isActive: true,
      ...(ids.length ? { userId: { in: ids } } : {}),
    },
    select: {
      userId: true,
      role: true,
      joinedAt: true,
      user: { select: { displayName: true, email: true, updatedAt: true } },
    },
    take: ids.length ? ids.length : MAX_CANDIDATES,
  });
  return memberships
    .filter((membership) => membership.user?.displayName || membership.user?.email)
    .map((membership) => {
      const email = String(membership.user?.email || '').trim();
      const emailName = email.split('@')[0] || '';
      return {
        id: `member:${membership.userId}`,
        canonicalName: membership.user?.displayName || emailName,
        entityType: 'person',
        aliases: [...new Set([emailName, email].filter(Boolean))],
        mentionCount: 0,
        lastSeenAt: membership.user?.updatedAt || membership.joinedAt || null,
        _member: true,
      };
    });
}

async function authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityIds, entityTypes, query = null, indexedCanonical = false, limit = MAX_LIMIT }) {
  if (!prisma) return { rows: [], degraded: 'entity_index_unavailable' };
  try {
    const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
    const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
    const tagSlugs = ids.filter((id) => id.startsWith('tag:')).map((id) => entitySlug(id.slice(4))).filter(Boolean);
    const memberIds = ids.filter((id) => id.startsWith('member:')).map((id) => id.slice('member:'.length)).filter(Boolean);
    const registryIds = ids.filter((id) => !id.startsWith('tag:') && !id.startsWith('member:'));
    const onlyNonRegistryIds = ids.length > 0 && registryIds.length === 0;
    const indexedRows = indexedCanonical && !ids.length && query
      ? await authorizedIndexedCanonicalRows({
          prisma,
          orgId,
          userId,
          accessContext,
          projectId,
          scopeFilter,
          entityTypes: types,
          query,
          limit,
        })
      : null;
    // Each registry is an optional projection of the same tenant-authorized
    // inventory. A stale legacy table or a transient canonical query must not
    // turn a healthy tag/member discovery path into a 503 for the entire UI.
    const legacy = typeof prisma.entity?.findMany === 'function' && !onlyNonRegistryIds
      ? prisma.entity.findMany({
          where: {
            orgId,
            isActive: true,
            ...(registryIds.length ? { id: { in: registryIds } } : {}),
            ...(types.length ? { entityType: { in: types } } : {}),
            mentions: { some: visibilityWhere({ orgId, userId, accessContext, projectId, scopeFilter }) },
          },
          select: { id: true, canonicalName: true, entityType: true, aliases: true, mentionCount: true, lastSeenAt: true },
          orderBy: [{ mentionCount: 'desc' }, { lastSeenAt: 'desc' }, { canonicalName: 'asc' }, { id: 'asc' }],
          take: registryIds.length ? registryIds.length : MAX_CANDIDATES,
        })
      : Promise.resolve([]);
    const sources = await Promise.allSettled([
      legacy,
      onlyNonRegistryIds
        ? Promise.resolve([])
        : indexedRows !== null
          ? Promise.resolve(indexedRows)
          : authorizedCanonicalRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityIds: registryIds, entityTypes: types }),
      // Discovery without an ID may enumerate tag-backed entities. Resolution
      // of a canonical/legacy ID must not: passing an empty tag-slug list used
      // to append every tenant tag as an additional selected entity, silently
      // turning a two-entity `must` request into an impossible predicate.
      (tagSlugs.length || ids.length === 0)
        ? authorizedTagRows({ memoryStore, orgId, userId, accessContext, projectId, scopeFilter, tagSlugs, entityTypes: types })
        : Promise.resolve([]),
      (memberIds.length || ids.length === 0)
        ? authorizedMemberRows({ prisma, orgId, memberIds, entityTypes: types, scopeFilter })
        : Promise.resolve([]),
    ]);
    const rows = sources.flatMap((source) => source.status === 'fulfilled' ? source.value : []);
    // Degrade only when every available authorized inventory failed. An empty
    // but healthy inventory is a valid zero-match result, not an outage.
    const allFailed = sources.length > 0 && sources.every((source) => source.status === 'rejected');
    return { rows: dedupeRows(rows), degraded: allFailed ? 'entity_index_unavailable' : null };
  } catch {
    return { rows: [], degraded: 'entity_index_unavailable' };
  }
}

export async function findEntities({ prisma, memoryStore = null, orgId, userId, query, entityTypes = [], limit = MAX_LIMIT, accessContext = {}, projectId = null, scope = null, recallQualityMode = 'off' } = {}) {
  if (!String(query || '').trim()) return { matches: [], degraded: null };
  const { scopeFilter, error } = normalizeEntityScope(scope);
  if (error) return { matches: [], degraded: null, error };
  const mode = ['shadow', 'on'].includes(recallQualityMode) ? recallQualityMode : 'off';
  const baselinePromise = authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityTypes, query, limit });
  if (mode === 'off') {
    const { rows, degraded } = await baselinePromise;
    if (degraded) return { matches: [], degraded };
    return { matches: rankEntityMatches(rows, query, limit), degraded: null, strategy: 'bounded_inventory' };
  }

  const indexedPromise = authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityTypes, query, limit, indexedCanonical: true });
  const [baseline, indexed] = await Promise.all([baselinePromise, indexedPromise]);
  if (mode === 'shadow') {
    const baselineMatches = baseline.degraded ? [] : rankEntityMatches(baseline.rows, query, limit);
    const indexedMatches = indexed.degraded ? [] : rankEntityMatches(indexed.rows, query, limit);
    console.info('[entity-discovery-shadow]', JSON.stringify({
      org_id: orgId,
      query_length: String(query).length,
      baseline_ids: baselineMatches.map((match) => match.entity_id),
      indexed_ids: indexedMatches.map((match) => match.entity_id),
    }));
    if (baseline.degraded) return { matches: [], degraded: baseline.degraded };
    return { matches: baselineMatches, degraded: null, strategy: 'bounded_inventory', shadow_strategy: 'indexed_alias' };
  }

  const selected = indexed.degraded ? baseline : indexed;
  const strategy = indexed.degraded ? 'bounded_inventory_fallback' : 'indexed_alias';
  const { rows, degraded } = selected;
  if (degraded) return { matches: [], degraded };
  return { matches: rankEntityMatches(rows, query, limit), degraded: null, strategy };
}

export async function resolveAuthorizedEntityIds({ prisma, memoryStore = null, orgId, userId, entityIds, accessContext = {}, projectId = null } = {}) {
  const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
  const selected = await authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds: ids });
  if (selected.degraded || !selected.rows.length || !prisma?.canonicalEntity?.findMany) {
    return {
      entities: selected.rows.map((entity) => ({
        id: entity.id,
        entityIds: entity.entityIds || [entity.id],
        canonicalEntityIds: entity.canonicalEntityIds || [],
        canonicalName: entity.canonicalName,
        aliases: entity.aliases || [],
      })),
      degraded: selected.degraded,
    };
  }

  // The chooser can return one representative for duplicate rows. Expand only
  // exact-name duplicates or records sharing a verified primary email, then
  // re-run the full authorized-memory intersection for every sibling ID.
  const requestedNames = selected.rows.filter((entity) => !entity.primaryEmail).map((entity) => entity.canonicalName).filter(Boolean);
  const requestedEmails = selected.rows.map((entity) => entity.primaryEmail).filter(Boolean);
  const identityFilters = [
    ...requestedNames.map((name) => ({ canonicalName: { equals: name, mode: 'insensitive' } })),
    ...requestedEmails.map((email) => ({ primaryEmail: email })),
  ];
  if (!identityFilters.length) return { entities: [], degraded: null };

  try {
    const siblings = await prisma.canonicalEntity.findMany({
      where: { organizationId: orgId, OR: identityFilters },
      select: { id: true, canonicalName: true, primaryEmail: true },
      take: MAX_LIMIT,
    });
    const siblingIds = [...new Set([
      ...ids,
      ...siblings.filter((candidate) => selected.rows.some((source) => {
        const sameEmail = source.primaryEmail && candidate.primaryEmail
          && normalize(source.primaryEmail) === normalize(candidate.primaryEmail);
        const sameUnverifiedNameOnly = !source.primaryEmail && !candidate.primaryEmail
          && normalize(source.canonicalName) === normalize(candidate.canonicalName);
        return sameEmail || sameUnverifiedNameOnly;
      })).map((entity) => entity.id),
    ])].slice(0, MAX_LIMIT);
    const authorized = await authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds: siblingIds });
    if (authorized.degraded) return { entities: [], degraded: authorized.degraded };
    const rows = dedupeRows(authorized.rows);
    return {
      entities: rows.map((entity) => ({
        id: entity.id,
        entityIds: entity.entityIds || [entity.id],
        canonicalEntityIds: entity.canonicalEntityIds || [],
        canonicalName: entity.canonicalName,
        aliases: entity.aliases || [],
        primaryEmail: entity.primaryEmail || null,
      })),
      degraded: null,
    };
  } catch {
    // The original ID was already authorized. Expansion is additive and may
    // fail without turning a valid selected entity into an error.
    return {
      entities: selected.rows.map((entity) => ({
        id: entity.id,
        entityIds: entity.entityIds || [entity.id],
        canonicalEntityIds: entity.canonicalEntityIds || [],
        canonicalName: entity.canonicalName,
        aliases: entity.aliases || [],
      })),
      degraded: null,
    };
  }
}
