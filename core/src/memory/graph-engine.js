import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { isMnemeOrg, mnemeMode, amrUpdateTags, orgIsRemote, amrListRecent } from '../vector/mneme/driver.js';
import { runWithOrg, currentOrg } from '../db/prisma.js';
import { memoryChatFetch } from '../llm/groq-fallback.js';
import { chatCompletionWithFallback } from '../knowledge/enterprise/litellm-client.js';
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
  relationshipOperationForType,
  certifyRelationshipMetadata,
  validateRelationshipProposal,
  validateSupersedingEdge,
} from './relationship-semantics.js';
import { clusterHash } from './cluster-hash.js';
import { normalizeEntity, normalizeTagsArray } from './entity-normalize.js';
import { getEntityLinkQueue } from './entity-link-queue.js';
import { persistCanonicalLinks } from './canonical-entity-persister.js';
import {
  CANONICAL_MEMORY_TYPES,
  normalizeMemoryType,
} from './memory-taxonomy.js';

function nowIso() {
  return new Date().toISOString();
}

// ── P2 salience: content-derived importance_score (0.1–1.0). ───────────
// Until now importance_score defaulted to 0.5 for ~99% of rows and was
// never computed, so recall ranking could not separate a board-level
// decision from a throwaway observation. We derive it from two signals
// the engine already has: memory_type (structural importance) and the
// LLM/user priority (low/medium/high). Consumed by applyClusterBoost in
// persisted-retrieval.js (centered on 0.5 → legacy rows stay neutral).
const IMPORTANCE_TYPE_WEIGHT = {
  decision: 0.85,
  canonical_summary: 0.85,
  lesson: 0.80,
  goal: 0.75,
  summary: 0.72,
  preference: 0.70,
  relationship: 0.70,
  event: 0.60,
  fact: 0.55,
  observation: 0.45,
  conversation: 0.30,
};
const IMPORTANCE_PRIORITY_DELTA = { high: 0.15, medium: 0, low: -0.15 };
function computeImportanceScore({ memory_type, priority } = {}) {
  const base = IMPORTANCE_TYPE_WEIGHT[String(memory_type || 'fact').toLowerCase()] ?? 0.5;
  const delta = IMPORTANCE_PRIORITY_DELTA[String(priority || 'medium').toLowerCase()] ?? 0;
  return Math.max(0.1, Math.min(1.0, Number((base + delta).toFixed(3))));
}

// ── Memory-ingest LLM model (overrides per-stage env vars). ────────────
// Follow the configured canonical memory processor unless a stage explicitly
// overrides it. Gemini is the schema-capable production default.
// Override per-stage via STRUCTURED_ENRICHER_MODEL / ENTITY_LINKER_MODEL
// if a specific stage needs different quality vs. cost tradeoff.
const MEMORY_INGEST_MODEL = process.env.MEMORY_INGEST_MODEL
  || process.env.MEMORY_PROCESSOR_MODEL
  || 'google/gemini-2.5-flash-lite';

// Sleep helper for retry backoff.
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENTITY_MEMORY_TYPES = new Set(CANONICAL_MEMORY_TYPES);

// qwen3-ingest needs a shape contract, not merely JSON mode. This mirrors the
// linker parser below: required arrays keep a single extracted entity from
// being returned as the whole response, while optional fields preserve the
// current tolerant enrichment and retry semantics.
const ENTITY_LINK_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'hivemind_entity_link',
    schema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['person', 'organization', 'product', 'place', 'technology', 'standard'] },
            },
            required: ['name', 'kind'],
            additionalProperties: true,
          },
        },
        temporal: { type: 'object' },
        memory_type: { type: 'string' },
        links: { type: 'array', items: { type: 'object' } },
      },
      required: ['entities', 'links'],
      additionalProperties: true,
    },
  },
};

function extractedEntityCandidates(memory) {
  const out = [];
  const seen = new Set();
  const add = (value, kind = null) => {
    const name = typeof value === 'string'
      ? value.trim()
      : (value && typeof value.name === 'string' ? value.name.trim() : '');
    // A canonical entity must contain a letter in some human language. This
    // rejects years, bare quantities and timestamps even when a model labels
    // one as a product, while retaining genuine model names such as "3M".
    if (!name || name.length >= 120 || !/\p{L}/u.test(name)) return;
    const slug = normalizeEntity(name);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const resolvedKind = kind || (value && typeof value === 'object' ? value.kind : null);
    out.push(resolvedKind ? { name, kind: resolvedKind } : name);
  };

  for (const value of (memory?.metadata?.extracted_entities || [])) add(value);
  for (const value of (memory?.metadata?.extracted_facts?.entities || [])) add(value);
  const canonical = memory?.metadata?.enrichment?.canonical_entities;
  if (canonical && typeof canonical === 'object') {
    for (const [key, value] of Object.entries(canonical)) {
      add(value?.display || key, value?.kind || null);
    }
  }
  return out.slice(0, 12);
}

function inferredMemoryTypeFallback(memory) {
  const explicit = String(memory?.memory_type || memory?.memoryType || 'fact').toLowerCase();
  if (explicit !== 'fact') return explicit;
  const kind = String(memory?.metadata?.enrichment?.memory_kind || '').toLowerCase();
  return ENTITY_MEMORY_TYPES.has(kind) ? kind : explicit;
}

// Extract the first JSON object from a raw LLM response. Handles:
//   • markdown code fences (```json ... ```)
//   • leading/trailing prose
//   • trailing commas (replaces with empty)
// Returns parsed object or throws.
function extractJsonFromText(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('empty raw');
  let text = raw.trim();
  // Strip markdown fence.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Find first { ... } block — balanced-brace scan.
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no opening brace');
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('unbalanced braces');
  let slice = text.slice(start, end + 1);
  // Repair common LLM mistakes: trailing comma before } or ].
  slice = slice.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(slice);
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
    clusterIndex = null,
    memoryChatClient = null,
  } = {}) {
    if (!store) {
      throw new Error('MemoryGraphEngine requires a store');
    }

    this.store = store;
    // ClusterIndex (optional): when set, ingestMemory bumps a cluster's
    // dirty_count fire-and-forget so the scheduler can dream early (WS1).
    this.clusterIndex = clusterIndex;
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
    // Injectable transport keeps relationship/enrichment tests deterministic
    // and lets non-Groq deployments provide the same OpenAI-shaped contract.
    // The production default retains the existing Groq -> OpenRouter funnel.
    this.memoryChatClient = memoryChatClient || memoryChatFetch;
    this.hasInjectedMemoryChatClient = typeof memoryChatClient === 'function';
    // Observer is superseded by MemoryProcessor (unified single-call pipeline).
    // this.observer is intentionally not initialized; Observer import kept for backward compat.
  }

  setSmartIngestRouter(router) {
    this.smartIngestRouter = router;
  }

  setClusterIndex(clusterIndex) {
    this.clusterIndex = clusterIndex;
  }

  /**
   * WS1 — ingest-time dirty bump. For each entity:/topic: tag on a freshly
   * saved (non-synthesis) memory, increment the matching cluster's dirty_count
   * so the scheduler can trigger an early dream once enough new evidence piles
   * up. Strictly fire-and-forget: a cluster_index failure must NEVER block or
   * slow a save (this table is a perf optimisation, not a gate). Synthesis
   * writes (cognitive_layer_role set) are skipped so dreams don't self-trigger.
   *
   * Cluster identity mirrors cognition-loop: clusterHash(`canonical:<tag>`).
   *
   * @param {{ id?: string, tags?: string[], org_id?: string, user_id?: string, cognitive_layer_role?: string }} memory
   */
  _bumpClusterDirty(memory) {
    try {
      if (!this.clusterIndex || !memory) return;
      if (memory.cognitive_layer_role) return; // synthesis output — don't self-trigger
      const orgId = memory.org_id;
      const userId = memory.user_id;
      if (!orgId || !userId) return; // bumpDirty needs both NOT-NULL uuids
      const tags = Array.isArray(memory.tags) ? memory.tags : [];
      // Cluster on entity:/topic: tags only — the same signal synthesis clusters
      // on. Cap to the first 3 to avoid a single memory storming many clusters.
      const clusterTags = tags
        .filter((t) => typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('topic:')))
        .slice(0, 3);
      for (const tag of clusterTags) {
        // Fire-and-forget — never await, never throw into the caller.
        this.clusterIndex
          .bumpDirty({
            organizationId: orgId,
            userId,
            clusterHash: clusterHash(`canonical:${tag}`),
            clusterType: 'canonical',
          })
          .catch(() => {});
      }
    } catch {
      /* never block a save */
    }
  }

  async ingestMemory(input) {
    // Preserve whether the relationship was explicitly authorized by the
    // caller before smart routing / MemoryProcessor can infer one. Explicit
    // Updates have a concrete predecessor target and are tenant-checked by
    // applyUpdate; inferred Updates still require the destructive safety gate.
    const callerAuthorizedRelationship = input?._authorized_relationship === true
      || (Boolean(input?.relationship) && input?._smart_routed !== true);
    // Full data residency: run the whole ingest inside this org's context so every nested
    // getPrismaClient() resolves to the org's store (customer Postgres for a self-host org). Re-entrancy
    // guard: enter the context once, then proceed. Undefined org → central (managed), unchanged.
    const _org = input?.org_id;
    if (_org && currentOrg() !== _org) {
      return runWithOrg(_org, () => this.ingestMemory(input));
    }
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
          input = {
            ...payloads[0],
            _smart_routed: true,
            ...(callerAuthorizedRelationship ? { _authorized_relationship: true } : {}),
          };
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
      // EVENT-TIME first: a connector record (gmail/slack/docs) carries the
      // real-world date it HAPPENED (document_date / email Date header). Stamp
      // ts: from that, not the ingest clock — otherwise a May-26 email and a
      // June-12 email both get ts:<today> and the timeline looks unordered
      // ("unstructured"). Falls back to now for chat/manual saves with no
      // event date. Only accept sane past/near dates (not epoch/garbage).
      let stampNow = new Date();
      const _evRaw = input.document_date
        || input.metadata?.document_date
        || input.metadata?.email_date
        || input.event_time
        || null;
      if (_evRaw) {
        const _ev = new Date(_evRaw);
        const _y = _ev.getUTCFullYear();
        if (!Number.isNaN(_ev.getTime()) && _y >= 2000 && _ev.getTime() <= Date.now() + 86400000) {
          stampNow = _ev;
        }
      }
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
      if (input.append_timestamp_to_content !== false && c) {
        // The final marker is canonical EVENT TIME. A pre-router or retry may
        // already have appended an ingest-time marker; replace it when it does
        // not match document_date instead of treating any timestamp as valid.
        // This keeps every saved memory useful to temporal retrieval without
        // relying on prose inference.
        const withoutMarker = c.replace(/\s*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\s*$/, '');
        input = { ...input, content: withoutMarker.replace(/\s+$/, '') + ` (${dispTs})` };
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
    // Structured callers and canonical extraction may already know the exact
    // typed entities. Materialize their deterministic tags before graph
    // admission so remote and central stores validate the same subject set;
    // the async linker later enriches rather than being required for safety.
    const declaredEntities = extractedEntityCandidates(baseMemory);
    if (declaredEntities.length) {
      baseMemory.tags = normalizeTagsArray([
        ...(baseMemory.tags || []),
        ...declaredEntities.map((entity) => {
          const name = typeof entity === 'string' ? entity : entity?.name;
          const slug = normalizeEntity(name || '');
          return slug ? `entity:${slug}` : null;
        }).filter(Boolean),
      ]);
    }

    // Bulk-KB fast path (#6): the per-user advisory lock exists to serialize a
    // user's writes so concurrent supersede/dedup can't race. When the caller
    // skips ALL of dedup (skipPredictCalibrate), relationship-classification,
    // and contradiction-detection, this ingest is a PURE INSERT with nothing to
    // serialize — the lock then only throttles throughput. Honor skipAdvisoryLock
    // ONLY under that exact condition (provably safe); every other ingest keeps it.
    const _pureInsert = input.skipAdvisoryLock === true
      && input.skipPredictCalibrate === true
      && (input.skip_relationship_classification === true || input.smartIngest === false)
      && input.skip_contradiction_detection === true;
    const _acquire = _pureInsert
      ? (uid, fn) => fn((isMnemeOrg(baseMemory.org_id) && mnemeMode() === 'sole') ? this.store.inProcessTx() : this.store)
      : (uid, fn) => this.store.advisoryLock(uid, fn, baseMemory.org_id);

    let postCommitRecallSimilar = [];
    let shouldEnqueueEntityLink = false;
    const ingestResult = await _acquire(baseMemory.user_id, async lockedStore => {
      const transactionalStore = lockedStore || this.store;
      return transactionalStore.transaction(async store => {
        // A caller-declared pure insert has explicitly disabled dedup,
        // relationship inference and contradiction detection. None of those
        // paths may consume the latest-memory set, so do not make a remote
        // Memory Box `/v1/list` call merely to throw its result away. This is
        // especially important for `.amr` tenants: an unavailable list route
        // must not block an otherwise durable, deterministic append. Explicit
        // Updates resolve their authorized target by id below.
        const latestMemories = _pureInsert
          ? []
          : await store.listLatestMemories(baseMemory);

        // V5 corroboration pre-check (Postgres, immediately consistent — unlike the
        // Qdrant/FTS smart-ingest search below which lags on just-created rows, so
        // near-simultaneous re-saves would slip through). Language-neutral: reuses
        // the structured claim signature (validateSupersedingEdge → assessClaimRelation:
        // shared canonical subject + typed value slots / SI units / model-ids — no
        // language-specific words). Bounded: only candidates sharing an entity: tag,
        // capped. Fires ONLY on a proven values-agree verdict, so it never drops a
        // changed claim; anything uncertain falls through to normal creation (safe
        // default for every tenant/language). Flag V5_CORROBORATION_DEDUP.
        if ((process.env.V5_CORROBORATION_DEDUP || 'false').toLowerCase() === 'true'
            && !input.relationship_explicit && !input.skip_fact_extraction) {
          try {
            const baseTags = [...new Set((baseMemory.tags || []).filter(t => typeof t === 'string' && t.startsWith('entity:')))];
            // Candidate pool: latest memories in the org that SHARE an entity tag.
            // Query directly by tag (is_latest + org) so we don't depend on the
            // caller's scope-tier — listLatestMemories is scope-filtered and can
            // exclude an org-scoped prior (why the earlier pass found pool=0).
            // ENTITY-ANCHORED ONLY. A broad recent-org fallback (no shared-tag
            // anchor) was tried and REVERTED: it over-merged — assessClaimRelation
            // false-positived 'values-agree' against unrelated recent memories and
            // dropped brand-new claims (data loss, incl. the first save of a topic).
            // Requiring a shared entity: tag is what makes corroboration safe. Bare
            // content without an entity anchor is NOT deduped here (safe default);
            // that needs reliable structured subject extraction first (deferred).
            let pool = [];
            const _pc = (store && store.client) || this.store?.client;
            if (baseTags.length > 0 && baseMemory.org_id && _pc?.memory?.findMany) {
              pool = await _pc.memory.findMany({
                where: { orgId: baseMemory.org_id, isLatest: true, deletedAt: null, tags: { hasSome: baseTags }, id: { not: baseMemory.id } },
                select: { id: true, content: true, tags: true },
                take: 25,
              }).catch(() => []);
            }
            for (const cand of pool) {
              if (!cand?.id || cand.id === baseMemory.id) continue;
              const v = validateSupersedingEdge(baseMemory, cand, { requireChangeEvidence: true });
              if (!v.ok && typeof v.reason === 'string' && v.reason.includes('values-agree')) {
                // Same subject + values AGREE ⇒ paraphrase duplicate. Attach the new
                // source as evidence to the kept memory; do NOT mint a duplicate.
                try { await store.updateMemory(cand.id, { last_confirmed_at: new Date().toISOString() }); } catch { /* best-effort */ }
                return { memoryId: cand.id, operation: 'corroborated', reason: 'values_agree_no_change', matchedMemoryId: cand.id };
              }
            }
          } catch (e) { /* structure indecisive / fetch issue → normal creation */ }
        }

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
                // V5 corroboration guard (vision: "exact duplicate → attach evidence,
                // do not create another memory"). The LLM MemoryProcessor sometimes
                // labels a differently-WORDED but same-VALUE claim as UPDATE. The
                // structured claim signature (validateSupersedingEdge → assessClaimRelation)
                // is deterministic: same subject + values AGREE ⇒ corroboration, not a
                // change. When structure proves values agree, treat as redundant
                // (skip + attach evidence) instead of minting a paraphrase duplicate.
                // Flag-gated for instant rollback; only fires on a proven values-agree
                // verdict, so it can never drop a genuinely-changed claim.
                const targetMatch = candidates.find(m => m.id === targetId) || topMatch;
                let corroborates = false;
                if ((process.env.V5_CORROBORATION_DEDUP || 'false').toLowerCase() === 'true') {
                  try {
                    const v = validateSupersedingEdge(baseMemory, targetMatch, { requireChangeEvidence: true });
                    corroborates = !v.ok && typeof v.reason === 'string' && v.reason.includes('values-agree');
                  } catch { /* structure indecisive → fall through to UPDATE */ }
                }
                if (corroborates) {
                  return {
                    memoryId: targetMatch.id,
                    operation: 'corroborated',
                    reason: 'values_agree_no_change',
                    matchedMemoryId: targetMatch.id,
                    similarity: topMatch.score,
                    processingMs: Date.now() - startedAt,
                  };
                }
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
            // P2: upgrade importance now the processor has extracted priority.
            baseMemory.importance_score = computeImportanceScore({ memory_type: baseMemory.memory_type, priority: result.priority });
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
            // P2: upgrade importance now the processor has extracted priority.
            baseMemory.importance_score = computeImportanceScore({ memory_type: baseMemory.memory_type, priority: result.priority });
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
        let classification = shouldSkipRelationshipClassification
          ? { operation: 'created', relationship: null }
          : input.relationship
          ? this._explicitClassification(input.relationship)
          : this.relationshipClassifier.classifyRelationship(baseMemory, latestMemories);

        // An inferred Updates edge is destructive and also becomes persisted
        // semantic metadata. Validate its subject identity before storing the
        // row, not only later when applyUpdate runs; otherwise a rejected edge
        // still leaves the memory claiming it updated an unrelated target and
        // the API reports `operation: updated` even though nothing was changed.
        if (classification.relationship?.type === 'Updates' && !callerAuthorizedRelationship) {
          const targetId = classification.relationship.targetId;
          const confidence = Number(classification.relationship.confidence || 0);
          let target = (latestMemories || []).find((memory) => memory?.id === targetId) || null;
          if (!target && targetId) {
            target = await store.getMemory(targetId).catch(() => null);
          }
          const entityTags = (memory) => new Set((memory?.tags || [])
            .filter((tag) => typeof tag === 'string' && tag.startsWith('entity:'))
            .map((tag) => tag.toLowerCase()));
          const nextEntities = entityTags(baseMemory);
          const targetEntities = entityTags(target);
          const sharesSubject = [...nextEntities].some((entity) => targetEntities.has(entity));
          if (!targetId || confidence < 0.85 || !sharesSubject) {
            console.log(`[graph-engine] inferred Updates rejected before persistence: memory=${baseMemory.id.slice(0, 8)} target=${targetId?.slice(0, 8) || 'none'} conf=${confidence} shared_entity=${sharesSubject}`);
            classification = { operation: 'created', relationship: null };
            if (input.relationship?.type === 'Updates') delete input.relationship;
          }
        }

        const deriveSources = classification.relationship?.sourceIds?.length
          ? classification.relationship.sourceIds
          : Array.isArray(input._derives_from)
            ? input._derives_from.map(source => source?.id || source?.sourceId || source).filter(Boolean)
            : [];
        const deriveSourceRefs = Array.isArray(input._derives_from) ? input._derives_from.filter(Boolean) : [];

        let semanticRelationship = (classification.relationship || deriveSources.length > 0)
          ? normalizeRelationshipDescriptor({
            ...(classification.relationship || { type: 'Derives' }),
            sourceIds: classification.relationship?.sourceIds?.length ? classification.relationship.sourceIds : deriveSources,
          }, {
            sourceMemory: baseMemory,
            confidence: classification.relationship?.confidence ?? deriveSourceRefs[0]?.score ?? deriveSourceRefs[0]?.confidence,
          })
          : null;
        let effectiveRelationshipType = semanticRelationship?.type || classification.relationship?.type || null;

        // Remote/BYOD transactions cannot roll back an already acknowledged
        // Memory Box write. Validate every caller-declared semantic edge before
        // createMemory so a rejected edge can never leave an orphan memory or
        // trigger a second persistence path. The same admission policy runs for
        // managed, hybrid, BYOD and .amr storage modes.
        if (semanticRelationship) {
          const confidence = classification.relationship?.confidence ?? semanticRelationship.confidence ?? 1;
          let verdict;
          if (effectiveRelationshipType === 'Derives') {
            const sourceIds = semanticRelationship.sourceIds?.length ? semanticRelationship.sourceIds : deriveSources;
            const sources = await Promise.all(sourceIds.map((id) => store.getMemory(id)));
            verdict = validateRelationshipProposal({
              type: effectiveRelationshipType,
              sourceMemory: sources[0],
              sourceMemories: sources,
              targetMemory: baseMemory,
              confidence,
              orgId: baseMemory.org_id,
              userId: baseMemory.user_id,
            });
          } else {
            const targetId = semanticRelationship.targetId || classification.relationship?.targetId;
            const target = targetId ? await store.getMemory(targetId) : null;
            verdict = validateRelationshipProposal({
              type: effectiveRelationshipType,
              sourceMemory: baseMemory,
              targetMemory: target,
              confidence,
              orgId: baseMemory.org_id,
              userId: baseMemory.user_id,
            });
          }
          if (!verdict?.ok) {
            if (callerAuthorizedRelationship) {
              throw new Error(`relationship_policy_rejected:${effectiveRelationshipType}:${verdict?.reason || 'invalid-relationship'}`);
            }
            console.log(`[graph-engine] inferred ${effectiveRelationshipType} rejected before persistence: ${verdict?.reason || 'invalid-relationship'}`);
            classification = { operation: 'created', relationship: null };
            semanticRelationship = null;
            effectiveRelationshipType = null;
          }
        }

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
            // Structural membership: extracted fact → parent memory.
            await this.applyValidatedRelationship({
              id: crypto.randomUUID ? crypto.randomUUID() : `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              from_id: factId,
              to_id: baseMemory.id,
              type: 'PartOf',
              confidence: 0.9,
              metadata: buildSemanticMetadata({
                semanticRole: 'relationship',
                relationship: {
                  type: 'PartOf',
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
            }, {
              store,
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
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

        // Entity enrichment MUST run after commit. Calling the LLM and the
        // canonical registry from this transaction held the per-user lock for
        // seconds and allowed a swallowed Prisma error to poison the ingest
        // transaction. Capture the bounded peer set here and enqueue only after
        // the canonical memory row + source metadata have committed.
        if (!input.defer_entity_linking) {
          postCommitRecallSimilar = recallSimilar;
          shouldEnqueueEntityLink = true;
        }

        // WS1: mark this memory's clusters dirty so the scheduler can dream
        // early. Fire-and-forget — entity tags are attached above by now.
        this._bumpClusterDirty(baseMemory);

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
          // Floor + entity-overlap guard: destructive supersede needs
          // BOTH high confidence (>=0.85) AND shared non-common entities
          // with the target (≥1). MemoryProcessor LLM is over-aggressive
          // on "Updates" classification — two purchase events get linked
          // as Updates because they share the verb "bought" plus
          // entity:Amar. Demand semantic kinship via actual entity
          // overlap, not LLM confidence alone.
          const updatesTargetId = classification.relationship?.targetId ?? semanticRelationship?.targetId;
          const updateConf = classification.relationship?.confidence ?? semanticRelationship?.confidence ?? 0;
          const explicitUpdateAuthorized = callerAuthorizedRelationship
            || input._authorized_relationship === true;
          let entityOverlapOk = explicitUpdateAuthorized;
          let targetMem = null; // hoisted: also read by the H1 synthesis-guard below
          if (Number(updateConf) >= 0.85 && updatesTargetId) {
            try {
              targetMem = await store.getMemory(updatesTargetId);
              if (targetMem && !explicitUpdateAuthorized) {
                const newEntsArr = (baseMemory.tags || [])
                  .filter(t => typeof t === 'string' && t.startsWith('entity:'))
                  .map(t => t.slice('entity:'.length).toLowerCase());
                const targetEntsArr = (targetMem.tags || [])
                  .filter(t => typeof t === 'string' && t.startsWith('entity:'))
                  .map(t => t.slice('entity:'.length).toLowerCase());
                // Drop common cross-memory entities (owner name etc).
                // Compute frequency over recall set as a quick proxy.
                const candCounts = new Map();
                for (const c of (recallSimilar || [])) {
                  for (const t of (c.tags || [])) {
                    if (typeof t === 'string' && t.startsWith('entity:')) {
                      const e = t.slice('entity:'.length).toLowerCase();
                      candCounts.set(e, (candCounts.get(e) || 0) + 1);
                    }
                  }
                }
                const total = Math.max(1, (recallSimilar || []).length);
                const isCommon = (e) => (candCounts.get(e) || 0) / total >= 0.40;
                const newSet = new Set(newEntsArr.filter(e => !isCommon(e)));
                const sharedNonCommon = targetEntsArr.filter(e => !isCommon(e) && newSet.has(e));
                entityOverlapOk = sharedNonCommon.length >= 1;
                if (!entityOverlapOk) {
                  console.log(`[graph-engine] Updates DROPPED (no shared non-common entity): ${baseMemory.id.slice(0,8)} → ${updatesTargetId.slice(0,8)} (conf=${updateConf})`);
                }
              }
            } catch (overlapErr) {
              console.warn('[graph-engine] entity-overlap check failed:', overlapErr.message);
            }
          }
          // H1: never let a synthesis supersede another synthesis via smart-ingest.
          // Syntheses are demoted only by cognition-loop's own revision path.
          if (
            baseMemory.memory_type === 'synthesis'
            && (targetMem?.memory_type === 'synthesis' || targetMem?.memoryType === 'synthesis')
          ) {
            console.log(`[graph-engine] H1: synthesis→synthesis Updates SKIPPED: ${baseMemory.id.slice(0,8)} → ${updatesTargetId.slice(0,8)} (cognition-loop owns synthesis demotion)`);
          } else if (Number(updateConf) >= 0.85 && entityOverlapOk && updatesTargetId) {
            Object.assign(result, await this.applyUpdate(baseMemory.id, updatesTargetId, {
              store,
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
              confidence: updateConf,
              startedAt
            }));
          } else if (!updatesTargetId) {
            // targetId missing from both classification.relationship and semanticRelationship —
            // skip the apply to avoid TypeError; record a plain version snapshot instead.
            console.warn(`[graph-engine] Updates SKIPPED (no targetId): memory=${baseMemory.id} — falling back to 'created' snapshot`);
            await this._recordVersionSnapshot(store, baseMemory, {
              reason: 'created',
              is_latest: true,
              related_memory_id: null
            });
            result.processingMs = Date.now() - startedAt;
          } else {
            // Below threshold — drop entirely. Previously downgraded to a
            // Mentions edge, but that produced noise edges between
            // unrelated memories (keyboard purchase ↔ tuition email,
            // both authored by same user). Skip the edge. The dedicated
            // entity_co_mention_llm path will still create Mentions
            // edges for memories with REAL shared non-common entities.
            // This is the catch-all for the guard at ~1431, which requires BOTH
            // conf >= 0.85 AND entityOverlapOk. The message used to hardcode
            // "conf=X < 0.85" as the reason, so an edge dropped purely for lack of
            // entity overlap printed the self-contradictory
            //   "Updates DROPPED (conf=0.92 < 0.85)"
            // — observed live during a 39-document batch. A log that states a false
            // reason is worse than no log: it sends whoever reads it to tune a
            // threshold that was never the cause. Name the predicate that actually
            // failed.
            const _why = Number(updateConf) < 0.85
              ? `conf=${updateConf} < 0.85`
              : (!entityOverlapOk ? `no shared non-common entity (conf=${updateConf} passed)`
                                  : `guard failed (conf=${updateConf}, overlap=ok)`);
            console.log(`[graph-engine] Updates DROPPED (${_why}): ${baseMemory.id.slice(0,8)} → ${updatesTargetId?.slice(0,8)}`);
          }
        } else if (effectiveRelationshipType === 'Extends') {
          const extendsTargetId = classification.relationship?.targetId ?? semanticRelationship?.targetId;
          if (extendsTargetId) {
            Object.assign(result, await this.applyExtends(baseMemory.id, extendsTargetId, {
              store,
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
              confidence: classification.relationship?.confidence ?? semanticRelationship?.confidence,
              startedAt
            }));
          } else {
            // targetId missing from both classification.relationship and semanticRelationship —
            // skip the apply to avoid TypeError; record a plain version snapshot instead.
            console.warn(`[graph-engine] Extends SKIPPED (no targetId): memory=${baseMemory.id} — falling back to 'created' snapshot`);
            await this._recordVersionSnapshot(store, baseMemory, {
              reason: 'created',
              is_latest: true,
              related_memory_id: null
            });
            result.processingMs = Date.now() - startedAt;
          }
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
            // sourceIds missing from both semanticRelationship and deriveSources —
            // skip the apply to avoid a no-op call; record a plain version snapshot instead.
            console.warn(`[graph-engine] Derives SKIPPED (no sourceIds): memory=${baseMemory.id} — falling back to 'created' snapshot`);
            await this._recordVersionSnapshot(store, baseMemory, {
              reason: 'created',
              is_latest: true,
              related_memory_id: null
            });
            result.processingMs = Date.now() - startedAt;
          }
        } else if (effectiveRelationshipType === 'Contradicts') {
          const targetId = semanticRelationship?.targetId || classification.relationship?.targetId;
          const applied = await this.applyValidatedRelationship({
            from_id: baseMemory.id,
            to_id: targetId,
            type: 'Contradicts',
            confidence: classification.relationship?.confidence ?? semanticRelationship?.confidence ?? 1,
            reason: semanticRelationship?.reason || 'caller_declared_contradiction',
          }, {
            store,
            user_id: baseMemory.user_id,
            org_id: baseMemory.org_id,
            startedAt,
          });
          Object.assign(result, applied, { processingMs: Date.now() - startedAt });
        } else {
          await this._recordVersionSnapshot(store, baseMemory, {
            reason: 'created',
            is_latest: true,
            related_memory_id: null
          });
          result.processingMs = Date.now() - startedAt;
        }

        // Persist bounded queue admissions inside this transaction; derivation
        // workers perform the expensive enrichment asynchronously afterward.
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

            // Pre-filter latestMemories by entity-overlap with baseMemory
            // tags before paying for the (token-similarity + regex) loop.
            // Same-topic by LLM entity definition is the only signal that
            // matters here; everything else just spams edges.
            const baseEntityTags = new Set((baseMemory.tags || []).filter(t => typeof t === 'string' && t.startsWith('entity:')));
            // TIME OVERLAP IS ALSO "SAME TOPIC". Entity overlap alone cannot see the
            // most common personal conflict: two commitments in the same window naming
            // DIFFERENT entities. "Trip to Dubai next week" (time:2026-08-13) and
            // "Trip to Hannover on Aug 9" (time:2026-08-09) share no entity tag, so the
            // filter below excluded them from each other permanently and no contradiction
            // could ever be raised. Worse, a memory with NO entity tag at all — which is
            // what the Dubai save actually got — fell to a blind first-20 slice that is
            // ordered by recency, not by relevance.
            //
            // Same-week `time:YYYY-MM-DD` tags are a cheap, precise second signal: they
            // are already emitted by the extractor, they need no LLM call, and they only
            // widen the pool for memories that actually coincide in time. The detector
            // still decides whether anything is a real contradiction — this only makes
            // sure it is shown the candidates that could be one.
            const _dayTags = (m) => (m.tags || []).filter(t => typeof t === 'string' && /^time:\d{4}-\d{2}-\d{2}$/.test(t));
            const _baseDays = _dayTags(baseMemory).map(t => t.slice(5));
            const _withinDays = (a, b, n = 10) => {
              const da = Date.parse(a), db = Date.parse(b);
              return Number.isFinite(da) && Number.isFinite(db) && Math.abs(da - db) <= n * 86400000;
            };
            const _entityMatch = (m) => {
              const mt = (m.tags || []).filter(t => typeof t === 'string' && t.startsWith('entity:'));
              for (const t of mt) if (baseEntityTags.has(t)) return true;
              return false;
            };
            const _timeMatch = (m) => {
              if (!_baseDays.length) return false;
              for (const t of _dayTags(m)) {
                for (const b of _baseDays) if (_withinDays(t.slice(5), b)) return true;
              }
              return false;
            };
            const _pool = latestMemories.filter(m => (baseEntityTags.size > 0 && _entityMatch(m)) || _timeMatch(m));
            // Unchanged fallback when neither signal exists: bounded, recency-ordered.
            const filteredLatest = _pool.length ? _pool.slice(0, 40) : latestMemories.slice(0, 20);

            const contradictions = this.conflictDetector.detectContradictions(
              baseMemory,
              filteredLatest,
              { strictMode, maxResults: 5 }
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
                const applied = await this.applyValidatedRelationship({
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
                }, {
                  store,
                  user_id: baseMemory.user_id,
                  org_id: baseMemory.org_id,
                });
                if (applied.edgesCreated?.length) result.edgesCreated.push(...applied.edgesCreated);
              } catch { /* Edge already exists — skip duplicate */ }

              if (isReconciled) {
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
          const sourceIds = input._derives_from.filter(source => Number(source?.score || 0) >= this.deriveThreshold).map(source => source.id);
          if (sourceIds.length) {
            const minConfidence = Math.min(...input._derives_from.filter(source => sourceIds.includes(source.id)).map(source => Number(source.score)));
            const applied = await this.applyDerivesFromSources(sourceIds, baseMemory.id, {
              store,
              user_id: baseMemory.user_id,
              org_id: baseMemory.org_id,
              confidence: minConfidence,
              startedAt,
              reason: 'smart_ingest_router',
            });
            if (applied.edgesCreated?.length) result.edgesCreated.push(...applied.edgesCreated);
          }
        }

        // Do not infer Derives from similarity alone. A created memory with
        // extracted fact sentences is not necessarily a synthesis; direct
        // user assertions and atomic ingestion facts satisfy those conditions
        // too. That legacy heuristic attached unrelated nearby memories as
        // sources at a fixed 0.70 confidence. Derives edges now require an
        // explicit source set (`_derives_from`) or the validated multi-source
        // linker/cognition paths, both of which preserve real provenance.

        // Attach predict-calibrate metadata when available
        if (pcResult) {
          result.noveltyScore = pcResult.noveltyScore;
          result.maxSimilarity = pcResult.maxSimilarity;
          result.deltaExtracted = pcResult.deltaExtracted || false;
        }

        return result;
      });
    });

    if (shouldEnqueueEntityLink && ingestResult?.memoryId === baseMemory.id) {
      const q = getEntityLinkQueue(this);
      if (q) {
        q.enqueue(baseMemory, postCommitRecallSimilar);
      } else {
        // Queue construction should only fail during partial boot/tests. Keep a
        // bounded post-commit fallback so enrichment never re-enters the ingest
        // transaction and a provider failure can never roll back the memory.
        try {
          await this._attachEntityCoMentionEdges(baseMemory, this.store, postCommitRecallSimilar);
        } catch (entityErr) {
          console.warn('[entity-co-mention] post-commit fallback failed:', entityErr.message);
        }
      }
    }
    return ingestResult;
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
  /**
   * Post-commit structured enrichment. Runs OUTSIDE the ingest transaction
   * (caller invokes after engine.ingestMemory / ingestMemoryTree returns).
   * Extracts enterprise-grade fields via LLM and patches them onto the
   * memory's source_metadata.metadata.enrichment JSON blob:
   *   - summary       : 2-3 sentence executive abstract
   *   - urgency       : low | medium | high | critical
   *   - action_items  : [{ task, owner, deadline?, status }]
   *   - decisions     : [{ claim, owner, date? }]
   *   - open_questions: [{ question, blocker?, owner? }]
   *   - blockers      : [{ what, who_blocks, since? }]
   *   - canonical_entities : { "<canonical-key>": { display, kind, emails?, aliases? } }
   *
   * Fire-and-forget at the caller. Best-effort — never blocks ingestion.
   */
  async enrichMemoryStructured(memoryId, { content, title, tags = [] } = {}) {
    if (!process.env.GROQ_API_KEY) return null;
    if (!memoryId) return null;
    // Sanitize: strip Gmail MIME headers (Content-Type, boundary=, charset, etc.),
    // base64 blobs, and non-printable control bytes. gpt-oss-20b in JSON mode
    // returns HTTP 400 json_validate_failed when the prompt contains stray
    // control chars or excessive boundary noise.
    const sanitized = String(content || '')
      .replace(/Content-(Type|Transfer-Encoding|Disposition):[^\n]*/gi, '')
      .replace(/boundary=[^\s;]+/gi, '')
      .replace(/charset="?[^"\s;]+"?/gi, '')
      .replace(/Content-ID:\s*<[^>]+>/gi, '')
      .replace(/^--[A-Za-z0-9_=-]+$/gm, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .replace(/\s{3,}/g, '  ')
      .trim();
    const text = sanitized.slice(0, 4000);
    if (text.length < 80) {
      // Mark as skipped — distinct from error. Operators can filter these
      // out of retry sweeps. Skipping silently was the old behavior and
      // produced misleading "failed" counts in queue stats.
      try {
        const c = this.store?.client;
        if (c?.sourceMetadata?.findFirst && c?.sourceMetadata?.update) {
          const sm = await c.sourceMetadata.findFirst({ where: { memoryId }, select: { id: true, metadata: true } });
          if (sm && !sm.metadata?.enrichment_status) {
            await c.sourceMetadata.update({
              where: { id: sm.id },
              data: { metadata: { ...(sm.metadata || {}), enrichment_status: 'skipped:short_content', enrichment_skipped_at: nowIso() } },
            });
          }
        }
      } catch {}
      return null;
    }

    const client = this.store?.client;
    // ── Idempotency lock ─────────────────────────────────────────────
    // Read source_metadata.metadata.enrichment_status once. Skip if
    // 'done' or 'in_progress' (concurrent enricher). Re-run only on
    // null / 'error:*' (failed previous attempt).
    let smRow = null;
    if (client?.sourceMetadata?.findFirst) {
      try {
        smRow = await client.sourceMetadata.findFirst({
          where: { memoryId },
          select: { id: true, metadata: true },
        });
        const status = smRow?.metadata?.enrichment_status;
        if (status === 'done') return smRow.metadata.enrichment || null;
        if (status === 'in_progress') {
          console.log(`[structured-enrich] ${memoryId.slice(0, 8)} skip — already in_progress`);
          return null;
        }
      } catch (lockErr) {
        console.warn(`[structured-enrich] lock-read failed for ${memoryId.slice(0, 8)}: ${lockErr.message}`);
      }
    }

    // Mark in_progress so concurrent enrichers no-op. Best-effort.
    if (smRow && client?.sourceMetadata?.update) {
      try {
        await client.sourceMetadata.update({
          where: { id: smRow.id },
          data: { metadata: { ...(smRow.metadata || {}), enrichment_status: 'in_progress', enrichment_started_at: nowIso() } },
        });
      } catch {}
    }

    const todayIso = new Date().toISOString().slice(0, 10);

    // Dispatch CRM-aware schema by Salesforce object type. Encoded as
    // `sf-object:<type>` tag set by SalesforceAdapter.normalize.
    let sfObjectType = null;
    if (Array.isArray(tags)) {
      const sfTag = tags.find((t) => typeof t === 'string' && t.startsWith('sf-object:'));
      if (sfTag) {
        const raw = sfTag.slice('sf-object:'.length);
        const upper = raw.charAt(0).toUpperCase() + raw.slice(1);
        sfObjectType = ({
          Account: 'Account', Contact: 'Contact', Opportunity: 'Opportunity',
          Opportunityhistory: 'OpportunityHistory', Task: 'Task', Event: 'Event',
          Emailmessage: 'EmailMessage', Case: 'Case', Casecomment: 'CaseComment',
        })[upper] || null;
      }
    }
    let prompt;
    if (sfObjectType) {
      try {
        const { pickSalesforceSchema } = await import('../connectors/providers/salesforce/enrichment-schema.js');
        const schema = pickSalesforceSchema(sfObjectType);
        if (schema) {
          prompt = schema.buildPrompt({ todayIso, title, text });
        }
      } catch (schemaErr) {
        console.warn(`[structured-enrich] SF schema load failed for ${sfObjectType}: ${schemaErr.message}`);
      }
    }
    if (!prompt) prompt = `You enrich a single memory with enterprise-grade structured fields. Read the memory and emit a STRICT JSON object with these keys (omit any field that doesn't apply):

{
  "summary": "2-3 sentence executive abstract for someone reopening this memory months later. Lead with WHAT/WHO/WHEN/WHY.",
  "urgency": "low|medium|high|critical",
  "memory_kind": "decision|event|fact|preference|goal|issue|relationship|note",
  "action_items": [
    { "task": "...", "owner": "person or email", "deadline": "YYYY-MM-DD|null", "status": "open|done|blocked" }
  ],
  "decisions": [
    { "claim": "what was decided", "owner": "who decided", "date": "YYYY-MM-DD|null" }
  ],
  "open_questions": [
    { "question": "...", "blocker": "what's blocking|null", "owner": "who owes the answer|null" }
  ],
  "blockers": [
    { "what": "...", "who_blocks": "person/team|null", "since": "YYYY-MM-DD|null" }
  ],
  "canonical_entities": {
    "<slug>": { "display": "Lennart Dahms", "kind": "person|org|product|place", "emails": ["..."], "aliases": ["..."] }
  }
}

Today is ${todayIso}. Resolve relative dates against it. Multilingual content OK — translate place names to canonical English where unambiguous, keep person names in original script.

TITLE: ${String(title || '').slice(0, 200)}

MEMORY:
${text}

OUTPUT JSON only.`;

    const primaryModel = process.env.STRUCTURED_ENRICHER_MODEL || MEMORY_INGEST_MODEL;
    // Fallback to gpt-oss-120b when 20b returns malformed JSON or http_400.
    // 120b is more reliable at structured generation. Env override available.
    const fallbackModel = process.env.STRUCTURED_ENRICHER_FALLBACK_MODEL || 'openai/gpt-oss-120b';
    const maxAttempts = Number(process.env.ENRICH_MAX_ATTEMPTS || 3);
    // gpt-oss family fails Groq strict JSON-mode pre-validation.
    const supportsStrictJson = (m) => !/gpt-oss/i.test(m);

    let usedModel = primaryModel;

    // Helper to persist failure reason on source_metadata so retries are
    // targetable + visible.
    const recordError = async (code, status, bodyExcerpt) => {
      if (!smRow || !client?.sourceMetadata?.update) return;
      try {
        const fresh = await client.sourceMetadata.findUnique({ where: { id: smRow.id }, select: { metadata: true } });
        const merged = {
          ...(fresh?.metadata || {}),
          enrichment_status: `error:${code}`,
          enrichment_error: {
            code,
            http_status: status || null,
            body_excerpt: (bodyExcerpt || '').slice(0, 400),
            attempted_at: nowIso(),
            model: usedModel,
          },
        };
        await client.sourceMetadata.update({ where: { id: smRow.id }, data: { metadata: merged } });
      } catch {}
    };

    // Single-model attempt loop. Returns { parsed, err } — parsed=null
    // on failure with err describing reason. Caller decides whether to
    // try the fallback model based on err.code.
    const callModel = async (modelName) => {
      let parsed = null;
      let err = { code: 'unknown', status: null, body: '' };
      const useStrict = supportsStrictJson(modelName);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const resp = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: modelName,
              messages: [{ role: 'user', content: prompt }],
              ...(useStrict ? { response_format: { type: 'json_object' } } : {}),
              temperature: 0.1,
              max_tokens: 1600,
            }),
            // Bounded — a hung groq connection must not wedge ingestMemory (it holds a
            // per-user advisory lock during promotion → would stall the whole KB upload).
            signal: AbortSignal.timeout(Number(process.env.ENTITY_LINK_TIMEOUT_MS || 25000)),
          });
          if (!resp.ok) {
            const bodyText = await resp.text().catch(() => '');
            err = { code: `http_${resp.status}`, status: resp.status, body: bodyText };
            const transient = resp.status === 429 || (resp.status >= 500 && resp.status <= 599);
            console.warn(`[structured-enrich] ${memoryId.slice(0, 8)} ${modelName} attempt ${attempt}/${maxAttempts} HTTP ${resp.status}: ${bodyText.slice(0, 200)}`);
            if (!transient || attempt === maxAttempts) return { parsed: null, err };
            await _sleep(1000 * Math.pow(2, attempt - 1));
            continue;
          }
          const data = await resp.json();
          const raw = data?.choices?.[0]?.message?.content || '{}';
          try {
            parsed = JSON.parse(raw);
          } catch (strictErr) {
            try {
              parsed = extractJsonFromText(raw);
            } catch (lenientErr) {
              err = { code: 'parse_error', status: 200, body: raw.slice(0, 400) };
              console.warn(`[structured-enrich] ${memoryId.slice(0, 8)} ${modelName} parse failed (strict: ${strictErr.message}; lenient: ${lenientErr.message}); raw=${raw.slice(0, 200)}`);
              if (attempt === maxAttempts) return { parsed: null, err };
              await _sleep(500 * attempt);
              continue;
            }
          }
          return { parsed, err: null };
        } catch (netErr) {
          err = { code: 'network_error', status: null, body: netErr.message };
          console.warn(`[structured-enrich] ${memoryId.slice(0, 8)} ${modelName} network err attempt ${attempt}/${maxAttempts}: ${netErr.message}`);
          if (attempt === maxAttempts) return { parsed: null, err };
          await _sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
      return { parsed: null, err };
    };

    // Try primary (gpt-oss-20b). On parse_error or http_4xx fall through
    // to gpt-oss-120b. Transient 429/5xx are already retried inside
    // callModel — exhausting those still escalates to fallback for
    // resilience.
    let { parsed, err: lastErr } = await callModel(primaryModel);
    if (!parsed && primaryModel !== fallbackModel) {
      console.log(`[structured-enrich] ${memoryId.slice(0, 8)} primary ${primaryModel} failed (${lastErr?.code}) — escalating to ${fallbackModel}`);
      usedModel = fallbackModel;
      const fb = await callModel(fallbackModel);
      parsed = fb.parsed;
      lastErr = fb.err || lastErr;
    }

    if (!parsed || typeof parsed !== 'object') {
      await recordError(lastErr?.code || 'empty_response', lastErr?.status || null, lastErr?.body || '');
      return null;
    }

    // Structured enrichment is the language-independent semantic classifier
    // shared by all sources. Preserve an explicit caller type; only upgrade
    // the generic default `fact` to a more specific valid type.
    const enrichedKind = String(parsed.memory_kind || '').toLowerCase();
    if (ENTITY_MEMORY_TYPES.has(enrichedKind) && enrichedKind !== 'fact') {
      try {
        const existing = await this.store?.getMemory?.(memoryId);
        if ((existing?.memory_type || existing?.memoryType) === 'fact') {
          await this.store.updateMemory(memoryId, { memoryType: enrichedKind });
        }
      } catch (typeErr) {
        console.warn(`[structured-enrich] memory type upgrade failed for ${memoryId.slice(0, 8)}: ${typeErr.message}`);
      }
    }

    // Distilled high-signal tags from enrichment (independent of where the row lives).
    const enrichTags = [];
    if (parsed.urgency) enrichTags.push(`urgency:${parsed.urgency}`);
    if (parsed.memory_kind) enrichTags.push(`kind:${parsed.memory_kind}`);
    if (Array.isArray(parsed.action_items) && parsed.action_items.length > 0) {
      enrichTags.push(`has-action:${parsed.action_items.length}`);
      for (const a of parsed.action_items.slice(0, 3)) {
        if (a.owner) enrichTags.push(`owner:${String(a.owner).slice(0, 40).replace(/\s+/g, '_')}`);
      }
    }
    if (Array.isArray(parsed.open_questions) && parsed.open_questions.length > 0) enrichTags.push(`open:${parsed.open_questions.length}`);
    if (Array.isArray(parsed.blockers) && parsed.blockers.length > 0) enrichTags.push(`blocked:${parsed.blockers.length}`);

    // Remote (self-host): no central source_metadata row — apply enrich tags to the AGENT (durable via
    // the outbox) and return; the enrichment blob lives implicitly in the tags. Compute ran centrally.
    const _enrichOrg = currentOrg();
    if (orgIsRemote(_enrichOrg)) {
      if (enrichTags.length > 0) {
        const newTags = Array.from(new Set([...(tags || []), ...enrichTags]));
        try { amrUpdateTags(_enrichOrg, memoryId, newTags); } catch { /* best-effort */ }
      }
      return parsed;
    }

    // Central: persist on source_metadata.metadata.enrichment + mark status=done, then apply tags.
    try {
      if (!client) return parsed;
      const fresh = await client.sourceMetadata.findFirst({
        where: { memoryId },
        select: { id: true, metadata: true },
      });
      if (!fresh) return parsed;
      const merged = {
        ...(fresh.metadata || {}),
        enrichment: parsed,
        enrichment_status: 'done',
        enrichment_completed_at: nowIso(),
        enrichment_model: usedModel,
      };
      // Clear any prior error fields.
      delete merged.enrichment_error;
      await client.sourceMetadata.update({
        where: { id: fresh.id },
        data: { metadata: merged },
      });

      if (enrichTags.length > 0) {
        const cur = (tags || []);
        const newTags = Array.from(new Set([...cur, ...enrichTags]));
        try {
          await client.memory.update({ where: { id: memoryId }, data: { tags: newTags } });
        } catch {}
      }
      return parsed;
    } catch (persistErr) {
      console.warn(`[structured-enrich] persist failed for ${memoryId.slice(0, 8)}: ${persistErr.message}`);
      await recordError('persist_error', null, persistErr.message);
      return parsed;
    }
  }

  /**
   * Concurrent, lock-free entity-co-mention linking for a batch of ALREADY-persisted
   * memories. Used after deferred bulk ingest (KB promotion) — runs the per-memory
   * entity-link LLM in parallel WITHOUT the per-user advisory lock (entity:* tags +
   * co-mention edges are additive; edge dedup + EDGE_CAP in _attachEntityCoMentionEdges
   * make concurrent runs safe). Best-effort: failures are logged, never thrown.
   *
   * @param {Array<object>} memories - persisted memory objects (need id, user_id, org_id, content, tags, memory_type)
   * @param {{concurrency?: number}} opts
   */
  // Route deferred entity-linking through ONE global bounded queue so Groq
  // pressure is capped regardless of how many ingests fire concurrently. Was
  // a per-call worker pool (concurrency 6) — N concurrent callers each spun
  // their own pool → N×6 simultaneous Groq calls → TPM saturation → 429 →
  // untagged rows. The shared queue (EntityLinkQueue, default cap 4) is the
  // single chokepoint; enqueue returns immediately (best-effort, eventually
  // consistent — tags land seconds later as the queue drains).
  async linkEntitiesForMemories(memories, _opts = {}) {
    if (!Array.isArray(memories) || memories.length === 0) return;
    if ((process.env.MEMORY_ENTITY_LINKING || 'true').toLowerCase() === 'false') return;
    const q = getEntityLinkQueue(this);
    if (!q) return;
    const items = memories.filter((m) => m && m.id);
    // noPeers: enqueue individually so the co-mention linker does NOT receive same-batch siblings as
    // candidates — used by the unified KB extractor, which already created intra-doc edges; this pass
    // only adds CROSS-DOC/TIME edges (candidates come from listLatestMemories = other docs/time).
    if (_opts.noPeers) { for (const it of items) q.enqueue(it); }
    else q.enqueueBatch(items);
  }

  /**
   * PHASE-3 (KB relationship intelligence): run the SAME contradiction detection +
   * reconciliation the hot-path save uses (Contradicts / Updates / Extends + the
   * is_latest supersession flip), on an already-stored memory against a set of
   * candidate memories. KB ingest pure-inserts (skip_contradiction_detection) for
   * latency; this runs that skipped pass OFF the hot path (kb-enrich) so KB facts
   * gain real typed relationships, not just entity co-mention.
   *
   * SAFE BY CONSTRUCTION — cannot re-introduce the edge-explosion class:
   *   • entity-overlap pre-filter (≥1 shared entity: tag) before any work
   *   • conflictDetector's hardened thresholds (minSim 0.65, both-side signal)
   *   • strictMode default true (high bar — KB docs rarely truly contradict)
   *   • maxResults cap (5)
   * detectContradictions is ALGORITHMIC (token-sim + regex), not an LLM call —
   * cheap enough to run per-fact. Returns {contradicts, updates, extends} counts.
   *
   * @param {object} baseMemory  persisted memory (needs id, content, tags, memory_type)
   * @param {Array<object>} candidates  cross-doc same-org candidate memories (need id, content, tags)
   * @param {{store?: object, strictMode?: boolean, maxResults?: number}} opts
   */
  async detectAndLinkContradictionsFor(baseMemory, candidates = [], opts = {}) {
    const out = { contradicts: 0, updates: 0, extends: 0 };
    const store = opts.store || this.store;
    const strictMode = opts.strictMode !== false; // default strict
    const maxResults = typeof opts.maxResults === 'number' ? opts.maxResults : 5;
    if (!this.conflictDetector || !store?.createRelationship || !baseMemory?.id) return out;
    if (!Array.isArray(candidates) || candidates.length === 0) return out;

    const EVOLUTION_RE = /\b(now|switched|changed|moved to|migrating|replaced|updated|corrected|actually|no longer|stopped|used to|formerly|previously|instead)\b/i;
    const ADDITIVE_RE = /\b(also|additionally|furthermore|plus|as well|on top of|in addition|moreover|and also)\b/i;

    // Entity-overlap pre-filter — the only signal that matters; everything else spams edges.
    const baseEntityTags = new Set((baseMemory.tags || []).filter((t) => typeof t === 'string' && t.startsWith('entity:')));
    const filtered = baseEntityTags.size > 0
      ? candidates.filter((m) => (m.tags || []).some((t) => typeof t === 'string' && t.startsWith('entity:') && baseEntityTags.has(t)))
      : candidates.slice(0, 20);
    if (filtered.length === 0) return out;

    let contradictions = [];
    try {
      contradictions = this.conflictDetector.detectContradictions(baseMemory, filtered, { strictMode, maxResults });
    } catch (e) {
      console.warn('[kb-rel] detectContradictions failed:', e.message);
      return out;
    }

    for (const c of contradictions) {
      if (!c?.memory?.id) continue;
      const newContent = (baseMemory.content || '').toLowerCase();
      let edgeType = 'Contradicts';
      let reasoning = '';
      if (EVOLUTION_RE.test(newContent) && (c.contradictionType === 'temporal_shift' || c.contradictionType === 'change' || c.contradictionType === 'explicit_correction')) {
        edgeType = 'Updates'; reasoning = `Belief evolved: ${c.contradictionType}`;
      } else if (EVOLUTION_RE.test(newContent) && c.contradictionType === 'negation') {
        edgeType = 'Updates'; reasoning = 'Negation + evolution language';
      } else if (ADDITIVE_RE.test(newContent)) {
        edgeType = 'Extends'; reasoning = 'Additive language: adds nuance';
      } else if (c.confidence >= 0.7 && baseMemory.memory_type === c.memory.memory_type && c.contradictionType === 'value_divergence') {
        edgeType = 'Updates'; reasoning = 'Same type, divergent values: factual update';
      }
      const isReconciled = edgeType !== 'Contradicts';
      try {
        const applied = await this.applyValidatedRelationship({
          id: crypto.randomUUID ? crypto.randomUUID() : `kbrel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          from_id: baseMemory.id,
          to_id: c.memory.id,
          type: edgeType,
          confidence: c.confidence,
          metadata: {
            semanticRole: 'relationship',
            kind: 'kb_relationship',
            contradictionType: c.contradictionType,
            reason: reasoning || 'contradiction_detection',
          },
          created_by: isReconciled ? 'turing-reconciliation' : 'conflict-detector',
        }, { store, user_id: baseMemory.user_id, org_id: baseMemory.org_id });
        if (applied.edgesCreated?.length) {
          if (edgeType === 'Contradicts') out.contradicts++;
          else if (edgeType === 'Updates') out.updates++;
          else out.extends++;
        }
      } catch { /* edge already exists — skip duplicate */ }

      // Reconciled-to-Updates supersedes the older memory (skip syntheses — cognition owns those).
      // STRICT VALIDATOR gate: an algorithmic Updates edge may NOT demote
      // is_latest unless the two memories provably share a specific subject
      // and attribute (validateSupersedingEdge). The edge itself stands for
      // graph context; only the destructive flip is withheld.
      // The dispatcher atomically owns Updates demotion; no second side effect.
    }
    return out;
  }

  async _attachEntityCoMentionEdges(baseMemory, store, similar = []) {
    const content = baseMemory.content || '';
    // Short content is OK when the caller explicitly forced linking (chat
    // saves), since user-typed short facts like "meet Ethan Tuesday 7pm"
    // are exactly what the graph should connect. Otherwise the 10-char
    // floor is enough to weed out single-word noise.
    const forceLink = baseMemory.metadata?.force_entity_linking === true;
    const minLen = forceLink ? 1 : 10;
    const structuredFallbackEntities = extractedEntityCandidates(baseMemory);
    const entityStatusClient = (store && store.client) || this.store?.client;
    const persistEntityStatus = async (status, extra = {}) => {
      if (orgIsRemote(baseMemory.org_id)) {
        const current = (baseMemory.metadata && typeof baseMemory.metadata === 'object') ? baseMemory.metadata : {};
        const statusExtra = { ...extra };
        if (status === 'in_progress') {
          statusExtra.entity_link_attempts = Number(current.entity_link_attempts || 0) + 1;
        }
        const metadata = { ...current, entity_link_status: status, ...statusExtra };
        baseMemory.metadata = metadata;
        try { await (store || this.store).updateMemory(baseMemory.id, { metadata }); }
        catch (e) { console.warn(`[entity-co-mention] remote status persist failed for ${String(baseMemory.id).slice(0, 8)}: ${e.message}`); }
        return;
      }
      if (!entityStatusClient?.sourceMetadata) return;
      try {
        const sm = await entityStatusClient.sourceMetadata.findFirst({
          where: { memoryId: baseMemory.id },
          select: { id: true, metadata: true },
        });
        if (!sm) return;
        const current = (sm.metadata && typeof sm.metadata === 'object') ? sm.metadata : {};
        const statusExtra = { ...extra };
        if (status === 'in_progress') {
          statusExtra.entity_link_attempts = Number(current.entity_link_attempts || 0) + 1;
        }
        await entityStatusClient.sourceMetadata.update({
          where: { id: sm.id },
          data: { metadata: { ...current, entity_link_status: status, ...statusExtra } },
        });
      } catch (e) {
        console.warn(`[entity-co-mention] status persist failed for ${String(baseMemory.id).slice(0, 8)}: ${e.message}`);
      }
    };
    if ((process.env.MEMORY_ENTITY_LINKING || 'true').toLowerCase() === 'false') {
      await persistEntityStatus('skipped:disabled', { entity_link_completed_at: nowIso() });
      return { ok: true, status: 'skipped', reason: 'disabled', entities: 0, edges: 0 };
    }
    const configuredEntityLinkModel = process.env.ENTITY_LINKER_MODEL
      || process.env.MEMORY_PROCESSOR_MODEL
      || 'google/gemini-2.5-flash-lite';
    if (content.length < minLen) {
      await persistEntityStatus('skipped:short_content', { entity_link_completed_at: nowIso() });
      return { ok: true, status: 'skipped', reason: 'short_content', entities: 0, edges: 0 };
    }
    await persistEntityStatus('in_progress', {
      entity_link_started_at: nowIso(),
    });

    // Filter the recall set: drop self, drop empty bodies, cap at 8 to
    // keep the prompt small + cost predictable.
    let candidates = (similar || [])
      .filter(s => s.id && s.id !== baseMemory.id && (s.content || s.title))
      .slice(0, 8);

    // Smart-router attaches recall hints when it ran a pre-flight search
    // (router runs BEFORE engine, so its hints are the freshest). Merge
    // them in. The LLM then sees the union of vector + entity + temporal
    // recalled candidates and can decide the operator per pair.
    const routerHints = Array.isArray(baseMemory.metadata?._llm_recall_hints)
      ? baseMemory.metadata._llm_recall_hints
      : [];
    const existingIds = new Set(candidates.map(c => c.id));
    for (const h of routerHints) {
      if (!h?.id || h.id === baseMemory.id || existingIds.has(h.id)) continue;
      if (candidates.length >= 8) break;
      candidates.push({
        id: h.id,
        title: h.title,
        content: h.content,
        tags: h.tags || [],
        _searchMethod: 'router_hint',
      });
      existingIds.add(h.id);
    }
    // RESIDENCY: remote (self-host) orgs need a RELIABLE candidate pool. The agent's vector recall leg
    // is eventually-consistent — embeddings lag the row write (mid-ingest, the just-saved peer often has
    // no vector yet), so `similar` arrives empty or thin and the linker would degrade to an 8-row recency
    // fallback (cross-person noise, missed same-entity supersessions). Pull the org's latest memories from
    // the agent (PG-backed via listLatestMemories → /v1/list, always current + carries entity:* tags) and
    // merge them in, freshest-first. This gives the co-mention LLM the same same-entity peers central gets
    // from vector recall, so Updates/Extends/Contradicts/Mentions classify identically across org types.
    if (orgIsRemote(baseMemory.org_id)) {
      try {
        const REMOTE_LINK_CANDIDATES = Number(process.env.REMOTE_LINK_CANDIDATES || 12);
        const latest = await (store || this.store).listLatestMemories({
          user_id: baseMemory.user_id,
          org_id: baseMemory.org_id,
        });
        for (const m of (latest || [])) {
          if (candidates.length >= REMOTE_LINK_CANDIDATES) break;
          if (!m?.id || m.id === baseMemory.id || existingIds.has(m.id) || !(m.content || m.title)) continue;
          candidates.push({ id: m.id, title: m.title, content: m.content, tags: m.tags || [], _searchMethod: 'remote_latest' });
          existingIds.add(m.id);
        }
      } catch (e) {
        console.warn('[entity-co-mention] remote latest augmentation failed:', e.message);
      }
    }

    const deriveCandidates = Array.isArray(baseMemory.metadata?._llm_derive_candidates)
      ? baseMemory.metadata._llm_derive_candidates
      : [];
    for (const h of deriveCandidates) {
      if (!h?.id || h.id === baseMemory.id || existingIds.has(h.id)) continue;
      if (candidates.length >= 8) break;
      candidates.push({
        id: h.id,
        title: null,
        content: h.content,
        tags: [],
        _searchMethod: 'router_derive_band',
      });
      existingIds.add(h.id);
    }

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
          // Pull a WIDE recent pool, then rank by SHARED-ENTITY SPECIFICITY —
          // not recency. The old `orderBy createdAt desc, take 6` let a flood
          // of freshly-ingested bulk docs sharing one GENERIC entity (e.g.
          // 6 "photovoltaic in Germany" KB rows all tagged entity:Germany)
          // crowd out the genuinely-related older memory sharing a RARE,
          // specific entity (e.g. "German Registration" sharing entity:DACH).
          // That starved real links: the GTM/B&B memory stayed edgeless
          // because its only top-6 neighbours were Germany-energy docs the
          // LLM (correctly) judged unrelated. Rank by count of shared tag
          // signals, weighting rare entity:/person: tags above generic ones.
          const tagPool = await prismaClient.memory.findMany({
            where: {
              userId: baseMemory.user_id,
              orgId: baseMemory.org_id,
              deletedAt: null,
              isLatest: true,
              id: { not: baseMemory.id },
              tags: { hasSome: tagSignals },
            },
            select: { id: true, title: true, content: true, tags: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 60,
          });
          // Generic vs specific is DERIVED from the pool, not a hardcoded
          // stoplist of countries/brands (which never generalizes across
          // tenants/domains and silently dies once tags are canonical-cased).
          // An entity tag shared across a LARGE fraction of the candidate pool
          // is a weak (generic) link; one shared by only a few memories is a
          // strong (specific) link.
          const signalSet = new Set(tagSignals);
          const poolFreq = new Map();
          for (const r of tagPool) {
            for (const t of (r.tags || [])) {
              if (signalSet.has(t)) poolFreq.set(t, (poolFreq.get(t) || 0) + 1);
            }
          }
          const genericFloor = Math.max(3, Math.ceil(tagPool.length * 0.4));
          const scoreOf = (r) => {
            let s = 0;
            for (const t of (r.tags || [])) {
              if (!signalSet.has(t)) continue;
              const isEntity = t.startsWith('entity:') || t.startsWith('person:');
              if (t.startsWith('time:')) s += 0.25;
              else if (isEntity && (poolFreq.get(t) || 0) < genericFloor) s += 2; // rare/specific = strong
              else if (isEntity) s += 0.5; // shared by many = generic = weak
              else s += 1;
            }
            return s;
          };
          const ranked = tagPool
            .map((r) => ({ r, s: scoreOf(r) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => (b.s - a.s) || (new Date(b.r.createdAt) - new Date(a.r.createdAt)))
            .map((x) => x.r);
          const existingIds = new Set(candidates.map(c => c.id));
          for (const r of ranked) {
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
        if (orgIsRemote(baseMemory.org_id)) {
          // Remote (self-host) orgs have NO central rows — the candidate pool lives on the agent.
          // Pull recent peers over HTTP so co-mention edges can form on self-host too.
          const recent = await amrListRecent(baseMemory.org_id, baseMemory.user_id, 15);
          candidates = recent
            .filter((r) => r.id && r.id !== baseMemory.id)
            .map((r) => ({ id: r.id, title: r.title, content: r.content, tags: r.tags, _searchMethod: 'remote_recent_fallback' }))
            .slice(0, 8);
          console.log(`[entity-co-mention] remote recall empty → agent recency fallback: ${candidates.length} candidates`);
        } else {
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
        }
      } catch (fallbackErr) {
        console.warn('[entity-co-mention] recency fallback failed:', fallbackErr.message);
      }
    }

    // NOTE: candidates may still be 0 here (genuinely first memory in the org). We do NOT bail —
    // the linker LLM ALSO extracts this memory's own entity:* + temporal tags from its content, and
    // those tags must land regardless of peers (they're the overlap signal for the NEXT ingest).
    // With an empty candidate block the prompt simply returns links:[]; the edge loop no-ops.
    if (candidates.length === 0) {
      console.log('[entity-co-mention] no candidates — extracting self-tags only (no edges)');
    }

    const candidateBlock = candidates.map((c, i) =>
      `[${i}] ${(c.title || '').slice(0, 120)}\n    ${(c.content || '').slice(0, 280)}`
    ).join('\n\n');

    // Today's date is passed in so the LLM resolves relative temporal refs
    // ("Tuesday 7pm", "next week", "mañana 19:00") against the actual now,
    // not the model's training cutoff.
    const todayIso = new Date().toISOString().slice(0, 10);

    const prompt = `You are a multilingual memory graph linker. Given a NEW MEMORY and CANDIDATE memories, do FIVE things in ONE pass:

  1. extract ALL materially useful, source-supported entities from the new memory. Return each entity as {"name":"...","kind":"..."}; never return a bare string. Allowed kinds are person, organization, product, place, technology, and standard. Include named people, organizations / brands, products / models, projects (kind=product only when it is a named offering; otherwise omit), cities, countries, regions and facilities (kind=place), technologies, standards, and specific components, subsystems, or named features (kind=product or technology). Read the memory in WHATEVER language it is written, but EMIT every entity in CANONICAL form per the ENTITY NAMING rules below. Do not stop after the first or most obvious entity. Never manufacture people, places, or relationships that the source does not state.
  2. extract TEMPORAL anchors (day-of-week, time-of-day, relative refs like "tomorrow"/"mañana"/"morgen", absolute dates, recurring patterns). Resolve relatives against today=${todayIso}.
  3. classify the new memory's TYPE. Read the memory in ANY language and pick the SINGLE best-fit type by MEANING (not keywords), using these definitions:
       • decision     — a choice made or a commitment to a course of action ("we will ship X", "chose vendor Y", "agreed to Z"). Prefer over 'fact' whenever a resolution/commitment is expressed.
       • goal          — a desired future outcome / target / objective still to be achieved ("reach 30% margin", "launch by Q3", an action item to complete).
       • preference    — a person's subjective like / dislike / priority ("prefers dark mode", "favourite vendor is X").
       • lesson        — a learning, insight, takeaway, or postmortem conclusion ("we learned that…", "root cause was…").
       • event         — something that happened at a point in time (a meeting, a launch, a call, a quote said in a meeting, an incident).
       • relationship  — a durable connection BETWEEN entities (reports-to, works-with, partner-of, owns, located-in).
       • fact          — an objective, verifiable state or attribute that fits none of the above ("SolvisPia 13 uses R290", "warranty is 5 years"). This is the DEFAULT only when no more-specific type applies.
     Choose the most specific type the content genuinely supports; do not force-fit.
  4. for EACH candidate that shares an entity OR temporal anchor OR clear semantic continuity, emit ONE typed edge. Inspect the complete claim, including exact model names, components, mechanisms, quantities, units, conditions, negation, dates, ownership, and causal language; these details often distinguish an Extends edge from an Update or contradiction.
     Multiple candidates can each get DIFFERENT edge types simultaneously
     (e.g. Updates A, Extends B, Mentions C in the same save).
  5. when 2+ candidates together inform a synthesis claim made in the new
     memory, additionally emit a Derives edge per source candidate. Use
     Derives ONLY for genuine multi-source synthesis, not for plain
     co-mention (those are Mentions).

Use coreference: pronouns and possessives ("she", "my partner", "it", "they", "elle", "उसने") can resolve to a named entity from earlier turns.

ENTITY NAMING — emit ONE canonical name per real-world thing so the same entity never forks into variants:
  • LANGUAGE: write every entity in English. Translate common-noun concepts and widely-known place names to their standard English name. EXCEPTION — never translate or alter the proper name of a specific person, company, brand, or product/model; keep those verbatim as written in the source.
  • NUMBER: use the singular form for a concept or category; never the plural.
  • ABBREVIATIONS: prefer the full, widely-recognized term over an abbreviation or acronym — UNLESS the abbreviation IS the entity's established proper name.
  • SUFFIXES: drop corporate / legal-form suffixes from organization names.
  • FORM: the bare name only — no leading articles, quotes, trailing qualifiers, or punctuation.
  • SPECIFIC PARTS: a concrete component, subsystem, or named feature may be an entity even when it is not a proper noun, when the memory makes it a stable participant in a durable relation (for example a product contains it, it retains something, or it enables an operating mode). Keep the shortest source-faithful noun phrase that uniquely identifies it. Do not promote broad attributes such as "quality", "temperature", or "efficiency" by themselves.
  • COVERAGE CHECK: before answering, verify that every specific participant required to express the memory's durable subject-predicate-object claims is present. Preserve crucial qualifiers in link reasoning; never erase model variants, quantities, units, scope, conditions, negation, uncertainty, or temporal validity.
  The SAME thing mentioned twice (in any language, case, number, or abbreviation) MUST map to the SAME canonical string both times.

EXCLUDE — never emit these as entities:
  • job titles, roles, or functions (CTO, Chief Scientist, manager, engineer) — emit the PERSON'S name, not their title.
  • nationalities or vague regions with no retrieval value. Named cities, countries, regions, offices, stores, campuses, and facilities ARE place entities when the source actually mentions them.
  • generic descriptors (the project, the team, the company, the document, the meeting, data, stuff) and broad attributes with no stable identity. This exclusion does NOT remove a specific source-supported component, subsystem, technology, standard, model, or named feature.
  • standalone dates, times, numbers, or money amounts (captured under TEMPORAL / not entities).
  • placeholder or test tokens (foo, bar, test, smoke, alpha/bravo-style fillers).

PICK THE OPERATOR FROM SEMANTICS, NOT WORD OVERLAP:
  • "I prefer X" then later "switching to Y" → Updates the earlier preference.
  • "X works for case A" + "X works for case B" → Extends (additive, no
    contradiction).
  • "the team prefers X" + "manager actually prefers Y" → Contradicts (two
    parties hold opposing positions).
  • "X and Y separately suggested Z, so we'll do Z" → Derives from both X and Y.
  • two memories mentioning the same person but unrelated facts → Mentions only.
  • a product capability plus a memory naming the component or mechanism that provides it → Extends when the source supports additive detail; never infer the mechanism from co-occurrence alone.

NEW MEMORY:
${(baseMemory.title || '').slice(0, 200)}
${content.slice(0, 1500)}

CANDIDATE MEMORIES (already-recalled, indexed):
${candidateBlock}

Output JSON only:
{
  "entities": [{"name":"Rama","kind":"person"},{"name":"Heidelberg","kind":"place"}],
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
If no CANDIDATE matches, return "links":[] but STILL extract all supported entities, temporal anchors, and memory_type from NEW MEMORY. Return "entities":[] only when NEW MEMORY itself contains no supported entity.`;

    // Retry the Groq call on TRANSIENT failures (429 rate-limit, 5xx, and
    // network/timeout aborts). A single-attempt best-effort call meant any
    // transient Groq blip at save time silently produced ZERO edges and —
    // with no backfill — orphaned the memory permanently (observed: ~10
    // edgeless MCP saves, e.g. the GTM/B&B memory, despite 13 valid
    // candidates). Up to 3 attempts with exponential backoff; only a
    // genuine 4xx (bad request / auth) or exhausted retries gives up.
    const LINK_MODEL = configuredEntityLinkModel;
    const LINK_TIMEOUT_MS = Number(process.env.ENTITY_LINK_TIMEOUT_MS || 25000);
    const LINK_MAX_ATTEMPTS = Number(process.env.ENTITY_LINK_MAX_ATTEMPTS || 3);
    let parsed;
    let lastRaw = '';
    let linkLastErr = null;
    for (let attempt = 1; attempt <= LINK_MAX_ATTEMPTS; attempt++) {
      try {
        if (!this.hasInjectedMemoryChatClient) {
          // Keep the injected legacy client seam intact for unit tests. Normal
          // production traffic uses the governed provider route, so Gemini and
          // its fallback chain behave consistently with canonical extraction.
          parsed = await chatCompletionWithFallback({
            models: [LINK_MODEL, process.env.ENTITY_LINKER_FALLBACK_MODEL || 'deepseek/deepseek-v4-flash-0731'],
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 700,
            json_mode: true,
            response_format: ENTITY_LINK_RESPONSE_FORMAT,
            feature: 'entity-linking',
          });
          lastRaw = JSON.stringify(parsed);
          linkLastErr = null;
          break;
        }
        const resp = await this.memoryChatClient('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            // Entity extraction needs proper-noun recall, not just JSON
            // shaping. gpt-oss-20b returns entities=[] for short MCP saves
            // with obvious proper nouns, so pin to llama-3.3-70b-versatile.
            model: LINK_MODEL,
            messages: [{ role: 'user', content: prompt }],
            // Pinned to llama-3.3-70b for proper-noun recall (gpt-oss-20b returns
            // entities=[] for short MCP saves). If overridden to a gpt-oss model:
            // it IS a reasoning model, so use low reasoning_effort to keep latency
            // down (extraction needs no deep reasoning); gpt-oss now also supports
            // strict json_schema, but extractJsonFromText already salvages its
            // output, so we don't force a schema here. Non-gpt-oss → JSON-object.
            ...(/gpt-oss/i.test(LINK_MODEL)
              ? { reasoning_effort: process.env.ENTITY_LINK_REASONING_EFFORT || 'low' }
              : { response_format: { type: 'json_object' } }),
            temperature: 0.1,
            max_tokens: 700,
          }),
          // Bounded — prevent a hung groq call from wedging the advisory lock.
          signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          // 429 / 5xx are transient → retry. Other 4xx (400/401/403) are
          // permanent (bad key/request) → give up immediately.
          const transient = resp.status === 429 || resp.status >= 500;
          console.warn(`[entity-co-mention] LLM ${resp.status} (attempt ${attempt}/${LINK_MAX_ATTEMPTS}${transient ? ', retrying' : ', fatal'}): ${errBody.slice(0, 160)}`);
          if (transient && attempt < LINK_MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 400 * attempt * attempt)); // 400ms, 1.6s
            continue;
          }
          linkLastErr = Object.assign(new Error(`HTTP ${resp.status}`), { code: `http_${resp.status}` });
          break;
        }
        const data = await resp.json();
        const raw = data?.choices?.[0]?.message?.content || '{}';
        lastRaw = raw;
        try {
          parsed = JSON.parse(raw);
        } catch (strictErr) {
          parsed = extractJsonFromText(raw); // lenient fallback for gpt-oss
        }
        linkLastErr = null;
        break; // success
      } catch (llmErr) {
        // Network error / AbortSignal timeout — transient, retry.
        linkLastErr = llmErr;
        console.warn(`[entity-co-mention] LLM failed (attempt ${attempt}/${LINK_MAX_ATTEMPTS}): ${llmErr.message}`);
        if (attempt < LINK_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
          continue;
        }
      }
    }
    if (!parsed) {
      if (linkLastErr) console.warn('[entity-co-mention] LLM exhausted retries:', linkLastErr.message);
      parsed = {
        entities: structuredFallbackEntities,
        temporal: {},
        memory_type: inferredMemoryTypeFallback(baseMemory),
        links: [],
      };
      await persistEntityStatus(`error:${linkLastErr?.code || 'parse_error'}`, {
        entity_link_error: {
          code: linkLastErr?.code || 'parse_error',
          message: String(linkLastErr?.message || 'entity linker returned malformed output').slice(0, 240),
          raw_excerpt: String(lastRaw || '').slice(0, 400),
          model: LINK_MODEL,
          attempted_at: nowIso(),
        },
        entity_link_fallback_applied: structuredFallbackEntities.length > 0,
      });
    }

    const entityBySlug = new Map();
    for (const rawEntity of [...structuredFallbackEntities, ...(Array.isArray(parsed?.entities) ? parsed.entities : [])]) {
      const name = typeof rawEntity === 'string' ? rawEntity.trim() : rawEntity?.name?.trim();
      const slug = name ? normalizeEntity(name) : null;
      if (slug && !entityBySlug.has(slug)) entityBySlug.set(slug, rawEntity);
    }
    const entities = [...entityBySlug.values()].slice(0, 12);
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

    console.log(`[entity-co-mention] entities=[${entities.map((e) => typeof e === 'string' ? e : e.name).join(',')}] type=${inferredType || '-'} temporal=[${temporalTags.join(',')}] links=${links.length}`);

    // If the LLM inferred a more specific memory_type than the caller
    // supplied (caller likely defaulted to 'fact'), upgrade it. Only
    // upgrade in the fact→specific direction; never downgrade a caller
    // who explicitly set 'decision'/'preference'/etc.
    const normalizedInferredType = normalizeMemoryType(inferredType, { fallback: null, allowLegacy: false });
    if (normalizedInferredType && baseMemory.memory_type === 'fact' && normalizedInferredType !== 'fact') {
      try {
        await store.updateMemory(baseMemory.id, { memoryType: normalizedInferredType });
        baseMemory.memory_type = normalizedInferredType; // keep local copy in sync
        console.log(`[entity-co-mention] upgraded memory_type: fact → ${normalizedInferredType}`);
      } catch (typeErr) {
        console.warn('[entity-co-mention] type upgrade failed:', typeErr.message);
      }
    }

    // Persist extracted entities on the parent so the FE chip can render
    // them without another LLM pass + retrieval can filter by them.
    //
    // Tags remain the fast retrieval index; typed objects are also persisted
    // into the canonical registry below so person/place/org identity is not
    // flattened into an untyped chip.
    //   entity:Rama, entity:Heidelberg, entity:SAP
    // FE EntityChips reads these tags (filters tags starting with 'entity:').
    // Filterable via /api/memories?tags=entity:Rama — first-class graph node.
    if (entities.length > 0 || temporalTags.length > 0) {
      try {
        const cleanEntities = entities
          .map((e) => typeof e === 'string' ? e : e?.name)
          .filter(e => typeof e === 'string' && e.length > 0 && e.length < 60)
          // Canonicalize: collapse case/dash/underscore/legal-suffix duplicates
          // so SOLVIS / Solvis / SOLVIS_GmbH all become entity:solvis. Pure +
          // deterministic (entity-normalize.js); applied symmetrically at recall.
          .map(e => { const slug = normalizeEntity(e); return slug ? `entity:${slug}` : null; })
          .filter(Boolean);
        // Canonicalize existing tags too, so a pre-canonicalization
        // entity:SOLVIS and the new entity:solvis don't coexist on the same row.
        const newTags = normalizeTagsArray([
          ...(baseMemory.tags || []),
          ...cleanEntities,
          ...temporalTags,
        ]);
        await store.updateMemory(baseMemory.id, { tags: newTags });
        // Resync entity tags into .amr/Memory Box and require an acknowledgement.
        // A remote save is not entity-complete until the tenant store confirms it.
        if (orgIsRemote(baseMemory.org_id)) {
          const acknowledged = await amrUpdateTags(baseMemory.org_id, baseMemory.id, newTags, { requireAck: true });
          if (!acknowledged) throw new Error('remote memory entity-tag projection was not acknowledged');
        }
        baseMemory.tags = newTags;
      } catch (tagErr) {
        console.warn('[entity-co-mention] tag update failed:', tagErr.message);
        // Postgres 25P02 = transaction aborted by earlier failure.
        // Subsequent DB ops in same transaction will all fail; abort the
        // rest of entity-co-mention to keep the txn small + let the outer
        // ingestMemory return cleanly. Memory itself is already saved.
        if (tagErr.code === '25P02' || /transaction is aborted/.test(String(tagErr.message))) {
          console.warn('[entity-co-mention] txn aborted — skipping edge writes');
          return;
        }
      }
    }

    // Canonical entity registry is the durable cross-source entity graph.
    // This is idempotent and intentionally independent of relationship
    // inference: malformed relationship JSON must never erase entities the
    // save planner or memory processor already extracted.
    if (entities.length > 0 && !store?.inTransaction && entityStatusClient?.canonicalEntity) {
      const projection = await persistCanonicalLinks({
        prisma: entityStatusClient,
        organizationId: baseMemory.org_id,
        items: [{ memoryId: baseMemory.id, entities }],
        logger: console,
      });
      if (orgIsRemote(baseMemory.org_id) && projection.projectionFailed > 0) {
        throw new Error(`remote canonical entity projection incomplete (${projection.projectionFailed} writes)`);
      }
    }

    // Edge cap. Chat-bucket saves with force_entity_linking get a higher
    // ceiling (6) since the user explicitly invoked the save and we want
    // every relevant prior fact connected. Connector-tier noise sources
    // (gmail digests/newsletters) cap at 2 — digest threads mention 10+
    // entities, all junk: capping at 2 keeps the sender + one real topic.
    // Other paths stay at 3.
    const _tagsForCap = Array.isArray(baseMemory.tags) ? baseMemory.tags : [];
    const _isGmailish = _tagsForCap.includes('gmail') || _tagsForCap.includes('gmail_thread');
    const _isNoise = _tagsForCap.some((t) => t === 'updates' || t === 'promotions' || t === 'social' || t === 'forums' || t === 'newsletter' || t === 'label:updates' || t === 'label:promotions');
    const EDGE_CAP = (baseMemory.metadata?.force_entity_linking === true)
      ? 6
      : (_isGmailish || _isNoise) ? 2 : 3;
    const VALID_EDGE_TYPES = new Set(['Updates', 'Extends', 'Mentions', 'Contradicts', 'Derives']);

    // Per-type confidence floor. Updates is destructive (flips
    // is_latest=false on target) so demand high confidence + entity
    // overlap. Mentions stay permissive — they're just co-mention hints.
    const MIN_CONFIDENCE_BY_TYPE = {
      Updates: 0.85,        // raised from 0.70 — observed false positives
                            // where two unrelated gmail threads got Updates
                            // because they shared entity:Amar (owner name).
                            // 0.85 demands very strong evidence.
      Contradicts: 0.75,
      Extends: 0.60,
      Mentions: 0.55,
    };

    // Entity-overlap gating. Two principles, learned the hard way on the
    // GTM/B&B memory (LLM found 3 links, all wrongly filtered → 0 edges):
    //
    // 1. PUNCTUATION-INSENSITIVE matching. The same real-world entity is
    //    tagged inconsistently — entity:Da'Vinci_AI here vs entity:Davinci_AI
    //    on the candidate. Exact-string intersection missed it. normEntity()
    //    strips apostrophes/punctuation and collapses spaces so the two match.
    //
    // 2. Only the OWNER NAME vetoes a link — NOT batch-frequency. The old
    //    frequency-common rule marked "Germany" common (a German-business
    //    cluster legitimately co-mentions it everywhere) and stripped it from
    //    overlap, killing a Mentions edge the LLM had cited on "Germany" with
    //    0.8 confidence + a reason. The LLM citing a specific shared entity is
    //    a STRONGER signal than batch frequency, so we trust it: a link
    //    survives if its cited entity (normalized) appears on both sides, or
    //    if any non-owner entity overlaps. Frequency-common is gone.
    const normEntity = (s) => String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')   // apostrophes, &, dots, dashes → space
      .replace(/\s+/g, ' ')
      .trim();

    // Owner name + pronouns: the ONLY hard veto. These appear on nearly every
    // memory and co-mention of just the owner is not a real connection.
    const OWNER_COMMON = new Set(['amar', 'amar sai gadde', 'user', 'me', 'i', 'the user'].map(normEntity));

    const candEntsNorm = (cand) => new Set(
      (cand?.tags || [])
        .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
        .map((t) => normEntity(t.slice('entity:'.length).replace(/_/g, ' ')))
        .filter((e) => e && !OWNER_COMMON.has(e)),
    );

    // Candidate content, normalized once for the tag-lag fallback below.
    const candContentNorm = (cand) => normEntity(`${cand?.title || ''} ${cand?.content || ''}`);

    // Count shared non-owner entities between the new memory and a candidate.
    // PRIMARY signal = candidate entity:* tags. But entity tags are extracted
    // ASYNCHRONOUSLY (deferred entity-linking — server.js sets defer_entity_linking
    // on every /api/memories save), so a peer created seconds earlier in the same
    // session often has NO tags yet at link-time. Without a fallback the overlap
    // gate drops every edge to a fresh peer (observed: "N links proposed, 0 survived").
    // Fallback when the candidate has no entity tags: scan its raw content for the
    // new memory's LLM-extracted entities. The LLM already read both texts and cited
    // the shared entity, so a content hit is a sound same-topic signal. Applies to
    // ALL org types (central is usually masked by the vector-recall smart-ingest path;
    // self-host relies entirely on this co-mention path).
    const sharedEntityCount = (cand) => {
      const cset = candEntsNorm(cand);
      if (cset.size > 0) {
        let n = 0;
        for (const e of cset) if (newEntitiesLower.has(e)) n += 1;
        return n;
      }
      const hay = candContentNorm(cand);
      let n = 0;
      for (const e of newEntitiesLower) {
        if (e.length >= 3 && (hay === e || hay.includes(` ${e} `) || hay.startsWith(`${e} `) || hay.endsWith(` ${e}`))) n += 1;
      }
      return n;
    };

    // New memory's entity set (LLM-extracted + own entity tags), normalized,
    // owner stripped. Union both so a tag the LLM didn't re-emit still counts.
    const baseTagEnts = (baseMemory.tags || [])
      .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
      .map((t) => normEntity(t.slice('entity:'.length).replace(/_/g, ' ')));
    const newEntitiesLower = new Set(
      [...entities.map((e) => normEntity(typeof e === 'string' ? e : e?.name)), ...baseTagEnts].filter((e) => e && !OWNER_COMMON.has(e)),
    );

    const sorted = links
      .filter((l) => Number.isInteger(l.index) && l.index >= 0 && l.index < candidates.length)
      .filter((l) => typeof l.entity === 'string' && l.entity.length > 0)
      .filter((l) => {
        const type = VALID_EDGE_TYPES.has(l.type) ? l.type : 'Mentions';
        const floor = MIN_CONFIDENCE_BY_TYPE[type] ?? 0.55;
        return typeof l.confidence === 'number' && l.confidence >= floor;
      })
      // For Updates (destructive — flips target is_latest=false): demand ≥1 shared
      // non-owner entity. This MATCHES the smart-ingest supersede policy (graph-engine
      // line ~1320: sharedNonCommon.length >= 1 + conf≥0.85, the floor already enforced
      // above). Person-centric supersessions ("Greta moved to Netflix" vs "Greta works
      // at Amazon") share exactly ONE non-owner entity — the person — so the old ≥2
      // requirement made co-mention NEVER supersede a job/role change; central got the
      // flip from the vector-recall classifier instead, which self-host can't rely on.
      // sharedEntityCount falls back to candidate-content scan when tags lag (async).
      .filter((l) => {
        const type = VALID_EDGE_TYPES.has(l.type) ? l.type : 'Mentions';
        if (type !== 'Updates') return true;
        return sharedEntityCount(candidates[l.index]) >= 1;
      })
      // For Mentions/Extends/Contradicts: ≥1 shared non-owner entity (tag or
      // content fallback), OR the LLM-cited entity present on both sides.
      .filter((l) => {
        const type = VALID_EDGE_TYPES.has(l.type) ? l.type : 'Mentions';
        if (type === 'Updates') return true; // handled above
        if (sharedEntityCount(candidates[l.index]) >= 1) return true;
        // LLM-cited entity bridge: cited entity present on both sides (tags OR content).
        const cited = normEntity(l.entity);
        if (cited && !OWNER_COMMON.has(cited) && newEntitiesLower.has(cited)) {
          const cset = candEntsNorm(candidates[l.index]);
          if (cset.has(cited)) return true;
          const hay = candContentNorm(candidates[l.index]);
          if (cited.length >= 3 && (hay === cited || hay.includes(` ${cited} `) || hay.startsWith(`${cited} `) || hay.endsWith(` ${cited}`))) return true;
        }
        return false;
      })
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, EDGE_CAP);
    const commonEntities = OWNER_COMMON; // for the diagnostic log below

    // Telemetry: when the LLM proposed links but NONE survived the overlap
    // gate, that's either correct (newsletter noise — no real shared entity)
    // or a missed connection. Short line always; full detail only under
    // ENTITY_LINK_DEBUG to keep prod logs clean (this fires on every noise
    // email ingest).
    if (links.length > 0 && sorted.length === 0) {
      if (process.env.ENTITY_LINK_DEBUG === 'true') {
        console.warn(`[entity-co-mention] ALL ${links.length} link(s) filtered for ${String(baseMemory.id).slice(0, 8)}. newEntities=[${[...newEntitiesLower].join('|')}] linkDetail=${JSON.stringify(links.map((l) => ({ i: l.index, t: l.type, e: l.entity, c: l.confidence, candEnts: (candidates[l.index]?.tags || []).filter((t) => t.startsWith('entity:')).map((t) => t.slice(7).replace(/_/g, ' ').toLowerCase()) })).slice(0, 5))}`);
      } else {
        console.log(`[entity-co-mention] ${links.length} link(s) proposed, 0 survived overlap gate for ${String(baseMemory.id).slice(0, 8)} (no shared entity)`);
      }
    }

    const writeStore = store || this.store;
    // Pre-flight: drop links pointing at memory IDs that no longer exist
    // (candidate may have been deleted / superseded between recall and
    // edge create). One FK violation poisons the outer Postgres txn so
    // verify existence BEFORE any createRelationship attempt.
    // Remote (self-host) orgs: candidates came from the agent's /v1/list, which already filters
    // deleted_at IS NULL — they're known-live. A central existence check would query empty central
    // Postgres and drop EVERY edge. Skip it; the agent enforces FK/existence on its own insert.
    if (sorted.length > 0 && !orgIsRemote(baseMemory.org_id)) {
      try {
        const targetIds = Array.from(new Set(sorted.map((l) => candidates[l.index]?.id).filter(Boolean)));
        const prismaClient = (writeStore && writeStore.client) || this.store.client;
        if (prismaClient && prismaClient.memory && targetIds.length > 0) {
          const live = await prismaClient.memory.findMany({
            where: { id: { in: targetIds }, deletedAt: null },
            select: { id: true },
          });
          const liveSet = new Set(live.map((m) => m.id));
          const filtered = sorted.filter((l) => liveSet.has(candidates[l.index]?.id));
          if (filtered.length < sorted.length) {
            console.log(`[entity-co-mention] dropped ${sorted.length - filtered.length} edge(s) to deleted/missing candidate memories`);
          }
          sorted.length = 0;
          sorted.push(...filtered);
        }
      } catch (preflightErr) {
        console.warn('[entity-co-mention] pre-flight existence check failed:', preflightErr.message);
      }
    }

    let txnPoisoned = false;
    let edgeWrites = 0;
    let edgeWriteFailures = 0;
    for (const l of sorted) {
      if (txnPoisoned) break;
      const cand = candidates[l.index];
      const confidence = Math.min(Math.max(l.confidence, 0.55), 0.95);
      const edgeType = VALID_EDGE_TYPES.has(l.type) ? l.type : 'Mentions';
      // Co-occurrence is already persisted in CanonicalEntity/MemoryEntityLink.
      // It is searchable metadata, not a durable memory-to-memory relationship.
      if (edgeType === 'Mentions') continue;
      // A linker candidate is only a semantic neighbour. It is not source
      // provenance. Admit Derives here only when the canonical ingest router
      // explicitly placed that candidate in the derive band; otherwise the
      // model could turn ordinary co-occurrence into a permanent provenance
      // edge simply by labelling it "Derives".
      if (edgeType === 'Derives' && cand?._searchMethod !== 'router_derive_band') continue;

      // Negation guard: a memory that explicitly says it is UNRELATED to the
      // shared entity ("unrelated to X", "not related to X", "nothing to do
      // with X", "other than X") must not become a semantic co-mention edge to
      // that entity — the mention is a disclaimer, not a relationship (observed:
      // a negative-control note falsely linked to SolvisMax). Checks a short
      // window before the entity mention in BOTH memories' content.
      {
        const _ent = String(l.entity || '').replace(/_/g, ' ').toLowerCase().trim();
        const _negated = (text) => {
          const c = String(text || '').toLowerCase();
          if (!_ent || !c.includes(_ent)) return false;
          const idx = c.indexOf(_ent);
          const before = c.slice(Math.max(0, idx - 48), idx);
          return /\b(un-?related to|not related to|no relation to|nothing to do with|not associated with|not connected to|other than|unrelated to)\s*$/.test(before);
        };
        if (_negated(baseMemory.content) || _negated(cand?.content)) {
          console.log(`[entity-co-mention] negation-guard: skip "${edgeType}" edge on "${l.entity}" (negated mention)`);
          continue;
        }
      }

      try {
        const applied = await this.applyValidatedRelationship({
          id: uuidv4(),
          from_id: baseMemory.id,
          to_id: cand.id,
          org_id: baseMemory.org_id,
          type: edgeType,
          confidence,
          created_by: 'entity_co_mention_llm',
          created_at: nowIso(),
          metadata: {
            shared_entities: [l.entity],
            reason: (l.reason || '').slice(0, 200),
            extraction_model: process.env.ENTITY_LINKER_MODEL || MEMORY_INGEST_MODEL,
            classification_source: 'llm',
          },
        }, {
          store: writeStore,
          user_id: baseMemory.user_id,
          org_id: baseMemory.org_id,
        });
        edgeWrites += applied.edgesCreated?.length || 0;
        continue; // dispatcher owns Updates demotion and all semantic side effects
      } catch (edgeErr) {
        const msg = String(edgeErr.message || '');
        // Foreign-key violation = candidate memory was deleted between
        // recall and edge create. Skip this edge but DON'T retry — the
        // FK failure has poisoned the transaction. Subsequent edge ops
        // will all fail with 25P02. Abort entity-co-mention immediately
        // so the outer ingestMemory can commit the parent cleanly.
        if (/Foreign key constraint violated/i.test(msg) || edgeErr.code === '23503') {
          console.warn(`[entity-co-mention] FK violation to candidate ${cand?.id?.slice(0,8)} (likely deleted) — aborting edge loop to spare txn`);
          txnPoisoned = true;
          break;
        }
        if (edgeErr.code === '25P02' || /transaction is aborted/.test(msg)) {
          console.warn('[entity-co-mention] txn aborted — aborting edge loop');
          txnPoisoned = true;
          break;
        }
        // Never manufacture an Extends edge when a proposal fails validation.
        edgeWriteFailures += 1;
      }

      // Rejected proposals have no durable side effect. In particular, never
      // demote a target after the canonical dispatcher refused an Updates edge.
    }
    const relationshipWriteFailed = edgeWriteFailures > 0 || txnPoisoned;
    if (parsed && !linkLastErr && !relationshipWriteFailed) {
      await persistEntityStatus('done', {
        entity_link_completed_at: nowIso(),
        entity_link_model: LINK_MODEL,
        entity_link_entity_count: entities.length,
        entity_link_edge_count: edgeWrites,
        entity_link_fallback_applied: false,
      });
    } else if (parsed && !linkLastErr && relationshipWriteFailed) {
      const code = edgeWrites > 0 ? 'relationship_write_partial' : 'relationship_write_failed';
      await persistEntityStatus(`error:${code}`, {
        entity_link_completed_at: nowIso(),
        entity_link_model: LINK_MODEL,
        entity_link_entity_count: entities.length,
        entity_link_edge_count: edgeWrites,
        entity_link_edge_failures: edgeWriteFailures + (txnPoisoned ? 1 : 0),
        entity_link_error: { code, attempted_at: nowIso() },
      });
    }
    return {
      ok: !linkLastErr && !relationshipWriteFailed,
      status: linkLastErr ? 'fallback' : relationshipWriteFailed ? 'partial' : 'done',
      entities: entities.length,
      edges: edgeWrites,
      error: linkLastErr ? (linkLastErr.code || linkLastErr.message) : relationshipWriteFailed ? 'relationship_write_failed' : null,
    };
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
        const applied = await this.applyValidatedRelationship({
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
        }, { user_id: tree.parent.user_id, org_id: tree.parent.org_id });
        partOfEdgeIds.push(applied.edgesCreated?.[0]?.id || null);
      } catch (edgeErr) {
        console.warn('[ingest-tree] PartOf edge failed:', edgeErr.message);
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
    let vectorPatch = null;
    const result = await activeStore.transaction(async store => {
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

      const verdict = validateRelationshipProposal({
        type: 'Updates', sourceMemory: source, targetMemory: target,
        confidence, orgId: org_id, userId: user_id,
      });
      if (!verdict.ok) throw new Error(`relationship_policy_rejected:Updates:${verdict.reason}`);

      const sourceEffectiveAt = source.valid_from || source.document_date || source.created_at || nowIso();
      const targetEffectiveAt = target.valid_from || target.document_date || target.created_at || sourceEffectiveAt;
      const sourceEffectiveMs = new Date(sourceEffectiveAt).getTime();
      const targetEffectiveMs = new Date(targetEffectiveAt).getTime();
      const closeAt = new Date(Math.max(
        Number.isFinite(sourceEffectiveMs) ? sourceEffectiveMs : Date.now(),
        Number.isFinite(targetEffectiveMs) ? targetEffectiveMs : 0,
      )).toISOString();
      await store.updateMemory(targetId, {
        is_latest: false,
        valid_to: closeAt,
        updated_at: nowIso()
      });
      vectorPatch = { memoryId: targetId, payload: { is_latest: false, valid_to: closeAt } };

      const nextVersion = (target.version || 1) + 1;
      const edge = await store.createRelationship({
        id: uuidv4(),
        org_id,
        storage_backend: source._storage_backend || target._storage_backend || undefined,
        from_id: sourceId,
        to_id: targetId,
        type: 'Updates',
        confidence,
        created_at: nowIso(),
        metadata: certifyRelationshipMetadata(buildSemanticMetadata({
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
        }), verdict)
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

    // Never perform network I/O inside the database transaction. The canonical
    // write commits first; Qdrant is a candidate index and is synchronized
    // best-effort. Canonical hydration below prevents stale payloads from
    // changing eligibility if this patch temporarily fails.
    if (vectorPatch && this.vectorStore?.updateMemoryPayload && !orgIsRemote(org_id)) {
      try {
        await runWithOrg(org_id, () => this.vectorStore.updateMemoryPayload(
          vectorPatch.memoryId,
          vectorPatch.payload,
          { orgId: org_id },
        ));
      } catch (error) {
        console.warn('[graph-engine] Qdrant lifecycle payload sync failed:', error.message);
      }
    }
    return result;
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

      const verdict = validateRelationshipProposal({
        type: 'Extends', sourceMemory: source, targetMemory: target,
        confidence, orgId: org_id, userId: user_id,
      });
      if (!verdict.ok) throw new Error(`relationship_policy_rejected:Extends:${verdict.reason}`);

      const nextVersion = (target.version || 1) + 1;
      const edge = await store.createRelationship({
        id: uuidv4(),
        org_id,
        storage_backend: source._storage_backend || target._storage_backend || undefined,
        from_id: sourceId,
        to_id: targetId,
        type: 'Extends',
        confidence,
        created_at: nowIso(),
        metadata: certifyRelationshipMetadata(buildSemanticMetadata({
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
        }), verdict)
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

      const verdict = validateRelationshipProposal({
        type: 'Derives', sourceMemory: sources[0], sourceMemories: sources, targetMemory: target,
        confidence, orgId: org_id, userId: user_id,
      });
      if (!verdict.ok) throw new Error(`relationship_policy_rejected:Derives:${verdict.reason}`);

      const edges = [];
      for (const sourceIdValue of uniqueSourceIds) {
        const edge = await store.createRelationship({
          id: uuidv4(),
          org_id,
          storage_backend: sources.find((memory) => memory?.id === sourceIdValue)?._storage_backend || target._storage_backend || undefined,
          from_id: sourceIdValue,
          to_id: targetId,
          type: 'Derives',
          confidence,
          created_at: nowIso(),
          metadata: certifyRelationshipMetadata(buildSemanticMetadata({
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
          }), verdict),
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

  /** Single durable entrypoint for every semantic or structural edge proposal. */
  async applyValidatedRelationship(edge = {}, {
    store: storeOverride,
    user_id = null,
    org_id = null,
    startedAt = Date.now(),
  } = {}) {
    const store = storeOverride || this.store;
    const type = normalizeRelationshipType(edge.type);
    const sourceIds = [...new Set((edge.source_ids || edge.sourceIds || [edge.from_id || edge.fromId]).filter(Boolean))];
    const targetId = edge.to_id || edge.toId || edge.target_id || edge.targetId;
    if (!type || sourceIds.length === 0 || !targetId) {
      return { operation: 'relationship_rejected', edgesCreated: [], reason: 'invalid-relationship-envelope' };
    }

    if (type === 'Updates') {
      return this.applyUpdate(sourceIds[0], targetId, { store, user_id, org_id, confidence: edge.confidence ?? 1, startedAt });
    }
    if (type === 'Extends') {
      return this.applyExtends(sourceIds[0], targetId, { store, user_id, org_id, confidence: edge.confidence ?? 1, startedAt });
    }
    if (type === 'Derives') {
      return this.applyDerivesFromSources(sourceIds, targetId, {
        store, user_id, org_id, confidence: edge.confidence ?? 1, startedAt,
        reason: edge.reason || edge.metadata?.reason || 'Derives',
      });
    }

    return store.transaction(async tx => {
      const sources = await Promise.all(sourceIds.map(id => tx.getMemory(id)));
      const target = await tx.getMemory(targetId);
      const verdict = validateRelationshipProposal({
        type, sourceMemory: sources[0], sourceMemories: sources, targetMemory: target,
        confidence: edge.confidence ?? 1, orgId: org_id, userId: user_id,
      });
      if (!verdict.ok) {
        return { operation: 'relationship_rejected', edgesCreated: [], reason: verdict.reason };
      }
      const metadata = certifyRelationshipMetadata({
        ...buildSemanticMetadata({
          semanticRole: type === 'PartOf' ? 'structure' : 'relationship',
          relationship: { type, sourceIds, targetId, confidence: edge.confidence ?? 1, reason: edge.reason || null },
          sourceIds,
          sourceMemory: sources[0],
          targetMemory: target,
          reason: edge.reason || null,
          confidence: edge.confidence ?? 1,
        }),
        ...(edge.metadata || {}),
      }, verdict);
      const created = await tx.createRelationship({
        ...edge,
        id: edge.id || uuidv4(),
        from_id: sourceIds[0],
        to_id: targetId,
        type,
        org_id,
        storage_backend: sources.find((memory) => memory?._storage_backend)?._storage_backend || target?._storage_backend || edge.storage_backend,
        confidence: edge.confidence ?? 1,
        created_at: edge.created_at || nowIso(),
        created_by: edge.created_by || 'canonical-relationship-dispatcher',
        metadata,
      });
      return { operation: relationshipOperationForType(type), edgesCreated: [created], reason: verdict.reason };
    });
  }

  _buildMemoryRecord(input) {
    const timestamp = nowIso();
    const documentDate = deriveDocumentDate(input);
    const memoryType = normalizeMemoryType(input.memory_type, { allowLegacy: false });

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
      memory_type: memoryType,
      title: input.title || null,
      tags: input.tags || [],
      // P2 salience: explicit caller value wins; else derive from memory_type
      // (priority is unknown pre-processor and is upgraded below once the
      // processor extracts it). Legacy callers that pass nothing still get a
      // meaningful type-based score instead of the flat 0.5 default.
      importance_score: Number.isFinite(input.importance_score)
        ? input.importance_score
        : computeImportanceScore({ memory_type: memoryType, priority: input.priority }),
      is_latest: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      document_date: documentDate,
      valid_from: input.valid_from || input.validFrom || documentDate,
      valid_to: input.valid_to || input.validTo || null,
      event_dates: input.event_dates || [],
      cognitive_layer_role: input.cognitive_layer_role || null,
      claim_key: input.claim_key || null,
      claim_subject: input.claim_subject || null,
      claim_predicate: input.claim_predicate || null,
      claim_qualifiers: input.claim_qualifiers || null,
      extraction_confidence: Number.isFinite(input.extraction_confidence)
        ? input.extraction_confidence
        : null,
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
    const maxCandidates = Math.max(1, Number(process.env.DERIVATION_ENQUEUE_MAX || 16));
    const timeoutMs = Math.max(25, Number(process.env.DERIVATION_ENQUEUE_TIMEOUT_MS || 250));
    const jobs = latestMemories.slice(0, maxCandidates).flatMap((candidate) => {
      if (candidate.id === memory.id) return [];
      const confidence = this.conflictDetector.detectCandidates(memory, [candidate])[0]?.similarity || 0;
      if (confidence < this.deriveThreshold) return [];
      return [Promise.race([
          store.enqueueDerivationJob({
            id: uuidv4(),
            source_memory_id: memory.id,
            target_memory_id: candidate.id,
            confidence,
            status: 'queued',
            created_at: nowIso()
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue timeout')), timeoutMs)),
        ]).catch((error) => console.warn('[derivation-queue] candidate skipped:', error.message))];
    });
    await Promise.all(jobs);
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
