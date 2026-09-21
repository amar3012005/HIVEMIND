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
      canonical_name: entity.canonicalName,
      entity_type: entity.entityType,
      aliases: entity.aliases || [],
      match,
      mention_count: Number(entity.mentionCount || 0),
      last_seen_at: entity.lastSeenAt || null,
    }));
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
    // All registries describe the same user-facing identity. Entity kind is
    // metadata, not part of identity: a tag-backed `entity:solvispia` and a
    // canonical `product / SolvisPia` must collapse into one chooser result.
    const key = entitySlug(row.canonicalName);
    const previous = winners.get(key);
    if (!previous) {
      winners.set(key, { ...row });
      continue;
    }
    const preferred = row._canonical && !previous._canonical ? row : previous;
    const secondary = preferred === row ? previous : row;
    winners.set(key, {
      ...secondary,
      ...preferred,
      aliases: [...new Set([...(previous.aliases || []), ...(row.aliases || [])])],
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
    select: { id: true, canonicalName: true, entityKind: true, aliases: true, updatedAt: true },
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
      aliases: entity.aliases || [],
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

async function authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityIds, entityTypes }) {
  if (!prisma) return { rows: [], degraded: 'entity_index_unavailable' };
  try {
    const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
    const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
    const tagSlugs = ids.filter((id) => id.startsWith('tag:')).map((id) => entitySlug(id.slice(4))).filter(Boolean);
    const memberIds = ids.filter((id) => id.startsWith('member:')).map((id) => id.slice('member:'.length)).filter(Boolean);
    const registryIds = ids.filter((id) => !id.startsWith('tag:') && !id.startsWith('member:'));
    const onlyNonRegistryIds = ids.length > 0 && registryIds.length === 0;
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

export async function findEntities({ prisma, memoryStore = null, orgId, userId, query, entityTypes = [], limit = MAX_LIMIT, accessContext = {}, projectId = null, scope = null } = {}) {
  if (!String(query || '').trim()) return { matches: [], degraded: null };
  const { scopeFilter, error } = normalizeEntityScope(scope);
  if (error) return { matches: [], degraded: null, error };
  const { rows, degraded } = await authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, scopeFilter, entityTypes });
  if (degraded) return { matches: [], degraded };
  return { matches: rankEntityMatches(rows, query, limit), degraded: null };
}

export async function resolveAuthorizedEntityIds({ prisma, memoryStore = null, orgId, userId, entityIds, accessContext = {}, projectId = null } = {}) {
  const { rows, degraded } = await authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds });
  return { entities: rows.map((entity) => ({ id: entity.id, canonicalName: entity.canonicalName })), degraded };
}
