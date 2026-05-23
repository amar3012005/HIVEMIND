import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ConflictDetector, computeTokenSimilarity } from './conflict-detector.js';
import { RelationshipClassifier } from './relationship-classifier.js';
import { extractCodeChunks, detectCodeLanguage } from './code-ingestion.js';
import { PredictCalibrateFilter } from './predict-calibrate.js';
import { Observer } from './observer.js'; // kept for backward compat, not initialized
import { buildObservationPayload, formatObservation } from './observation-store.js';
import { extractFacts } from './fact-extractor.js';
import {
  buildSemanticMetadata,
  inferMemorySemanticRole,
  normalizeRelationshipDescriptor,
  normalizeRelationshipType,
} from './relationship-semantics.js';

function nowIso() {
  return new Date().toISOString();
}

// STOPWORDS removed (2026-05-21) — replaced by LLM-based entity linker
// which handles coreference/pronouns/cross-cultural names without
// needing a curated stoplist. See _attachEntityCoMentionEdges.

/**
 * Heuristic fact extraction fallback — used when LLM extraction returns too few facts.
 * Extracts personal-statement sentences from user-side content.
 */
function heuristicFactExtraction(content) {
  // Extract user statements only (not assistant recommendations)
  const userPart = content.split(/\nAssistant:/i)[0] || content;

  const facts = [];
  const sentences = userPart.split(/[.!?\n]+/)
    .map(s => s.replace(/^User:\s*/i, '').trim())
    .filter(s => s.length > 15 && s.length < 300);

  for (const sent of sentences) {
    // Skip questions
    if (sent.includes('?')) continue;
    if (/^(can|could|do|does|would|should|what|how|where|when|why|is|are)\b/i.test(sent)) continue;
    // Keep statements with personal facts
    if (/\b(I|my|me|we|I'm|I've|I'll|I'd)\b/i.test(sent)) {
      facts.push(sent);
    }
  }

  return facts.slice(0, 20);
}

/**
 * Parse extracted date strings into ISO event dates.
 * Handles both absolute dates ("October 15th", "March 3") and
 * relative dates ("two months ago", "last Saturday") anchored to documentDate.
 */
function parseEventDates(rawDates, documentDate) {
  if (!rawDates || rawDates.length === 0) return [];
  const anchor = documentDate ? new Date(documentDate) : new Date();
  if (isNaN(anchor.getTime())) return [];

  const wordToNum = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

  const parsed = [];
  for (const raw of rawDates) {
    const s = (raw || '').trim().toLowerCase();
    if (!s || s === 'none') continue;

    // Relative: "X days/weeks/months/years ago"
    const relMatch = s.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?|years?)\s+ago/i);
    if (relMatch) {
      const num = parseInt(relMatch[1], 10) || wordToNum[relMatch[1]] || 1;
      const unit = relMatch[2].replace(/s$/, '');
      const d = new Date(anchor);
      if (unit === 'day') d.setDate(d.getDate() - num);
      else if (unit === 'week') d.setDate(d.getDate() - num * 7);
      else if (unit === 'month') d.setMonth(d.getMonth() - num);
      else if (unit === 'year') d.setFullYear(d.getFullYear() - num);
      parsed.push(d.toISOString());
      continue;
    }

    // Relative: "last Saturday/Monday/..."
    const lastDayMatch = s.match(/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (lastDayMatch) {
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = dayNames.indexOf(lastDayMatch[1].toLowerCase());
      const d = new Date(anchor);
      const currentDay = d.getDay();
      const diff = (currentDay - targetDay + 7) % 7 || 7;
      d.setDate(d.getDate() - diff);
      parsed.push(d.toISOString());
      continue;
    }

    // Relative: "about two weeks now" / "for two weeks"
    const durationMatch = s.match(/(?:about|for)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?|months?)/i);
    if (durationMatch) {
      const num = parseInt(durationMatch[1], 10) || wordToNum[durationMatch[1]] || 1;
      const unit = durationMatch[2].replace(/s$/, '');
      const d = new Date(anchor);
      if (unit === 'day') d.setDate(d.getDate() - num);
      else if (unit === 'week') d.setDate(d.getDate() - num * 7);
      else if (unit === 'month') d.setMonth(d.getMonth() - num);
      parsed.push(d.toISOString());
      continue;
    }

    // Absolute: "October 15th", "March 3", "January 10, 2023"
    const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
    const absMatch = s.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
    if (absMatch) {
      const month = months[absMatch[1].toLowerCase()];
      const day = parseInt(absMatch[2], 10);
      const year = absMatch[3] ? parseInt(absMatch[3], 10) : anchor.getFullYear();
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) parsed.push(d.toISOString());
      continue;
    }

    // Numeric: "3/22", "05/20/2023"
    const numMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (numMatch) {
      const month = parseInt(numMatch[1], 10) - 1;
      const day = parseInt(numMatch[2], 10);
      const year = numMatch[3] ? (numMatch[3].length === 2 ? 2000 + parseInt(numMatch[3], 10) : parseInt(numMatch[3], 10)) : anchor.getFullYear();
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) parsed.push(d.toISOString());
    }
  }
  return parsed;
}

function deriveDocumentDate(input = {}) {
  if (input.document_date) {
    return input.document_date;
  }

  const candidates = [
    input.metadata?.session_date,
    input.metadata?.document_date,
    input.metadata?.question_date,
    input.metadata?.observation_date,
    input.metadata?.email_date,
    input.metadata?.created_at,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = parseFlexibleDate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  // Fallback: use current time so every memory has a temporal anchor
  return new Date().toISOString();
}

function parseFlexibleDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value !== 'string') return null;

  const normalized = value
    .replace(/\s*\([^)]+\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const match = normalized.match(
    /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (match) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
    const parsed = new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ));

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const native = new Date(normalized);
  if (!Number.isNaN(native.getTime())) {
    return native.toISOString();
  }

  return null;
}

export class InMemoryGraphStore {
  constructor() {
    this.memories = new Map();
    this.relationships = [];
    this.versions = [];
    this.sources = [];
    this.codeMetadata = [];
    this.derivationJobs = [];
    this.userLocks = new Map();
  }

  async advisoryLock(userId, fn) {
    const lockKey = `${userId || 'global'}`;
    const previous = this.userLocks.get(lockKey) || Promise.resolve();
    const next = previous.then(() => fn(this));
    this.userLocks.set(lockKey, next.catch(() => {}));
    return next;
  }

  async transaction(fn) {
    return fn(this);
  }

  async createMemory(memory) {
    this.memories.set(memory.id, { ...memory });
    return { ...memory };
  }

  async updateMemory(id, patch) {
    const current = this.memories.get(id);
    if (!current) {
      throw new Error(`Memory not found: ${id}`);
    }
    const updated = { ...current, ...patch };
    this.memories.set(id, updated);
    return { ...updated };
  }

  async getMemory(id) {
    const memory = this.memories.get(id);
    return memory ? { ...memory } : null;
  }

  async listLatestMemories({ user_id, org_id, project }) {
    return Array.from(this.memories.values())
      .filter(memory => memory.user_id === user_id && memory.org_id === org_id)
      .filter(memory => !project || memory.project === project)
      .filter(memory => memory.is_latest !== false)
      .map(memory => ({ ...memory }));
  }

  async searchMemories({ query = '', user_id, org_id, project, tags, n_results = 10, is_latest } = {}) {
    const q = (query || '').trim();
    const all = Array.from(this.memories.values())
      .filter(memory => memory.user_id === user_id && memory.org_id === org_id)
      .filter(memory => !project || memory.project === project)
      .filter(memory => typeof is_latest === 'boolean' ? memory.is_latest === is_latest : true)
      .filter(memory => !tags?.length || tags.every(tag => (memory.tags || []).includes(tag)))
      .map(memory => ({
        ...memory,
        _score: q ? computeTokenSimilarity(q, memory.content || '') : 1
      }))
      .sort((left, right) => right._score - left._score || new Date(right.created_at) - new Date(left.created_at));

    return all.slice(0, n_results).map(({ _score, ...memory }) => ({ ...memory, score: _score }));
  }

  async listRelationships({ user_id, org_id, project, relationship_types, limit = 2000 } = {}) {
    const normalizedTypes = relationship_types?.length
      ? relationship_types.map(type => normalizeRelationshipType(type) || type)
      : null;
    const scopedIds = new Set(
      Array.from(this.memories.values())
        .filter(memory => memory.user_id === user_id && memory.org_id === org_id)
        .filter(memory => !project || memory.project === project)
        .map(memory => memory.id)
    );

    return this.relationships
      .filter(edge => scopedIds.has(edge.from_id) && scopedIds.has(edge.to_id))
      .filter(edge => !normalizedTypes?.length || normalizedTypes.includes(normalizeRelationshipType(edge.type) || edge.type))
      .slice(0, limit)
      .map(edge => ({ ...edge }));
  }

  async getRelatedMemories(memoryId, { maxDepth = 1, user_id, org_id, project } = {}) {
    if (maxDepth <= 0) return [];
    const scopedIds = new Set(
      Array.from(this.memories.values())
        .filter(memory => !user_id || memory.user_id === user_id)
        .filter(memory => !org_id || memory.org_id === org_id)
        .filter(memory => !project || memory.project === project)
        .map(memory => memory.id)
    );
    return this.relationships
      .filter(edge => edge.from_id === memoryId || edge.to_id === memoryId)
      .filter(edge => scopedIds.size === 0 || (scopedIds.has(edge.from_id) && scopedIds.has(edge.to_id)))
      .map(edge => ({ ...edge, type: normalizeRelationshipType(edge.type) || edge.type }));
  }

  async createRelationship(edge) {
    const normalized = {
      ...edge,
      type: normalizeRelationshipType(edge.type) || edge.type,
      confidence: Number.isFinite(edge.confidence) ? edge.confidence : 1,
      metadata: edge.metadata || {},
    };
    this.relationships.push({ ...normalized });
    return { ...normalized };
  }

  async createMemoryVersion(version) {
    this.versions.push({ ...version });
    return { ...version };
  }

  async createSourceMetadata(source) {
    this.sources.push({ ...source });
    return { ...source };
  }

  async createCodeMetadata(metadata) {
    this.codeMetadata.push({ ...metadata });
    return { ...metadata };
  }

  async enqueueDerivationJob(job) {
    this.derivationJobs.push({ ...job });
    return { ...job };
  }
}

export class MemoryGraphEngine {
  constructor({
    store,
    vectorStore = null,
    conflictDetector = new ConflictDetector(),
    relationshipClassifier = new RelationshipClassifier({ conflictDetector }),
    deriveThreshold = 0.75,
    predictCalibrate = false,
    predictCalibrateOptions = {},
    smartIngestRouter = null,
  } = {}) {
    if (!store) {
      throw new Error('MemoryGraphEngine requires a store');
    }

    this.store = store;
    this.vectorStore = vectorStore; // Qdrant client for semantic similarity search
    this.conflictDetector = conflictDetector;
    this.relationshipClassifier = relationshipClassifier;
    this.deriveThreshold = deriveThreshold;
    this.predictCalibrate = predictCalibrate;
    this.predictCalibrateFilter = predictCalibrate
      ? new PredictCalibrateFilter(predictCalibrateOptions)
      : null;
    // SmartIngestRouter is the canonical entry-point for every save: it
    // normalizes content, recalls similar memories, infers the triple
    // operator (Updates/Extends/Derives/Contradicts/Mentions), and emits
    // entity/temporal tags. Setting this on the engine makes ingestMemory
    // a single gateway — direct callers (server.js, MCP, /api/memories,
    // connectors) can skip building routedPayloads themselves and the
    // engine will route automatically.
    this.smartIngestRouter = smartIngestRouter;
    // Observer is superseded by MemoryProcessor (unified single-call pipeline).
    // this.observer is intentionally not initialized; Observer import kept for backward compat.
  }

  setSmartIngestRouter(router) {
    this.smartIngestRouter = router;
  }

  async ingestMemory(input) {
    // Canonical gateway: if a router is attached AND the caller hasn't
    // pre-routed (no `_smart_routed` flag) AND the caller hasn't explicitly
    // opted out (smartIngest: false), route through SmartIngestRouter so
    // recall→operator-inference→tagging fires for EVERY save path (MCP,
    // chat, talk-to-hive, /api/memories, connectors, direct calls). This
    // is what makes HIVEMIND a memory engine, not a database — every save
    // updates/extends/contradicts prior memories instead of accumulating
    // duplicates.
    if (this.smartIngestRouter
        && !input._smart_routed
        && input.smartIngest !== false
        && input.skipSmartRouting !== true) {
      try {
        const routed = await this.smartIngestRouter.route({ ...input });
        // Tree shape: route returned { parent, children, ... }
        if (routed && !Array.isArray(routed) && routed.parent) {
          return await this.ingestMemoryTree({
            ...routed,
            parent: { ...routed.parent, _smart_routed: true },
            children: (routed.children || []).map((c) => ({ ...c, _smart_routed: true })),
          });
        }
        // Flat-array shape: route returned [enrichedPayload, ...]. If it
        // collapsed to one payload, ingest that one through the rest of
        // this method (re-entering with _smart_routed marker so the
        // gateway doesn't loop). If it expanded into multiple (chunks),
        // ingest each child and return the first result for backwards
        // compatibility (legacy callers expect a single result object).
        const payloads = Array.isArray(routed) ? routed : [routed];
        if (payloads.length === 0) {
          // Router stripped everything (e.g. empty content) — skip.
          return { skipped: true, reason: 'routed-empty' };
        }
        if (payloads.length === 1) {
          input = { ...payloads[0], _smart_routed: true };
        } else {
          const results = [];
          for (const p of payloads) {
            results.push(await this.ingestMemory({ ...p, _smart_routed: true }));
          }
          return { ingested: results.length, results, multi: true };
        }
      } catch (routeErr) {
        // Router failure is non-fatal — degrade to direct save so the
        // user's data still lands. Surface the error for ops visibility.
        console.warn('[graph-engine] smart-router fallback:', routeErr.message);
      }
    }

    // Stamp ingest timestamp on EVERY memory regardless of source:
    //   - tags: `ts:YYYY-MM-DD` (filterable) + `ts:YYYY-MM-DDTHH:MMZ` (precise)
    //   - content suffix: ` (YYYY-MM-DDTHH:MMZ)` — survives embedding so
    //     retrieval and the FE chip can surface "when was this saved" without
    //     a join on createdAt. Idempotent — re-ingests of routed payloads
    //     (which have _smart_routed=true) skip re-stamping by sniffing the
    //     marker tag.
    if (input && !input._ts_stamped) {
      const stampNow = new Date();
      const day = stampNow.toISOString().slice(0, 10);                  // 2026-05-24
      const minute = stampNow.toISOString().slice(0, 16).replace(/:/g, '') + 'Z'; // 2026-05-24T1430Z (no colon — safer in tag string)
      const dispTs = stampNow.toISOString().slice(0, 16) + 'Z';         // 2026-05-24T14:30Z
      const dayTag = `ts:${day}`;
      const minuteTag = `ts:${minute}`;
      const existing = Array.isArray(input.tags) ? input.tags : [];
      if (!existing.includes(dayTag) || !existing.includes(minuteTag)) {
        input = {
          ...input,
          tags: Array.from(new Set([...existing, dayTag, minuteTag])),
        };
      }
      const c = String(input.content || '');
      // Avoid double-stamping when the content already ends with our marker.
      if (c && !/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\s*$/.test(c)) {
        input = { ...input, content: c.replace(/\s+$/, '') + ` (${dispTs})` };
      }
      input._ts_stamped = true;
    }

    const startedAt = Date.now();
    const baseMemory = this._buildMemoryRecord(input);
    if (baseMemory.scope === 'project' && (!Array.isArray(baseMemory.project_ids) || baseMemory.project_ids.length === 0)) {
      throw new Error('Project-scoped memory requires at least one project_id');
    }
    if (baseMemory.scope === 'team' && !baseMemory.primary_team_id) {
      throw new Error('Team-scoped memory requires primary_team_id');
    }
    baseMemory.metadata = {
      ...(baseMemory.metadata || {}),
      ...buildSemanticMetadata({
        semanticRole: inferMemorySemanticRole(baseMemory),
        sourceMetadata: baseMemory.source_metadata,
      }),
    };

    return this.store.advisoryLock(baseMemory.user_id, async lockedStore => {
      const transactionalStore = lockedStore || this.store;
      return transactionalStore.transaction(async store => {
        const latestMemories = await store.listLatestMemories(baseMemory);

        // Hoisted so the post-save entity-link LLM step can re-use the
        // recall set instead of re-querying. Populated inside the
        // smart-ingest block below.
        let recallSimilar = [];

        // --- Smart Ingest: search-first duplicate/update detection ---
        // Uses Qdrant semantic vector search when available (finds paraphrased/reformulated
        // memories that keyword search misses), falls back to FTS otherwise.
        if (input.smartIngest !== false && !input.skipPredictCalibrate) {
          try {
            let similar = [];

            // Prefer Qdrant semantic search — finds semantically similar memories
            // even when wording differs (e.g. "favorite color blue" ↔ "user prefers blue")
            if (this.vectorStore) {
              try {
                const qdrantFilter = {
                  must: [
                    { key: 'user_id', match: { value: baseMemory.user_id } },
                    { key: 'is_latest', match: { value: true } },
                  ],
                };
                if (baseMemory.org_id) {
                  qdrantFilter.must.push({ key: 'org_id', match: { value: baseMemory.org_id } });
                }
                if (baseMemory.project) {
                  qdrantFilter.must.push({ key: 'project', match: { value: baseMemory.project } });
                }

                // Use precomputed embedding when provided (upload pipeline
                // pre-embeds outside the lock to keep the critical section fast).
                const vectorResults = await this.vectorStore.searchMemories({
                  query: input.precomputedQueryVector ? undefined : baseMemory.content.slice(0, 500),
                  vector: input.precomputedQueryVector || undefined,
                  filter: qdrantFilter,
                  limit: 5,
                  score_threshold: 0.45,
                });

                // Normalize Qdrant results to match store.searchMemories format
                similar = vectorResults.map(r => ({
                  id: r.id,
                  content: r.payload?.content || '',
                  title: r.payload?.title || null,
                  tags: r.payload?.tags || [],
                  memory_type: r.payload?.memory_type,
                  project: r.payload?.project,
                  score: r.score,
                  _searchMethod: 'qdrant_vector',
                }));
              } catch (qdrantErr) {
                console.warn('[smart-ingest] Qdrant vector search failed, falling back to FTS:', qdrantErr.message);
              }
            }

            // Fallback: FTS/token similarity from PostgreSQL
            if (similar.length === 0) {
              similar = await store.searchMemories({
                query: baseMemory.content.slice(0, 500),
                user_id: baseMemory.user_id,
                org_id: baseMemory.org_id,
                project: baseMemory.project,
                n_results: 5,
                is_latest: true,
              });
            }

            // Stash for the post-save LLM entity-linker so it doesn't
            // re-query Qdrant. Keeps the canonical pipeline single-fetch.
            recallSimilar = similar;

            // Use lower threshold for Qdrant (0.65) vs FTS (0.85) — vector scores
            // are calibrated differently and semantically meaningful at lower values
            const isVectorSearch = similar[0]?._searchMethod === 'qdrant_vector';
            const similarityThreshold = isVectorSearch ? 0.65 : 0.85;
            const topMatch = similar[0];

            if (topMatch && topMatch.score > similarityThreshold) {
              const { MemoryProcessor } = await import('./memory-processor.js');
              const processor = new MemoryProcessor();
              // Send top 3 candidates to LLM for comparison (not just top 1)
              const candidates = similar.filter(m => m.score > (isVectorSearch ? 0.50 : 0.70)).slice(0, 3);
              const result = await processor.process(baseMemory, candidates);

              if (result.relationship.action === 'NOOP') {
                return {
                  memoryId: baseMemory.id,
                  operation: 'skipped_redundant',
                  reason: 'smart_ingest_duplicate',
                  matchedMemoryId: topMatch.id,
                  similarity: topMatch.score,
                  searchMethod: isVectorSearch ? 'qdrant_vector' : 'fts',
                  processingMs: Date.now() - startedAt,
                };
              }

              if (result.relationship.action === 'UPDATE') {
                // Use LLM's targetId if available (more accurate), fall back to topMatch
                const targetId = result.relationship.targetId || topMatch.id;
                input.relationship = {
                  type: 'Updates',
                  target_id: targetId,
                  confidence: topMatch.score,
                };
              } else if (result.relationship.action === 'EXTEND') {
                const targetId = result.relationship.targetId || topMatch.id;
                input.relationship = {
                  type: 'Extends',
                  target_id: targetId,
                  confidence: topMatch.score,
                };
              } else if (result.relationship.action === 'DERIVE' && result.relationship.sourceIds?.length > 0) {
                input.relationship = {
                  type: 'Derives',
                  sourceIds: result.relationship.sourceIds,
                  confidence: 0.8,
                };
              }
            }
          } catch (smartIngestErr) {
            console.warn('[smart-ingest] Search-first check failed:', smartIngestErr.message);
          }
        }

        // --- Predict-Calibrate filter ---
        let pcResult = null;
        if (this.predictCalibrateFilter && !input.skipPredictCalibrate) {
          pcResult = this.predictCalibrateFilter.filter(baseMemory, latestMemories);
          if (!pcResult.shouldStore) {
            return {
              memoryId: baseMemory.id,
              operation: 'skipped_redundant',
              noveltyScore: pcResult.noveltyScore,
              maxSimilarity: pcResult.maxSimilarity,
              reason: pcResult.reason,
              deprecatedIds: [],
              edgesCreated: [],
              processingMs: Date.now() - startedAt
            };
          }
          // Replace content with delta-extracted content when trimmed
          if (pcResult.deltaExtracted && pcResult.deltaContent) {
            baseMemory.content = pcResult.deltaContent;
          }
          // Attach fingerprint to the memory record
          if (pcResult.fingerprint) {
            baseMemory.contentFingerprint = pcResult.fingerprint;
          }
        }

        if (input.benchmarkEnrichment === true) {
          try {
            const facts = await extractFacts(baseMemory.content, { useLLM: false });
            baseMemory.metadata = {
              ...(baseMemory.metadata || {}),
              benchmark_enrichment_mode: 'facts_only',
              extracted_facts: {
                entities: facts.entities || [],
                dates: facts.temporalRefs || [],
                keyphrases: facts.keyphrases || []
              },
              benchmark_summary: facts.summary || ''
            };
          } catch (enrichmentError) {
            console.warn('[benchmark-enrichment] Failed:', enrichmentError.message);
          }
        }

        const shouldSkipFactExtraction = input.skip_fact_extraction === true || input.skipProcessing === true;
        const shouldRunProcessor = baseMemory.memory_type !== 'observation' && !shouldSkipFactExtraction;
        let processorResult = null;

        // --- Fact-Augment-Only mode (benchmark mode) ---
        // Runs the MemoryProcessor to extract facts but ignores relationship results
        // (no UPDATE/EXTEND/NOOP merging). Prepends extracted facts to content for
        // better embedding quality, then stores the observation as normal.
        if (input.factAugmentOnly && shouldRunProcessor) {
          try {

            const { MemoryProcessor } = await import('./memory-processor.js');
            const processor = new MemoryProcessor();

            const similarMemories = pcResult?.needsConflictResolution && pcResult.matchedMemoryIds?.length > 0
              ? latestMemories.filter(m => pcResult.matchedMemoryIds.includes(m.id))
              : this.conflictDetector.detectCandidates(baseMemory, latestMemories).map(candidate => candidate.memory);

            const result = await processor.process(baseMemory, similarMemories);
            processorResult = result;

            // Build fact prefix from extracted entities/dates AND fact sentences
            const factParts = [];
            if (result.factSentences?.length) factParts.push(...result.factSentences);
            else {
              if (result.facts?.entities?.length) factParts.push(...result.facts.entities);
              if (result.facts?.dates?.length) factParts.push(...result.facts.dates);
            }

            if (factParts.length > 0) {
              baseMemory.content = `[FACTS: ${factParts.join('. ')}.]\n\n${baseMemory.content}`;
            } else {

            }

            // Parse extracted dates into ISO event_dates (anchor relative dates to documentDate)
            const rawDates = result.facts?.dates || [];
            const eventDates = parseEventDates(rawDates, baseMemory.document_date);

            baseMemory.metadata = {
              ...(baseMemory.metadata || {}),
              factSentences: result.factSentences || [],
              extracted_facts: result.facts || { entities: [], dates: [] },
              memory_priority: result.priority || 'medium',
              fact_augment_only: true,
              processed_at: nowIso()
            };
            // Store parsed event dates on the memory for Qdrant filtering
            if (eventDates.length > 0) {
              baseMemory.event_dates = eventDates;
            }

            // Store observation ONLY if no fact-memories were created
            // (facts are more searchable than observations — avoid duplicating)
            const hasUsefulFacts = (result.factSentences || []).filter(f => f.length >= 20).length > 0;
            if (result.observation && !hasUsefulFacts) {
              const obsText = formatObservation({
                content: result.observation,
                priority: result.priority,
                observationDate: baseMemory.document_date || baseMemory.created_at,
              });

              const obsFingerprint = crypto.createHash('sha256').update(obsText).digest('hex');
              const existingObs = latestMemories.filter(m => (m.tags || []).includes('observation'));
              const isDuplicate = existingObs.some(m => {
                const existingFp = crypto.createHash('sha256').update(m.content || '').digest('hex');
                return existingFp === obsFingerprint;
              });

              if (!isDuplicate) {
                const obsPayload = buildObservationPayload({
                  userId: baseMemory.user_id,
                  orgId: baseMemory.org_id,
                  observationText: obsText,
                  observationDate: baseMemory.document_date || baseMemory.created_at,
                  project: baseMemory.project,
                  sourceTags: baseMemory.tags || [],
                  semanticRole: 'finding',
                  relationship: {
                    type: 'Derives',
                    sourceIds: [baseMemory.id],
                    confidence: 0.85,
                    reason: 'observation_extraction',
                  },
                  sourceIds: [baseMemory.id],
                  sourceRefs: [{ id: baseMemory.id, title: baseMemory.title || null }],
                  sourceMetadata: baseMemory.source_metadata,
                });
                const obsId = crypto.randomUUID ? crypto.randomUUID() : `obs-${Date.now()}`;
                await store.createMemory({
                  ...obsPayload,
                  id: obsId,
                  is_latest: true,
                  version: 1,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });
                await this._recordVersionSnapshot(store, {
                  ...obsPayload,
                  id: obsId,
                  version: 1,
                  metadata: obsPayload.metadata || {}
                }, {
                  reason: 'created',
                  is_latest: true,
                  related_memory_id: null
                });
              }
            }
          } catch (procErr) {
            // Fallback: store original content without augmentation
            console.warn('[memory-processor] factAugmentOnly failed, storing original:', procErr.message);
          }
        }
        // --- Standard processor path (full relationship handling) ---
        else if (shouldRunProcessor) {
          try {
            const { MemoryProcessor } = await import('./memory-processor.js');
            const processor = new MemoryProcessor();

            // Gather similar memories for comparison
            // Priority: PredictCalibrate matches > ConflictDetector token matches > Qdrant vector matches
            let similarMemories;
            if (pcResult?.needsConflictResolution && pcResult.matchedMemoryIds?.length > 0) {
              similarMemories = latestMemories.filter(m => pcResult.matchedMemoryIds.includes(m.id));
            } else {
              similarMemories = this.conflictDetector.detectCandidates(baseMemory, latestMemories).map(candidate => candidate.memory);
              // If token-based detector found nothing, try Qdrant semantic search
              if (similarMemories.length === 0 && this.vectorStore) {
                try {
                  const qdrantFilter = {
                    must: [
                      { key: 'user_id', match: { value: baseMemory.user_id } },
                      { key: 'is_latest', match: { value: true } },
                    ],
                  };
                  if (baseMemory.org_id) {
                    qdrantFilter.must.push({ key: 'org_id', match: { value: baseMemory.org_id } });
                  }
                  const vectorResults = await this.vectorStore.searchMemories({
                    query: baseMemory.content.slice(0, 500),
                    filter: qdrantFilter,
                    limit: 3,
                    score_threshold: 0.55,
                  });
                  similarMemories = vectorResults.map(r => ({
                    id: r.id,
                    content: r.payload?.content || '',
                    title: r.payload?.title || null,
                    tags: r.payload?.tags || [],
                    memory_type: r.payload?.memory_type,
                    score: r.score,
                  }));
                } catch (vectorErr) {
                  console.warn('[memory-processor] Qdrant fallback failed:', vectorErr.message);
                }
              }
            }

            const result = await processor.process(baseMemory, similarMemories);
            processorResult = result;

            // Parse extracted dates into ISO event_dates
            const rawDatesStd = result.facts?.dates || [];
            const eventDatesStd = parseEventDates(rawDatesStd, baseMemory.document_date);

            baseMemory.metadata = {
              ...(baseMemory.metadata || {}),
              factSentences: result.factSentences || [],
              extracted_facts: result.facts || { entities: [], dates: [] },
              memory_priority: result.priority || 'medium',
              processed_at: nowIso()
            };
            if (eventDatesStd.length > 0) {
              baseMemory.event_dates = eventDatesStd;
            }

            // Apply relationship
            if (result.relationship.action === 'NOOP') {
              return { memoryId: null, operation: 'skipped_redundant', reason: 'llm_confirmed_duplicate' };
            }
            if (result.relationship.action === 'UPDATE' && result.relationship.targetId) {
              input.relationship = { type: 'Updates', target_id: result.relationship.targetId, confidence: 0.9 };
            }
            if (result.relationship.action === 'DERIVE' && result.relationship.sourceIds?.length > 0) {
              input.relationship = { type: 'Derives', sourceIds: result.relationship.sourceIds, confidence: 0.8 };
            }
            if (result.relationship.action === 'EXTEND' && result.relationship.targetId) {
              input.relationship = { type: 'Extends', target_id: result.relationship.targetId, confidence: 0.8 };
            }

            // Store observation ONLY if no fact-memories were created
            const hasUsefulFactsStd = (result.factSentences || []).filter(f => f.length >= 20).length > 0;
            if (result.observation && !hasUsefulFactsStd) {
              const obsText = formatObservation({
                content: result.observation,
                priority: result.priority,
                observationDate: baseMemory.document_date || baseMemory.created_at,
              });

              // Check for duplicate observation before storing (SHA-256 fingerprint)
              const obsFingerprint = crypto.createHash('sha256').update(obsText).digest('hex');
              const existingObs = latestMemories.filter(m => (m.tags || []).includes('observation'));
              const isDuplicate = existingObs.some(m => {
                const existingFp = crypto.createHash('sha256').update(m.content || '').digest('hex');
                return existingFp === obsFingerprint;
              });

              if (!isDuplicate) {
                const obsPayload = buildObservationPayload({
                  userId: baseMemory.user_id,
                  orgId: baseMemory.org_id,
                  observationText: obsText,
                  observationDate: baseMemory.document_date || baseMemory.created_at,
                  project: baseMemory.project,
                  sourceTags: baseMemory.tags || [],
                  semanticRole: 'finding',
                  relationship: {
                    type: 'Derives',
                    sourceIds: [baseMemory.id],
                    confidence: 0.85,
                    reason: 'observation_extraction',
                  },
                  sourceIds: [baseMemory.id],
                  sourceRefs: [{ id: baseMemory.id, title: baseMemory.title || null }],
                  sourceMetadata: baseMemory.source_metadata,
                });
                const obsId = crypto.randomUUID ? crypto.randomUUID() : `obs-${Date.now()}`;
                await store.createMemory({
                  ...obsPayload,
                  id: obsId,
                  is_latest: true,
                  version: 1,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });
                await this._recordVersionSnapshot(store, {
                  ...obsPayload,
                  id: obsId,
                  version: 1,
                  metadata: obsPayload.metadata || {}
                }, {
                  reason: 'created',
                  is_latest: true,
                  related_memory_id: null
                });
              }
            }
          } catch (procErr) {
            console.warn('[memory-processor] Processing failed:', procErr.message);
          }
        }

        const shouldSkipRelationshipClassification = input.skip_relationship_classification === true && !input.relationship;
        const classification = shouldSkipRelationshipClassification
          ? { operation: 'created', relationship: null }
          : input.relationship
          ? this._explicitClassification(input.relationship)
          : this.relationshipClassifier.classifyRelationship(baseMemory, latestMemories);

        const deriveSources = classification.relationship?.sourceIds?.length
          ? classification.relationship.sourceIds
          : Array.isArray(input._derives_from)
            ? input._derives_from.map(source => source?.id || source?.sourceId || source).filter(Boolean)
            : [];
        const deriveSourceRefs = Array.isArray(input._derives_from) ? input._derives_from.filter(Boolean) : [];

        const semanticRelationship = (classification.relationship || deriveSources.length > 0)
          ? normalizeRelationshipDescriptor({
            ...(classification.relationship || { type: 'Derives' }),
            sourceIds: classification.relationship?.sourceIds?.length ? classification.relationship.sourceIds : deriveSources,
          }, {
            sourceMemory: baseMemory,
            confidence: classification.relationship?.confidence ?? deriveSourceRefs[0]?.score ?? deriveSourceRefs[0]?.confidence,
          })
          : null;
        const effectiveRelationshipType = semanticRelationship?.type || classification.relationship?.type || null;

        baseMemory.metadata = {
          ...(baseMemory.metadata || {}),
          ...buildSemanticMetadata({
            semanticRole: inferMemorySemanticRole(baseMemory),
            relationship: semanticRelationship,
            sourceIds: deriveSources,
            sourceRefs: deriveSourceRefs,
            sourceMetadata: baseMemory.source_metadata,
          }),
        };

        await store.createMemory(baseMemory);

        // --- Create fact-memories (separate searchable memories per extracted fact) ---
        // Filter out trivial/noise sentences before creating fact-memories
        const TRIVIAL_PATTERNS = /^(thanks|thank you|that sounds|great|okay|sure|yes|no|I see|I agree|I understand|wow|cool|nice|oh|hmm|interesting|exactly|right|got it|I am (so )?(excited|happy|glad|sorry))/i;
        // Filter out meta-facts from LLM extraction — these are about the extraction process, not actual facts
        const META_FACT_PATTERNS = /\b(the user (did not|provided|shared|mentioned|gave|is discussing|discussed|started a new topic|gave a|uploaded))\b/i;
        let rawFactSentences = processorResult?.factSentences || [];

        // Heuristic fallback: if LLM extraction returned too few facts, augment with heuristic extraction
        if (rawFactSentences.length < 3 && baseMemory.content.length > 100) {
          const heuristicFacts = heuristicFactExtraction(baseMemory.content);
          const existing = new Set(rawFactSentences.map(f => f.toLowerCase().slice(0, 50)));
          for (const hf of heuristicFacts) {
            if (!existing.has(hf.toLowerCase().slice(0, 50))) {
              rawFactSentences.push(hf);
              existing.add(hf.toLowerCase().slice(0, 50));
            }
          }
        }

        const factSentences = rawFactSentences.filter(f => {
          if (f.length < 20) return false; // too short to be useful
          if (TRIVIAL_PATTERNS.test(f)) return false; // sentiment, not fact
          if (META_FACT_PATTERNS.test(f)) return false; // meta-observation about extraction, not actual fact
          // Skip if it's essentially the same as the parent title
          if (baseMemory.title && f.toLowerCase().includes(baseMemory.title.toLowerCase().slice(0, 30))) return false;
          return true;
        });
        const factMemoryIds = [];

        // Gate child fact-memory creation. Default OFF (2026-05-21) because
        // it 6x-bloats the flat list view — every meaningful save spawned
        // 5 child "Fact: ..." memories that polluted the main UI without
        // surfacing the Extends edge that ties them together.
        // Set MEMORY_FACT_CHILDREN_ENABLED=true to restore legacy behaviour
        // (kept around for benchmark / Mem0-parity runs that compare child
        // counts). When OFF we still persist the distilled facts on the
        // parent's metadata so recall + UI can show them inline.
        const factChildrenEnabled =
          (process.env.MEMORY_FACT_CHILDREN_ENABLED || '').toLowerCase() === 'true';

        if (!factChildrenEnabled && factSentences.length > 0) {
          // Persist distilled facts as parent metadata instead of as
          // separate child memories. No edges, no extra rows — but the
          // facts remain searchable on the parent and visible in the UI
          // via `metadata.extracted_facts.sentences`.
          try {
            await store.updateMemory(baseMemory.id, {
              metadata: {
                ...(baseMemory.metadata || {}),
                extracted_facts: {
                  ...(baseMemory.metadata?.extracted_facts || {}),
                  sentences: factSentences.slice(0, 10),
                  extracted_at: new Date().toISOString(),
                  extraction_source: 'memory_processor',
                },
              },
            });
          } catch (mdErr) {
            console.warn('[ingest] failed to attach extracted_facts metadata:', mdErr.message);
          }
        } else if (factChildrenEnabled && factSentences.length > 0) {
          for (const fact of factSentences.slice(0, 5)) { // Max 5 facts per parent (production: quality over quantity)
            const factId = crypto.randomUUID ? crypto.randomUUID() : `fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await store.createMemory({
              id: factId,
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
              project: baseMemory.project,
              content: fact,
              title: `Fact: ${fact.slice(0, 60)}`,
              tags: [...(baseMemory.tags || []), 'extracted-fact'],
              memory_type: 'fact',
              is_latest: true,
              version: 1,
              importance_score: 0.8,
              document_date: baseMemory.document_date,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              metadata: {
                parent_memory_id: baseMemory.id,
                extraction_source: 'memory_processor',
                extracted_at: new Date().toISOString(),
                ...buildSemanticMetadata({
                  semanticRole: 'claim',
                  relationship: {
                    type: 'Derives',
                    sourceIds: [baseMemory.id],
                    confidence: 0.9,
                    reason: 'fact_extraction',
                  },
                  sourceIds: [baseMemory.id],
                  sourceRefs: [{ id: baseMemory.id, title: baseMemory.title || null }],
                  sourceMetadata: baseMemory.source_metadata,
                }),
              },
            });
            // Create Extends relationship: fact → parent
            await store.createRelationship({
              id: crypto.randomUUID ? crypto.randomUUID() : `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              from_id: factId,
              to_id: baseMemory.id,
              type: 'Extends',
              confidence: 0.9,
              metadata: buildSemanticMetadata({
                semanticRole: 'relationship',
                relationship: {
                  type: 'Extends',
                  sourceId: factId,
                  targetId: baseMemory.id,
                  confidence: 0.9,
                  reason: 'fact_extraction',
                },
                sourceIds: [factId],
                sourceRefs: [{ id: factId, title: `Fact: ${fact.slice(0, 60)}` }],
                targetMemory: baseMemory,
                sourceMetadata: baseMemory.source_metadata || null,
                reason: 'fact_extraction',
                confidence: 0.9,
              }),
              created_by: 'memory_processor',
            });
            factMemoryIds.push(factId);
          }
        }

        await this._persistSourceMetadata(store, baseMemory, input.source_metadata || baseMemory.source_metadata);

        if (input.code_metadata) {
          await store.createCodeMetadata({
            id: uuidv4(),
            memory_id: baseMemory.id,
            ...input.code_metadata,
            created_at: nowIso()
          });
        }

        // Post-save: entity co-mention linker fires AFTER createMemory +
        // sourceMetadata + codeMetadata persist, so the new row exists by
        // the time we search for co-mentioning peers. Awaited inside the
        // transaction so the edges land in the same atomic batch — if
        // ingest fails everything rolls back together.
        //
        // For high-throughput callers (bulk KB promotion), this adds
        // 1 extra query per save. We accept that cost in exchange for
        // ALL ingest paths (chat, MCP, KB, connectors) producing
        // entity-rich graphs without per-callsite wiring.
        try {
          await this._attachEntityCoMentionEdges(baseMemory, store, recallSimilar);
        } catch (entityErr) {
          // Non-fatal — entity linking is best-effort enrichment.
          console.warn('[entity-co-mention] failed:', entityErr.message);
        }

        const result = {
          memoryId: baseMemory.id,
          factMemoryIds,
          operation: effectiveRelationshipType === 'Updates'
            ? 'updated'
            : effectiveRelationshipType === 'Extends'
              ? 'extended'
              : effectiveRelationshipType === 'Derives'
                ? 'derived'
                : classification.operation,
          deprecatedIds: [],
          edgesCreated: [],
          processingMs: 0
        };

        if (effectiveRelationshipType === 'Updates') {
          Object.assign(result, await this.applyUpdate(baseMemory.id, classification.relationship.targetId, {
            store,
            user_id: baseMemory.user_id,
            org_id: baseMemory.org_id,
            confidence: classification.relationship?.confidence ?? semanticRelationship?.confidence,
            startedAt
          }));
        } else if (effectiveRelationshipType === 'Extends') {
          Object.assign(result, await this.applyExtends(baseMemory.id, classification.relationship.targetId, {
            store,
            user_id: baseMemory.user_id,
            org_id: baseMemory.org_id,
            confidence: classification.relationship?.confidence ?? semanticRelationship?.confidence,
            startedAt
          }));
        } else if (effectiveRelationshipType === 'Derives') {
          const sourceIds = semanticRelationship?.sourceIds?.length
            ? semanticRelationship.sourceIds
            : deriveSources;

          if (sourceIds.length > 0) {
            Object.assign(result, await this.applyDerivesFromSources(sourceIds, baseMemory.id, {
              store,
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
              confidence: classification.relationship?.confidence ?? semanticRelationship?.confidence,
              startedAt,
            }));
          } else {
            await this._recordVersionSnapshot(store, baseMemory, {
              reason: 'Derives',
              is_latest: true,
              related_memory_id: null
            });
            result.processingMs = Date.now() - startedAt;
          }
        } else {
          await this._recordVersionSnapshot(store, baseMemory, {
            reason: 'created',
            is_latest: true,
            related_memory_id: null
          });
          result.processingMs = Date.now() - startedAt;
        }

        await this._enqueueDeriveCandidates(store, baseMemory, latestMemories);

        // Detect contradictions and reconcile: determine correct edge type BEFORE creating
        // Two opt-outs:
        //   - skip_contradiction_detection: hard skip (legacy)
        //   - strict_contradictions: high-bar mode (KB promotion uses this)
        const skipContradictions = input.skip_contradiction_detection === true
          || input.skipContradictionDetection === true;
        const strictMode = input.strict_contradictions === true
          || input.strictContradictions === true;
        if (this.conflictDetector && latestMemories.length > 0 && !skipContradictions) {
          try {
            const EVOLUTION_RE = /\b(now|switched|changed|moved to|migrating|replaced|updated|corrected|actually|no longer|stopped|used to|formerly|previously|instead)\b/i;
            const ADDITIVE_RE = /\b(also|additionally|furthermore|plus|as well|on top of|in addition|moreover|and also)\b/i;

            const contradictions = this.conflictDetector.detectContradictions(
              baseMemory,
              latestMemories,
              { strictMode }
            );
            for (const c of contradictions) {
              // Reconcile: is this a real contradiction, or an evolution/extension?
              const newContent = (baseMemory.content || '').toLowerCase();
              let edgeType = 'Contradicts';
              let reasoning = '';

              if (EVOLUTION_RE.test(newContent) && (c.contradictionType === 'temporal_shift' || c.contradictionType === 'change' || c.contradictionType === 'explicit_correction')) {
                edgeType = 'Updates';
                reasoning = `Belief evolved: ${c.contradictionType} with evolution language`;
              } else if (EVOLUTION_RE.test(newContent) && c.contradictionType === 'negation') {
                edgeType = 'Updates';
                reasoning = 'Negation with evolution language: belief changed over time';
              } else if (ADDITIVE_RE.test(newContent)) {
                edgeType = 'Extends';
                reasoning = 'Additive language: new memory adds nuance';
              } else if (c.confidence >= 0.7 && baseMemory.memory_type === c.memory.memory_type && c.contradictionType === 'value_divergence') {
                edgeType = 'Updates';
                reasoning = 'Same type with different values: factual update';
              }

              const isReconciled = edgeType !== 'Contradicts';

              try {
                await store.createRelationship({
                  id: crypto.randomUUID ? crypto.randomUUID() : `crel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  from_id: baseMemory.id,
                  to_id: c.memory.id,
                  type: edgeType,
                  confidence: c.confidence,
                  metadata: buildSemanticMetadata({
                    semanticRole: 'relationship',
                    relationship: {
                      type: edgeType,
                      sourceId: baseMemory.id,
                      targetId: c.memory.id,
                      confidence: c.confidence,
                      reason: reasoning || 'contradiction_detection',
                    },
                    sourceIds: [baseMemory.id],
                    sourceRefs: [{ id: baseMemory.id, title: baseMemory.title || null }],
                    targetMemory: c.memory,
                    sourceMetadata: baseMemory.source_metadata || null,
                    reason: reasoning || 'contradiction_detection',
                    confidence: c.confidence,
                  }),
                  created_by: isReconciled ? 'turing-reconciliation' : 'conflict-detector',
                });
              } catch { /* Edge already exists — skip duplicate */ }

              // If reconciled to Updates: mark old memory as superseded
              if (edgeType === 'Updates') {
                try { await store.updateMemory(c.memory.id, { is_latest: false }); } catch {}
              }

              if (isReconciled) {
                result.edgesCreated.push({ type: edgeType, from: baseMemory.id, to: c.memory.id, reconciled: true, reasoning });
                console.log(`[conflict-reconciliation] ${baseMemory.id} → ${c.memory.id}: Contradicts → ${edgeType} (${reasoning})`);
              }
            }
            if (contradictions.length > 0) {
              console.log(`[contradiction] Detected ${contradictions.length} contradictions for memory ${baseMemory.id}`);
              result.contradictions = contradictions.map(c => {
                const newContent = (baseMemory.content || '').toLowerCase();
                const EVOLUTION_RE = /\b(now|switched|changed|moved to|migrating|replaced|updated|corrected|actually|no longer|stopped|used to|formerly|previously|instead)\b/i;
                const isEvolution = EVOLUTION_RE.test(newContent) && (c.contradictionType === 'temporal_shift' || c.contradictionType === 'change' || c.contradictionType === 'explicit_correction' || c.contradictionType === 'negation');
                return {
                  memory_id: c.memory.id,
                  type: c.contradictionType,
                  confidence: c.confidence,
                  reconciled_to: isEvolution ? 'Updates' : undefined,
                };
              });
            }

            // Old reconciliation block removed — reconciliation now happens BEFORE edge creation above
          } catch (contradictionErr) {
            console.warn('[contradiction] Detection failed:', contradictionErr.message);
          }
        }

        // --- Auto-Derives from SmartIngestRouter ---
        // When the router detected multiple moderately-similar source memories,
        // create Derives edges: source → new memory (synthesis relationship).
        if (effectiveRelationshipType !== 'Derives' && input._derives_from && Array.isArray(input._derives_from)) {
          for (const source of input._derives_from) {
            try {
              await store.createRelationship({
                id: crypto.randomUUID ? crypto.randomUUID() : `drel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                from_id: source.id,
                to_id: baseMemory.id,
                type: 'Derives',
                confidence: source.score || 0.6,
                metadata: { auto_derived: true, source: 'smart_ingest_router' },
                created_at: nowIso(),
              });
              result.edgesCreated.push({ type: 'Derives', from: source.id, to: baseMemory.id });
            } catch (err) {
              // Non-fatal: edge creation should never block ingest
            }
          }
        }

        // --- Auto-Derives from processor similarity ---
        // When the MemoryProcessor was given 2+ similar memories for comparison
        // and the relationship was not Updates/Extends (i.e. a new memory that
        // synthesizes insights from multiple existing ones), create Derives edges.
        if (processorResult && !input._derives_from
            && classification.operation === 'created'
            && processorResult.factSentences?.length > 0) {
          // The similar memories that were passed to the processor
          const candidates = pcResult?.needsConflictResolution && pcResult.matchedMemoryIds?.length > 0
            ? latestMemories.filter(m => pcResult.matchedMemoryIds.includes(m.id))
            : this.conflictDetector.detectCandidates(baseMemory, latestMemories).map(c => c.memory);

          if (candidates.length >= 2) {
            for (const cand of candidates.slice(0, 5)) {
              try {
                await store.createRelationship({
                  id: crypto.randomUUID ? crypto.randomUUID() : `drel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  from_id: cand.id,
                  to_id: baseMemory.id,
                  type: 'Derives',
                  confidence: 0.7,
                  metadata: { auto_derived: true, source: 'ingest_synthesis' },
                  created_at: nowIso(),
                });
                result.edgesCreated.push({ type: 'Derives', from: cand.id, to: baseMemory.id });
              } catch (err) {
                // Non-fatal
              }
            }
          }
        }

        // Attach predict-calibrate metadata when available
        if (pcResult) {
          result.noveltyScore = pcResult.noveltyScore;
          result.maxSimilarity = pcResult.maxSimilarity;
          result.deltaExtracted = pcResult.deltaExtracted || false;
        }

        return result;
      });
    });
  }

  async ingestCodeMemory({ content, filepath, language, user_id, org_id, project, tags = [], source_metadata = {}, metadata = {} }) {
    const chunks = extractCodeChunks({
      content,
      filepath,
      language: language || detectCodeLanguage(filepath)
    });
    const memories = [];

    for (const chunk of chunks) {
      const result = await this.ingestMemory({
        user_id,
        org_id,
        project,
        content: chunk.text,
        tags: [...new Set(['code', ...tags])],
        source_metadata,
        metadata: {
          ...metadata,
          filepath,
          language: language || detectCodeLanguage(filepath),
          chunk_index: chunk.chunk_index,
          chunk_start: chunk.chunk_start,
          chunk_end: chunk.chunk_end,
          ast_metadata: chunk.ast_metadata
        },
        code_metadata: chunk.code_metadata,
        skip_relationship_classification: true
      });

      const storedMemory = await this.store.getMemory(result.memoryId);
      memories.push(storedMemory);
    }

    return {
      memories,
      indexed_files: [filepath],
      chunk_count: memories.length
    };
  }

  /**
   * Ingest a hierarchical tree of memories (parent + children + edges).
   *
   * Contract (IngestTree):
   *   {
   *     parent:    Payload                      ← canonical doc / session / thread root
   *     children:  Payload[]                    ← sections / turns / messages, ORDERED
   *     entities?: Array<{ name, type, mentions_in?: 'parent'|'all'|number[] }>   (reserved)
   *     edges?:    Array<{ from, to, type, confidence?, metadata? }> (reserved — extra edges
   *                beyond the automatic child→parent PartOf links this method creates)
   *   }
   *
   * Behaviour:
   *   1. Ingest parent via ingestMemory() → parentId (full smart-router/conflict/edge logic still fires).
   *   2. For each child, stamp metadata.parent_memory_id = parentId, then ingestMemory().
   *      • Pass skip_fact_extraction:true on children by default — the parent owns the
   *        distilled facts, children carry the raw content. Caller can override per child.
   *   3. Write PartOf edge per child:  child.id → parent.id, confidence=1.0,
   *      created_by='ingest_tree'.
   *   4. (Reserved) entities + extra edges from the tree payload.
   *
   * Returns: { parentId, childIds, partOfEdgeIds, parentResult, childResults }
   *
   * This is the new canonical entry for hierarchical sources (KB docs, Talk-to-HIVE
   * sessions, Gmail/Slack threads, web pages). buildRoutedIngestPayloads dispatches
   * here automatically when SmartIngestRouter.route returns an IngestTree shape;
   * legacy flat-array routes still hit ingestMemory() per payload unchanged.
   */
  /**
   * Post-save entity co-mention linker — LLM-driven, recall-first.
   *
   * Why LLM: regex/stopword extraction misses pronouns ('she'),
   * paraphrased references ('my partner' → Rama), and cross-cultural
   * names. The recall step already fetched the top-K semantically similar
   * memories; we hand them to a 70B model with the new content and ask
   * for structured entity links.
   *
   * Flow:
   *   1. Use the `similar` array already produced by Qdrant vector search
   *      (passed in from ingestMemory). If empty, do nothing.
   *   2. ONE LLM call (llama-3.3-70b-versatile, JSON mode):
   *        input  = new memory + indexed candidates
   *        output = { entities, links: [{ index, entity, confidence, reason }] }
   *   3. Persist entities[] on baseMemory.metadata.extracted_entities so the
   *      FE chip renderer can show them without a second LLM pass.
   *   4. Write up to 3 Mentions edges (confidence >= 0.55).
   *
   * Gated by MEMORY_ENTITY_LINKING (default 'true'). Soft-fails if
   * GROQ_API_KEY missing or LLM errors — never blocks the save.
   */
  async _attachEntityCoMentionEdges(baseMemory, store, similar = []) {
    if ((process.env.MEMORY_ENTITY_LINKING || 'true').toLowerCase() === 'false') return;
    if (!process.env.GROQ_API_KEY) {
      console.warn('[entity-co-mention] GROQ_API_KEY missing — skipping LLM extraction');
      return;
    }
    const content = baseMemory.content || '';
    // Short content is OK when the caller explicitly forced linking (chat
    // saves), since user-typed short facts like "meet Ethan Tuesday 7pm"
    // are exactly what the graph should connect. Otherwise the 10-char
    // floor is enough to weed out single-word noise.
    const forceLink = baseMemory.metadata?.force_entity_linking === true;
    const minLen = forceLink ? 1 : 10;
    if (content.length < minLen) return;

    // Filter the recall set: drop self, drop empty bodies, cap at 8 to
    // keep the prompt small + cost predictable.
    let candidates = (similar || [])
      .filter(s => s.id && s.id !== baseMemory.id && (s.content || s.title))
      .slice(0, 8);

    // Boost: pre-pull memories sharing entity: or time: tags. Short user
    // facts ("meet Ethan Tuesday 7pm") share little embedding signal with
    // older memories about the same person/event but share the same tags,
    // so tag-overlap surfaces the right candidates that vector recall
    // would miss. Cap at 4 extra so the LLM prompt stays bounded.
    const tagSignals = (baseMemory.tags || []).filter(t =>
      typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('time:') || t.startsWith('project:') || t.startsWith('person:'))
    );
    if (tagSignals.length > 0) {
      try {
        const prismaClient = (store && store.client) || this.store.client;
        if (prismaClient && prismaClient.memory) {
          const tagHits = await prismaClient.memory.findMany({
            where: {
              userId: baseMemory.user_id,
              orgId: baseMemory.org_id,
              deletedAt: null,
              isLatest: true,
              id: { not: baseMemory.id },
              tags: { hasSome: tagSignals },
            },
            select: { id: true, title: true, content: true, tags: true },
            orderBy: { createdAt: 'desc' },
            take: 6,
          });
          const existingIds = new Set(candidates.map(c => c.id));
          for (const r of tagHits) {
            if (existingIds.has(r.id) || candidates.length >= 8) continue;
            candidates.push({ id: r.id, title: r.title, content: r.content, tags: r.tags, _searchMethod: 'tag_overlap' });
            existingIds.add(r.id);
          }
        }
      } catch (tagErr) {
        console.warn('[entity-co-mention] tag-overlap pre-pull failed:', tagErr.message);
      }
    }

    // FALLBACK: Qdrant semantic recall can return 0 hits when the new
    // content is phrased entirely in pronouns ("we recovered from it")
    // and shares no embedding-meaningful tokens with prior memories. In
    // that case, pull the top-15 most-recent memories for the same user
    // — pronouns most often reference RECENT entities, so recency is a
    // strong heuristic for coreference candidates.
    if (candidates.length === 0) {
      try {
        const prismaClient = (store && store.client) || this.store.client;
        if (prismaClient && prismaClient.memory) {
          const recent = await prismaClient.memory.findMany({
            where: {
              userId: baseMemory.user_id,
              orgId: baseMemory.org_id,
              deletedAt: null,
              isLatest: true,
              id: { not: baseMemory.id },
            },
            select: { id: true, title: true, content: true, tags: true },
            orderBy: { createdAt: 'desc' },
            take: 15,
          });
          candidates = recent.map(r => ({
            id: r.id,
            title: r.title,
            content: r.content,
            tags: r.tags,
            _searchMethod: 'recent_fallback',
          })).slice(0, 8);
          console.log(`[entity-co-mention] recall empty → recency fallback: ${candidates.length} candidates`);
        }
      } catch (fallbackErr) {
        console.warn('[entity-co-mention] recency fallback failed:', fallbackErr.message);
      }
    }

    if (candidates.length === 0) {
      console.log('[entity-co-mention] no candidates at all — skipping');
      return;
    }

    const candidateBlock = candidates.map((c, i) =>
      `[${i}] ${(c.title || '').slice(0, 120)}\n    ${(c.content || '').slice(0, 280)}`
    ).join('\n\n');

    // Today's date is passed in so the LLM resolves relative temporal refs
    // ("Tuesday 7pm", "next week", "mañana 19:00") against the actual now,
    // not the model's training cutoff.
    const todayIso = new Date().toISOString().slice(0, 10);

    const prompt = `You are a multilingual memory graph linker. Given a NEW MEMORY and CANDIDATE memories, do FOUR things in ONE pass:

  1. extract proper-noun entities from the new memory (people, orgs, products, projects, places). Work in ANY language — Spanish, Hindi, Tamil, German, etc. — return entities in their original form.
  2. extract TEMPORAL anchors (day-of-week, time-of-day, relative refs like "tomorrow"/"mañana"/"morgen", absolute dates, recurring patterns). Resolve relatives against today=${todayIso}.
  3. classify the new memory's TYPE (decision | preference | fact | event | goal | lesson | relationship)
  4. for each candidate that shares an entity OR temporal anchor, emit ONE typed edge

Use coreference: pronouns and possessives ("she", "my partner", "it", "they", "elle", "उसने") can resolve to a named entity from earlier turns.

NEW MEMORY:
${(baseMemory.title || '').slice(0, 200)}
${content.slice(0, 1500)}

CANDIDATE MEMORIES (already-recalled, indexed):
${candidateBlock}

Output JSON only:
{
  "entities": ["Rama", "Heidelberg"],
  "temporal": {
    "day_of_week": "tuesday",
    "time_of_day": "19:00",
    "date_iso": "2026-05-26",
    "relative": "next week",
    "recurring": null
  },
  "memory_type": "event",
  "links": [
    { "index": 0, "entity": "Rama", "type": "Updates", "confidence": 0.85, "reason": "new memory supersedes the older decision about Rama" },
    { "index": 2, "entity": "Rama", "type": "Mentions", "confidence": 0.70, "reason": "same person, different context" }
  ]
}

Temporal rules:
  • day_of_week  — english lowercase (monday/tuesday/...) or null. Translate from any language.
  • time_of_day  — 24-hour "HH:MM" string or null. "7 pm" → "19:00", "noon" → "12:00".
  • date_iso     — "YYYY-MM-DD" if the new memory has an unambiguous absolute or computable-relative date; else null. Today is ${todayIso}.
  • relative     — original relative-time phrase (e.g. "tomorrow", "next week", "mañana") for audit, or null.
  • recurring    — "weekly", "monthly", "daily", "every-tuesday", etc., or null.

Edge type rules (pick ONE per link):
  • Updates     — new memory supersedes the candidate. The user just made a DIFFERENT choice on the same topic, or the same fact changed value. ALSO writes is_latest=false on the candidate.
  • Contradicts — new memory disagrees with candidate but is NOT a clear supersession (competing claims).
  • Extends     — new memory adds nuance to the candidate without overriding it.
  • Mentions    — both share an entity OR temporal anchor but unrelated factually.

Memory type rules:
  • decision/preference/fact/event/goal/lesson/relationship — pick the best fit. If the memory mentions a specific time/date/person-meeting it is usually "event".

Confidence: 0.55–1.0 only. Skip uncertain links.
Reason: ≤80 chars plain English.
At most one link per candidate index.
If nothing matches: { "entities": [], "temporal": {}, "memory_type": null, "links": [] }.`;

    let parsed;
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.ENTITY_LINKER_MODEL || 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 700,
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        console.warn(`[entity-co-mention] LLM ${resp.status}: ${errBody.slice(0, 200)}`);
        return;
      }
      const data = await resp.json();
      const raw = data?.choices?.[0]?.message?.content || '{}';
      parsed = JSON.parse(raw);
    } catch (llmErr) {
      console.warn('[entity-co-mention] LLM failed:', llmErr.message);
      return;
    }

    const entities = Array.isArray(parsed?.entities) ? parsed.entities.map(String).slice(0, 12) : [];
    const links = Array.isArray(parsed?.links) ? parsed.links : [];
    const inferredType = (typeof parsed?.memory_type === 'string' && parsed.memory_type.trim()) || null;
    const temporal = (parsed && typeof parsed.temporal === 'object' && parsed.temporal) || {};

    // Build temporal tags from LLM output. Language-agnostic — the LLM
    // already normalized to english day names, HH:MM, ISO dates.
    const temporalTags = [];
    if (typeof temporal.day_of_week === 'string' && temporal.day_of_week.trim()) {
      temporalTags.push(`time:${temporal.day_of_week.trim().toLowerCase()}`);
    }
    if (typeof temporal.time_of_day === 'string' && /^\d{2}:\d{2}$/.test(temporal.time_of_day.trim())) {
      temporalTags.push(`time:${temporal.time_of_day.trim()}`);
    }
    if (typeof temporal.date_iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(temporal.date_iso.trim())) {
      temporalTags.push(`time:${temporal.date_iso.trim()}`);
    }
    if (typeof temporal.recurring === 'string' && temporal.recurring.trim()) {
      temporalTags.push(`time:recurring-${temporal.recurring.trim().toLowerCase().replace(/\s+/g, '-')}`);
    }

    console.log(`[entity-co-mention] entities=[${entities.join(',')}] type=${inferredType || '-'} temporal=[${temporalTags.join(',')}] links=${links.length}`);

    // If the LLM inferred a more specific memory_type than the caller
    // supplied (caller likely defaulted to 'fact'), upgrade it. Only
    // upgrade in the fact→specific direction; never downgrade a caller
    // who explicitly set 'decision'/'preference'/etc.
    const VALID_TYPES = new Set(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']);
    if (inferredType && VALID_TYPES.has(inferredType) && baseMemory.memory_type === 'fact' && inferredType !== 'fact') {
      try {
        await store.updateMemory(baseMemory.id, { memoryType: inferredType });
        baseMemory.memory_type = inferredType; // keep local copy in sync
        console.log(`[entity-co-mention] upgraded memory_type: fact → ${inferredType}`);
      } catch (typeErr) {
        console.warn('[entity-co-mention] type upgrade failed:', typeErr.message);
      }
    }

    // Persist extracted entities on the parent so the FE chip can render
    // them without another LLM pass + retrieval can filter by them.
    //
    // Memory model has no metadata JSONB column — we use TAGS instead:
    //   entity:Rama, entity:Heidelberg, entity:SAP
    // FE EntityChips reads these tags (filters tags starting with 'entity:').
    // Filterable via /api/memories?tags=entity:Rama — first-class graph node.
    if (entities.length > 0 || temporalTags.length > 0) {
      try {
        const cleanEntities = entities
          .filter(e => typeof e === 'string' && e.length > 0 && e.length < 60)
          .map(e => `entity:${e.replace(/\s+/g, '_')}`);
        const newTags = Array.from(new Set([
          ...(baseMemory.tags || []),
          ...cleanEntities,
          ...temporalTags,
        ]));
        await store.updateMemory(baseMemory.id, { tags: newTags });
      } catch (tagErr) {
        console.warn('[entity-co-mention] tag update failed:', tagErr.message);
      }
    }

    // Edge cap. Chat-bucket saves with force_entity_linking get a higher
    // ceiling (6) since the user explicitly invoked the save and we want
    // every relevant prior fact connected. Other paths stay at 3 to keep
    // the graph noise-controlled.
    const EDGE_CAP = (baseMemory.metadata?.force_entity_linking === true) ? 6 : 3;
    const VALID_EDGE_TYPES = new Set(['Updates', 'Extends', 'Mentions', 'Contradicts']);
    const sorted = links
      .filter(l => Number.isInteger(l.index) && l.index >= 0 && l.index < candidates.length)
      .filter(l => typeof l.entity === 'string' && l.entity.length > 0)
      .filter(l => typeof l.confidence === 'number' && l.confidence >= 0.55)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, EDGE_CAP);

    const writeStore = store || this.store;
    for (const l of sorted) {
      const cand = candidates[l.index];
      const confidence = Math.min(Math.max(l.confidence, 0.55), 0.95);
      // Honor LLM-picked edge type when it's valid; default to Mentions
      // for plain co-mention. Updates also flips the old memory to
      // is_latest=false so downstream recall/graph don't surface a
      // superseded value.
      const edgeType = VALID_EDGE_TYPES.has(l.type) ? l.type : 'Mentions';
      const isSupersede = edgeType === 'Updates';

      try {
        await writeStore.createRelationship({
          id: uuidv4(),
          from_id: baseMemory.id,
          to_id: cand.id,
          type: edgeType,
          confidence,
          created_by: 'entity_co_mention_llm',
          created_at: nowIso(),
          metadata: {
            shared_entities: [l.entity],
            reason: (l.reason || '').slice(0, 200),
            extraction_model: process.env.ENTITY_LINKER_MODEL || 'llama-3.3-70b-versatile',
            classification_source: 'llm',
          },
        });
      } catch (edgeErr) {
        // Fallback to Extends + subtype if enum missing (mid-rollout).
        try {
          await writeStore.createRelationship({
            id: uuidv4(),
            from_id: baseMemory.id,
            to_id: cand.id,
            type: 'Extends',
            confidence,
            created_by: 'entity_co_mention_llm',
            created_at: nowIso(),
            metadata: {
              subtype: edgeType,
              shared_entities: [l.entity],
              reason: (l.reason || '').slice(0, 200),
              fallback_reason: edgeErr.message,
            },
          });
        } catch {}
      }

      // When the LLM said "Updates", flip the old memory's is_latest
      // flag so retrieval + the graph view treat it as superseded.
      // Same canonical behaviour as the regex-based supersede path in
      // graph-engine, just driven by LLM intent instead.
      if (isSupersede) {
        try {
          await writeStore.updateMemory(cand.id, { is_latest: false });
          console.log(`[entity-co-mention] supersede: ${cand.id.slice(0, 8)} → is_latest=false (by ${baseMemory.id.slice(0, 8)})`);
        } catch (supErr) {
          console.warn('[entity-co-mention] supersede update failed:', supErr.message);
        }
      }
    }
  }

  async ingestMemoryTree(tree) {
    if (!tree || typeof tree !== 'object' || !tree.parent) {
      throw new Error('ingestMemoryTree requires a tree with a .parent payload');
    }
    const children = Array.isArray(tree.children) ? tree.children : [];

    // 1. Parent ingest — full canonical pipeline (smart-router, conflict, edges).
    const parentResult = await this.ingestMemory({
      ...tree.parent,
      // Tag parent so retrieval can identify roots easily without inspecting children.
      metadata: {
        ...(tree.parent.metadata || {}),
        ingest_tree_role: 'parent',
        child_count: children.length,
      },
    });
    const parentId = parentResult.memoryId;
    const childIds = [];
    const childResults = [];

    // 2. Children — sequential to keep order + share the same advisory lock window.
    //    Each child's metadata gets parent_memory_id set so the FE / list filter
    //    can hide them from default views via include_children=false.
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const childPayload = {
        ...c,
        skip_fact_extraction: c.skip_fact_extraction !== false, // default true for children
        metadata: {
          ...(c.metadata || {}),
          parent_memory_id: parentId,
          ingest_tree_role: 'child',
          chunk_index: typeof c.metadata?.chunk_index === 'number' ? c.metadata.chunk_index : i,
          chunk_total: children.length,
        },
        // Auto-tag children with 'extracted-fact' so the default list view hides them.
        // Caller-supplied tags preserved.
        tags: Array.from(new Set([...(c.tags || []), 'extracted-fact'])),
      };
      try {
        const r = await this.ingestMemory(childPayload);
        childIds.push(r.memoryId);
        childResults.push(r);
      } catch (childErr) {
        console.warn(`[ingest-tree] child ${i} failed:`, childErr.message);
      }
    }

    // 3. PartOf edges — outside the advisory lock since they touch different rows.
    //    We use the store directly (not in a transaction) so a failed edge doesn't
    //    roll back legit child memories. Each edge is idempotent via uuid.
    //
    // Native PartOf edge (enum migration 20260521120000 added the value).
    const partOfEdgeIds = [];
    for (const childId of childIds) {
      try {
        const edge = await this.store.createRelationship({
          id: uuidv4(),
          from_id: childId,
          to_id: parentId,
          type: 'PartOf',
          confidence: 1.0,
          created_by: 'ingest_tree',
          created_at: nowIso(),
          metadata: {
            ingest_tree: true,
            parent_role: tree.parent.metadata?.semantic_role || 'document',
          },
        });
        partOfEdgeIds.push(edge?.id || null);
      } catch (edgeErr) {
        // Edge already exists or constraint violation — non-fatal.
        // If this is a stale Prisma client without the new enum, fall back
        // to legacy Extends + metadata.subtype='PartOf' so ingest never
        // crashes mid-deploy. Once all containers reload the new client,
        // this fallback is dead code.
        try {
          const edge2 = await this.store.createRelationship({
            id: uuidv4(),
            from_id: childId,
            to_id: parentId,
            type: 'Extends',
            confidence: 1.0,
            created_by: 'ingest_tree',
            created_at: nowIso(),
            metadata: {
              ingest_tree: true,
              subtype: 'PartOf',
              parent_role: tree.parent.metadata?.semantic_role || 'document',
              fallback_reason: edgeErr.message,
            },
          });
          partOfEdgeIds.push(edge2?.id || null);
        } catch (edge2Err) {
          console.warn('[ingest-tree] PartOf edge failed (both native + fallback):', edge2Err.message);
        }
      }
    }

    return {
      parentId,
      childIds,
      partOfEdgeIds,
      parentResult,
      childResults,
      operation: 'tree_ingested',
    };
  }

  async applyUpdate(sourceId, targetId, { store: storeOverride, user_id, org_id, confidence = 1.0, startedAt = Date.now() } = {}) {
    const activeStore = storeOverride || this.store;
    return activeStore.transaction(async store => {
      const source = await store.getMemory(sourceId);
      let target = await store.getMemory(targetId);

      if (!source || !target) {
        throw new Error('applyUpdate requires source and target memories');
      }

      if (target.is_latest === false) {
        const rebasedTarget = await this._findLatestReplacement(store, target, source);
        if (rebasedTarget) {
          target = rebasedTarget;
          targetId = rebasedTarget.id;
        }
      }

      if (source.user_id !== user_id || target.user_id !== user_id || source.org_id !== org_id || target.org_id !== org_id) {
        throw new Error('Tenant scope violation in applyUpdate');
      }

      await store.updateMemory(targetId, {
        is_latest: false,
        updated_at: nowIso()
      });

      const nextVersion = (target.version || 1) + 1;
      const edge = await store.createRelationship({
        id: uuidv4(),
        from_id: sourceId,
        to_id: targetId,
        type: 'Updates',
        confidence,
        created_at: nowIso(),
        metadata: buildSemanticMetadata({
          semanticRole: 'relationship',
          relationship: {
            type: 'Updates',
            sourceId,
            targetId,
            confidence,
            reason: 'Updates',
          },
          sourceIds: [sourceId],
          targetMemory: target,
          sourceMemory: source,
          sourceMetadata: source.source_metadata || null,
          reason: 'Updates',
          confidence,
        })
      });

      await this._recordVersionSnapshot(store, target, {
        reason: 'Updates',
        is_latest: false,
        related_memory_id: sourceId
      });
      await this._recordVersionSnapshot(store, source, {
        reason: 'Updates',
        is_latest: true,
        related_memory_id: targetId,
        version: nextVersion
      });

      return {
        memoryId: sourceId,
        operation: 'updated',
        deprecatedIds: [targetId],
        edgesCreated: [edge],
        processingMs: Date.now() - startedAt
      };
    });
  }

  async applyExtends(sourceId, targetId, { store: storeOverride, user_id, org_id, confidence = 1.0, startedAt = Date.now() } = {}) {
    const activeStore = storeOverride || this.store;
    return activeStore.transaction(async store => {
      const source = await store.getMemory(sourceId);
      const target = await store.getMemory(targetId);

      if (!source || !target) {
        throw new Error('applyExtends requires source and target memories');
      }
      if (source.user_id !== user_id || target.user_id !== user_id || source.org_id !== org_id || target.org_id !== org_id) {
        throw new Error('Tenant scope violation in applyExtends');
      }

      const nextVersion = (target.version || 1) + 1;
      const edge = await store.createRelationship({
        id: uuidv4(),
        from_id: sourceId,
        to_id: targetId,
        type: 'Extends',
        confidence,
        created_at: nowIso(),
        metadata: buildSemanticMetadata({
          semanticRole: 'relationship',
          relationship: {
            type: 'Extends',
            sourceId,
            targetId,
            confidence,
            reason: 'Extends',
          },
          sourceIds: [sourceId],
          targetMemory: target,
          sourceMemory: source,
          sourceMetadata: source.source_metadata || null,
          reason: 'Extends',
          confidence,
        })
      });

      await this._recordVersionSnapshot(store, source, {
        reason: 'Extends',
        is_latest: true,
        related_memory_id: targetId,
        version: nextVersion
      });

      return {
        memoryId: sourceId,
        operation: 'extended',
        deprecatedIds: [],
        edgesCreated: [edge],
        processingMs: Date.now() - startedAt
      };
    });
  }

  async applyDerives(sourceId, targetId, options = {}) {
    return this.applyDerivesFromSources([sourceId], targetId, options);
  }

  async applyDerivesFromSources(sourceIds, targetId, { store: storeOverride, user_id, org_id, confidence, startedAt = Date.now(), reason = 'Derives' } = {}) {
    const uniqueSourceIds = [...new Set((sourceIds || []).filter(Boolean))];
    if (confidence < this.deriveThreshold) {
      return {
        memoryId: targetId,
        operation: 'derived',
        deprecatedIds: [],
        edgesCreated: [],
        processingMs: Date.now() - startedAt
      };
    }

    const activeStore = storeOverride || this.store;
    return activeStore.transaction(async store => {
      const target = await store.getMemory(targetId);
      const sources = await Promise.all(uniqueSourceIds.map(id => store.getMemory(id)));

      if (!target || sources.some(source => !source)) {
        throw new Error('applyDerives requires source and target memories');
      }
      for (const source of sources) {
        if (source.user_id !== user_id || target.user_id !== user_id || source.org_id !== org_id || target.org_id !== org_id) {
          throw new Error('Tenant scope violation in applyDerives');
        }
      }

      const edges = [];
      for (const sourceIdValue of uniqueSourceIds) {
        const edge = await store.createRelationship({
          id: uuidv4(),
          from_id: sourceIdValue,
          to_id: targetId,
          type: 'Derives',
          confidence,
          created_at: nowIso(),
          metadata: buildSemanticMetadata({
            semanticRole: 'relationship',
            relationship: {
              type: 'Derives',
              sourceIds: [sourceIdValue],
              targetId,
              confidence,
              reason,
            },
            sourceIds: [sourceIdValue],
            sourceRefs: sources.filter(source => source.id === sourceIdValue).map(source => ({
              id: source.id,
              title: source.title || null,
              memory_type: source.memory_type || null,
            })),
            targetMemory: target,
            sourceMetadata: sources.find(source => source.id === sourceIdValue)?.source_metadata || null,
            reason,
            confidence,
          }),
        });
        edges.push(edge);
      }

      await this._recordVersionSnapshot(store, target, {
        reason: 'Derives',
        is_latest: true,
        related_memory_id: uniqueSourceIds[0] || null,
        version: (target.version || 1) + 1
      });

      return {
        memoryId: targetId,
        operation: 'derived',
        deprecatedIds: [],
        edgesCreated: edges,
        processingMs: Date.now() - startedAt
      };
    });
  }

  _buildMemoryRecord(input) {
    const timestamp = nowIso();
    const documentDate = deriveDocumentDate(input);

    // Derive scope: explicit input.scope wins; else infer from inputs.
    //   - explicit project_ids[]   → scope=project
    //   - explicit primary_team_id → scope=team
    //   - target_scope=organization or visibility=organization → scope=organization
    //   - default                  → personal
    let scope = input.scope;
    if (!scope) {
      if (Array.isArray(input.project_ids) && input.project_ids.length > 0) scope = 'project';
      else if (input.primary_team_id) scope = 'team';
      else if (input.target_scope === 'organization' || input.visibility === 'organization') scope = 'organization';
      else scope = 'personal';
    }

    return {
      id: input.id || uuidv4(),
      user_id: input.user_id,
      org_id: input.org_id,
      visibility: input.visibility || 'private',
      scope,
      primary_team_id: input.primary_team_id || null,
      project_ids: Array.isArray(input.project_ids) ? input.project_ids : [],
      project: input.project || null,
      content: input.content,
      memory_type: input.memory_type || 'fact',
      title: input.title || null,
      tags: input.tags || [],
      is_latest: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      document_date: documentDate,
      event_dates: input.event_dates || [],
      metadata: input.metadata || {},
      contentFingerprint: null,
      source_metadata: input.source_metadata || {
        source_type: 'manual',
        source_id: null,
        source_platform: null,
        source_url: null
      }
    };
  }

  _explicitClassification(relationship) {
    const type = normalizeRelationshipType(relationship.type) || relationship.type;
    const operation = type === 'Updates' ? 'updated' : type === 'Extends' ? 'extended' : 'derived';
    const sourceIds = Array.isArray(relationship.sourceIds)
      ? relationship.sourceIds.filter(Boolean)
      : Array.isArray(relationship.source_ids)
        ? relationship.source_ids.filter(Boolean)
        : [];
    return {
      operation,
      relationship: {
        type,
        targetId: relationship.target_id || relationship.targetId,
        sourceIds,
        confidence: relationship.confidence ?? 1.0
      }
    };
  }

  async _recordVersionSnapshot(store, memory, { reason, is_latest, related_memory_id, version }) {
    await store.createMemoryVersion({
      id: uuidv4(),
      memory_id: memory.id,
      version: version || memory.version || 1,
      is_latest,
      reason,
      related_memory_id,
      content_hash: this.conflictDetector.contentHash(memory.content),
      metadata: memory.metadata || {},
      created_at: nowIso()
    });
  }

  async _persistSourceMetadata(store, memory, sourceMetadata) {
    await store.createSourceMetadata({
      id: uuidv4(),
      memory_id: memory.id,
      source_type: sourceMetadata?.source_type || 'manual',
      source_id: sourceMetadata?.source_id || null,
      source_platform: sourceMetadata?.source_platform || null,
      source_url: sourceMetadata?.source_url || null,
      thread_id: sourceMetadata?.thread_id || null,
      parent_message_id: sourceMetadata?.parent_message_id || null,
      ingested_at: nowIso(),
      metadata: memory.metadata || {}
    });
  }

  async _enqueueDeriveCandidates(store, memory, latestMemories) {
    for (const candidate of latestMemories) {
      if (candidate.id === memory.id) continue;
      const confidence = this.conflictDetector.detectCandidates(memory, [candidate])[0]?.similarity || 0;
      if (confidence >= this.deriveThreshold) {
        await store.enqueueDerivationJob({
          id: uuidv4(),
          source_memory_id: memory.id,
          target_memory_id: candidate.id,
          confidence,
          status: 'queued',
          created_at: nowIso()
        });
      }
    }
  }

  async _findLatestReplacement(store, target, source) {
    const latest = await store.listLatestMemories({
      user_id: target.user_id,
      org_id: target.org_id,
      project: target.project || source.project || null
    });

    return latest
      .filter(candidate => candidate.id !== source.id)
      .map(candidate => ({
        memory: candidate,
        similarity: computeTokenSimilarity(target.content, candidate.content)
      }))
      .filter(candidate => candidate.similarity >= 0.6)
      .sort((left, right) => right.similarity - left.similarity)[0]?.memory || null;
  }
}
