// Indexed, tenant-scoped entity directory. This is a fast chooser before
// recall, never a retrieval lane: it returns stable canonical entity IDs from
// ResourceEntityLink visibility, without scanning memories or legacy tags.

const MAX_LIMIT = 25;
const MAX_QUERY_CANDIDATES = 100;

const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
const words = (value) => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function matchKind(entity, query) {
  const q = normalize(query);
  if (!q) return null;
  const canonical = normalize(entity.canonicalName);
  const aliases = (entity.aliases || []).map(normalize).filter(Boolean);
  const terms = new Set((entity.searchTerms || []).map(normalize).filter(Boolean));
  if (canonical === q) return 'canonical_exact';
  if (aliases.includes(q)) return 'alias_exact';
  if (terms.has(q)) return 'token_exact';
  const queryWords = words(query).filter((word) => word.length >= 2);
  const canonicalWords = words(entity.canonicalName);
  const aliasWords = aliases.flatMap(words);
  if (queryWords.some((queryWord) => canonicalWords.some((word) => word.startsWith(queryWord)))) return 'canonical_prefix';
  if (queryWords.some((queryWord) => aliasWords.some((word) => word.startsWith(queryWord)))) return 'alias_prefix';
  if (q.length >= 4 && (canonical.includes(q) || aliases.some((alias) => alias.includes(q)))) return 'substring';
  return null;
}

const MATCH_ORDER = Object.freeze({
  canonical_exact: 0, alias_exact: 1, token_exact: 2,
  canonical_prefix: 3, alias_prefix: 4, substring: 5,
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
      entity_id: entity.id, canonical_name: entity.canonicalName,
      entity_type: entity.entityType, aliases: entity.aliases || [], match,
      mention_count: Number(entity.mentionCount || 0), last_seen_at: entity.lastSeenAt || null,
    }));
}

function normalizedScope(accessContext = {}, projectId = null, scope = null) {
  const projectIds = new Set((accessContext.projectIds || []).map(String));
  const teamIds = new Set((accessContext.teamIds || []).map(String));
  if (projectId) projectIds.add(String(projectId));
  const requested = scope && typeof scope === 'object' ? scope : null;
  if (requested?.type === 'project' && requested.id) projectIds.add(String(requested.id));
  if (requested?.type === 'team' && requested.id) teamIds.add(String(requested.id));
  return { requested, projectIds: [...projectIds], teamIds: [...teamIds] };
}

function visibleResourceWhere({ orgId, userId, accessContext = {}, projectId = null, scope = null }) {
  const role = normalize(accessContext.orgRole);
  const privileged = role === 'owner' || role === 'admin';
  const { requested, projectIds, teamIds } = normalizedScope(accessContext, projectId, scope);
  const base = { organizationId: orgId };
  if (requested?.type === 'personal') return { ...base, scopeType: 'personal', userId };
  if (requested?.type === 'organization') {
    return role === 'guest' ? { ...base, id: '__denied__' } : { ...base, scopeType: 'organization' };
  }
  if (requested?.type === 'project') {
    const id = String(requested.id || projectId || '');
    if (!id || (!privileged && !projectIds.includes(id))) return { ...base, id: '__denied__' };
    return { ...base, scopeType: 'project', scopeId: id };
  }
  if (requested?.type === 'team') {
    const id = String(requested.id || '');
    if (!id || (!privileged && !teamIds.includes(id))) return { ...base, id: '__denied__' };
    return { ...base, scopeType: 'team', scopeId: id };
  }
  if (projectId) {
    const id = String(projectId);
    if (!privileged && !projectIds.includes(id)) return { ...base, id: '__denied__' };
    return { ...base, scopeType: 'project', scopeId: id };
  }
  if (privileged) return base;
  const OR = [{ scopeType: 'personal', userId }];
  if (role !== 'guest') OR.push({ scopeType: 'organization' });
  if (projectIds.length) OR.push({ scopeType: 'project', scopeId: { in: projectIds } });
  if (teamIds.length) OR.push({ scopeType: 'team', scopeId: { in: teamIds } });
  return { ...base, OR };
}

function entityWhere({ orgId, query = null, entityIds = [], entityTypes = [], resourceWhere }) {
  const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
  const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
  const q = normalize(query);
  return {
    organizationId: orgId,
    ...(ids.length ? { id: { in: ids } } : {}),
    ...(types.length ? { entityKind: { in: types } } : {}),
    ...(q ? { OR: [
      { normalizedName: { startsWith: q } },
      { canonicalName: { contains: q, mode: 'insensitive' } },
      { searchTerms: { has: q } },
    ] } : {}),
    resourceLinks: { some: resourceWhere },
  };
}

async function authorizedEntityRows({ prisma, orgId, userId, query = null, accessContext,
  projectId, scope, entityIds, entityTypes, limit = 12 }) {
  if (!prisma?.canonicalEntity || !prisma?.resourceEntityLink) {
    return { rows: [], degraded: 'entity_index_unavailable' };
  }
  try {
    const resourceWhere = visibleResourceWhere({ orgId, userId, accessContext, projectId, scope });
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 12, MAX_LIMIT));
    const entities = await prisma.canonicalEntity.findMany({
      where: entityWhere({ orgId, query, entityIds, entityTypes, resourceWhere }),
      select: {
        id: true, canonicalName: true, entityKind: true, aliases: true,
        searchTerms: true, updatedAt: true,
        resourceLinks: {
          where: resourceWhere, select: { knownAt: true },
          orderBy: [{ knownAt: 'desc' }, { id: 'asc' }], take: MAX_QUERY_CANDIDATES,
        },
      },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      take: query ? Math.min(MAX_QUERY_CANDIDATES, requestedLimit * 4) : requestedLimit,
    });
    return {
      rows: entities.map((entity) => ({
        id: entity.id, canonicalName: entity.canonicalName, entityType: entity.entityKind,
        aliases: entity.aliases || [], searchTerms: entity.searchTerms || [],
        mentionCount: entity.resourceLinks.length,
        lastSeenAt: entity.resourceLinks[0]?.knownAt || entity.updatedAt,
      })),
      degraded: null,
    };
  } catch (error) {
    return { rows: [], degraded: 'entity_index_unavailable', error: error?.message };
  }
}

export async function findEntities({ prisma, orgId, userId, query, entityTypes = [], limit = 12,
  accessContext = {}, projectId = null, scope = null } = {}) {
  if (!String(query || '').trim()) return { matches: [], degraded: null };
  const { rows, degraded } = await authorizedEntityRows({
    prisma, orgId, userId, query, accessContext, projectId, scope, entityTypes, limit,
  });
  if (degraded) return { matches: [], degraded };
  return { matches: rankEntityMatches(rows, query, limit), degraded: null };
}

export async function resolveAuthorizedEntityIds({ prisma, orgId, userId, entityIds,
  accessContext = {}, projectId = null, scope = null } = {}) {
  const { rows, degraded } = await authorizedEntityRows({
    prisma, orgId, userId, accessContext, projectId, scope, entityIds, limit: MAX_LIMIT,
  });
  return { entities: rows.map((entity) => ({ id: entity.id, canonicalName: entity.canonicalName })), degraded };
}
