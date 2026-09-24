const normalizeSourceLabel = (value) => String(value || '').trim().toLocaleLowerCase();
const entitySlug = (value) => normalizeSourceLabel(value)
  .replace(/[^\p{L}\p{N}]+/gu, '-')
  .replace(/^-+|-+$/g, '');
const memoryRowId = (memory = {}) => memory.id || memory.memory?.id || null;

/**
 * Enforce selected canonical identity groups without conflating aliases with
 * separate selected people. Within each group, a verified link or exact alias
 * is OR; across groups, each separately selected identity is required.
 */
export function filterMemoriesByEntities(memories = [], entities = [], {
  mode = 'must',
  strictEntitySelection = false,
  entityGroups = [],
  entityLinkGroupMatches = null,
} = {}) {
  const groups = (entityGroups || []).map((group) => ({
    names: [...new Set((group?.names || []).map(normalizeSourceLabel).filter(Boolean))],
    entityIds: [...new Set((Array.isArray(group?.canonical_entity_ids)
      ? group.canonical_entity_ids
      : (group?.entity_ids || group?.entityIds || [])).map(String).filter(Boolean))],
  })).filter((group) => group.names.length || group.entityIds.length);
  const wanted = [...new Set((entities || []).map(normalizeSourceLabel).filter(Boolean))];
  if (groups.length && mode !== 'off' && mode !== 'should') {
    return memories.filter((memory) => {
      const memoryId = memoryRowId(memory);
      const linked = entityLinkGroupMatches instanceof Map ? (entityLinkGroupMatches.get(memoryId) || new Set()) : new Set();
      const rawTags = [...(memory?.tags || memory?.memory?.tags || [])].map((tag) => String(tag || ''));
      const entityTags = new Set(rawTags.filter((tag) => tag.toLowerCase().startsWith('entity:'))
        .map((tag) => entitySlug(tag.slice('entity:'.length))).filter(Boolean));
      const metadata = memory?.source_metadata || memory?.sourceMetadata || memory?.memory?.source_metadata || {};
      const metadataEntities = [
        ...(Array.isArray(metadata.entities) ? metadata.entities : []),
        ...(Array.isArray(memory?.entities) ? memory.entities : []),
        memory?.claimSubject, memory?.claim_subject,
      ].map(normalizeSourceLabel).filter(Boolean);
      return groups.every((group) => {
        if (group.entityIds.some((id) => linked.has(id))) return true;
        return group.names.some((name) => rawTags.some((tag) => normalizeSourceLabel(tag) === `entity:${name}`)
          || entityTags.has(entitySlug(name))
          || metadataEntities.some((candidate) => candidate === name || entitySlug(candidate) === entitySlug(name))
          || (!strictEntitySelection && metadataEntities.some((candidate) => candidate.includes(name) || name.includes(candidate))));
      });
    });
  }
  if (!wanted.length || mode === 'off' || mode === 'should') return [...memories];
  return memories.filter((memory) => {
    const stored = memory?.memory || {};
    const rawTags = [...(memory?.tags || stored?.tags || [])].map((tag) => String(tag || ''));
    const tags = rawTags.map((tag) => normalizeSourceLabel(tag));
    const entityTags = new Set(rawTags
      .filter((tag) => tag.toLocaleLowerCase().startsWith('entity:'))
      .map((tag) => entitySlug(tag.slice('entity:'.length)))
      .filter(Boolean));
    const metadata = memory?.source_metadata || memory?.sourceMetadata || stored?.source_metadata || {};
    const metadataEntities = [
      ...(Array.isArray(metadata.entities) ? metadata.entities : []),
      ...(Array.isArray(memory?.entities) ? memory.entities : []),
      memory?.claimSubject, memory?.claim_subject,
    ].map(normalizeSourceLabel).filter(Boolean);
    const searchable = [memory?.title, stored?.title, memory?.content, stored?.content]
      .map((value) => typeof value === 'string' ? value : '')
      .join(' ').normalize('NFKC').toLocaleLowerCase();
    const matches = wanted.map((entity) => {
      const slug = entitySlug(entity);
      const exactIdentity = tags.includes(`entity:${entity}`)
        || entityTags.has(slug)
        || metadataEntities.some((candidate) => candidate === entity || entitySlug(candidate) === slug);
      if (exactIdentity || strictEntitySelection) return exactIdentity;
      // Free-text recall retains compatibility for old memories with no links.
      return metadataEntities.some((candidate) => candidate.includes(entity) || entity.includes(candidate))
        || searchable.includes(entity);
    });
    return mode === 'any' ? matches.some(Boolean) : matches.every(Boolean);
  });
}

export async function loadSelectedEntityLinkMatches(prisma, entityGroups = [], memories = []) {
  if (!prisma?.memoryEntityLink?.findMany || !entityGroups.length || !memories.length) return new Map();
  const memoryIds = [...new Set(memories.map(memoryRowId).filter(Boolean))].slice(0, 5000);
  const entityGroupById = new Map();
  entityGroups.forEach((group, index) => {
    for (const id of (Array.isArray(group?.canonical_entity_ids)
      ? group.canonical_entity_ids
      : (group?.entity_ids || group?.entityIds || []))) {
      const entityId = String(id || '');
      if (entityId) entityGroupById.set(entityId, index);
    }
  });
  if (!memoryIds.length || !entityGroupById.size) return new Map();
  try {
    const links = await prisma.memoryEntityLink.findMany({
      where: { memoryId: { in: memoryIds }, entityId: { in: [...entityGroupById.keys()] } },
      select: { memoryId: true, entityId: true },
      take: Math.min(12000, memoryIds.length * Math.min(entityGroupById.size, 12)),
    });
    const matches = new Map();
    for (const link of links) {
      if (!entityGroupById.has(String(link.entityId))) continue;
      const key = String(link.memoryId);
      if (!matches.has(key)) matches.set(key, new Set());
      matches.get(key).add(String(link.entityId));
    }
    return matches;
  } catch {
    // Names/tags remain available if this optional evidence lookup fails.
    return new Map();
  }
}
