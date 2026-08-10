function memoryId(row = {}) {
  return row.id || row.memory_id || row.memoryId || null;
}

function evidenceId(row = {}) {
  return row.segment_id || row.segmentId || row.id || null;
}

export function buildUnifiedRecallResults({ memories = [], evidence = [], rankedCandidates = [] } = {}) {
  const memoryById = new Map(memories.map((row) => [memoryId(row), row]).filter(([id]) => id));
  const evidenceById = new Map(evidence.map((row) => [evidenceId(row), row]).filter(([id]) => id));
  const ordered = [];
  const seen = new Set();

  const append = (kind, row, candidate = {}) => {
    const id = kind === 'memory' ? memoryId(row) : evidenceId(row);
    if (!id || seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    const document = row.document || {};
    ordered.push({
      kind,
      id,
      rank: ordered.length + 1,
      score: candidate.score ?? candidate.rerank_score ?? row.score ?? null,
      citation_id: `${kind}:${id}`,
      content: row.content || row.snippet || '',
      title: kind === 'memory'
        ? row.title || null
        : document.title || row.document_title || null,
      ...(kind === 'memory' ? {
        memory_type: row.memory_type || null,
        scope: row.scope || row.tier || null,
        source: row.source || row.source_metadata?.platform || null,
      } : {
        document_id: row.document_id || row.documentId || document.id || null,
        page: row.page || row.metadata?.startPage || null,
        source: row.source_platform || row.metadata?.sourcePlatform || null,
      }),
    });
  };

  for (const candidate of rankedCandidates || []) {
    if (candidate.kind === 'memory') append('memory', memoryById.get(candidate.memory_id || candidate.id), candidate);
    if (candidate.kind === 'evidence') append('evidence', evidenceById.get(candidate.segment_id || candidate.id), candidate);
  }

  // A degraded/no-reranker response still gets one deterministic mixed contract.
  // Interleave instead of comparing lane-local score magnitudes.
  const remainder = Math.max(memories.length, evidence.length);
  for (let index = 0; index < remainder; index += 1) {
    if (evidence[index]) append('evidence', evidence[index]);
    if (memories[index]) append('memory', memories[index]);
  }
  return ordered;
}
