// Tenant-scoped lexical entity discovery. This is a chooser before recall,
// not another retrieval lane: callers select a canonical entity, then pass its
// name into the existing RetrievalSpec entity predicate.

const MAX_CANDIDATES = 1000;
const MAX_LIMIT = 25;

const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
const words = (value) => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

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

async function authorizedEntityRows({ prisma, orgId, userId, accessContext, projectId, entityIds, entityTypes }) {
  if (!prisma?.entity) return { rows: [], degraded: 'entity_index_unavailable' };
  try {
    const types = [...new Set((entityTypes || []).map(normalize).filter(Boolean))];
    const ids = [...new Set((entityIds || []).map(String).filter(Boolean))].slice(0, MAX_LIMIT);
    const rows = await prisma.entity.findMany({
      where: {
        orgId,
        isActive: true,
        ...(ids.length ? { id: { in: ids } } : {}),
        ...(types.length ? { entityType: { in: types } } : {}),
        mentions: { some: visibilityWhere({ orgId, userId, accessContext, projectId }) },
      },
      select: { id: true, canonicalName: true, entityType: true, aliases: true, mentionCount: true, lastSeenAt: true },
      orderBy: [{ mentionCount: 'desc' }, { lastSeenAt: 'desc' }, { canonicalName: 'asc' }, { id: 'asc' }],
      take: ids.length ? ids.length : MAX_CANDIDATES,
    });
    return { rows, degraded: null };
  } catch {
    return { rows: [], degraded: 'entity_index_unavailable' };
  }
}

export async function findEntities({ prisma, orgId, userId, query, entityTypes = [], limit = 12, accessContext = {}, projectId = null } = {}) {
  if (!String(query || '').trim()) return { matches: [], degraded: null };
  const { rows, degraded } = await authorizedEntityRows({ prisma, orgId, userId, accessContext, projectId, entityTypes });
  if (degraded) return { matches: [], degraded };
  return { matches: rankEntityMatches(rows, query, limit), degraded: null };
}

export async function resolveAuthorizedEntityIds({ prisma, orgId, userId, entityIds, accessContext = {}, projectId = null } = {}) {
  const { rows, degraded } = await authorizedEntityRows({ prisma, orgId, userId, accessContext, projectId, entityIds });
  return { entities: rows.map((entity) => ({ id: entity.id, canonicalName: entity.canonicalName })), degraded };
}
