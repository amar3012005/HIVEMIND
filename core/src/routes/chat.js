export async function buildChatRecallContext(ctx = {}) {
  const {
    message,
    userId,
    orgId,
    prisma,
    persistentMemoryStore,
    persistentMemoryEngine,
    smartIngestRouter,
    buildRoutedIngestPayloads,
    recallPersistedMemories,
    buildAccessContext,
    detectQueryIntent,
    computeDynamicWeights,
  } = ctx;

  const msgTrimmed = String(message || '')
    .trim()
    .replace(/<METADATA:[^>]*>[\s\S]*?<\/METADATA:[^>]*>/gi, '')
    .trim();
  const isQuestion = /^(what|when|where|who|how|why|do |does |did |is |are |can |could |tell me|show me|list |describe )/i.test(msgTrimmed);
  const isMetaQuery = /\b(what do you know|what have (i|you)|tell me about me|who am i|my profile|summarize my|everything about me|about myself)\b/i.test(msgTrimmed);
  const isAggregateQuery = /\b(what products|what services|list all|everything about|all .{0,20} (we|I|you) (have|know|sell|offer|make))\b/i.test(msgTrimmed);
  const isRecencyQuery = /\b(latest|newest|most recent|last message|last email|just now|right now|current)\b/i.test(message);

  let memories = [];
  let injectionText = '';

  if (!persistentMemoryStore) {
    return {
      memories,
      injectionText,
      isQuestion,
      isMetaQuery,
      isAggregateQuery,
      isRecencyQuery,
      msgTrimmed,
    };
  }

  try {
    const chatIntent = detectQueryIntent(message);
    const chatWeights = computeDynamicWeights(chatIntent);

    let chatValidAt = null;
    try {
      const m = message.match(/\b(?:as of|back in|on|before|by)\s+([A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|Q[1-4]\s+\d{4})/i);
      if (m && m[1]) {
        const parsed = new Date(m[1]);
        if (!Number.isNaN(parsed.getTime())) chatValidAt = parsed;
      }
    } catch {}

    let inferredTags = [];
    try {
      const { inferQueryTags } = await import('../services/query-tag-inference.js');
      inferredTags = inferQueryTags(message);
      if (inferredTags.length > 0) {
        console.log('[chat] inferred preferred_tags:', inferredTags);
      }
    } catch (tagErr) {
      console.warn('[chat] tag inference failed:', tagErr.message);
    }

    const recallQueries = isMetaQuery
      ? [message, 'personal facts about user', 'user preferences decisions']
      : isAggregateQuery
        ? [message, message.replace(/\b(what|list|all|everything)\b/gi, '').trim()]
        : [message];

    let allRecalled = [];
    const chatAccessCtx = await buildAccessContext(userId, orgId);
    for (const q of recallQueries) {
      if (!q || q.length < 3) continue;
      try {
        const recallResult = await recallPersistedMemories(persistentMemoryStore, {
          query_context: q,
          user_id: userId,
          org_id: orgId,
          max_memories: isMetaQuery ? 20 : isAggregateQuery ? 15 : isRecencyQuery ? 15 : 10,
          inject_parent_chunks: true,
          weights: chatWeights,
          preference_boost: chatIntent.type === 'preference',
          preferred_tags: [
            ...inferredTags,
            'canonical-summary',
            'synthesized',
            'cognition-loop',
          ],
          access_context: chatAccessCtx,
          ...(chatValidAt ? { bitemporal: { valid_at: chatValidAt } } : {}),
        });
        const recalled = recallResult.memories || [];
        injectionText = injectionText || recallResult.injectionText || '';
        const existingIds = new Set(allRecalled.map((m) => m.id));
        for (const m of recalled) {
          if (!existingIds.has(m.id)) {
            existingIds.add(m.id);
            allRecalled.push(m);
          }
        }
      } catch {}
    }

    let recalledMemories = allRecalled;
    for (const mem of recalledMemories) {
      if ((mem.tags || []).includes('extracted-fact') && mem.metadata?.parent_memory_id) {
        try {
          const parent = await persistentMemoryStore.getMemory(mem.metadata.parent_memory_id);
          if (parent) mem.parent_chunk = parent.content;
        } catch {}
      }
    }

    if (isMetaQuery) {
      recalledMemories.sort((a, b) => {
        const aIsFact = (a.memory_type === 'fact' || (a.tags || []).includes('extracted-fact')) ? 1 : 0;
        const bIsFact = (b.memory_type === 'fact' || (b.tags || []).includes('extracted-fact')) ? 1 : 0;
        const aIsPersonal = (a.tags || []).includes('sent-by-user') ? 1 : 0;
        const bIsPersonal = (b.tags || []).includes('sent-by-user') ? 1 : 0;
        return (bIsFact + bIsPersonal) - (aIsFact + aIsPersonal) || (b.score || 0) - (a.score || 0);
      });
    }

    if (isRecencyQuery && recalledMemories.length > 0) {
      recalledMemories.sort((a, b) => {
        const dateA = new Date(a.created_at || a.document_date || 0);
        const dateB = new Date(b.created_at || b.document_date || 0);
        return dateB - dateA;
      });
      try {
        const newest = await persistentMemoryStore.listLatestMemories({
          user_id: userId, org_id: orgId,
        });
        const recentReal = newest
          .filter((m) => !(m.tags || []).includes('observation') && !(m.tags || []).includes('longmemeval'))
          .slice(0, 5);
        const existingIds = new Set(recalledMemories.map((m) => m.id));
        for (const m of recentReal) {
          if (!existingIds.has(m.id)) {
            m._recencyInjected = true;
            recalledMemories.unshift(m);
          }
        }
      } catch {}
    }

    const CHAT_MIN_SCORE = 0.05;
    const CONFIG_TAGS = new Set(['assistant-name', 'voice-profile', 'org-voice', 'user-voice']);
    const relevantMemories = recalledMemories.filter((m) => {
      const tags = m.tags || [];
      if (tags.some((t) => CONFIG_TAGS.has(t))) return false;
      if (m._recencyInjected) return true;
      return (m.score || 0) >= CHAT_MIN_SCORE || (m.vectorScore || 0) >= 0.3;
    });

    console.log('[chat] Recall stats: %d total, %d relevant, scores:', recalledMemories.length, relevantMemories.length, relevantMemories.slice(0, 3).map((m) => ({ score: m.score, vectorScore: m.vectorScore, content: (m.content||'').slice(0,50) })));

    const isDecisionQuery = /\b(decide|decision|chose|chosen|picked|selected|why did (we|i|you)|why use|why prefer|trade-off)\b/i.test(message);
    if (isDecisionQuery) {
      relevantMemories.sort((a, b) => {
        const aDec = (a.memory_type === 'decision' || (a.tags || []).includes('decision')) ? 1 : 0;
        const bDec = (b.memory_type === 'decision' || (b.tags || []).includes('decision')) ? 1 : 0;
        return bDec - aDec || (b.score || 0) - (a.score || 0);
      });
    }

    memories = relevantMemories.slice(0, isMetaQuery ? 20 : 15).map((m, idx) => {
      const isFact = (m.tags || []).includes('extracted-fact');
      // WHAT RANKS TOP IS PASSED WHOLE. The pipeline searches wide then ranks
      // narrow through RRF, MMR, collapse and a Cohere cross-encoder — and then
      // this line used to throw away the tail of whatever won. Observed live: asked
      // about HEIDELBERG, chat retrieved and CITED the right memory, then answered
      // "none of them mention Heidelberg" because the token sits at char 2428 of
      // 5314 and the top-3 cap was 2400. Twenty-eight characters.
      //
      // Truncating the winner is never right. Everything upstream exists to decide
      // what deserves the model's attention; discarding part of the answer after
      // that decision wastes the whole pipeline. Top results now pass in full up to
      // a generous ceiling.
      const TOP_FULL = Number(process.env.CHAT_TOP_MEMORY_CHARS || 8000);
      const cap = idx < 3 ? TOP_FULL : (isFact ? 400 : 700);
      // For the lower ranks a cap is still needed for context budget — but cut from
      // the MIDDLE, never the tail. Structured content puts its most identifying
      // material last (an image description's entity list, a document's conclusion,
      // a table's final rows). Head-only truncation reliably destroys exactly the
      // part that answers "what is this about". Keep both ends and mark the elision
      // so the model knows it is reading an excerpt rather than a complete record.
      const _clip = (text, limit) => {
        const s = String(text || '');
        if (s.length <= limit) return s;
        const head = Math.floor(limit * 0.6);
        const tail = limit - head - 24;
        return tail > 0
          ? `${s.slice(0, head)}\n…[trimmed]…\n${s.slice(-tail)}`
          : s.slice(0, limit);
      };
      return {
        id: m.id,
        title: m.title || (m.content || '').slice(0, 60),
        content: _clip(m.content, cap),
        parent_chunk: m.parent_chunk ? m.parent_chunk.slice(0, idx < 3 ? 1200 : 500) : undefined,
        score: m.score || 0,
        tags: m.tags || [],
        memory_type: m.memory_type,
        created_at: m.created_at,
        document_date: m.document_date,
      };
    });

    if (memories.length > 0 && prisma) {
      try {
        const topId = memories[0].id;
        const links = await prisma.relationship.findMany({
          where: {
            OR: [{ fromId: topId }, { toId: topId }],
            type: { in: ['Updates', 'Extends', 'Derives'] },
            fromMemory: { userId, orgId, deletedAt: null },
            toMemory: { userId, orgId, deletedAt: null },
          },
          select: { fromId: true, toId: true, type: true },
          take: 5,
        });
        const seen = new Set(memories.map((m) => m.id));
        const connectedIds = [];
        for (const r of links) {
          const nbr = r.fromId === topId ? r.toId : r.fromId;
          if (!seen.has(nbr)) { seen.add(nbr); connectedIds.push(nbr); }
        }
        if (connectedIds.length > 0) {
          const connectedMems = await prisma.memory.findMany({
            where: { id: { in: connectedIds }, userId, orgId, deletedAt: null },
            select: {
              id: true, title: true, content: true, tags: true,
              memoryType: true, createdAt: true, documentDate: true
            },
          });
          for (const cm of connectedMems) {
            memories.push({
              id: cm.id,
              title: cm.title || (cm.content || '').slice(0, 60),
              // Graph-expanded neighbours: same middle-elision rule as the main
              // set. Head-only truncation here discarded the tail of a memory that
              // the graph explicitly said was relevant to the top hit.
              content: (() => {
                const s = String(cm.content || '');
                const limit = Number(process.env.CHAT_GRAPH_MEMORY_CHARS || 1600);
                if (s.length <= limit) return s;
                const head = Math.floor(limit * 0.6);
                const tail = limit - head - 24;
                return tail > 0 ? `${s.slice(0, head)}\n…[trimmed]…\n${s.slice(-tail)}` : s.slice(0, limit);
              })(),
              score: 0.5,
              tags: cm.tags || [],
              memory_type: cm.memoryType,
              created_at: cm.createdAt,
              document_date: cm.documentDate,
              _graphExpanded: true,
            });
          }
        }
      } catch (gErr) {
        console.warn('[chat] graph expand failed:', gErr.message);
      }
    }
  } catch (recallErr) {
    console.warn('[chat] Recall failed:', recallErr.message);
  }

  return { memories, injectionText, isMetaQuery, isAggregateQuery, isRecencyQuery, isQuestion, msgTrimmed };
}
