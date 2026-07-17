function documentIdOf(memory) {
  const row = memory?.memory || memory;
  const metadata = row?.source_metadata || row?.sourceMetadata || {};
  if (metadata.document_id || metadata.documentId) {
    return metadata.document_id || metadata.documentId;
  }
  const tag = (row?.tags || []).find((value) => typeof value === 'string' && value.startsWith('doc-id:'));
  return tag ? tag.slice('doc-id:'.length) : null;
}

export function filterMemoriesByDocumentIds(memories = [], documentIds = []) {
  const allowed = new Set(documentIds.filter(Boolean));
  if (allowed.size === 0) return [];
  return memories.filter((memory) => allowed.has(documentIdOf(memory)));
}
