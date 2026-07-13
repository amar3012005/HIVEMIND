import crypto from 'node:crypto';

function resolveWithinDeadline(promise, timeoutMs, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

export async function handleRecallRoute(ctx = {}) {
  const {
    req,
    res,
    body,
    userId,
    orgId,
    prisma,
    jsonResponse,
    ensurePersistedMemoryOrFail,
    rateLimitAllowOrgRequest,
    planEnforcer,
    cognitiveOperator,
    detectQueryIntent,
    computeDynamicWeights,
    expandTemporalQuery,
    rewriteQuery,
    effectiveContainerTag,
    buildAccessContext,
    isUuidLike,
    recallPersistedMemories,
    persistentMemoryStore,
    ClusterIndex,
    crossClusterEntityBoost,
    deduplicateResults,
    profileStore,
    evidenceRetrieval,
    amrBumpRecall,
    qdrantClient,
  } = ctx;

  const _recallT0 = Date.now();
  if (!ensurePersistedMemoryOrFail(res, '/api/recall')) return;
  if (orgId && !rateLimitAllowOrgRequest(orgId)) {
    return jsonResponse(res, { error: 'rate_limited', retry_after_seconds: 1 }, 429);
  }

  try {
    let recallWeights = body.weights;
    if (cognitiveOperator && !recallWeights) {
      const intent = detectQueryIntent(body.query_context || body.context || '');
      recallWeights = computeDynamicWeights(intent);
    }

    const temporalExpansion = expandTemporalQuery(body.query_context || body.context || '');
    const rewritten = rewriteQuery(body.query_context || body.context || '');
    const effectiveRecallQuery = rewritten.expanded || body.query_context || body.context;
    const recallProject = body.project || effectiveContainerTag || null;

    let recallAccessCtx = await buildAccessContext(userId, orgId);
    let recallProjectId = (typeof body.project_id === 'string' && body.project_id.trim())
      ? body.project_id.trim()
      : (Array.isArray(body.project_ids) && body.project_ids.find((id) => typeof id === 'string' && id.trim())?.trim())
        || null;
    if (!recallProjectId && recallProject && prisma) {
      try {
        const term = String(recallProject).trim();
        const proj = await prisma.project.findFirst({
          where: {
            orgId,
            OR: [
              ...(isUuidLike(term) ? [{ id: term }] : []),
              { slug: term.toLowerCase() },
              { name: { equals: term, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        }).catch(() => null);
        recallProjectId = proj?.id || null;
      } catch {}
    }
    if (recallProjectId) {
      const _baseCtx = recallAccessCtx || {};
      const _canAccessProject = Array.isArray(_baseCtx.projectIds)
        && _baseCtx.projectIds.includes(recallProjectId);
      if (_canAccessProject) {
        recallAccessCtx = { ..._baseCtx, projectIds: [recallProjectId], teamIds: _baseCtx.teamIds || [] };
      } else {
        return jsonResponse(res, { error: 'Project not found or access denied', project_id: recallProjectId }, 403);
      }
    }

    const { resolveRecallPlan, RecallRouter } = await import('../memory/recall-router.js');
    const recallPlan = resolveRecallPlan(body);
    if (!recallPlan.legacy) {
      const { buildRecallPacket } = await import('../memory/recall-packet.js');
      const query = body.query_context || body.context || '';
      if (!query || typeof query !== 'string') {
        return jsonResponse(res, { error: 'query_context is required' }, 400);
      }
      const router = new RecallRouter({ persistentMemoryStore, evidenceRetrieval, prisma });
      const remainingMs = Math.max(1, recallPlan.latency_budget_ms - (Date.now() - _recallT0));
      const timeoutResult = { memories: [], evidence: [], live: [], trace: { timeout: true } };
      const bounded = await resolveWithinDeadline(router.recall(query, {
        mode: recallPlan.mode,
        include_live: body.include_live === true,
        live_intent: body.live_intent === true,
        surface_policy_allows_live: body.surface_policy_allows_live !== false,
        project: recallProject,
        project_id: recallProjectId,
        tags: body.tags || [],
        source_document_id: body.source_document_id || null,
        source_title: body.source_title || null,
        valid_at: body.valid_at,
        date_range: body.date_range || temporalExpansion.dateRange || null,
      }, {
        userId,
        orgId,
        projectId: recallProjectId,
        accessContext: recallAccessCtx,
      }), remainingMs, timeoutResult);
      const cutoffReason = bounded.trace?.timeout || Date.now() - _recallT0 >= recallPlan.latency_budget_ms
        ? 'latency_budget'
        : bounded.trace?.cutoff_reason || null;
      const packet = buildRecallPacket({
        facts: bounded.memories || [],
        sourceSections: bounded.evidence || [],
        liveEvidence: bounded.live || [],
        plan: recallPlan,
        cutoffReason,
      });
      if (planEnforcer && orgId) planEnforcer.recordUsage(orgId, 'searches', 1);
      return jsonResponse(res, {
        memories: bounded.memories || [],
        evidence: bounded.evidence || [],
        live: bounded.live || [],
        mode_used: recallPlan.mode,
        recall_plan: recallPlan,
        evidence_packet: packet,
        cutoff_reason: cutoffReason,
        latency_ms: Date.now() - _recallT0,
      });
    }

    let recallAuthorId = null;
    if (body.author_id && typeof body.author_id === 'string') {
      recallAuthorId = body.author_id;
    } else if (body.author && typeof body.author === 'string' && prisma) {
      const term = body.author.trim();
      const a = await prisma.user.findFirst({
        where: {
          organizations: { some: { orgId } },
          OR: [{ email: term }, { displayName: { equals: term, mode: 'insensitive' } }],
        },
        select: { id: true },
      }).catch(() => null);
      recallAuthorId = a?.id || null;
    }

    const validAt = body.valid_at ? new Date(body.valid_at) : null;
    const transactionAt = body.transaction_at ? new Date(body.transaction_at) : null;
    const bitemporalFilter = (validAt || transactionAt)
      ? { valid_at: validAt, transaction_at: transactionAt }
      : null;

    const result = await recallPersistedMemories(persistentMemoryStore, {
      query_context: effectiveRecallQuery,
      raw_query: body.query_context || body.context || '',
      user_id: userId,
      org_id: orgId,
      project: recallProject,
      source_platforms: body.source_platforms || [],
      tags: body.tags || [],
      preferred_project: body.preferred_project || recallProject,
      preferred_source_platforms: body.preferred_source_platforms || [],
      preferred_tags: body.preferred_tags || [],
      date_range: body.date_range || temporalExpansion.dateRange || null,
      max_memories: body.max_memories || 5,
      weights: recallWeights,
      is_latest: body.is_latest,
      include_expired: body.include_expired,
      sort: body.sort,
      preference_boost: body.preference_boost,
      include_superseded: body.include_superseded,
      access_context: recallAccessCtx,
      ...(recallProjectId ? { project_id: recallProjectId, project_ids: [recallProjectId] } : {}),
      scope_filter: body.scope_filter || null,
      entity_filter_mode: body.entity_filter_mode || null,
      tiered_view: body.tiered_view ?? null,
      cross_rerank: body.cross_rerank ?? null,
      query_expansion: body.query_expansion ?? null,
      bitemporal: bitemporalFilter,
    });

    if (bitemporalFilter && Array.isArray(result?.memories)) {
      const filtered = result.memories.filter((m) => {
        const created = m.created_at ? new Date(m.created_at) : null;
        const validFrom = m.valid_from ? new Date(m.valid_from)
          : (m.document_date ? new Date(m.document_date) : created);
        const validTo = m.valid_to ? new Date(m.valid_to) : null;
        if (bitemporalFilter.transaction_at && created && created > bitemporalFilter.transaction_at) return false;
        if (bitemporalFilter.valid_at) {
          if (validFrom && validFrom > bitemporalFilter.valid_at) return false;
          if (validTo && validTo <= bitemporalFilter.valid_at) return false;
        }
        return true;
      });
      result.memories = filtered;
      result.bitemporal_filter_applied = {
        valid_at: bitemporalFilter.valid_at?.toISOString() || null,
        transaction_at: bitemporalFilter.transaction_at?.toISOString() || null,
        kept: filtered.length,
      };
    }

    if (Array.isArray(result?.memories) && result.memories.length && prisma) {
      try {
        const ids = result.memories.map((m) => m.id).filter(Boolean);
        if (ids.length) {
          const ph = ids.map((_, i) => `$${i + 2}::uuid`).join(',');
          const rows = await prisma.$queryRawUnsafe(
            `SELECT m.id, m.user_id, m.scope, m.project_id,
                    COALESCE(array_agg(mp.project_id::text) FILTER (WHERE mp.project_id IS NOT NULL), '{}') AS project_ids,
                    u.display_name AS dn, u.email AS em
             FROM hivemind.memories m LEFT JOIN hivemind.users u ON u.id = m.user_id
             LEFT JOIN hivemind.memory_projects mp ON mp.memory_id = m.id
             WHERE m.org_id = $1::uuid AND m.id IN (${ph})
             GROUP BY m.id, m.user_id, m.scope, m.project_id, u.display_name, u.email`,
            orgId, ...ids,
          );
          const byId = Object.fromEntries((rows || []).map((r) => [r.id, r]));
          for (const m of result.memories) {
            const r = byId[m.id];
            if (!r) continue;
            if (!m.user_id) m.user_id = r.user_id;
            if (!m.scope) m.scope = r.scope;
            if (m.project_id == null) m.project_id = r.project_id || null;
            if (!Array.isArray(m.project_ids)) m.project_ids = Array.isArray(r.project_ids) ? r.project_ids : [];
            const nm = r.dn || r.em || null;
            if (!m.owner_name) m.owner_name = nm;
            if (!m.owner && r.user_id) m.owner = { id: r.user_id, name: nm };
          }
        }
      } catch {}
    }

    if (recallProjectId && Array.isArray(result?.memories)) {
      const before = result.memories.length;
      result.memories = result.memories.filter((m) => {
        const pids = Array.isArray(m.project_ids) ? m.project_ids : [];
        return m.scope !== 'project' || m.project_id === recallProjectId || pids.includes(recallProjectId);
      });
      result.project_scope_applied = { project_id: recallProjectId, kept: result.memories.length, dropped: before - result.memories.length };
    }

    if (recallAuthorId && Array.isArray(result?.memories)) {
      const before = result.memories.length;
      result.memories = result.memories.filter((m) => m.user_id === recallAuthorId);
      result.author_filter_applied = { author_id: recallAuthorId, kept: result.memories.length, dropped: before - result.memories.length };
    }

    if (cognitiveOperator && result.memories) {
      const intent = detectQueryIntent(body.query_context || body.context || '');
      for (const m of result.memories) {
        const boost = ctx.getMemoryTypeBoost(intent, m.memory_type || 'fact');
        if (boost !== 1.0) {
          m.score = (m.score || 0) * boost;
          m.operator_boost = boost;
        }
      }
      if (!body.sort || body.sort === 'score') {
        result.memories.sort((a, b) => (b.score || 0) - (a.score || 0));
      }
      result.intent = intent;
    }

    if (result.memories && result.memories.length > 1) {
      try {
        const clusterIndex = new ClusterIndex({ prisma });
        result.memories = await crossClusterEntityBoost(result.memories, {
          clusterIndex, organizationId: orgId,
        });
      } catch (boostErr) {
        console.warn('[api/recall] cross-cluster boost failed:', boostErr.message);
      }
    }

    const injectParentChunks = body.inject_parent_chunks !== false;
    if (injectParentChunks && result.memories && result.memories.length > 0) {
      for (const mem of result.memories) {
        if ((mem.tags || []).includes('extracted-fact') && mem.metadata?.parent_memory_id) {
          try {
            const parent = await persistentMemoryStore.getMemory(mem.metadata.parent_memory_id);
            if (parent) {
              mem.parent_chunk = parent.content;
              mem.parent_document_date = parent.document_date;
            }
          } catch {}
        }
      }
    }

    if (result.memories && result.memories.length > 1) {
      const before = result.memories.length;
      result.memories = deduplicateResults(result.memories);
      result.dedup = { before, after: result.memories.length, collapsed: before - result.memories.length };
    }

    if (persistentMemoryStore && result.memories) {
      for (const mem of result.memories) {
        try {
          const contradictions = await persistentMemoryStore.getRelationships(mem.id, 'Contradicts');
          if (contradictions && contradictions.length > 0) {
            mem._contradictions = contradictions.map((c) => ({
              contradicts_memory_id: c.from_id === mem.id ? c.to_id : c.from_id,
              confidence: c.confidence,
              type: c.metadata?.contradiction_type || 'unknown',
            }));
          }
        } catch {}
      }
    }

    if (profileStore) {
      try {
        result.user_profile = await profileStore.buildProfileContext(userId, orgId);
      } catch (profileErr) {
        console.warn('[recall] Profile injection failed:', profileErr.message);
      }
    }

    result.query_rewrite = {
      expanded: rewritten.expanded,
      entities: rewritten.entities,
      stripped: rewritten.stripped,
    };

    const mode = body.mode || 'auto';
    const wantEvidence = mode === 'evidence' || mode === 'hybrid' || mode === 'auto';
    const memoryHits = Array.isArray(result.memories) ? result.memories : [];
    result.mode_used = mode;

    if (wantEvidence && mode !== 'memory') {
      try {
        const memIds = memoryHits.map((m) => m.id).filter(Boolean);
        if (memIds.length) {
          const links = await prisma.memoryEvidenceLink.findMany({
            where: { memoryId: { in: memIds } },
            select: {
              memoryId: true,
              segmentId: true,
              documentId: true,
              linkType: true,
              confidence: true,
              excerpt: true,
              document: { select: { id: true, title: true, sourcePlatform: true } },
            },
          });
          const byMemory = new Map();
          for (const l of links) {
            if (!byMemory.has(l.memoryId)) byMemory.set(l.memoryId, []);
            byMemory.get(l.memoryId).push({
              segment_id: l.segmentId,
              document_id: l.documentId,
              document_title: l.document?.title || null,
              source_platform: l.document?.sourcePlatform || null,
              link_type: l.linkType,
              confidence: l.confidence,
              excerpt: l.excerpt,
            });
          }
          for (const mem of memoryHits) {
            mem.evidence = byMemory.get(mem.id) || [];
          }
        }
      } catch (evErr) {
        console.warn(`[recall] evidence attach failed: ${evErr.message}`);
      }

      try {
        const { recallEnhance } = await import('../memory/recall-router.js');
        const enhanced = await recallEnhance({
          memories: memoryHits,
          query: body.query_context || body.context || '',
          ctx: { userId, orgId },
          evidenceService: evidenceRetrieval,
          prisma,
          includeLive: body.include_live !== false,
        });
        const attachedSegIds = new Set(
          memoryHits.flatMap((m) => (m.evidence || []).map((e) => e.segment_id))
        );
        result.evidence = (enhanced.evidence || [])
          .filter((e) => !attachedSegIds.has(e.segmentId));
        result.evidence_count = result.evidence.length;
        result.live = enhanced.live || [];
        result.live_count = result.live.length;
        result.recall_trace = enhanced.trace;
      } catch (enhErr) {
        console.warn(`[recall] router enhance failed: ${enhErr.message}`);
        result.evidence = [];
        result.live = [];
      }
    }

    if (planEnforcer && orgId) {
      planEnforcer.recordUsage(orgId, 'searches', 1);
    }

    if (!Array.isArray(result.synthesized)) result.synthesized = [];
    if (!Array.isArray(result.raw)) result.raw = [];

    if (!body.verbose) {
      const SLIM_MEM_KEYS = ['id','title','content','memory_type','tags','score','created_at','document_date','project','project_id','source','evidence','_synthesis_boosted','_cross_cluster_boost','_cross_cluster_overlap','synthesis_cluster_hash','synthesis_revision','synthesis_confidence','synthesis_evidence_ids','source_metadata','tier','last_accessed_at','promoted_at','_ws_match','_entity_match','cognitive_layer_role','_cognitive_role'];
      const slimMem = (m) => {
        const out = {};
        for (const k of SLIM_MEM_KEYS) if (m[k] !== undefined) out[k] = m[k];
        return out;
      };
      result.memories = (result.memories || []).map(slimMem);
      result.synthesized = (result.synthesized || []).map((s) => ({
        id: s.id,
        type: s.type,
        claim: s.claim,
        title: s.title,
        confidence: s.confidence,
        revision: s.revision,
        evidence: (s.evidence || []).map((e) => ({
          id: e.id,
          title: e.title,
          snippet: (e.snippet || '').slice(0, 200),
        })),
        score: s.score,
        created_at: s.created_at,
      }));
      result.raw = (result.raw || []).map(slimMem);
      delete result.injectionText;
      delete result.user_profile;
      delete result.expansion_stats;
      delete result.dedup;
      delete result.query_rewrite;
      delete result.intent;
      if (Array.isArray(result.evidence)) {
        result.evidence = result.evidence.map((e) => ({
          segment_id: e.segmentId || e.segment_id,
          document_id: e.documentId || e.document_id,
          document_title: e.document?.title || e.document_title || null,
          score: e.score,
          snippet: (e.snippet || e.content || '').slice(0, 200),
        }));
      }
    }

    try {
      const hits = Array.isArray(result.memories) ? result.memories : [];
      if (hits.length > 0 && prisma) {
        const ids = hits.map((m) => m.id).filter(Boolean);
        if (ids.length > 0) {
          prisma.memory.updateMany({
            where: { id: { in: ids } },
            data: {
              lastAccessedAt: new Date(),
              recallCount: { increment: 1 },
              strength: { increment: 0.05 },
            },
          }).catch(() => {});
          try { amrBumpRecall(orgId, ids); } catch {}
          const HYDRATE_THRESHOLD = 0.6;
          const tier1Hits = hits.filter((m) => m.tier === 1 && (m.score || 0) >= HYDRATE_THRESHOLD);
          if (tier1Hits.length > 0) {
            import('../memory/tier-hydrate.js').then(({ hydrateMemory }) => {
              for (const hit of tier1Hits) {
                hydrateMemory(
                  { prisma, qdrantClient },
                  { memoryId: hit.id, userId, orgId },
                ).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      }
    } catch (hydrateErr) {
      console.warn('[recall] tier hydration tap failed:', hydrateErr.message);
    }

    try { if (result && typeof result === 'object' && !Array.isArray(result)) result.timing_ms = Date.now() - _recallT0; } catch {}
    return jsonResponse(res, result);
  } catch (error) {
    console.error('Auto recall failed:', error);
    return jsonResponse(res, {
      error: 'Recall failed',
      message: error.message
    }, 500);
  }
}

export async function handleQuickSearchRoute(ctx = {}) {
  const {
    res,
    body,
    userId,
    orgId,
    jsonResponse,
    ensurePersistedMemoryOrFail,
    effectiveContainerTag,
    buildAccessContext,
    recallPersistedMemories,
    persistentMemoryStore,
    planEnforcer,
  } = ctx;

  if (!ensurePersistedMemoryOrFail(res, '/api/search/quick')) return;
  try {
    const { query, memory_type, tags, source_platform, limit, project } = body;
    if (!query || typeof query !== 'string') {
      return jsonResponse(res, {
        error: 'Validation failed',
        message: 'query is required and must be a string'
      }, 400);
    }

    const searchProject = project || effectiveContainerTag || null;
    const sAccessCtx = await buildAccessContext(userId, orgId).catch(() => null);
    const sRecall = await recallPersistedMemories(persistentMemoryStore, {
      query_context: query,
      user_id: userId,
      org_id: orgId,
      ...(searchProject ? { project_id: searchProject } : {}),
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map((t) => t.trim()).filter(Boolean) : []),
      source_platforms: source_platform ? [source_platform] : [],
      memory_type: memory_type || undefined,
      max_memories: limit || 10,
      access_context: sAccessCtx,
    }).catch((e) => {
      console.warn('[search/quick] unified recall failed:', e.message);
      return { memories: [], evidence: [] };
    });

    if (planEnforcer && orgId) planEnforcer.recordUsage(orgId, 'searches', 1);

    return jsonResponse(res, {
      results: sRecall.memories || [],
      memories: sRecall.memories || [],
      evidence: sRecall.evidence || [],
      count: (sRecall.memories || []).length,
      source: 'unified-recall',
    });
  } catch (error) {
    console.error('QuickSearch failed:', error);
    return jsonResponse(res, {
      error: 'QuickSearch failed',
      message: error.message,
      requestId: error.requestId || crypto.randomUUID()
    }, 500);
  }
}
