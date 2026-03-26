import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ConflictDetector, computeTokenSimilarity } from './conflict-detector.js';
import { RelationshipClassifier } from './relationship-classifier.js';
import { extractCodeChunks, detectCodeLanguage } from './code-ingestion.js';
import { PredictCalibrateFilter } from './predict-calibrate.js';
import { Observer } from './observer.js';
import { buildObservationPayload } from './observation-store.js';

function nowIso() {
  return new Date().toISOString();
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
    this.observer = new Observer();
  }

  async ingestMemory(input) {
    const startedAt = Date.now();
    const baseMemory = this._buildMemoryRecord(input);

    return this.store.advisoryLock(baseMemory.user_id, async lockedStore => {
      const transactionalStore = lockedStore || this.store;
      return transactionalStore.transaction(async store => {
        const latestMemories = await store.listLatestMemories(baseMemory);

        // --- Predict-Calibrate filter ---
        let pcResult = null;
        if (this.predictCalibrateFilter) {
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

        // Observer: compress delta into observation node
        if (this.observer && pcResult && pcResult.shouldStore !== false && baseMemory.memory_type !== 'observation') {
          try {
            const obsResult = await this.observer.observe({
              content: baseMemory.content,
              documentDate: baseMemory.document_date || baseMemory.created_at,
              tags: baseMemory.tags || [],
            });
            if (obsResult.observation) {
              const obsPayload = buildObservationPayload({
                userId: baseMemory.user_id,
                orgId: baseMemory.org_id,
                observationText: obsResult.observation,
                observationDate: baseMemory.document_date || baseMemory.created_at,
                referencedDate: obsResult.referencedDate,
                project: baseMemory.project,
                sourceTags: baseMemory.tags || [],
              });
              // Store observation as separate memory (use transactional store, skip relationship classification)
              const obsId = crypto.randomUUID ? crypto.randomUUID() : `obs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              await transactionalStore.createMemory({
                ...obsPayload,
                id: obsId,
                is_latest: true,
                version: 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
          } catch (obsErr) {
            console.warn('[observer] Observation failed:', obsErr.message);
          }
        }

        const classification = input.skip_relationship_classification
          ? { operation: 'created', relationship: null }
          : input.relationship
          ? this._explicitClassification(input.relationship)
          : this.relationshipClassifier.classifyRelationship(baseMemory, latestMemories);

        await store.createMemory(baseMemory);
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
    return {
      id: input.id || uuidv4(),
      user_id: input.user_id,
      org_id: input.org_id,
      project: input.project || null,
      content: input.content,
      memory_type: input.memory_type || 'fact',
      title: input.title || null,
      tags: input.tags || [],
      is_latest: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      document_date: input.document_date || null,
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
      ingested_at: nowIso()
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
