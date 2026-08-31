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
  // Hybrid recall has two authoritative lanes.  A document citation must not
  // make a concurrently retrieved memory unciteable: doing so lets synthesis
  // see a memory fact but forces it to cite an unrelated document (or discard
  // the fact entirely).  Keep one stable, server-owned citation for every
  // delivered memory as well as every delivered source section.
  for (const fact of facts) {
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
  const claimIndex = new Map();
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
    const fingerprint = text.normalize('NFKC').toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
    const duplicateAt = claimIndex.get(fingerprint);
    if (duplicateAt !== undefined) {
      const existing = claims[duplicateAt];
      existing.citation_ids = [...new Set([...existing.citation_ids, ...citation_ids])];
      existing.grounded = existing.grounded && grounded;
      continue;
    }
    claimIndex.set(fingerprint, claims.length);
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

// ── Chat-lane evidence packet (moved from recall-router.js — V5 Phase 8: one
// module owns the typed evidence contract; shapes unchanged, zero behavior change) ──
export function buildEvidencePacket({ memories = [], evidence = [], graph = [], live = [], plan, trace, cutoffReason = null }) {
  const full = plan?.mode === 'full';
  const totalCap = full ? 12 : 8;
  const perDocCap = full ? 8 : 3;
  const perDoc = new Map();
  const sourceSections = [];
  for (const item of evidence) {
    const documentId = item.documentId || item.document_id || item.document?.id || null;
    const key = documentId || 'unknown';
    if ((perDoc.get(key) || 0) >= perDocCap || sourceSections.length >= totalCap) continue;
    perDoc.set(key, (perDoc.get(key) || 0) + 1);
    sourceSections.push({
      segment_id: item.segmentId || item.segment_id || null,
      document_id: documentId,
      document_title: item.document?.title || item.document_title || null,
      source_platform: item.document?.sourcePlatform || item.source_platform || null,
      // Snippets are query-centred by EvidenceRetrievalService. They are the
      // precision payload; raw segment prefixes are only a fallback.
      content: String(item.snippet || item.content || item.excerpt || '').slice(0, full ? 2400 : 900),
      score: item.score ?? null,
      page: item.metadata?.startPage || item.page || null,
      segment_index: item.metadata?.segmentIndex ?? null,
    });
  }
  const citations = [];
  const seen = new Set();
  for (const section of sourceSections) {
    const key = section.segment_id || `${section.document_id}:${section.page || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    citations.push({ id: `C${citations.length + 1}`, segment_id: section.segment_id, document_id: section.document_id, title: section.document_title, page: section.page });
  }
  // Preserve citations for the memory lane even when document evidence is
  // present.  The packet represents a unified reranked result, not a
  // source-first fallback where one lane invalidates the other.
  for (const memory of memories.slice(0, 5)) {
    if (!memory?.id) continue;
    citations.push({
      id: `C${citations.length + 1}`,
      memory_id: memory.id,
      segment_id: null,
      document_id: memory.document_id || memory.documentId || null,
      title: memory.title || null,
      page: null,
      source_label: memory.title || 'Workspace memory',
    });
  }
  const conflicts = graph.filter((edge) => String(edge.type).toLowerCase() === 'contradicts');
  return {
    mode: plan?.mode || 'fact',
    anchors: memories.slice(0, 5).map((m) => ({ id: m.id, title: m.title || null, score: m.score ?? null })),
    facts: memories.slice(0, 5),
    source_sections: sourceSections,
    sourceSections,
    graph_evidence: graph,
    graphEvidence: graph,
    conflicts,
    live_evidence: live,
    liveEvidence: live,
    citations,
    source_coverage: {
      documents: new Set(sourceSections.map((s) => s.document_id).filter(Boolean)).size,
      segments: sourceSections.length,
      graph_edges: graph.length,
      live_items: live.length,
    },
    coverage: {
      facts: Math.min(memories.length, 5),
      documents: new Set(sourceSections.map((s) => s.document_id).filter(Boolean)).size,
      source_sections: sourceSections.length,
      graph_edges: graph.length,
      live_items: live.length,
    },
    cutoff_reason: cutoffReason,
    trace,
  };
}
