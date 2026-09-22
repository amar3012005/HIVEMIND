export function publicWebFallbackEligible({ plan = {}, coverage = {}, hasRuntime = false, remainingMs = 0, enabled = false } = {}) {
  const policy = plan.web_fallback || {};
  const eligibleRequest = plan.needs_web === true
    && policy.allowed === true
    && !coverage.retrieval_timed_out
    && !coverage.retrieval_unavailable
    && Boolean(policy.query)
    && hasRuntime
    && remainingMs > 0;
  if (!eligibleRequest) return false;
  // An explicit request is the caller's per-turn consent for the bounded,
  // public-only Web Intelligence tool. It must not depend on a global toggle
  // that otherwise keeps opportunistic/current-information lookups off.
  if (policy.reason === 'explicit_web') return true;
  // The remaining fallback modes are intentionally rollout-controlled.
  return enabled === true
    // An explicit web request cannot be fulfilled by internal evidence alone;
    // recall still runs first for context, then exactly one public search runs.
    // For implicit current/competitor fallback, a complete workspace answer
    // suppresses the external call.
    && coverage.complete !== true;
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

export function promoteWebEvidenceWindow(evidenceItems, rankedCandidates, sourceSections) {
  const webIds = new Set((sourceSections || []).map((section) => section.segment_id).filter(Boolean));
  const webRows = evidenceItems.filter((item) => webIds.has(item.segment_id));
  const retainedEvidence = evidenceItems.filter((item) => !webIds.has(item.segment_id));
  evidenceItems.splice(0, evidenceItems.length, ...webRows, ...retainedEvidence);
  const webCandidates = (sourceSections || []).map((section) => ({
    kind: 'evidence', segment_id: section.segment_id, score: section.score || 0,
  }));
  const retainedCandidates = rankedCandidates.filter((candidate) => !webIds.has(candidate.segment_id));
  rankedCandidates.splice(0, rankedCandidates.length, ...webCandidates, ...retainedCandidates);
}

export function recentPublicContextPacket(sources = [], answer = '') {
  const refs = (sources || []).filter((source) => source?.url).slice(-8);
  const content = String(answer || '').trim().slice(0, 4000);
  if (!refs.length || !content) return null;
  const sourceSections = refs.map((source, index) => ({
    segment_id: `recent-web:${index + 1}:${source.url}`,
    document_title: String(source.title || source.url).slice(0, 500),
    source_platform: 'public_web', content, url: source.url,
    retrieved_at: source.retrieved_at || null, score: 1,
  }));
  return {
    mode: 'recent_public_context', facts: [], sourceSections,
    citations: sourceSections.map((section, index) => ({
      id: `RW${index + 1}`, segment_id: section.segment_id,
      title: section.document_title, source_label: section.document_title,
      source_type: 'public_web', url: section.url, retrieved_at: section.retrieved_at,
    })),
    coverage: { facts: 0, documents: refs.length, source_sections: refs.length },
  };
}
