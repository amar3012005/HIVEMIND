/**
 * SmartIngestRouter
 *
 * Type-aware ingestion preprocessor. Normalizes content by source type,
 * retrieves similar existing memories, and annotates payloads with the
 * correct triple operator (Updates / Extends / Contradicts) before
 * passing to graph-engine.ingestMemory().
 *
 * Returns an array of enriched payloads (some sources like docs may split into chunks).
 */

import { deduplicateResults } from '../search/result-dedup.js';
import { ContentNormalizer } from './content-normalizer.js';
import { detectContentType, CHUNK_STRATEGY_MAP } from './content-type-detector.js';
import { buildSemanticMetadata, inferMemorySemanticRole, normalizeRelationshipDescriptor } from './relationship-semantics.js';
import { getNormalizer, detectBucket as detectIngestBucket } from './normalizers/index.js';
import { normalizeMemoryType } from './memory-taxonomy.js';

// Re-export so callers (and future bucket-aware code paths) can import
// the same helpers from one place.
export { detectIngestBucket };

const SIMILARITY_UPDATE_THRESHOLD = 0.88;   // >this → Updates (supersede)
const SIMILARITY_EXTEND_THRESHOLD = 0.65;   // >this → Extends (augment)

export class SmartIngestRouter {
  constructor({ memoryStore }) {
    this.memoryStore = memoryStore; // PrismaGraphStore instance
    this.normalizer = new ContentNormalizer();
  }

  /**
   * Route a single ingest payload through type-specific preprocessing.
   * @param {Object} payload - raw ingest payload (same shape as ingestMemory input)
   * @returns {Promise<Object[]>} - array of enriched payloads ready for ingestMemory()
   */
  async route(payload) {
    const sourceType = this._detectSourceType(payload);

    // Step 0: Provider-specific noise stripping via normalizers/ registry.
    // Each provider has its own file under memory/normalizers/ — adding a
    // new connector = drop one file + map it in normalizers/index.js. No
    // changes to this router needed. The legacy ContentNormalizer below
    // still runs after for cross-cutting cleanup (whitespace, unicode).
    if (payload.content) {
      const platform =
        payload.source_metadata?.source_platform ||
        payload.metadata?.source_platform ||
        sourceType;
      const provNormalizer = getNormalizer(platform);
      if (provNormalizer && provNormalizer.name !== 'default') {
        const out = provNormalizer.normalize(payload.content, payload.metadata || {});
        payload = {
          ...payload,
          content: out.content,
          metadata: { ...payload.metadata, ...out.metadata },
        };
      }
    }

    // Step 1: Cross-cutting normalization (whitespace, unicode, base64 hygiene)
    if (payload.content) {
      const normalized = this.normalizer.normalize(payload.content, sourceType, payload.metadata);
      payload = { ...payload, content: normalized.content, metadata: { ...payload.metadata, ...normalized.metadata } };
    }

    // Stash the canonical bucket on the payload metadata so downstream
    // code (e.g. graph-engine, retrieval, audit) can reason in terms of
    // the 4 buckets instead of N providers.
    if (payload.metadata) {
      payload.metadata.ingest_bucket = detectIngestBucket(payload);
    }

    // Step 2: Apply type-specific routing.
    //
    // Routers may return either:
    //   • Payload[]          (legacy flat shape — each item becomes one memory)
    //   • IngestTree         { parent, children, entities?, edges? }
    //                        (graph-engine.ingestMemoryTree handles it)
    let result;
    switch (sourceType) {
      case 'gmail':
        result = await this._routeGmail(payload);
        break;
      case 'claude':
        result = await this._routeClaude(payload);
        break;
      case 'knowledge_base':
        result = await this._routeKnowledgeBase(payload);
        break;
      case 'github':
        result = await this._routeGithub(payload);
        break;
      case 'slack':
        result = await this._routeSlack(payload);
        break;
      case 'chat':
        result = await this._routeChat(payload);
        break;
      case 'google_docs':
        result = await this._routeGoogleDocs(payload);
        break;
      case 'gemini':
        result = await this._routeGemini(payload);
        break;
      case 'salesforce':
        result = await this._routeSalesforce(payload);
        break;
      default:
        result = [payload];
    }

    // Detect tree vs flat array. IngestTree is identified by a top-level
    // `.parent` field (object, not array). All other shapes are treated
    // as flat Payload[].
    if (result && !Array.isArray(result) && result.parent) {
      // Tree: enrich parent + each child with triple-operator. Children
      // intentionally do NOT get the operator (they're co-ingested as
      // sections of the same doc, not standalone facts) — only the
      // parent is checked against existing memories for Updates/Extends.
      const enrichedParent = await this._enrichWithTripleOperator({
        ...result.parent,
        memory_type: normalizeMemoryType(result.parent.memory_type, { allowLegacy: false }),
      });
      // Stamp _smart_routed on every payload so the engine gateway
      // (graph-engine.ingestMemory) does NOT re-route — prevents an
      // infinite loop when the engine itself calls route → engine.
      enrichedParent._smart_routed = true;
      const stampedChildren = (result.children || []).map((c) => ({
        ...c,
        memory_type: normalizeMemoryType(c.memory_type, { allowLegacy: false }),
        _smart_routed: true,
      }));
      return {
        parent: enrichedParent,
        children: stampedChildren,
        entities: result.entities || [],
        edges: result.edges || [],
      };
    }

    // Flat array path (unchanged from before).
    const payloads = Array.isArray(result) ? result : [result];
    const enriched = await Promise.all(payloads.map((p) => this._enrichWithTripleOperator({
      ...p,
      memory_type: normalizeMemoryType(p.memory_type, { allowLegacy: false }),
    })));
    return enriched.map((p) => ({ ...p, _smart_routed: true }));
  }

  _detectSourceType(payload) {
    // Tree-shape payloads stash source metadata on the parent. Look there
    // first when present so adapters that emit { _tree: { parent, ... } }
    // (gdocs, gemini, gmail-thread) still dispatch correctly.
    const tree = payload?._tree?.parent || null;
    const platform = (
      payload.source_metadata?.source_platform ||
      payload.source_metadata?.source_type ||
      payload.metadata?.source_platform ||
      payload.ingest_type ||
      tree?.source_metadata?.source_platform ||
      tree?.source_metadata?.source_type ||
      tree?.metadata?.source_platform ||
      ''
    ).toLowerCase();

    // Explicit platform metadata takes priority
    if (platform.includes('gmail') || platform.includes('google_mail') || platform.includes('google-mail') || platform.includes('email')) return 'gmail';
    if (platform.includes('google-docs') || platform.includes('google_docs') || platform.includes('gdocs')) return 'google_docs';
    if (platform.includes('gemini') || platform.includes('google-gemini')) return 'gemini';
    if (platform.includes('claude') || platform.includes('anthropic')) return 'claude';
    if (platform.includes('notion') || platform.includes('obsidian') || platform.includes('document') || platform.includes('pdf') || platform.includes('knowledge')) return 'knowledge_base';
    if (platform.includes('github') || platform.includes('gitlab') || platform.includes('code')) return 'github';
    if (platform.includes('salesforce')) return 'salesforce';
    if (platform.includes('slack') || platform.includes('teams') || platform.includes('discord')) return 'slack';
    if (platform.includes('chat') || platform.includes('talk-to-hive') || platform.includes('conversation')) return 'chat';

    // No explicit platform — auto-detect from content
    if (platform === '' || platform === 'manual') {
      const content = payload.content || '';
      if (content.length > 0) {
        const detection = detectContentType(content);
        if (detection.confidence >= 0.70) {
          payload.metadata = {
            ...(payload.metadata || {}),
            auto_detected_type: detection.detectedType,
            detection_confidence: detection.confidence,
            detection_signals: detection.signals,
          };
          if (!payload.memory_type) {
            payload.memory_type = detection.suggestedMemoryType;
          }
          return detection.suggestedRoute;
        }
      }
    }

    return 'manual';
  }

  // --- Gmail ---
  // Email threads with multiple messages → Thread parent + Message children tree.
  // Single emails or already-structured single-message payloads → flat.
  // The gmail normalizer (memory/normalizers/gmail.js) already ran in
  // route() above and stripped headers/sig/quotes, so we work with clean
  // content here.
  async _routeGmail(payload) {
    const content = payload.content || '';
    // Thread mode: payload.metadata.messages is an array of message bodies
    // (set by the gmail bridge when ingesting a multi-message thread).
    // Build Thread parent + Message children tree.
    const threadMsgs = Array.isArray(payload.metadata?.messages) ? payload.metadata.messages : null;
    if (threadMsgs && threadMsgs.length >= 2) {
      const threadSubject =
        payload.metadata.thread_subject
        || payload.metadata.email_subject
        || payload.title
        || 'Email thread';
      const threadId = payload.metadata?.thread_id || payload.source_metadata?.thread_id || null;

      const parent = {
        ...payload,
        id: undefined,
        title: `Thread: ${threadSubject}`,
        content: `Email thread "${threadSubject}" (${threadMsgs.length} messages).`,
        memory_type: payload.memory_type || 'event',
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'gmail',
          semantic_role: 'thread',
          ingest_tree_role: 'parent',
          thread_id: threadId,
          message_count: threadMsgs.length,
        },
      };
      const children = threadMsgs.map((msg, i) => ({
        ...payload,
        id: undefined,
        content: typeof msg === 'string' ? msg : (msg.content || msg.body || ''),
        title: typeof msg === 'object'
          ? (msg.subject || `Message ${i + 1}/${threadMsgs.length}`)
          : `Message ${i + 1}/${threadMsgs.length}`,
        memory_type: payload.memory_type || 'event',
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'gmail',
          semantic_role: 'message',
          ingest_tree_role: 'child',
          thread_id: threadId,
          message_index: i,
          message_total: threadMsgs.length,
          email_from: typeof msg === 'object' ? (msg.from || null) : null,
          email_date: typeof msg === 'object' ? (msg.date || null) : null,
        },
      }));
      return { parent, children };
    }

    // Single-message path (legacy + most Gmail webhooks).
    const subject = this._extractEmailField(content, 'Subject') || payload.title || '';
    const from = this._extractEmailField(content, 'From') || '';
    const date = this._extractEmailField(content, 'Date') || '';
    const threadId = payload.metadata?.thread_id || payload.source_metadata?.thread_id || null;

    // Reconstruct cleaner content
    const body = this._stripEmailHeaders(content);
    const cleanContent = [
      subject ? `Subject: ${subject}` : '',
      from ? `From: ${from}` : '',
      date ? `Date: ${date}` : '',
      body.trim()
    ].filter(Boolean).join('\n');

    return [{
      ...payload,
      content: cleanContent || content,
      title: subject || payload.title,
      memory_type: payload.memory_type || 'event',
      metadata: {
        ...payload.metadata,
        email_subject: subject,
        email_from: from,
        email_date: date,
        thread_id: threadId,
        source_type_normalized: 'gmail',
      }
    }];
  }

  // --- Claude conversations ---
  async _routeClaude(payload) {
    const content = payload.content || '';
    // Extract only meaningful lines (user turns with decisions/insights)
    const lines = content.split('\n');
    const meaningful = lines.filter(l => {
      const lower = l.toLowerCase();
      return l.length > 20 && (
        lower.includes('decided') || lower.includes('prefer') || lower.includes('learned') ||
        lower.includes('remember') || lower.includes('important') || lower.includes('always') ||
        lower.includes('never') || lower.includes('should') || lower.includes('will') ||
        lower.startsWith('user:') || lower.startsWith('human:')
      );
    });

    const distilled = meaningful.length > 3
      ? meaningful.join('\n')
      : content; // fallback to full content

    return [{
      ...payload,
      content: distilled,
      memory_type: payload.memory_type || 'lesson',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'claude',
        original_length: content.length,
        distilled: meaningful.length > 3,
      }
    }];
  }

  // --- Knowledge base documents ---
  //
  // Returns either:
  //   • flat Payload[]              (single-chunk docs — legacy shape)
  //   • IngestTree { parent, children }  (multi-chunk docs — new shape)
  //
  // buildRoutedIngestPayloads detects the shape and dispatches to
  // graph-engine.ingestMemoryTree() vs ingestMemory().  Trees produce a
  // Document parent + N Section children connected by PartOf edges, fixing
  // the long-standing 'KB chunks have no parent edge' complaint.
  async _routeKnowledgeBase(payload) {
    const content = payload.content || '';
    // ATOMIC MEANS ATOMIC. This router chunked unconditionally — it had no concept
    // of atomic mode — so a caller that explicitly asked for ONE memory still got a
    // Document parent plus N "· §i/N" Section children.
    //
    // Images are the case that proves it: image ingest passes mode:'atomic' because
    // "an image is ONE thing", and that invariant held only while descriptions were
    // short enough to fall under the chunk threshold. Enriching the vision prompt
    // (domain entities, verbatim text, structure) pushed them over it, and every
    // uploaded PNG silently became 3-4 memories again — §1/3, §2/3, §3/3 plus a
    // whole copy — reversing the invariant with no error anywhere.
    //
    // Honour the caller's DECLARED mode instead of inferring intent from length.
    const _atomic = payload.metadata?.ingest_mode === 'atomic'
      || payload.metadata?.mode === 'atomic'
      || payload.metadata?.document_type === 'image'
      || payload.metadata?.media_kind === 'image'
      || (Array.isArray(payload.tags) && payload.tags.includes('kind:image'));
    if (_atomic) {
      return [{
        ...payload,
        memory_type: payload.memory_type || 'fact',
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'knowledge_base',
          chunk_strategy: 'atomic',
          semantic_role: 'document',
          chunk_total: 1,
        },
      }];
    }
    const chunkStrategy = payload.metadata?.suggestedChunkStrategy
      || payload.metadata?.auto_detected_type && CHUNK_STRATEGY_MAP[payload.metadata.auto_detected_type]
      || 'heading_hierarchy';

    let rawChunks = this._chunkByStrategy(content, chunkStrategy);

    // _chunkByHeadings merges multiple small sections up to 2000 chars,
    // so a 4-heading doc with 250 chars total collapses to 1 chunk and
    // the tree never emits. For the parent/section graph contract we
    // want one Section node *per heading*, regardless of merge budget.
    // Re-split when:
    //   - strategy is heading_hierarchy (or unset)
    //   - the document has ≥2 H1/H2 headings
    //   - we ended up with <2 chunks from the budget-merging chunker
    if (rawChunks.length < 2 && (chunkStrategy === 'heading_hierarchy' || !chunkStrategy)) {
      const perHeading = content
        .split(/(?=^#{1,6}\s)/m)
        .map(s => s.trim())
        .filter(s => s.length > 30);
      if (perHeading.length >= 2) {
        rawChunks = perHeading;
      }
    }

    if (rawChunks.length <= 1) {
      // Single-chunk doc — keep legacy flat shape so existing callers
      // that expect Payload[] still work.
      return [{
        ...payload,
        memory_type: payload.memory_type || 'fact',
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'knowledge_base',
          chunk_strategy: chunkStrategy,
          semantic_role: 'document',
          ingest_tree_role: 'standalone',
        },
      }];
    }

    // Multi-chunk doc → emit a Document parent + Section children tree.
    // Parent carries: title, full content (for vector search across the
    // whole doc), document_date, source_metadata. Children carry their
    // chunk text + position in the doc.
    const parent = {
      ...payload,
      id: undefined,
      // Parent's content stays as the full doc text so semantic search
      // can hit the doc-level intent (e.g. "the SOLVIS contract").
      // Children get the chunk text for fine-grained retrieval.
      memory_type: payload.memory_type || 'fact',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'knowledge_base',
        chunk_strategy: chunkStrategy,
        semantic_role: 'document',
        ingest_tree_role: 'parent',
        chunk_total: rawChunks.length,
      },
    };

    const children = rawChunks.map((chunk, i) => ({
      ...payload,
      id: undefined,
      content: chunk,
      // Section title: take first non-empty line as heading hint when
      // chunking by heading_hierarchy, else use 'Section i/N' fallback.
      title: payload.title
        ? `${payload.title} · §${i + 1}/${rawChunks.length}`
        : `Section ${i + 1}/${rawChunks.length}`,
      memory_type: payload.memory_type || 'fact',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'knowledge_base',
        chunk_strategy: chunkStrategy,
        chunk_index: i,
        chunk_total: rawChunks.length,
        parent_title: payload.title || null,
        semantic_role: 'section',
        ingest_tree_role: 'child',
      },
    }));

    return { parent, children };
  }

  // --- GitHub ---
  async _routeGithub(payload) {
    return [{
      ...payload,
      memory_type: payload.memory_type || 'decision',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'github',
      }
    }];
  }

  // --- Chat (Talk to HIVE) ---
  // Single-turn ingests stay flat (most common — one declarative
  // statement). Multi-turn sessions (payload.metadata.turns is an array)
  // emit a Session parent + Turn children tree so the conversation
  // becomes a connected graph instead of orphan facts.
  async _routeChat(payload) {
    const turns = Array.isArray(payload.metadata?.turns) ? payload.metadata.turns : null;
    if (turns && turns.length >= 2) {
      const sessionId =
        payload.metadata.session_id
        || payload.source_metadata?.session_id
        || `sess-${Date.now().toString(36)}`;
      const sessionTitle =
        payload.metadata.session_title
        || payload.title
        || `Chat session ${sessionId.slice(0, 8)}`;

      const parent = {
        ...payload,
        id: undefined,
        title: sessionTitle,
        content: `Talk-to-HIVE session "${sessionTitle}" with ${turns.length} turns.`,
        memory_type: 'fact',
        tags: Array.from(new Set([...(payload.tags || []), 'chat', 'talk-to-hive', 'session'])),
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'chat',
          semantic_role: 'session',
          ingest_tree_role: 'parent',
          session_id: sessionId,
          turn_count: turns.length,
        },
      };

      const children = turns.map((t, i) => ({
        ...payload,
        id: undefined,
        content: typeof t === 'string' ? t : (t.content || t.text || ''),
        title: typeof t === 'object'
          ? (t.title || `Turn ${i + 1}/${turns.length}`)
          : `Turn ${i + 1}/${turns.length}`,
        memory_type: 'fact',
        tags: Array.from(new Set([...(payload.tags || []), 'chat', 'talk-to-hive'])),
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'chat',
          semantic_role: 'turn',
          ingest_tree_role: 'child',
          session_id: sessionId,
          turn_index: i,
          turn_total: turns.length,
          turn_role: typeof t === 'object' ? (t.role || null) : null, // 'user' | 'assistant'
          turn_ts: typeof t === 'object' ? (t.ts || null) : null,
        },
      }));

      return { parent, children };
    }

    // Single-turn chat save. Entity + temporal extraction now happens via
    // LLM in graph-engine._attachEntityCoMentionEdges (one call, multilingual).
    // We only set force_entity_linking so that gate fires even for short
    // user-typed facts.
    const tagBoost = new Set(payload.tags || []);
    if (isChatLike(payload)) {
      tagBoost.add('talk-to-hive');
    }

    return [{
      ...payload,
      memory_type: payload.memory_type || 'fact',
      tags: Array.from(tagBoost),
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'chat',
        force_entity_linking: true,
      },
    }];
  }

  // --- Google Docs ---
  // Adapter returns either { _tree: { parent, children } } for small docs
  // (heading→section split) OR a single payload for large docs (>5k chars)
  // which we route through the KB pipeline (Docling hybrid chunker).
  async _routeGoogleDocs(payload) {
    if (payload?._tree?.parent) {
      return {
        parent: {
          ...payload._tree.parent,
          metadata: {
            ...(payload._tree.parent.metadata || {}),
            source_type_normalized: 'google-docs',
            force_entity_linking: true,
          },
        },
        children: (payload._tree.children || []).map(c => ({
          ...c,
          metadata: {
            ...(c.metadata || {}),
            source_type_normalized: 'google-docs',
            force_entity_linking: true,
          },
        })),
      };
    }
    // Flat payload (large doc routed to KB pipeline) — same path as
    // _routeKnowledgeBase but with google-docs source markers preserved.
    return [{
      ...payload,
      memory_type: payload.memory_type || 'fact',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'google-docs',
        force_entity_linking: true,
      },
    }];
  }

  // --- Gemini ---
  // Adapter wraps a chat session as { _tree: { parent, children } } where
  // parent is the session and each turn is a child. Same canonical
  // operator inference applies — turns Extend the session, cross-session
  // entities trigger Mentions/Updates.
  async _routeGemini(payload) {
    if (payload?._tree?.parent) {
      return {
        parent: {
          ...payload._tree.parent,
          metadata: {
            ...(payload._tree.parent.metadata || {}),
            source_type_normalized: 'gemini',
            force_entity_linking: true,
          },
        },
        children: (payload._tree.children || []).map(c => ({
          ...c,
          metadata: {
            ...(c.metadata || {}),
            source_type_normalized: 'gemini',
            force_entity_linking: true,
          },
        })),
      };
    }
    // Single-turn Gemini event (per-turn live log).
    return [{
      ...payload,
      memory_type: payload.memory_type || 'fact',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'gemini',
        force_entity_linking: true,
      },
    }];
  }

  // --- Salesforce ---
  // CRM-aware routing:
  //   • Idempotency: lookup existing memory by external_ref(salesforce, object_type, sf_id).
  //     If exists, emit operator=Updates targeting it.
  //   • Parent linkage: Contact→Account, Opportunity→Account,
  //     OpportunityHistory→Opportunity, CaseComment→Case.
  //     Surfaces parent_memory_id as router hint so entity-co-mention can
  //     attach the right edges.
  //   • Tree shape only for multi-child cases (Opportunity with bundled
  //     OpportunityHistory rows). Single records stay flat — they're
  //     already CRM facts not conversations.
  async _routeSalesforce(payload) {
    const objType = payload.metadata?.salesforce_object_type;
    const sfId = payload.metadata?.salesforce_id;
    const parentSfId = payload.metadata?.salesforce_parent_object_id;

    if (!objType || !sfId) {
      return [{ ...payload, metadata: { ...(payload.metadata || {}), source_type_normalized: 'salesforce' } }];
    }

    // Tag bucket so default views can filter.
    const baseTags = Array.from(new Set([
      ...(payload.tags || []),
      'salesforce',
      `sf-object:${objType.toLowerCase()}`,
    ]));

    let hints = [];

    // 1. Idempotent: if existing memory has this external_ref, target it.
    try {
      if (this.memoryStore?.client?.externalRef?.findFirst) {
        const existing = await this.memoryStore.client.externalRef.findFirst({
          where: {
            organizationId: payload.org_id,
            system: 'salesforce',
            objectType: objType,
            externalId: String(sfId),
          },
          select: { memoryId: true },
        });
        if (existing?.memoryId) {
          // Re-sync = Updates. Caller's enrichment + entity-link still fires
          // on the new content version.
          return [{
            ...payload,
            tags: baseTags,
            metadata: { ...(payload.metadata || {}), source_type_normalized: 'salesforce' },
            relationship: { type: 'Updates', target_id: existing.memoryId },
          }];
        }
      }
    } catch (lookupErr) {
      console.warn('[router-salesforce] external_ref lookup failed:', lookupErr.message);
    }

    // 2. Parent linkage: surface parent memory id as recall hint.
    if (parentSfId) {
      try {
        if (this.memoryStore?.client?.externalRef?.findFirst) {
          const parentRef = await this.memoryStore.client.externalRef.findFirst({
            where: {
              organizationId: payload.org_id,
              system: 'salesforce',
              externalId: String(parentSfId),
            },
            select: { memoryId: true, objectType: true },
          });
          if (parentRef?.memoryId) {
            hints.push({ id: parentRef.memoryId, content: '', title: `[salesforce ${parentRef.objectType}]`, tags: [] });
          }
        }
      } catch (parentErr) {
        console.warn('[router-salesforce] parent lookup failed:', parentErr.message);
      }
    }

    return [{
      ...payload,
      tags: baseTags,
      metadata: {
        ...(payload.metadata || {}),
        source_type_normalized: 'salesforce',
        _llm_recall_hints: hints.length ? hints : (payload.metadata?._llm_recall_hints || []),
      },
    }];
  }

  // --- Slack / Teams ---
  // Same conversation contract: multi-message threads become Thread+Message
  // trees; single messages stay flat.
  async _routeSlack(payload) {
    const msgs = Array.isArray(payload.metadata?.messages) ? payload.metadata.messages : null;
    if (msgs && msgs.length >= 2) {
      const threadTs = payload.metadata.thread_ts || payload.source_metadata?.thread_ts || null;
      const channel = payload.metadata.channel || payload.source_metadata?.channel || null;
      const threadLabel = channel ? `${channel} · ${threadTs || 'thread'}` : (threadTs || 'thread');

      const parent = {
        ...payload,
        id: undefined,
        title: `Slack thread: ${threadLabel}`,
        content: `Slack thread in ${channel || 'unknown channel'} with ${msgs.length} messages.`,
        memory_type: payload.memory_type || 'event',
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'slack',
          semantic_role: 'thread',
          ingest_tree_role: 'parent',
          channel,
          thread_ts: threadTs,
          message_count: msgs.length,
        },
      };
      const children = msgs.map((m, i) => ({
        ...payload,
        id: undefined,
        content: typeof m === 'string' ? m : (m.text || m.content || ''),
        title: typeof m === 'object'
          ? (m.user ? `${m.user}: ${(m.text || '').slice(0, 40)}` : `Msg ${i + 1}/${msgs.length}`)
          : `Msg ${i + 1}/${msgs.length}`,
        memory_type: payload.memory_type || 'event',
        metadata: {
          ...payload.metadata,
          source_type_normalized: 'slack',
          semantic_role: 'message',
          ingest_tree_role: 'child',
          channel,
          thread_ts: threadTs,
          message_index: i,
          message_total: msgs.length,
          slack_user: typeof m === 'object' ? (m.user || m.user_id || null) : null,
          slack_ts: typeof m === 'object' ? (m.ts || null) : null,
        },
      }));
      return { parent, children };
    }

    return [{
      ...payload,
      memory_type: payload.memory_type || 'event',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'slack',
      }
    }];
  }

  /**
   * Do semantic pre-flight search and annotate payload with triple operator.
   */
  async _enrichWithTripleOperator(payload) {
    if (!this.memoryStore || !payload.content) return payload;

    // Skip if caller already set an explicit relationship
    if (payload.relationship) {
      const relationship = normalizeRelationshipDescriptor(payload.relationship, { sourceMemory: payload });
      return {
        ...payload,
        metadata: {
          ...(payload.metadata || {}),
          ...buildSemanticMetadata({
            semanticRole: inferMemorySemanticRole(payload),
            relationship,
            sourceMetadata: payload.source_metadata,
          }),
        },
      };
    }

    // Short-content threshold split by source. Chat / talk-to-hive saves are
    // ALWAYS user-curated durable facts ("meet Ethan Tuesday 7pm") — we want
    // operator inference even when they are 10–30 chars long. Other sources
    // (KB chunks, connector rows) keep the higher floor to avoid wasting
    // LLM calls on auto-ingested noise.
    const isChatBucket = (payload.source_metadata?.source_platform || '').toLowerCase().includes('talk-to-hive')
      || (payload.metadata?.source_type_normalized === 'chat')
      || (payload.source_metadata?.source_type || '').toLowerCase() === 'chat';
    const minContentLen = isChatBucket ? 10 : 30;
    if (payload.content.length < minContentLen) return payload;

    try {
      const searchQuery = payload.title
        ? `${payload.title} ${payload.content.slice(0, 300)}`
        : payload.content.slice(0, 400);

      const similar = await this.memoryStore.searchMemories({
        query: searchQuery,
        user_id: payload.user_id,
        org_id: payload.org_id,
        project: payload.project || null,
        n_results: 5,
        is_latest: true,
      });

      // Deterministic document-structure override: later chunks should chain
      // to the previous chunk when we can identify it reliably.
      const chunkIndex = Number.isInteger(payload.metadata?.chunk_index)
        ? payload.metadata.chunk_index
        : Number(payload.metadata?.chunk_index);
      const chunkTotal = Number.isInteger(payload.metadata?.chunk_total)
        ? payload.metadata.chunk_total
        : Number(payload.metadata?.chunk_total);
      const parentTitle = payload.metadata?.parent_title || null;
      if (Number.isInteger(chunkIndex) && chunkIndex > 0 && parentTitle) {
        const previousIndex = chunkIndex - 1;
        let previousChunkMatch = (similar || []).find(m =>
          m.metadata?.parent_title === parentTitle &&
          Number(m.metadata?.chunk_index) === previousIndex
        );

        if (!previousChunkMatch) {
          const previousChunkQuery = `${parentTitle} (part ${chunkIndex}/${chunkTotal || '?'})`;
          const previousCandidates = await this.memoryStore.searchMemories({
            query: previousChunkQuery,
            user_id: payload.user_id,
            org_id: payload.org_id,
            project: payload.project || null,
            n_results: 5,
            is_latest: true,
          });
          previousChunkMatch = (previousCandidates || []).find(m =>
            m.metadata?.parent_title === parentTitle &&
            Number(m.metadata?.chunk_index) === previousIndex
          );
        }

        if (previousChunkMatch) {
          const relationship = normalizeRelationshipDescriptor({
            type: 'Extends',
            targetId: previousChunkMatch.id,
            confidence: 0.98,
            reason: 'previous_chunk_match',
          });
          return {
            ...payload,
            metadata: {
              ...(payload.metadata || {}),
              ...buildSemanticMetadata({
                semanticRole: inferMemorySemanticRole(payload),
                relationship,
                sourceMetadata: payload.source_metadata,
              }),
            },
            relationship: { type: 'Extends', target_id: previousChunkMatch.id, confidence: 0.98 }
          };
        }
      }

      // Deterministic document-structure override: if a chunk already knows
      // its persisted parent memory id, always attach to that parent.
      const parentSchemaId = payload.metadata?.parent_schema_id || null;
      if (parentSchemaId) {
        const relationship = normalizeRelationshipDescriptor({
          type: 'Extends',
          targetId: parentSchemaId,
          confidence: 0.99,
          reason: 'parent_schema_match',
        });
        return {
          ...payload,
          metadata: {
            ...(payload.metadata || {}),
            ...buildSemanticMetadata({
              semanticRole: inferMemorySemanticRole(payload),
              relationship,
              sourceMetadata: payload.source_metadata,
            }),
          },
          relationship: { type: 'Extends', target_id: parentSchemaId, confidence: 0.99 }
        };
      }

      if (!similar || similar.length === 0) return payload;

      // Thread-based override: exact thread match → always Extends
      const threadId = payload.metadata?.thread_id || payload.source_metadata?.thread_id;
      if (threadId) {
        const threadMatch = similar.find(m =>
          m.metadata?.thread_id === threadId || m.metadata?.email_thread_id === threadId
        );
        if (threadMatch) {
          const relationship = normalizeRelationshipDescriptor({
            type: 'Extends',
            targetId: threadMatch.id,
            confidence: 0.95,
            reason: 'thread_match',
          });
          return {
            ...payload,
            metadata: {
              ...(payload.metadata || {}),
              ...buildSemanticMetadata({
                semanticRole: inferMemorySemanticRole(payload),
                relationship,
                sourceMetadata: payload.source_metadata,
              }),
            },
            relationship: { type: 'Extends', target_id: threadMatch.id, confidence: 0.95 }
          };
        }
      }

      // Session-based override for Claude: same source_session_id → Updates
      const sessionId = payload.source_metadata?.source_id || payload.metadata?.source_session_id;
      if (sessionId) {
        const sessionMatch = similar.find(m =>
          m.metadata?.source_session_id === sessionId ||
          m.source_metadata?.source_id === sessionId
        );
        if (sessionMatch && sessionMatch.score > 0.5) {
          const relationship = normalizeRelationshipDescriptor({
            type: 'Updates',
            targetId: sessionMatch.id,
            confidence: 0.9,
            reason: 'session_match',
          });
          return {
            ...payload,
            metadata: {
              ...(payload.metadata || {}),
              ...buildSemanticMetadata({
                semanticRole: inferMemorySemanticRole(payload),
                relationship,
                sourceMetadata: payload.source_metadata,
              }),
            },
            relationship: { type: 'Updates', target_id: sessionMatch.id, confidence: 0.9 }
          };
        }
      }

      // ── LLM-DRIVEN OPERATOR DECISION ────────────────────────────────
      //
      // Previously this branch picked an operator from raw cosine similarity:
      //   ≥0.88 → Updates, ≥0.65 → Extends, ≥0.40 → Derives, else Mentions.
      // That heuristic mis-fired constantly because:
      //   • two memories on the same broad topic ("embedding models") look
      //     ≥0.88 similar even when they share NO entity or claim
      //   • single-target relationship can't express "this Updates A and
      //     Mentions B" simultaneously
      //   • language semantics ("switching to X" vs "X is still useful")
      //     never enter the decision — only word overlap does
      //
      // The canonical multi-edge LLM decider lives in graph-engine's
      // _attachEntityCoMentionEdges. It already:
      //   - runs ONE Groq call with entity + temporal + memory_type +
      //     per-candidate operator (Updates|Extends|Contradicts|Mentions)
      //   - emits up to EDGE_CAP edges, multilingual, with confidence
      //   - flips is_latest=false when its operator says Updates
      // It is the right place for the decision.
      //
      // We surface the recall result + extracted entities to it via two
      // attached hints so the same recall isn't paid for twice downstream.
      // The router no longer locks a primary operator from similarity.
      const baseHaystack = `${payload.title || ''} ${payload.content || ''}`.toLowerCase();
      const recallHints = (similar || [])
        .filter(m => m && m.id)
        .slice(0, 8)
        .map(m => ({
          id: m.id,
          title: m.title || null,
          content: (m.content || '').slice(0, 280),
          score: typeof m.score === 'number' ? m.score : null,
          tags: m.tags || [],
        }));
      // Soft Derives hint: when 2+ candidates score in the synthesis band
      // (0.40-0.65) we still mark sourceIds so a Derives edge can be
      // attached if the LLM agrees the new memory is a synthesis. NOT a
      // hard primary relationship — just metadata for the downstream LLM.
      const deriveBand = (similar || []).filter(m => m.score >= 0.40 && m.score < SIMILARITY_EXTEND_THRESHOLD);
      const derivesFrom = deriveBand.length >= 2
        ? deriveBand.slice(0, 5).map(m => ({ id: m.id, score: m.score, content: (m.content || '').slice(0, 200) }))
        : null;

      return {
        ...payload,
        metadata: {
          ...(payload.metadata || {}),
          // Pass recall + derive candidates to graph-engine via hints. The
          // LLM in _attachEntityCoMentionEdges reads these and picks the
          // correct operator per candidate; no similarity-thresholding here.
          _llm_recall_hints: recallHints,
          _llm_derive_candidates: derivesFrom || undefined,
          // Top-similarity hint for the contradiction reconciler downstream
          // (it still consults raw content for "switching"/"actually"
          // language; keeping this lets that path stay accurate too).
          _top_similarity_id: similar[0]?.id || null,
          _top_similarity_score: typeof similar[0]?.score === 'number' ? similar[0].score : null,
        },
      };
    } catch (err) {
      console.warn('[smart-ingest-router] Pre-flight check failed:', err.message);
      return payload;
    }
  }

  _hasContradictionSignal(newContent, existingContent) {
    if (!existingContent) return false;
    const negationWords = [
      'no longer', 'not anymore', 'changed', 'updated', 'now uses', 'switched to',
      'replaced', 'instead of', "doesn't", "won't", 'removed'
    ];
    const lower = newContent.toLowerCase();
    return negationWords.some(w => lower.includes(w));
  }

  _extractEmailField(content, field) {
    const re = new RegExp(`^${field}:\\s*(.+)$`, 'mi');
    const m = content.match(re);
    return m ? m[1].trim() : null;
  }

  _stripEmailHeaders(content) {
    // Remove standard email header block (From:, To:, Subject:, Date:, etc.)
    return content.replace(/^(From|To|Cc|Bcc|Subject|Date|Message-ID|Content-Type|MIME-Version|Reply-To):.*\n?/gim, '').trim();
  }

  _chunkDocument(content, maxChars) {
    // Split on headings first
    const headingRe = /^#{1,3}\s.+/m;
    if (headingRe.test(content)) {
      const sections = content.split(/(?=^#{1,3}\s)/m).filter(s => s.trim().length > 50);
      // Merge small sections
      const chunks = [];
      let current = '';
      for (const section of sections) {
        if (current.length + section.length > maxChars) {
          if (current) chunks.push(current.trim());
          current = section;
        } else {
          current += '\n\n' + section;
        }
      }
      if (current.trim()) chunks.push(current.trim());
      return chunks.length > 0 ? chunks : [content];
    }

    // Fallback: split on double newlines
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 30);
    if (paragraphs.length <= 1) return [content];

    const chunks = [];
    let current = '';
    for (const para of paragraphs) {
      if (current.length + para.length > maxChars) {
        if (current) chunks.push(current.trim());
        current = para;
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [content];
  }

  _chunkByStrategy(content, strategy) {
    const MAX_CHUNK = 2000;
    const MIN_CHUNK = 50;

    switch (strategy) {
      case 'heading_hierarchy':
        return this._chunkByHeadings(content, MAX_CHUNK);

      case 'paragraph_split':
        return this._chunkByParagraphs(content, MAX_CHUNK);

      case 'turn_pairs':
        return this._chunkByTurns(content);

      case 'row_batches':
        return this._chunkByRows(content, 50);

      case 'key_sections':
        return this._chunkByKeyStructure(content, MAX_CHUNK);

      case 'article_structure':
        return this._chunkByHtmlSections(content, MAX_CHUNK);

      case 'page_sections':
      case 'ast_boundaries':
      case 'thread_grouped':
      case 'single':
      default:
        return this._chunkDocument(content, MAX_CHUNK);
    }
  }

  _chunkByHeadings(content, maxChars) {
    const sections = content.split(/(?=^#{1,6}\s)/m).filter(s => s.trim().length > 30);
    if (sections.length <= 1) return this._chunkByParagraphs(content, maxChars);

    const chunks = [];
    let current = '';
    for (const section of sections) {
      if (current.length + section.length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = section;
      } else {
        current += (current ? '\n\n' : '') + section;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [content];
  }

  _chunkByParagraphs(content, maxChars) {
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20);
    if (paragraphs.length <= 1) return [content];

    const chunks = [];
    let current = '';
    for (const para of paragraphs) {
      if (current.length + para.length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [content];
  }

  _chunkByTurns(content) {
    // Split conversation into User+Assistant turn pairs
    const turnPattern = /^(User|Human|You|Me|Assistant|AI|Claude|Bot|GPT|System):\s*/gim;
    const parts = content.split(/(?=^(?:User|Human|You|Me):\s)/gim).filter(p => p.trim().length > 20);

    if (parts.length <= 1) return [content];

    // Group into pairs (user turn + assistant response)
    const chunks = [];
    let current = '';
    for (const part of parts) {
      const isUserTurn = /^(User|Human|You|Me):\s/i.test(part.trim());
      if (isUserTurn && current.length > 0) {
        chunks.push(current.trim());
        current = part;
      } else {
        current += (current ? '\n' : '') + part;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [content];
  }

  _chunkByRows(content, rowsPerChunk) {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length <= rowsPerChunk) return [content];

    // Keep header row with each chunk
    const header = lines[0];
    const dataRows = lines.slice(1);
    const chunks = [];

    for (let i = 0; i < dataRows.length; i += rowsPerChunk) {
      const batch = dataRows.slice(i, i + rowsPerChunk);
      chunks.push(header + '\n' + batch.join('\n'));
    }
    return chunks.length > 0 ? chunks : [content];
  }

  _chunkByKeyStructure(content, maxChars) {
    // For JSON/YAML: split by top-level keys
    const trimmed = content.trimStart();

    // JSON: split by top-level object keys
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const keys = Object.keys(obj);
        if (keys.length <= 1) return [content];

        const chunks = [];
        let current = {};
        let currentSize = 0;

        for (const key of keys) {
          const entry = JSON.stringify({ [key]: obj[key] }, null, 2);
          if (currentSize + entry.length > maxChars && currentSize > 0) {
            chunks.push(JSON.stringify(current, null, 2));
            current = {};
            currentSize = 0;
          }
          current[key] = obj[key];
          currentSize += entry.length;
        }
        if (Object.keys(current).length > 0) {
          chunks.push(JSON.stringify(current, null, 2));
        }
        return chunks.length > 0 ? chunks : [content];
      } catch {
        return this._chunkByParagraphs(content, maxChars);
      }
    }

    // YAML: split by top-level keys (lines starting with non-whitespace + colon)
    const yamlSections = content.split(/(?=^[a-zA-Z_][a-zA-Z0-9_]*:\s)/m).filter(s => s.trim().length > 10);
    if (yamlSections.length > 1) {
      const chunks = [];
      let current = '';
      for (const section of yamlSections) {
        if (current.length + section.length > maxChars && current.length > 0) {
          chunks.push(current.trim());
          current = section;
        } else {
          current += (current ? '\n' : '') + section;
        }
      }
      if (current.trim()) chunks.push(current.trim());
      return chunks.length > 0 ? chunks : [content];
    }

    return this._chunkByParagraphs(content, maxChars);
  }

  _chunkByHtmlSections(content, maxChars) {
    // Strip tags, split by heading-like elements
    const stripped = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

    // Split at heading tags
    const sections = stripped.split(/(?=<h[1-6][^>]*>)/i).filter(s => s.trim().length > 30);

    if (sections.length <= 1) {
      // Fallback: strip all tags and chunk as paragraphs
      const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return this._chunkByParagraphs(text, maxChars);
    }

    const chunks = [];
    let current = '';
    for (const section of sections) {
      const text = section.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 20) continue;
      if (current.length + text.length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = text;
      } else {
        current += (current ? '\n\n' : '') + text;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()];
  }
}

// ── Helpers (module-scope) ─────────────────────────────────────────

function isChatLike(payload) {
  const p = String(payload.source_metadata?.source_platform || '').toLowerCase();
  return p.includes('talk-to-hive')
    || p.includes('chat')
    || (p === 'manual' && payload.metadata?.source_type_normalized === 'chat');
}

// Extract temporal anchors from short user-typed content. Returns
//   { tags: ["time:tuesday", "time:19:00", "time:may-23"], refs: [...] }
// Used at save-time to attach time tags so retrieval can filter by
// "what did I save about Tuesday" or "find the 7pm meeting".
const _DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const _MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function _extractTemporalAnchors(content, _tz) {
  const text = String(content || "").toLowerCase();
  const tags = [];
  const refs = [];

  // Day-of-week
  for (const d of _DAYS) {
    if (new RegExp('\\b' + d + '\\b').test(text)) { tags.push(`time:${d}`); refs.push({ kind: "dow", value: d }); }
  }
  // Relative tokens
  for (const rel of ["today","tomorrow","tonight","yesterday","next week","this week"]) {
    if (new RegExp('\\b' + rel.replace(' ', '\\s+') + '\\b').test(text)) { tags.push(`time:${rel.replace(/\s+/g, "-")}`); refs.push({ kind: "rel", value: rel }); }
  }
  // Hour-of-day (e.g. "7 pm", "19:00", "7pm")
  const hourMatch = text.match(/\b(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)\b/);
  if (hourMatch) {
    let h = Number(hourMatch[1]);
    const min = hourMatch[2] || "00";
    const ampm = hourMatch[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const stamp = `${String(h).padStart(2, "0")}:${min}`;
    tags.push(`time:${stamp}`);
    refs.push({ kind: "hod", value: stamp, raw: hourMatch[0] });
  }
  const hm24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hm24 && !hourMatch) {
    const stamp = `${String(Number(hm24[1])).padStart(2, "0")}:${hm24[2]}`;
    tags.push(`time:${stamp}`);
    refs.push({ kind: "hod", value: stamp, raw: hm24[0] });
  }
  // Month + day ("may 23", "may 12")
  for (const m of _MONTHS) {
    const re = new RegExp('\\b' + m + '\\s+(\\d{1,2})\\b');
    const mm = text.match(re);
    if (mm) {
      tags.push(`time:${m}-${mm[1]}`);
      refs.push({ kind: "md", value: `${m}-${mm[1]}` });
    }
  }
  return { tags: Array.from(new Set(tags)), refs };
}
