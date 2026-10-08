/** Self-owned portable records, paged without silently truncating rows. */
export async function collectOwnedRecords(model, query, { batchSize = 250, maxBytes = 20 * 1024 * 1024, budget = { bytes: 0 }, allowRow = () => true } = {}) {
  const records = [];
  let cursor;
  while (true) {
    const page = await model.findMany({ ...query, orderBy: { id: 'asc' }, take: batchSize, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const row of page) {
      if (!allowRow(row)) continue;
      budget.bytes += Buffer.byteLength(JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      if (budget.bytes > maxBytes) throw Object.assign(new Error('Export exceeds the synchronous download limit; no partial export was produced'), { status: 413 });
      records.push(row);
    }
    if (page.length < batchSize) return records;
    cursor = page.at(-1).id;
  }
}
export async function exportAccountRecords(prisma, userId) {
  const budget = { bytes: 0 };
  const read = (model, query, options = {}) => collectOwnedRecords(prisma[model], query, { budget, ...options });
  const profile = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, avatarUrl: true, timezone: true, locale: true, createdAt: true, updatedAt: true } });
  if (!profile) throw Object.assign(new Error('Account not found'), { status: 404 });
  const memories = await read('memory', { where: { userId, scope: 'personal' } });
  const documentRows = await read('knowledgeDocument', { where: { userId, tags: { has: `scope-key:personal:${userId}` } }, select: { id: true, userId: true, title: true, documentType: true, sourceArtifactId: true, tags: true, sourcePlatform: true, sourceId: true, sourceUrl: true, documentDate: true, language: true, wordCount: true, createdAt: true, updatedAt: true } }, { allowRow: row => (row.tags || []).includes(`scope-key:personal:${userId}`) && !(row.tags || []).some(tag => /^scope-key:(org|organization|project|team)(:|$)/.test(tag)) });
  const documents = documentRows.map(({ tags, sourceArtifactId, ...record }) => record);
  const sourceIds = [...new Set(documentRows.map(row => row.sourceArtifactId).filter(Boolean))];
  const originalFiles = sourceIds.length ? await read('sourceArtifact', {
    where: { userId, id: { in: sourceIds }, documents: { every: { userId, tags: { has: `scope-key:personal:${userId}` } } } },
    select: { id: true, artifactType: true, contentType: true, sizeBytes: true, checksum: true, createdAt: true, documents: { select: { tags: true } } },
  }, { allowRow: row => Array.isArray(row.documents) && row.documents.length > 0 && row.documents.every(doc => (doc.tags || []).includes(`scope-key:personal:${userId}`) && !(doc.tags || []).some(tag => /^scope-key:(org|organization|project|team)(:|$)/.test(tag))) }) : [];
  const originalFileInventory = originalFiles.map(({ documents: sourceDocuments, ...row }) => ({ ...row, bytesIncluded: false, availability: 'not_verified', reason: 'Stored source metadata does not establish retained original bytes; ingestion staging objects may already be removed.' }));
  const sections = await read('knowledgeSegment', { where: { document: { userId }, documentId: { in: documents.map(row => row.id) } } });
  const profiles = await read('userProfile', { where: { userId, orgId: null } });
  const connectors = await read('platformIntegration', { where: { userId }, select: { id: true, platformType: true, platformUserId: true, platformDisplayName: true, oauthScopes: true, isActive: true, lastSyncedAt: true, syncStatus: true } });
  const sessions = await read('harnessSession', { where: { userId, scopeKind: 'personal' } });
  const events = await read('harnessSessionEvent', { where: { userId, session: { userId, scopeKind: 'personal' } } });
  const audit = await read('auditLog', { where: { userId, organizationId: null } });
  return {
    format: 'hivemind-account-records-v1', exported_at: new Date().toISOString(), user_id: userId,
    completeness: 'listed_record_categories',
    included: ['profile', 'memories', 'document_metadata', 'original_file_inventory', 'document_sections', 'derived_profile', 'connector_metadata', 'personal_native_sessions', 'personal_native_events', 'audit'],
    excluded: ['credentials_and_tokens', 'original_file_bytes', 'provider_and_backup_copies', 'organization_project_team_records', 'organization_agent_conversations', 'unlisted_record_categories'],
    profile, memories, documents, sections, profiles, connectors, sessions, events, audit, originalFileInventory,
  };
}
