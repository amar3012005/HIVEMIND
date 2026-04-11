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

    // Step 2: Apply type-specific routing → returns array of payloads
    let payloads;
    switch (sourceType) {
      case 'gmail':
        payloads = await this._routeGmail(payload);
        break;
      case 'claude':
        payloads = await this._routeClaude(payload);
        break;
      case 'knowledge_base':
        payloads = await this._routeKnowledgeBase(payload);
        break;
      case 'github':
        payloads = await this._routeGithub(payload);
        break;
      case 'slack':
        payloads = await this._routeSlack(payload);
        break;
      case 'chat':
        payloads = await this._routeChat(payload);
        break;
      default:
        payloads = [payload];
    }

    // For each payload, do semantic pre-flight and annotate with triple operator
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

    if (platform.includes('gmail') || platform.includes('google_mail') || platform.includes('email')) return 'gmail';
    if (platform.includes('claude') || platform.includes('anthropic')) return 'claude';
    if (platform.includes('notion') || platform.includes('obsidian') || platform.includes('document') || platform.includes('pdf') || platform.includes('knowledge')) return 'knowledge_base';
    if (platform.includes('github') || platform.includes('gitlab') || platform.includes('code')) return 'github';
    if (platform.includes('slack') || platform.includes('teams') || platform.includes('discord')) return 'slack';
    if (platform.includes('chat') || platform.includes('talk-to-hive') || platform.includes('conversation')) return 'chat';
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
  async _routeKnowledgeBase(payload) {
    const content = payload.content || '';

    // Split into chunks at heading markers or double newlines
    const chunkSize = 1500; // chars
    const rawChunks = this._chunkDocument(content, chunkSize);

    // Only chunk if document is large enough
    if (rawChunks.length <= 1) {
      return [{
        ...payload,
        memory_type: payload.memory_type || 'fact',
        metadata: { ...payload.metadata, source_type_normalized: 'knowledge_base' }
      }];
    }

    return rawChunks.map((chunk, i) => ({
      ...payload,
      id: undefined, // let graph-engine assign new IDs
      content: chunk,
      title: payload.title ? `${payload.title} (part ${i + 1}/${rawChunks.length})` : undefined,
      memory_type: payload.memory_type || 'fact',
      metadata: {
        ...payload.metadata,
        source_type_normalized: 'knowledge_base',
        chunk_index: i,
        chunk_total: rawChunks.length,
        parent_title: payload.title || null,
      }
    }));
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
}
