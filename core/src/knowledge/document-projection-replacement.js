function uniqueIds(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

/** Capture the currently active document-backed projection before a forced run. */
export async function captureDocumentProjection(db, documentId) {
  if (!db?.memoryEvidenceLink || !documentId) return [];
  const rows = await db.memoryEvidenceLink.findMany({
    where: { documentId },
    select: { memoryId: true },
  });
  return uniqueIds(rows.map((row) => row.memoryId));
}

/**
 * Replace a document projection only after its successor is durable.
 *
 * Old memories supported by another document remain active and lose only this
 * document's link. Memories whose sole support was this document are removed
 * from semantic recall first, then atomically retired in PostgreSQL together
 * with their graph edges and obsolete evidence links.
 */
export async function reconcileDocumentProjection({
  db,
  vectorStore,
  documentId,
  previousMemoryIds = [],
  currentMemoryIds = [],
}) {
  const current = new Set(uniqueIds(currentMemoryIds));
  // Include links created and then retired by same-run consolidation. Those are
  // not part of the final memory receipt and must not survive as dead citations.
  const projectedRows = await db.memoryEvidenceLink.findMany({
    where: { documentId },
    select: { memoryId: true },
  });
  const stale = uniqueIds([
    ...previousMemoryIds,
    ...projectedRows.map((row) => row.memoryId),
  ]).filter((id) => !current.has(id));
  if (!stale.length) return { stale: 0, retired: 0, detached: 0 };

  const supportRows = await db.memoryEvidenceLink.findMany({
    where: { memoryId: { in: stale } },
    select: { memoryId: true, documentId: true },
  });
  const shared = new Set(
    supportRows
      .filter((row) => row.documentId && row.documentId !== documentId)
      .map((row) => String(row.memoryId)),
  );
  const retired = stale.filter((id) => !shared.has(id));

  // Remove semantic points before retiring the authoritative rows. A failure
  // leaves the old DB projection untouched so a Workflow retry can safely try
  // the same replacement again; it must never report a partially reconciled
  // terminal success.
  for (const memoryId of retired) {
    if (!vectorStore || typeof vectorStore.deleteMemory !== 'function') {
      throw new Error(`Document projection vector cleanup unavailable for ${memoryId}`);
    }
    const deleted = await vectorStore.deleteMemory(memoryId);
    if (!deleted) throw new Error(`Document projection vector cleanup failed for ${memoryId}`);
  }

  await db.$transaction(async (tx) => {
    await tx.memoryEvidenceLink.deleteMany({
      where: { documentId, memoryId: { in: stale } },
    });
    if (!retired.length) return;
    await tx.relationship.deleteMany({
      where: { OR: [{ fromId: { in: retired } }, { toId: { in: retired } }] },
    });
    if (tx.vectorEmbedding) {
      await tx.vectorEmbedding.deleteMany({ where: { memoryId: { in: retired } } });
    }
    await tx.memory.updateMany({
      where: { id: { in: retired }, deletedAt: null },
      data: { deletedAt: new Date(), isLatest: false, updatedAt: new Date() },
    });
  });

  return {
    stale: stale.length,
    retired: retired.length,
    detached: stale.length - retired.length,
  };
}
