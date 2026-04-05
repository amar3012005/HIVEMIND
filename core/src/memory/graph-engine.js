import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ConflictDetector, computeTokenSimilarity } from './conflict-detector.js';
import { RelationshipClassifier } from './relationship-classifier.js';
import { extractCodeChunks, detectCodeLanguage } from './code-ingestion.js';
import { PredictCalibrateFilter } from './predict-calibrate.js';
import { Observer } from './observer.js'; // kept for backward compat, not initialized
import { buildObservationPayload, formatObservation } from './observation-store.js';
import { extractFacts } from './fact-extractor.js';

function nowIso() {
  return new Date().toISOString();
}

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
    const scopedIds = new Set(
      Array.from(this.memories.values())
        .filter(memory => memory.user_id === user_id && memory.org_id === org_id)
        .filter(memory => !project || memory.project === project)
        .map(memory => memory.id)
    );

    return this.relationships
      .filter(edge => scopedIds.has(edge.from_id) && scopedIds.has(edge.to_id))
      .filter(edge => !relationship_types?.length || relationship_types.includes(edge.type))
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
      .map(edge => ({ ...edge }));
  }

  async createRelationship(edge) {
    this.relationships.push({ ...edge });
    return { ...edge };
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
    conflictDetector = new ConflictDetector(),
    relationshipClassifier = new RelationshipClassifier({ conflictDetector }),
    deriveThreshold = 0.75,
    predictCalibrate = false,
    predictCalibrateOptions = {}
  } = {}) {
    if (!store) {
      throw new Error('MemoryGraphEngine requires a store');
    }

    this.store = store;
    this.conflictDetector = conflictDetector;
    this.relationshipClassifier = relationshipClassifier;
    this.deriveThreshold = deriveThreshold;
    this.predictCalibrate = predictCalibrate;
    this.predictCalibrateFilter = predictCalibrate
      ? new PredictCalibrateFilter(predictCalibrateOptions)
      : null;
    // Observer is superseded by MemoryProcessor (unified single-call pipeline).
    // this.observer is intentionally not initialized; Observer import kept for backward compat.
  }

  async ingestMemory(input) {
    const startedAt = Date.now();
    const baseMemory = this._buildMemoryRecord(input);

    return this.store.advisoryLock(baseMemory.user_id, async lockedStore => {
      const transactionalStore = lockedStore || this.store;
      return transactionalStore.transaction(async store => {
        const latestMemories = await store.listLatestMemories(baseMemory);

        // --- Smart Ingest: search-first duplicate/update detection ---
        if (input.smartIngest !== false && !input.skipPredictCalibrate) {
          try {
            const similar = await store.searchMemories({
              query: baseMemory.content.slice(0, 500),
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
              project: baseMemory.project,
              n_results: 3,
              is_latest: true,
            });

            const topMatch = similar[0];
            if (topMatch && topMatch.score > 0.85) {
              const { MemoryProcessor } = await import('./memory-processor.js');
              const processor = new MemoryProcessor();
              const result = await processor.process(baseMemory, [topMatch]);

              if (result.relationship.action === 'NOOP') {
                return {
                  memoryId: baseMemory.id,
                  operation: 'skipped_redundant',
                  reason: 'smart_ingest_duplicate',
                  matchedMemoryId: topMatch.id,
                  similarity: topMatch.score,
                  processingMs: Date.now() - startedAt,
                };
              }

              if (result.relationship.action === 'UPDATE') {
                input.relationship = {
                  type: 'Updates',
                  target_id: topMatch.id,
                  confidence: 0.9,
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

        const shouldRunProcessor = baseMemory.memory_type !== 'observation' && !input.skipProcessing;
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
            const similarMemories = pcResult?.needsConflictResolution && pcResult.matchedMemoryIds?.length > 0
              ? latestMemories.filter(m => pcResult.matchedMemoryIds.includes(m.id))
              : this.conflictDetector.detectCandidates(baseMemory, latestMemories).map(candidate => candidate.memory);

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

        const shouldSkipRelationshipClassification = input.skip_relationship_classification || input.skipProcessing === true;
        const classification = shouldSkipRelationshipClassification
          ? { operation: 'created', relationship: null }
          : input.relationship
          ? this._explicitClassification(input.relationship)
          : this.relationshipClassifier.classifyRelationship(baseMemory, latestMemories);

        await store.createMemory(baseMemory);

        // --- Create fact-memories (separate searchable memories per extracted fact) ---
        // Filter out trivial/noise sentences before creating fact-memories
        const TRIVIAL_PATTERNS = /^(thanks|thank you|that sounds|great|okay|sure|yes|no|I see|I agree|I understand|wow|cool|nice|oh|hmm|interesting|exactly|right|got it|I am (so )?(excited|happy|glad|sorry))/i;
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
          // Skip if it's essentially the same as the parent title
          if (baseMemory.title && f.toLowerCase().includes(baseMemory.title.toLowerCase().slice(0, 30))) return false;
          return true;
        });
        const factMemoryIds = [];
        if (factSentences.length > 0) {
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
              },
            });
            // Create Extends relationship: fact → parent
            await store.createRelationship({
              id: crypto.randomUUID ? crypto.randomUUID() : `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              from_id: factId,
              to_id: baseMemory.id,
              type: 'Extends',
              confidence: 0.9,
              metadata: { source: 'fact_extraction' },
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

        const result = {
          memoryId: baseMemory.id,
          factMemoryIds,
          operation: classification.operation,
          deprecatedIds: [],
          edgesCreated: [],
          processingMs: 0
        };

        if (classification.relationship?.type === 'Updates') {
          Object.assign(result, await this.applyUpdate(baseMemory.id, classification.relationship.targetId, {
            store,
            user_id: baseMemory.user_id,
            org_id: baseMemory.org_id,
            confidence: classification.relationship.confidence,
            startedAt
          }));
        } else if (classification.relationship?.type === 'Extends') {
          Object.assign(result, await this.applyExtends(baseMemory.id, classification.relationship.targetId, {
            store,
            user_id: baseMemory.user_id,
            org_id: baseMemory.org_id,
            confidence: classification.relationship.confidence,
            startedAt
          }));
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
        if (this.conflictDetector && latestMemories.length > 0) {
          try {
            const EVOLUTION_RE = /\b(now|switched|changed|moved to|migrating|replaced|updated|corrected|actually|no longer|stopped|used to|formerly|previously|instead)\b/i;
            const ADDITIVE_RE = /\b(also|additionally|furthermore|plus|as well|on top of|in addition|moreover|and also)\b/i;

            const contradictions = this.conflictDetector.detectContradictions(baseMemory, latestMemories);
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
                  metadata: {
                    contradiction_type: c.contradictionType,
                    detected_at: new Date().toISOString(),
                    source: isReconciled ? 'deterministic-reconciliation' : 'auto-detection',
                    ...(isReconciled ? { reconciled: true, original_type: 'Contradicts', reconciled_to: edgeType, reasoning } : {}),
                  },
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
        if (input._derives_from && Array.isArray(input._derives_from)) {
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
        metadata: {}
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
        metadata: {}
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

  async applyDerives(sourceId, targetId, { store: storeOverride, user_id, org_id, confidence, startedAt = Date.now() } = {}) {
    if (confidence < this.deriveThreshold) {
      return {
        memoryId: sourceId,
        operation: 'derived',
        deprecatedIds: [],
        edgesCreated: [],
        processingMs: Date.now() - startedAt
      };
    }

    const activeStore = storeOverride || this.store;
    return activeStore.transaction(async store => {
      const source = await store.getMemory(sourceId);
      const target = await store.getMemory(targetId);

      if (!source || !target) {
        throw new Error('applyDerives requires source and target memories');
      }
      if (source.user_id !== user_id || target.user_id !== user_id || source.org_id !== org_id || target.org_id !== org_id) {
        throw new Error('Tenant scope violation in applyDerives');
      }

      const nextVersion = (target.version || 1) + 1;
      const edge = await store.createRelationship({
        id: uuidv4(),
        from_id: sourceId,
        to_id: targetId,
        type: 'Derives',
        confidence,
        created_at: nowIso(),
        metadata: {}
      });

      await this._recordVersionSnapshot(store, source, {
        reason: 'Derives',
        is_latest: true,
        related_memory_id: targetId,
        version: nextVersion
      });

      return {
        memoryId: sourceId,
        operation: 'derived',
        deprecatedIds: [],
        edgesCreated: [edge],
        processingMs: Date.now() - startedAt
      };
    });
  }

  _buildMemoryRecord(input) {
    const timestamp = nowIso();
    const documentDate = deriveDocumentDate(input);
    return {
      id: input.id || uuidv4(),
      user_id: input.user_id,
      org_id: input.org_id,
      visibility: input.visibility || 'private',
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
    const type = relationship.type;
    const operation = type === 'Updates' ? 'updated' : type === 'Extends' ? 'extended' : 'derived';
    return {
      operation,
      relationship: {
        type,
        targetId: relationship.target_id || relationship.targetId,
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
