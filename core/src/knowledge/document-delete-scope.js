/** Build a tenant-safe and project-safe memory lookup for document deletion. */
export function projectScopedAnchorFilter({ orgId, documentTags = [], anchorTags = [] }) {
  const scopeTag = (Array.isArray(documentTags) ? documentTags : [])
    .find((tag) => String(tag).startsWith('scope-key:project:'));
  return {
    orgId,
    deletedAt: null,
    AND: [
      { tags: { hasSome: anchorTags } },
      ...(scopeTag ? [{ tags: { has: scopeTag } }] : []),
    ],
  };
}
