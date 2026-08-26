export function publicWebFallbackEligible({ plan = {}, coverage = {}, hasRuntime = false, remainingMs = 0 } = {}) {
  const policy = plan.web_fallback || {};
  return plan.needs_web === true
    && policy.allowed === true
    // An explicit web request cannot be fulfilled by internal evidence alone;
    // recall still runs first for context, then exactly one public search runs.
    // For implicit current/competitor fallback, a complete workspace answer
    // suppresses the external call.
    && (policy.reason === 'explicit_web' || coverage.complete !== true)
    && coverage.retrieval_timed_out !== true
    && coverage.retrieval_unavailable !== true
    && Boolean(policy.query)
    && hasRuntime
    && remainingMs > 0;
}

export function webResultPacket(job, query) {
  const rows = (Array.isArray(job?.results) ? job.results : [])
    .filter((row) => row && (row.url || row.title || row.content || row.snippet))
    .slice(0, 8);
  if (!rows.length) return null;
  const sourceSections = rows.map((row, index) => ({
    segment_id: `web:${job.id}:${index + 1}`,
    document_id: null,
    document_title: String(row.title || row.url || 'Web result').slice(0, 500),
    source_platform: 'public_web',
    content: String(row.content || row.snippet || row.description || '').slice(0, 1800),
    url: row.url || null,
    retrieved_at: job.completed_at || job.updated_at || new Date().toISOString(),
    query,
    score: Number.isFinite(row.score) ? row.score : null,
  }));
  return {
    mode: 'web_fallback', facts: [], sourceSections,
    citations: sourceSections.map((section, index) => ({
      id: `W${index + 1}`, segment_id: section.segment_id,
      title: section.document_title, source_label: section.document_title,
      source_type: 'public_web', url: section.url,
      retrieved_at: section.retrieved_at, query,
    })),
    coverage: { facts: 0, documents: rows.length, source_sections: rows.length },
  };
}
