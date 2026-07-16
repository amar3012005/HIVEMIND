/**
 * Server-owned read-context contract for every future recall consumer.
 *
 * This module is deliberately pure: packet construction and claim validation
 * never query a database or call a model. That makes it safe to run in chat
 * shadow mode and prevents model-provided source metadata from reaching users.
 */

const NO_GROUNDED_EVIDENCE = 'No grounded workspace evidence found.';

function stableCitationKey(section, index) {
  return section.segment_id || section.segmentId || section.document_id || section.documentId || `section-${index + 1}`;
}

export function buildRecallPacket({
  facts = [], sourceSections = [], timeline = [], conflicts = [], graphEvidence = [],
  liveEvidence = [], plan = {}, cutoffReason = null, trace = undefined,
} = {}) {
  const sections = sourceSections.map((section) => ({
    segment_id: section.segment_id || section.segmentId || null,
    document_id: section.document_id || section.documentId || null,
    document_title: section.document_title || section.documentTitle || null,
    source_platform: section.source_platform || section.sourcePlatform || null,
    content: section.content || section.excerpt || section.snippet || '',
    page: section.page || null,
    segment_index: section.segment_index ?? section.segmentIndex ?? null,
    score: section.score ?? null,
  }));
  const seen = new Set();
  const citations = sections.flatMap((section, index) => {
    const key = stableCitationKey(section, index);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: `C${seen.size}`,
      segment_id: section.segment_id,
      document_id: section.document_id,
      title: section.document_title,
      page: section.page,
      source_label: section.document_title || section.source_platform || 'Workspace source',
    }];
  });
  for (const fact of citations.length === 0 ? facts : []) {
    const memoryId = fact?.id || fact?.memory_id || fact?.memoryId || null;
    if (!memoryId || seen.has(`memory:${memoryId}`)) continue;
    seen.add(`memory:${memoryId}`);
    citations.push({
      id: `C${citations.length + 1}`,
      memory_id: memoryId,
      segment_id: null,
      document_id: fact?.document_id || fact?.documentId || null,
      title: fact?.title || null,
      page: null,
      source_label: fact?.title || 'Workspace memory',
    });
  }

  return {
    mode: plan.mode || 'fact',
    facts,
    sourceSections: sections,
    timeline,
    conflicts,
    graphEvidence,
    liveEvidence,
    citations,
    coverage: {
      facts: facts.length,
      documents: new Set(sections.map((section) => section.document_id).filter(Boolean)).size,
      source_sections: sections.length,
      timeline_events: timeline.length,
      conflicts: conflicts.length,
      graph_edges: graphEvidence.length,
      live_items: liveEvidence.length,
    },
    cutoff_reason: cutoffReason,
    ...(trace ? { trace } : {}),
  };
}

/**
 * Reject unsupported grounded output before it is rendered. The answer model
 * may select among packet citation IDs, but cannot manufacture a URL or title.
 */
export function validateGroundedClaims(payload, packet, { allowGeneralKnowledge = false } = {}) {
  const validIds = new Set((packet?.citations || []).map((citation) => citation.id));
  const inputClaims = Array.isArray(payload?.claims) ? payload.claims : [];
  const claims = [];
  const rejected = [];

  for (const claim of inputClaims) {
    const text = typeof claim?.text === 'string' ? claim.text.trim() : '';
    if (!text) continue;
    const grounded = claim.grounded === true;
    const citation_ids = Array.from(new Set((Array.isArray(claim.citation_ids) ? claim.citation_ids : [])
      .filter((id) => typeof id === 'string' && validIds.has(id))));
    if (grounded && citation_ids.length === 0) {
      rejected.push({ text, reason: 'missing_valid_citation' });
      continue;
    }
    if (!grounded && !allowGeneralKnowledge) {
      rejected.push({ text, reason: 'general_knowledge_disabled' });
      continue;
    }
    claims.push({ text, grounded, citation_ids });
  }

  if (!claims.length) {
    return { answer: NO_GROUNDED_EVIDENCE, claims: [], rejected_claims: rejected, grounded: false };
  }
  return {
    // Never render prose outside the validated structured claims.
    answer: claims.map((claim) => claim.text).join('\n'),
    claims,
    rejected_claims: rejected,
    grounded: claims.every((claim) => claim.grounded),
  };
}

export { NO_GROUNDED_EVIDENCE };
