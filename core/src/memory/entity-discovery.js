// Tenant-scoped lexical entity discovery. This is a chooser before recall,
// not another retrieval lane: callers select a canonical entity, then pass its
// name into the existing RetrievalSpec entity predicate.

const MAX_CANDIDATES = 1000;
const MAX_LIMIT = 25;

const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
const words = (value) => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const entitySlug = (value) => normalize(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

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
  return null;
}

const MATCH_ORDER = Object.freeze({
  canonical_exact: 0,
  alias_exact: 1,
  canonical_prefix: 2,
  alias_prefix: 3,
  substring: 4,
});

export function rankEntityMatches(entities, query, limit = 12) {
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

function visibilityWhere({ orgId, userId, accessContext = {}, projectId = null }) {
  const role = String(accessContext?.orgRole || '').toLowerCase();
  const privileged = role === 'owner' || role === 'admin';
  const projectTags = (accessContext?.projectIds || []).map((id) => `scope-key:project:${id}`);
  const document = {
    orgId,
    archivedAt: null,
    ...(projectId ? { tags: { has: `scope-key:project:${projectId}` } } : {}),
    ...(!projectId && !privileged ? { OR: [
      { userId },
      { tags: { hasSome: [`scope-key:org:${orgId}`, 'scope-key:organization'] } },
      { tags: { has: `scope-key:personal:${userId}` } },
      ...(projectTags.length ? [{ tags: { hasSome: projectTags } }] : []),
    ] } : {}),
  };
  const effectiveAccess = projectId ? { ...accessContext, projectIds: [projectId] } : accessContext;
  const projectIds = Array.isArray(effectiveAccess?.projectIds) ? effectiveAccess.projectIds : [];
  const teamIds = Array.isArray(effectiveAccess?.teamIds) ? effectiveAccess.teamIds : [];
  const tiers = [{ userId, scope: 'personal' }];
  if (effectiveAccess?.orgRole !== 'guest') tiers.push({ scope: 'organization', orgId });
  if (projectIds.length) tiers.push({ scope: 'project', memoryProjects: { some: { projectId: { in: projectIds } } } });
  if (teamIds.length) tiers.push({ scope: 'team', primaryTeamId: { in: teamIds } });
  const memory = {
    orgId,
    deletedAt: null,
    OR: tiers,
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
function visibleMemoryWhere({ orgId, userId, accessContext = {}, projectId = null }) {
  const effectiveAccess = projectId ? { ...accessContext, projectIds: [projectId] } : accessContext;
  const projectIds = Array.isArray(effectiveAccess?.projectIds) ? effectiveAccess.projectIds : [];
  const teamIds = Array.isArray(effectiveAccess?.teamIds) ? effectiveAccess.teamIds : [];
  const tiers = [{ userId, scope: 'personal' }];
  if (effectiveAccess?.orgRole !== 'guest') tiers.push({ scope: 'organization', orgId });
  if (projectIds.length) tiers.push({ scope: 'project', memoryProjects: { some: { projectId: { in: projectIds } } } });
  if (teamIds.length) tiers.push({ scope: 'team', primaryTeamId: { in: teamIds } });
  return {
    orgId,
    deletedAt: null,
    OR: tiers,
    ...((effectiveAccess?.orgRole === 'guest' || effectiveAccess?.crossProject === false)
      ? { NOT: { tags: { has: 'scope:cross-project' } } } : {}),
  };
}

function dedupeRows(rows = []) {
  const winners = new Map();
  for (const row of rows) {
    const key = `${normalize(row.entityType)}\u0000${normalize(row.canonicalName)}`;
    const previous = winners.get(key);
    // Canonical links are written by the current ingestion path, so prefer
    // them on an otherwise identical entity identity.
    if (!previous || (row._canonical && !previous._canonical)) winners.set(key, row);
  }
  return [...winners.values()];
}

async function authorizedCanonicalRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds, entityTypes }) {
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
        scope: 'all',
        access_context: accessContext,
      })
    : null;
  const visibleMemories = listed?.memories
    ? listed.memories.map((memory) => ({ id: memory.id, createdAt: memory.created_at || memory.createdAt || null }))
    : await prisma.memory.findMany({
        where: visibleMemoryWhere({ orgId, userId, accessContext, projectId }),
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

async function authorizedTagRows({ memoryStore, orgId, userId, accessContext, projectId, tagSlugs = [], entityTypes = [] }) {
  if (!memoryStore?.listMemories) return [];
  if (entityTypes.length && !entityTypes.includes('entity')) return [];
  const listed = await memoryStore.listMemories({
    user_id: userId,
    org_id: orgId,
    project_id: projectId || undefined,
    is_latest: true,
    limit: MAX_CANDIDATES,
    scope: 'all',
    access_context: accessContext,
  });
  const wanted = new Set(tagSlugs);
  const stats = new Map();
  for (const memory of listed?.memories || []) {
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

async function authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds, entityTypes }) {
  if (!prisma) return { rows: [], degraded: 'entity_index_unavailable' };
  try {
    const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
    const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
    const tagSlugs = ids.filter((id) => id.startsWith('tag:')).map((id) => entitySlug(id.slice(4))).filter(Boolean);
    const registryIds = ids.filter((id) => !id.startsWith('tag:'));
    const onlyTagIds = ids.length > 0 && registryIds.length === 0;
    const legacy = prisma.entity && !onlyTagIds
      ? prisma.entity.findMany({
          where: {
            orgId,
            isActive: true,
            ...(registryIds.length ? { id: { in: registryIds } } : {}),
            ...(types.length ? { entityType: { in: types } } : {}),
            mentions: { some: visibilityWhere({ orgId, userId, accessContext, projectId }) },
          },
          select: { id: true, canonicalName: true, entityType: true, aliases: true, mentionCount: true, lastSeenAt: true },
          orderBy: [{ mentionCount: 'desc' }, { lastSeenAt: 'desc' }, { canonicalName: 'asc' }, { id: 'asc' }],
          take: registryIds.length ? registryIds.length : MAX_CANDIDATES,
        })
      : Promise.resolve([]);
    const [legacyRows, canonicalRows, tagRows] = await Promise.all([
      legacy,
      onlyTagIds
        ? Promise.resolve([])
        : authorizedCanonicalRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds: registryIds, entityTypes: types }),
      authorizedTagRows({ memoryStore, orgId, userId, accessContext, projectId, tagSlugs, entityTypes: types }),
    ]);
    return { rows: dedupeRows([...legacyRows, ...canonicalRows, ...(tagRows || [])]), degraded: null };
  } catch {
    return { rows: [], degraded: 'entity_index_unavailable' };
  }
}

export async function findEntities({ prisma, memoryStore = null, orgId, userId, query, entityTypes = [], limit = 12, accessContext = {}, projectId = null } = {}) {
  if (!String(query || '').trim()) return { matches: [], degraded: null };
  const { rows, degraded } = await authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityTypes });
  if (degraded) return { matches: [], degraded };
  return { matches: rankEntityMatches(rows, query, limit), degraded: null };
}

export async function resolveAuthorizedEntityIds({ prisma, memoryStore = null, orgId, userId, entityIds, accessContext = {}, projectId = null } = {}) {
  const { rows, degraded } = await authorizedEntityRows({ prisma, memoryStore, orgId, userId, accessContext, projectId, entityIds });
  return { entities: rows.map((entity) => ({ id: entity.id, canonicalName: entity.canonicalName })), degraded };
}
