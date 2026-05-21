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

    // Step 1: Normalize content based on source type (cleanup + metadata extraction)
    if (payload.content) {
      const normalized = this.normalizer.normalize(payload.content, sourceType, payload.metadata);
      payload = { ...payload, content: normalized.content, metadata: { ...payload.metadata, ...normalized.metadata } };
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
      const enrichedParent = await this._enrichWithTripleOperator(result.parent);
      return {
        parent: enrichedParent,
        children: result.children || [],
        entities: result.entities || [],
        edges: result.edges || [],
      };
    }

    // Flat array path (unchanged from before).
    const payloads = Array.isArray(result) ? result : [result];
    const enriched = await Promise.all(payloads.map(p => this._enrichWithTripleOperator(p)));
    return enriched;
  }

  _detectSourceType(payload) {
    const platform = (
      payload.source_metadata?.source_platform ||
      payload.source_metadata?.source_type ||
      payload.metadata?.source_platform ||
      payload.ingest_type ||
      ''
    ).toLowerCase();

    // Explicit platform metadata takes priority
    if (platform.includes('gmail') || platform.includes('google_mail') || platform.includes('email')) return 'gmail';
    if (platform.includes('claude') || platform.includes('anthropic')) return 'claude';
    if (platform.includes('notion') || platform.includes('obsidian') || platform.includes('document') || platform.includes('pdf') || platform.includes('knowledge')) return 'knowledge_base';
    if (platform.includes('github') || platform.includes('gitlab') || platform.includes('code')) return 'github';
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
  async _routeGmail(payload) {
    const content = payload.content || '';
    // Extract structured fields if raw email format
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
  async _routeChat(payload) {
    // Chat facts are already clean statements from the user
    // Mark as fact type and ensure proper metadata for triple operator matching
    return [{
      ...payload,
      memory_type: payload.memory_type || 'fact',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'chat',
      }
    }];
  }

  // --- Slack / Teams ---
  async _routeSlack(payload) {
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

    // Skip for very short content
    if (payload.content.length < 30) return payload;

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

      const topMatch = similar[0];
      if (!topMatch) return payload;

      if (topMatch.score >= SIMILARITY_UPDATE_THRESHOLD) {
        // Very similar → supersede
        const relationship = normalizeRelationshipDescriptor({
          type: 'Updates',
          targetId: topMatch.id,
          confidence: topMatch.score,
          reason: 'high_similarity',
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
          relationship: { type: 'Updates', target_id: topMatch.id, confidence: topMatch.score }
        };
      }

      if (topMatch.score >= SIMILARITY_EXTEND_THRESHOLD) {
        // Moderately similar → extend/augment
        const relationship = normalizeRelationshipDescriptor({
          type: 'Extends',
          targetId: topMatch.id,
          confidence: topMatch.score,
          reason: 'moderate_similarity',
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
          relationship: { type: 'Extends', target_id: topMatch.id, confidence: topMatch.score }
        };
      }

      // Check for Derives: multiple memories with moderate similarity → synthesis
      const deriveSources = similar.filter(m => m.score >= 0.40 && m.score < SIMILARITY_EXTEND_THRESHOLD);
      if (deriveSources.length >= 2) {
        const base = this._hasContradictionSignal(payload.content, topMatch.content)
          ? { ...payload, _contradicts_hint: topMatch.id }
          : payload;
        const relationship = normalizeRelationshipDescriptor({
          type: 'Derives',
          sourceIds: deriveSources.slice(0, 5).map(m => m.id),
          confidence: deriveSources[0]?.score ?? topMatch.score ?? 0.6,
          reason: 'multi_source_synthesis',
        });
        return {
          ...base,
          metadata: {
            ...(base.metadata || {}),
            ...buildSemanticMetadata({
              semanticRole: inferMemorySemanticRole(base),
              relationship,
              sourceIds: deriveSources.slice(0, 5).map(m => m.id),
              sourceRefs: deriveSources.slice(0, 5),
              sourceMetadata: base.source_metadata,
            }),
          },
          relationship: { type: 'Derives', sourceIds: deriveSources.slice(0, 5).map(m => m.id), confidence: deriveSources[0]?.score ?? topMatch.score ?? 0.6 },
          _derives_from: deriveSources.slice(0, 5).map(m => ({ id: m.id, score: m.score })),
        };
      }

      // Low similarity: check for contradiction signals
      if (this._hasContradictionSignal(payload.content, topMatch.content)) {
        return {
          ...payload,
          _contradicts_hint: topMatch.id, // passed to graph-engine contradiction logic
        };
      }

      return payload; // no relationship: brand new memory
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
