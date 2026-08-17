import { createHash } from 'node:crypto';

function evidenceContentIdentity(candidate = {}) {
  if (candidate._kind !== 'evidence') return null;
  const normalized = String(candidate._content || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

function evidenceProvenance(row = {}) {
  return {
    segment_id: row.segmentId || row.segment_id || row.id || null,
    document_id: row.documentId || row.document_id || row.document?.id || null,
    document_title: row.document_title || row.document?.title || null,
    project_id: row.projectId || row.project_id || null,
  };
}

/**
 * Collapse byte/logically identical authorized evidence before the shared
 * cross-encoder. Retrieval has already enforced tenant/project access, so this
 * never imports provenance across an authorization boundary. Prefer the copy
 * with memory lineage, then the stronger lane score, and retain every
 * authorized source identity on the surviving row for audit/UI projection.
 */
export function dedupeAuthorizedEvidenceCandidates(pool = []) {
  const output = [];
  const evidenceByHash = new Map();
  for (const candidate of pool) {
    const hash = evidenceContentIdentity(candidate);
    if (!hash) {
      output.push(candidate);
      continue;
    }
    const existingIndex = evidenceByHash.get(hash);
    if (existingIndex == null) {
      const provenance = evidenceProvenance(candidate._row);
      output.push({
        ...candidate,
        _row: {
          ...(candidate._row || {}),
          content_hash: candidate._row?.content_hash || hash,
          authorized_provenance: [provenance],
        },
      });
      evidenceByHash.set(hash, output.length - 1);
      continue;
    }
    const current = output[existingIndex];
    const currentRow = current._row || {};
    const incomingRow = candidate._row || {};
    const currentScore = Number(currentRow.score) || 0;
    const incomingScore = Number(incomingRow.score) || 0;
    const preferIncoming = (!currentRow.linked_memory_id && !!incomingRow.linked_memory_id)
      || (!!currentRow.linked_memory_id === !!incomingRow.linked_memory_id && incomingScore > currentScore);
    const provenance = [
      ...(currentRow.authorized_provenance || [evidenceProvenance(currentRow)]),
      evidenceProvenance(incomingRow),
    ].filter((item, index, all) => item.segment_id
      && all.findIndex((other) => other.segment_id === item.segment_id) === index);
    const selected = preferIncoming ? candidate : current;
    output[existingIndex] = {
      ...selected,
      _row: {
        ...(selected._row || {}),
        content_hash: selected._row?.content_hash || hash,
        authorized_provenance: provenance,
      },
    };
  }
  return output;
}

/**
 * Apply the complete pre-rerank deduplication policy for the unified recall
 * pool. Lineage is provenance, not content identity: a source segment remains
 * eligible beside an atomic memory promoted from the same document.
 */
export function prepareUnifiedRecallCandidates(pool = []) {
  return dedupeAuthorizedEvidenceCandidates(pool);
}
