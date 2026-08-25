/**
 * Document-First Ingestion Service
 * Phase 1: Evidence → Structure → Canonical Memory transformation
 *
 * This service handles the new document-backed ingestion path where:
 * 1. Raw uploads become SourceArtifacts (evidence layer)
 * 2. Parsing creates KnowledgeDocuments and KnowledgeSegments (structure layer)
 * 3. Selective promotion creates canonical Memories (memory layer)
 *
 * Feature-flagged to run parallel to existing chunk-memory path.
 */

import crypto from 'crypto';
import { runWithOrg, currentOrg } from '../db/prisma.js';
import { memoryChatFetch, memoryLLMRoute } from '../llm/groq-fallback.js';
import { chatCompletion, chatCompletionWithFallback } from './enterprise/litellm-client.js';
import { computeTokenSimilarity } from '../memory/conflict-detector.js';
import { orgIsRemote, amrKbDoc, amrKbSegment, amrKbProvenance, amrKbTables, amrKbDocDelete, amrKbDocDetail } from '../vector/mneme/driver.js';
import { contextualEmbedInputForSegment } from './contextual-embed-input.js';
import { redactParsedDocument } from './content-secret-redaction.js';
import { sanitizeKnowledgeJson } from './upload-contract.js';
import { applyClaimPatchIfLive } from './claim-structuring-write.js';

// RESIDENCY GUARD — KB ingestion persists raw document content as knowledge_segments + the document
// row on the CENTRAL store (this.db). For a self-host (remote/agent) org that is a residency LEAK:
// the customer's document text would sit on our box. The KB-on-agent layer (agent-side knowledge
// tables + segment vectors + read/write/recall routing) is a dedicated build; until it ships we
// REFUSE self-host KB ingestion rather than leak. Chat + connector memories already route to the
// agent correctly. Throw a clear, surfaced message.
function assertKbAllowedForOrg(orgId) {
  if (orgIsRemote(orgId)) {
    const e = new Error('Knowledge Base document ingestion is not yet available for self-hosted orgs — coming soon. Memories (chat, API, connectors) work normally and stay on your server.');
    e.code = 'KB_SELFHOST_UNSUPPORTED';
    e.statusCode = 501;
    throw e;
  }
}
import { resolveCollectionForOrg, PER_TENANT } from '../vector/container-router.js';
import { normalizeEntity, normalizeTagsArray } from '../memory/entity-normalize.js';
import { persistCanonicalLinks } from '../memory/canonical-entity-persister.js';
import { validateSupersedingEdge, computeHubEntitySlugs, relationshipValidatorMode } from '../memory/relationship-semantics.js';
import { validateEnvelope, normalizeProvenance, detectMode } from './canonical-ingest.js';
import { isStructuredSourceNoise } from '../memory/durable-content.js';
import { countPages } from './page-count.js';
import { isValidEmbeddingVector } from '../embeddings/vector-contract.js';
import { normalizeKbMemoryType } from '../memory/memory-taxonomy.js';
import {
  buildEvidenceMetadata,
  buildEvidenceVectorPayload,
  assertEvidenceVectorPayload,
  buildMemoryProvenance,
  memoryTitle as provenanceMemoryTitle,
} from './provenance-metadata.js';

const DURABLE_EXTRACT_TYPES = ['fact', 'event'];
const KB_CURATED_TYPES = ['fact', 'event', 'summary', 'synthesis'];
const KB_CLAIM_KINDS = new Set(['fact', 'event', 'decision', 'preference', 'policy', 'goal', 'commitment', 'procedure', 'lesson']);
const CLAIM_ENTITY_KINDS = new Set(['person', 'organization', 'product', 'place', 'technology', 'standard']);
const KB_INGEST_VERBOSE = String(process.env.KB_INGEST_VERBOSE || '').toLowerCase() === 'true';

/** Keep parser and promotion diagnostics out of production task logs by default. */
export function createIngestDiagnosticLogger(logger = console, { verbose = KB_INGEST_VERBOSE } = {}) {
  const emit = (level) => (...args) => {
    if (verbose) logger?.[level]?.(...args);
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

const ingestDiagnostic = createIngestDiagnosticLogger(console);


// A promoted memory is a claim over a persisted evidence segment. Keep the
// segment's source/citation/scope/time fields intact instead of reconstructing
// a smaller, lossy provenance object at promotion time. This is intentionally
// data-shaped rather than provider-shaped so the same contract applies to
// central, embedded AMR, and self-hosted agent stores.
export function promotionProvenance(segment, documentId, documentMetadata = {}) {
  const source = segment?.metadata && typeof segment.metadata === 'object' && !Array.isArray(segment.metadata)
    ? { ...segment.metadata }
    : {};
  const sourceId = source.source_id || source.sourceId || documentMetadata.source_id || documentMetadata.sourceId || documentId;
  const sourceTitle = source.source_title || source.sourceTitle || documentMetadata.source_title
    || documentMetadata.sourceTitle || documentMetadata.documentTitle || documentMetadata.filename || null;
  return {
    ...source,
    segment_id: segment?.id || source.segment_id || source.segmentId || null,
    document_id: documentId || source.document_id || source.documentId || null,
    source_id: sourceId,
    source_title: sourceTitle,
    heading: source.heading || source.heading_path || null,
    page: source.page || segment?.startPage || source.start_page || null,
    citation_id: source.citation_id || source.citationId || null,
    scope: source.scope || documentMetadata.scope || null,
    project_ids: Array.isArray(source.project_ids) ? source.project_ids : (documentMetadata.project_ids || []),
    primary_team_id: source.primary_team_id || source.team_id || documentMetadata.primary_team_id || null,
    document_date: source.document_date || documentMetadata.document_date || null,
    known_at: source.known_at || source.ingested_at || documentMetadata.known_at || null,
    content_hash: source.content_hash || segment?.contentHash || segment?.content_hash || documentMetadata.content_hash || null,
    embedding_model: source.embedding_model || segment?.embeddingModel || documentMetadata.embedding_model || null,
    embedding_version: source.embedding_version || segment?.embeddingVersion || documentMetadata.embedding_version || null,
    uploaded_by_user_id: source.uploaded_by_user_id || source.uploader_user_id
      || documentMetadata.uploaded_by_user_id || documentMetadata.uploader_user_id || null,
    uploader_user_id: source.uploader_user_id || source.uploaded_by_user_id
      || documentMetadata.uploader_user_id || documentMetadata.uploaded_by_user_id || null,
  };
}

function promotionMemoryContext({ evidenceProvenance, supportingEvidenceProvenance = [], documentId, metadata = {}, userId }) {
  const primary = evidenceProvenance && typeof evidenceProvenance === 'object' && !Array.isArray(evidenceProvenance)
    ? sanitizeKnowledgeJson(evidenceProvenance)
    : {};
  const hasPrimary = Object.keys(primary).length > 0;
  const supportingCandidates = Array.isArray(supportingEvidenceProvenance)
    ? supportingEvidenceProvenance
    : [];
  const supporting = [];
  const seenSegments = new Set();
  for (const candidate of [...(hasPrimary ? [primary] : []), ...supportingCandidates]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const normalized = sanitizeKnowledgeJson(candidate);
    const key = normalized.segment_id || normalized.segmentId || JSON.stringify(normalized);
    if (seenSegments.has(key)) continue;
    seenSegments.add(key);
    supporting.push(normalized);
  }
  const projectIds = Array.isArray(primary.project_ids) && primary.project_ids.length
    ? primary.project_ids
    : (Array.isArray(metadata.project_ids) ? metadata.project_ids : []);
  const sourceContentHash = primary.content_hash || null;
  return {
    sourceId: primary.source_id || primary.sourceId || metadata.source_id || metadata.sourceId || documentId,
    sourceTitle: primary.source_title || primary.sourceTitle || metadata.source_title || metadata.sourceTitle
      || metadata.documentTitle || metadata.filename || null,
    sourceKind: primary.source_kind || metadata.source_kind || 'document',
    sourcePlatform: primary.source_platform || metadata.source_platform || 'knowledge_base',
    sourceUrl: primary.source_url || metadata.source_url || null,
    scope: primary.scope || metadata.scope || null,
    visibility: primary.visibility || metadata.visibility || 'private',
    projectIds,
    teamId: primary.primary_team_id || primary.team_id || metadata.primary_team_id || null,
    documentDate: primary.document_date || metadata.document_date || null,
    eventTime: primary.event_time || metadata.event_time || null,
    validFrom: primary.valid_from || metadata.valid_from || null,
    validTo: primary.valid_to || metadata.valid_to || null,
    knownAt: primary.known_at || metadata.known_at || null,
    language: primary.language || metadata.language || null,
    uploaderUserId: primary.uploaded_by_user_id || primary.uploader_user_id || userId,
    existing: {
      ...primary,
      ...(sourceContentHash ? { source_content_hash: sourceContentHash } : {}),
      ...(hasPrimary ? { evidence_provenance: primary } : {}),
      ...(supporting.length ? { supporting_evidence: supporting } : {}),
    },
  };
}

// qwen3-ingest is schema-led: plain JSON mode can return a valid but unrelated
// shape. Keep required fields deliberately small so the existing normalization
// and source-quote validation still own quality, while the model is forced to
// return the unified extractor envelope used by all downstream persistence.
const QWEN_UNIFIED_FACTS_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'hivemind_unified_facts',
    schema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              t: { type: 'string' }, f: { type: 'string' },
              memory_type: { type: 'string' }, importance: { type: 'number' },
              claim_kind: { type: 'string' },
              extraction_confidence: { type: 'number' }, source_quote: { type: 'string' },
              subject: { type: 'object' }, predicate: { type: 'string' }, object: { type: 'object' },
              qualifiers: { type: 'object' }, entities: { type: 'array', items: { type: 'object' } },
              relationships: { type: 'array', items: { type: 'object' } },
            },
            // The downstream normalizer deliberately rejects a fact without a
            // durable type or a verbatim grounding span.  Leaving these
            // optional made Qwen's otherwise valid schema response look like
            // a successful extraction while every candidate was discarded.
            // Require the minimal persistence contract at generation time.
            required: ['t', 'f', 'memory_type', 'claim_kind', 'source_quote'],
            additionalProperties: true,
          },
        },
      },
      required: ['facts'],
      additionalProperties: false,
    },
  },
};

const QWEN_RELATION_EDGES_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'hivemind_document_relationships',
    schema: {
      type: 'object',
      properties: {
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: { from: { type: 'integer' }, to: { type: 'integer' }, type: { type: 'string' } },
            required: ['from', 'to', 'type'],
            additionalProperties: false,
          },
        },
      },
      required: ['edges'],
      additionalProperties: false,
    },
  },
};

function usableEmbedding(vector) {
  return isValidEmbeddingVector(vector);
}

function boundedClaimText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizedClaimEntity(value) {
  if (typeof value === 'string') return { name: boundedClaimText(value), kind: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = boundedClaimText(value.name || value.n);
  const rawKind = boundedClaimText(value.kind || value.k, 64).toLowerCase();
  return name ? { name, kind: CLAIM_ENTITY_KINDS.has(rawKind) ? rawKind : null } : null;
}

function normalizedClaimRelationship(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const from = normalizedClaimEntity(value.from);
  const to = normalizedClaimEntity(value.to);
  const type = boundedClaimText(value.type, 100).toLowerCase().replace(/[^a-z0-9_:-]/g, '_');
  if (!from?.name || !to?.name || !type) return null;
  return { from, type, to };
}

function normalizeClaimStructure(item, fallback = {}) {
  const subject = normalizedClaimEntity(item?.subject || item?.claim_subject)
    || normalizedClaimEntity(fallback?.subject || fallback?.claim_subject)
    || null;
  const predicate = boundedClaimText(item?.predicate || item?.claim_predicate
    || fallback?.predicate || fallback?.claim_predicate, 500).toLowerCase();
  const rawObject = item?.object ?? item?.claim_object ?? fallback?.object ?? fallback?.claim_object;
  const object = typeof rawObject === 'string'
    ? { value: boundedClaimText(rawObject, 1000), type: null }
    : (rawObject && typeof rawObject === 'object' && !Array.isArray(rawObject)
      ? { value: boundedClaimText(rawObject.value, 1000), type: boundedClaimText(rawObject.type, 100) || null }
      : null);
  const rawQualifiers = item?.qualifiers ?? item?.claim_qualifiers
    ?? fallback?.qualifiers ?? fallback?.claim_qualifiers;
  const qualifiers = rawQualifiers && typeof rawQualifiers === 'object' && !Array.isArray(rawQualifiers)
    ? { ...rawQualifiers }
    : {};
  if (object?.value) qualifiers.object = object.value;
  if (object?.type) qualifiers.object_type = object.type;
  const relationships = (Array.isArray(item?.relationships) ? item.relationships
    : (Array.isArray(fallback?.relationships) ? fallback.relationships : []))
    .map(normalizedClaimRelationship).filter(Boolean).slice(0, 12);
  if (relationships.length) qualifiers.relationships = relationships;
  const confidenceValue = Number(item?.extraction_confidence ?? fallback?.extraction_confidence);
  const extractionConfidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : null;
  return { subject, predicate, object, qualifiers, relationships, extractionConfidence };
}

function stableClaimKey({ subject, predicate, object, qualifiers }) {
  if (!subject?.name || !predicate) return null;
  const materialQualifiers = Object.fromEntries(Object.entries(qualifiers || {})
    .filter(([key]) => key !== 'relationships')
    .sort(([a], [b]) => a.localeCompare(b)));
  const signature = JSON.stringify({
    subject: subject.name.toLowerCase(), predicate,
    object: object?.value || materialQualifiers.object || null,
    qualifiers: materialQualifiers,
  });
  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 64);
}

export function adaptiveAtomicMemoryBudget(sourceChars, uniqueCandidateCount = Number.POSITIVE_INFINITY) {
  const chars = Math.max(0, Number(sourceChars) || 0);
  const densityCeiling = chars <= 6_000 ? 12 : chars <= 40_000 ? 30 : 60;
  const candidates = Number.isFinite(Number(uniqueCandidateCount))
    ? Math.max(0, Number(uniqueCandidateCount))
    : densityCeiling;
  return Math.max(3, Math.min(densityCeiling, candidates || 3));
}
// BINARY SNIFF — one definition, used by every tier that might be handed bytes it cannot parse.
// Ratio of NULs and C0 control characters (excluding tab/newline/CR) to total length. A ZIP or PDF
// container runs far above the threshold; UTF-8 prose sits at zero. Deliberately NOT a mime check:
// the failure this exists to stop was a .pptx whose bytes were stringified regardless of its mime.
// Same cleaner as the seam's sanitizeText, defined here because this module must not depend on the
// seam's load order during ingestion. Keep the two in step.
/**
 * Rebuild markdown from docling's HYBRID CHUNKS.
 *
 * `engine=docling-chunks-only` means docling's PARSER failed while its CHUNKER succeeded.
 * That path joined bare `chunk.text` and set `markdown: null` — yet every chunk carries
 * `headings: string[]` (knowledge/enterprise/docling-adapter.js:302), which we already fetch
 * and then threw away. Measured consequence: all 26 chunks-only documents (11 pdf / 8 docx /
 * 5 xlsx / 2 pptx) were indexed with ZERO heading_path, so their citations can only ever say
 * "page 3", never "1. Gesellschaftliche Gründe > Lebensqualität".
 *
 * Same contract as the seam: markdown or NULL, never flat text dressed as markdown. If no
 * chunk carried a heading there is no structure to report and null is the honest answer.
 * Defined here, not imported, for the same load-order reason as the cleaner above.
 */
/**
 * LLM PROFILES — a task's MODEL and its TOKEN BUDGET are ONE decision, so they live in ONE place.
 *
 * Why this exists: these were seven independent env vars with `max_tokens` numbers scattered across
 * the file, each tuned to whichever model was current when that line was written. Swapping the
 * extraction model to deepseek-v4-flash silently invalidated two of them and produced a 100%
 * truncation on the claim-structuring path — `completion=800 finish=length` on EVERY call, JSON never
 * parseable, always falling through to a second model. `finish=length` raises no error; it returns
 * unparseable JSON, so the failure surfaced as a fallback storm and doubled latency, not an exception.
 *
 * The rule encoded here: budgets are sized for the MOST VERBOSE plausible model, never the current
 * one. Headroom is free when a model stops on its own; a truncation is a total loss of that call.
 *
 * Each profile: which env var overrides the model, the default model, its fallback chain, and the
 * budget (a number, or a function of batch size where the output scales with input).
 */
const EXTRACT_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
const FALLBACK_CHAIN_DEFAULT = 'google/gemini-2.5-flash-lite,openai/gpt-oss-120b';

export const LLM_PROFILES = {
  'kb-document-type':     { envModel: 'KB_DOCUMENT_TYPE_MODEL',   maxTokens: 1200 },
  'kb-unified-extract':   { envModel: 'KB_UNIFIED_MODEL',         maxTokens: 4500, compactMaxTokens: 2200 },
  'kb-document-curator':  { envModel: 'KB_UNIFIED_MODEL',         maxTokens: 4000 },
  'kb-doc-summary':       { envModel: 'KB_UNIFIED_MODEL',         maxTokens: 900 },
  'kb-doc-relations':     { envModel: 'KB_UNIFIED_MODEL',         maxTokens: 2000 },
  // Output scales with the batch. Sized for the MOST VERBOSE plausible model, never the
  // current one: measured live, deepseek needs ~300-350 tokens/claim (gpt-oss ~155), so
  // 400 + n*220 truncated EVERY deepseek batch (n=5 hit the 1500 cap, n=9 hit 2380, both
  // finish=length -> unparseable JSON -> fallback storm on every ingest, 2026-08-05).
  // 600 + n*420 keeps deepseek inside budget; the batch is capped (see CLAIM_BATCH_MAX)
  // so the 8000 ceiling is always reachable.
  'v5-claim-structuring': { envModel: 'CLAIM_STRUCTURING_MODEL',  maxTokens: (n) => Math.min(8000, 600 + (n || 1) * 420) },
  'v5-claim-structuring-single': { envModel: 'CLAIM_STRUCTURING_MODEL', maxTokens: 2500 },
};

export function normalizeClaimStructuringRows(parsed, batchLength) {
  const rawRows = Array.isArray(parsed?.claims) ? parsed.claims : (Array.isArray(parsed) ? parsed : []);
  const rowsByIndex = new Map();
  for (const row of rawRows) {
    const rowIndex = Number(row?.i);
    if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > batchLength || rowsByIndex.has(rowIndex)) continue;
    if (typeof row?.subject !== 'string' && typeof row?.predicate !== 'string') continue;
    rowsByIndex.set(rowIndex, row);
  }
  return [...rowsByIndex.values()];
}

/**
 * Resolve a feature's model chain and token budget together.
 * @param {string} feature key in LLM_PROFILES
 * @param {{batchSize?: number, compact?: boolean}} opts
 */
export function llmProfile(feature, opts = {}) {
  const prof = LLM_PROFILES[feature];
  if (!prof) {
    // Fail loudly rather than silently handing back a default budget for an unknown task — a wrong
    // budget is exactly the failure mode this table exists to prevent.
    throw new Error(`llmProfile: no profile for feature '${feature}' — add one to LLM_PROFILES`);
  }
  const model = (prof.envModel && process.env[prof.envModel])
    || process.env.MEMORY_PROCESSOR_MODEL
    || EXTRACT_DEFAULT_MODEL;
  const fallbacks = String(process.env.KB_UNIFIED_FALLBACK_MODELS || FALLBACK_CHAIN_DEFAULT)
    .split(',').map((x) => x.trim()).filter(Boolean)
    // Never list the primary twice: a "fallback" to the same model retries the same weakness.
    .filter((m) => m !== model);
  let maxTokens = (opts.compact && prof.compactMaxTokens) ? prof.compactMaxTokens : prof.maxTokens;
  if (typeof maxTokens === 'function') maxTokens = maxTokens(opts.batchSize);
  return { model, models: [model, ...fallbacks], maxTokens: Number(maxTokens), feature };
}

// A segment's display HEADING, falling back to the last component of its heading_path.
// Measured: 16 of 16 segments carried `heading_path` while only 2 carried `heading`, so the
// «filename : heading» prefix — an explicit owner requirement — appeared on just 2 of 30 memories
// even though the segmentation had the structure all along. heading_path is authoritative and
// inherited; its deepest component IS the heading of that segment ("Kapitel 1 > Preise" -> "Preise").
/**
 * Split page markers out of parser markdown.
 *
 * Page markers are METADATA and must never reach the chunker. Two things break
 * when they stay inline:
 *   1. chunkText() chunks them as CONTENT, so `<!-- page 7 -->` lands inside a
 *      segment's text and gets embedded and shown as evidence.
 *   2. Segments resolve their offset by locating a 60-char prefix in the source
 *      (indexOf). A prefix straddling a marker no longer matches, so the segment
 *      gets startOffset=null — and _pageAt() returns null for a null offset, so
 *      that segment can never be cited to a page at all.
 * Measured on a 15-slide deck when `<!-- page N -->` injection was added:
 * with_page rose 0/9 -> 6/9 but with_offset FELL 7/9 -> 6/9. The markers bought
 * pages and cost an offset.
 *
 * Returns the text with markers removed plus their positions IN THE CLEANED
 * STRING, so the page map and the segment offsets share one coordinate system.
 * Handles both emitters: Docling's `<!-- page N -->` and fast-pdf's `-- N of M --`.
 *
 * @param {string} raw
 * @returns {{ text: string, marks: Array<{at:number, page:number}> }}
 */
export function stripPageMarkers(raw) {
  const input = String(raw || '');
  if (!input) return { text: '', marks: [] };
  // One alternation, one pass — two passes would invalidate the first pass's offsets.
  const RE = /[ \t]*\n?<!--\s*page\s+(\d+)\s*-->[ \t]*\n?|[ \t]*\n?--\s*(\d+)\s+of\s+\d+\s*--[ \t]*\n?/gi;
  let out = '';
  let last = 0;
  const marks = [];
  for (const m of input.matchAll(RE)) {
    const page = Number(m[1] ?? m[2]);
    out += input.slice(last, m.index);
    // NEVER GLUE TWO WORDS TOGETHER. The pattern deliberately absorbs the newline
    // on each side of the marker so a stripped marker leaves no blank line — but
    // on `alpha\n-- 1 of 3 --\nbeta` that removes BOTH newlines and yields
    // "alphabeta", corrupting the text and every embedding derived from it.
    // Re-insert a single separator only when the join would otherwise be
    // word-to-word, so output stays byte-identical wherever whitespace already
    // separated the two sides.
    const prevCh = out.slice(-1);
    const nextCh = input[m.index + m[0].length] || '';
    if (prevCh && nextCh && !/\s/.test(prevCh) && !/\s/.test(nextCh)) out += '\n';
    // Position in the CLEANED string: content following the marker begins here.
    if (Number.isFinite(page) && page > 0) marks.push({ at: out.length, page });
    last = m.index + m[0].length;
  }
  if (!marks.length) return { text: input, marks: [] };
  out += input.slice(last);
  return { text: out, marks };
}

export function segmentHeading(segment) {
  const m = segment?.metadata || {};
  if (m.heading) return String(m.heading);
  const path = m.heading_path;
  const parts = Array.isArray(path)
    ? path
    : (typeof path === 'string' ? path.split('>') : []);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = String(parts[i] || '').trim();
    if (p) return p;
  }
  return null;
}

// Deterministic count of a window's fact-bearing sentences (digits/units/proper
// nouns). Used to FLOOR the per-window extraction ask — a flat chars/1k rate
// under-asks on dense windows and the model delivers conservatively under
// whatever ceiling it is given (told 5 over a 12-fact window -> exactly 5,
// measured live), so the missing facts exist in NO layer. Also used to report
// the shortfall. Language-neutral: no word lists, just scripts and symbols.
export function estimateFactBearingSentences(content) {
  const sentences = String(content || '')
    .split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 25);
  const factBearing = sentences.filter((x) =>
    /\d/.test(x) || /\b(?:kW|kWh|EUR|€|%|Mio|Nr\.)\b/i.test(x) || /\s\p{Lu}\p{Ll}{2,}/u.test(x)).length;
  return { sentences: sentences.length, factBearing };
}

export function markdownFromHeadedChunks(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const out = [];
  let prev = [];
  let emitted = false;
  for (const c of list) {
    const hs = (Array.isArray(c?.headings) ? c.headings : [])
      .filter((h) => typeof h === 'string' && h.trim())
      .map((h) => h.trim());
    // Once an ANCESTOR changes every DESCENDANT must be re-emitted — otherwise a child
    // reusing a name under a new parent (a "Preise" section in a second product chapter)
    // silently inherits the previous parent's heading path.
    let changed = false;
    for (let i = 0; i < hs.length; i += 1) {
      if (changed || hs[i] !== prev[i]) {
        changed = true;
        out.push(`${'#'.repeat(Math.min(6, i + 1))} ${hs[i]}`);
        emitted = true;
      }
    }
    prev = hs;
    const t = String(c?.text || '').trim();
    if (t) out.push(t);
  }
  return emitted ? out.join('\n\n') : null;
}

/**
 * Reconstruct markdown only when parser chunks account for most of the parser's
 * canonical text. A partial chunk list must never replace complete flat text.
 *
 * This is an ingestion-boundary invariant, not a parser-specific workaround:
 * any future tier that returns complete `text` plus incomplete `hybridChunks`
 * will retain the complete text and let semantic segmentation slice it safely.
 */
export function completeChunkMarkdown(fullText, chunks, minCoverage = 0.8) {
  const markdown = markdownFromHeadedChunks(chunks);
  if (!markdown) return { markdown: null, coverage: 0 };
  const visible = (value) => String(value || '').replace(/\s+/g, '');
  const fullLength = visible(fullText).length;
  if (!fullLength) return { markdown, coverage: 1 };
  const deliveredLength = (Array.isArray(chunks) ? chunks : [])
    .reduce((sum, chunk) => sum + visible(chunk?.text).length, 0);
  const coverage = Math.min(1, deliveredLength / fullLength);
  return { markdown: coverage >= minCoverage ? markdown : null, coverage };
}

export function sanitizeSegmentText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\uFFFD/g, '');
}

export function binaryRatio(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  let bad = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xFFFD) bad += 1;
  }
  return bad / s.length;
}
export function looksBinary(text, threshold = Number(process.env.KB_BINARY_RATIO_THRESHOLD || 0.02)) {
  return binaryRatio(text) > threshold;
}

const INTRA_WINDOW_REL_TYPES = ['Extends', 'Mentions', 'Contradicts', 'Updates', 'Derives'];
// Derives is INFERRED: it gets metadata.inferred=true at write time, is barred from
// grounded citation, and must never drive supersession — an inferred fact cannot
// replace an observed one.

function safeDocumentType(value) {
  const type = String(value || '').toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return type || 'general';
}

async function classifyKnowledgeDocument(text, filename) {
  const preview = String(text || '').slice(0, 6000).trim();
  if (!preview) return { type: 'general', confidence: 0.1 };
  try {
    const model = process.env.KB_DOCUMENT_TYPE_MODEL || process.env.MEMORY_FAST_MODEL || memoryLLMRoute()?.model || 'deepseek/deepseek-v4-flash-0731';
    const parsed = await chatCompletion({
      // 256 -> 1200. Same trap as v5-claim-structuring: this budget was tuned to gpt-oss, and
      // deepseek emits many more tokens for the same tiny JSON, so 256 truncates it and the parse
      // fails. The output is one {type, confidence} object; headroom is free when the model stops on
      // its own. A model swap must re-check every token budget that was sized for the old model.
      ...(() => { const _p = llmProfile('kb-document-type'); return { model: _p.model, max_tokens: _p.maxTokens }; })(),
      temperature: 0, json_mode: true, feature: 'kb-document-type',
      messages: [{ role: 'system', content: 'Classify this document. Return only JSON: {"type":"short_lowercase_snake_case_label","confidence":0.0}. Use a specific type such as payment_record, invoice, contract, meeting_notes, policy, contact_list, report, spreadsheet, or general. Do not use the filename as the type unless content supports it.' }, { role: 'user', content: `Filename: ${filename || 'unknown'}\n\n${preview}` }],
    });
    const confidence = Number(parsed.confidence);
    return { type: safeDocumentType(parsed.type), confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.3 };
  } catch (error) {
    ingestDiagnostic.warn(`[kb-ingest] document type classification unavailable: ${error.message}`);
    return { type: 'general', confidence: 0.2 };
  }
}

function durableTitle(title, content, max = 80) {
  const value = String(title || '').trim();
  const languageCodeOnly = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(value);
  return value && !languageCodeOnly && !isGarbageTitle(value)
    ? value.slice(0, max)
    : cleanTitleFrom(content, Math.min(max, 64));
}

function durableEntities(entities) {
  // Accepts a bare name or a TYPED pair ({n,k} from the extractor, {name,kind} internally) and
  // ALWAYS returns typed pairs. This used to require `typeof entity === 'string'`, which silently
  // discarded every typed entity the extractor produced — the kind never reached the persister and
  // every canonical row stayed entity_kind='entity'. A filter that drops the richer shape is how the
  // whole typing chain died without one log line.
  return (Array.isArray(entities) ? entities : [])
    .map((e) => {
      if (typeof e === 'string') return { name: e.trim(), kind: null };
      if (e && typeof e === 'object') {
        const name = typeof e.name === 'string' ? e.name : (typeof e.n === 'string' ? e.n : null);
        const kind = e.kind || e.k || null;
        return name ? { name: String(name).trim(), kind } : null;
      }
      return null;
    })
    .filter((e) => e && e.name)
    // Measurements, percentages, and dates are values on claims, not graph
    // identities. This language-agnostic structural gate drops numeric-led
    // phrases without maintaining a domain dictionary.
    .filter((e) => /^\p{L}/u.test(e.name))
    .slice(0, 8);
}

// Build a regex that matches `quote` inside the section tolerant of the
// formatting drift a model introduces while copying verbatim — the dominant one,
// measured on real German uploads, being a hard line-wrap re-rendered as a space
// ("...klein und\nergänzt..." vs "...klein und ergänzt..."). Byte-exact
// `content.includes(quote)` returns false on that pair and the fact was dropped
// with no log line. This tolerates whitespace runs (\s+) and the interchangeable
// Unicode dash/quote variants; it can only MERGE characters that already exist,
// never invent a match, so an ungrounded (hallucinated) quote still fails to
// match and is still rejected — the grounding guarantee is intact.
function driftTolerantQuotePattern(quote) {
  const DASH = '[-\\u2010-\\u2015\\u2212]';
  const SQUOTE = "['\\u2018\\u2019\\u201A\\u201B\\u2032]";
  const DQUOTE = '["\\u201C\\u201D\\u201E\\u201F\\u2033]';
  let out = '';
  let inWs = false;
  for (const ch of String(quote)) {
    if (/\s/u.test(ch)) { if (!inWs) { out += '\\s+'; inWs = true; } continue; }
    inWs = false;
    if (ch === '­') continue; // soft hyphen: strip
    if (/[-‐-―−]/u.test(ch)) out += DASH;
    else if (/['‘’‚‛′]/u.test(ch)) out += SQUOTE;
    else if (/["“”„‟″]/u.test(ch)) out += DQUOTE;
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

// Locate a model source_quote inside the section. Returns { start, quote } where
// `start` is the RAW offset into `content` and `quote` is the ACTUAL bytes at that
// span (so citations point at real document text, not the model's re-wrapped copy),
// or { start: -1 } when the quote is genuinely absent (ungrounded → drop it).
export function locateSourceQuote(content, quote) {
  if (typeof content !== 'string' || typeof quote !== 'string') return { start: -1, quote };
  const exact = content.indexOf(quote);
  if (exact !== -1) return { start: exact, quote }; // fast path, no repair needed
  let pattern;
  try { pattern = driftTolerantQuotePattern(quote); } catch { return { start: -1, quote }; }
  if (!pattern || pattern.length < 4) return { start: -1, quote };
  let match = null;
  try { match = new RegExp(pattern, 'iu').exec(content); } catch { return { start: -1, quote }; }
  if (match && typeof match.index === 'number' && match[0]) {
    return { start: match.index, quote: match[0] }; // repair to real bytes from the section
  }
  return { start: -1, quote };
}

export function normalizeUnifiedClaims(rawFacts, content, maxFacts, minImportance = 0) {
  const threshold = Number.isFinite(Number(minImportance))
    ? Math.max(0, Math.min(1, Number(minImportance)))
    : 0;
  const normalizedImportance = (value) => {
    const rated = Number(value);
    return Number.isFinite(rated) && rated > 0
      ? Math.max(0.1, Math.min(1, Number(rated.toFixed(3))))
      : 0.55;
  };
  const arr = Array.isArray(rawFacts) ? rawFacts : [];
  // Per-condition drop counters. The old single AND-ed .filter() dropped facts
  // with no record of WHICH condition fired — "0 facts" had seven silent causes.
  // Name the cause so a future zero-fact window is diagnosable from one log line.
  // `capped` is NOT a rejection — it is the per-window fact cap doing its job.
  // It still has to be counted: without it the loop breaks at the cap and every
  // remaining fact lands in `dropped` with all reason counters at zero, which is
  // what these counters exist to prevent. Observed live on a real upload as
  // "in=24 kept=9 dropped=15{quote_absent:0 type:0 ... low_importance:0}" — a
  // number with no explanation, exactly the silent drop this instrumentation was
  // added to eliminate.
  const drop = { shape: 0, type: 0, short_quote: 0, quote_absent: 0, noise: 0, low_importance: 0, capped: 0 };
  let repaired = 0;
  // SELECT THE MOST SALIENT N, NOT THE FIRST N.
  // This used to `break` at the cap, so it kept whichever facts the model happened
  // to emit first — document order, not importance — and discarded the rest
  // unseen (measured: in=24 kept=9, fifteen claims never even evaluated). A cap is
  // the right lever, because memories are meant to be curated rather than
  // exhaustive and the full text stays searchable as evidence; but the SELECTION
  // rule has to be salience or the graph keeps whatever came first.
  //
  // Every candidate is now validated, then the survivors are ranked by importance
  // and the top N taken, then RESTORED TO DOCUMENT ORDER so the narrative reads in
  // sequence. Safe only because rel indices are remapped below — before that,
  // changing which facts survive silently mis-wired intra-window relationships.
  const _valid = [];
  for (let _i = 0; _i < arr.length; _i += 1) {
    const item = arr[_i];
    if (!item || typeof item.f !== 'string' || item.f.trim().length < 4) { drop.shape += 1; continue; }
    const rawMemoryType = String(item.memory_type || '').trim().toLowerCase();
    // `relationship` is a legacy graph-edge label, never a durable memory. The
    // general taxonomy normalizer maps unknown KB labels to `fact` for legacy
    // read compatibility, so reject this one before that fallback can promote it.
    if (rawMemoryType === 'relationship') { drop.type += 1; continue; }
    const kbMemoryType = normalizeKbMemoryType(item.memory_type);
    if (!DURABLE_EXTRACT_TYPES.includes(kbMemoryType)) { drop.type += 1; continue; }
    if (typeof item.source_quote !== 'string' || item.source_quote.length < 4) { drop.short_quote += 1; continue; }
    if (isStructuredSourceNoise(item.f) || isStructuredSourceNoise(item.source_quote)) { drop.noise += 1; continue; }
    const loc = locateSourceQuote(content, item.source_quote);
    if (loc.start === -1) { drop.quote_absent += 1; continue; } // ungrounded → reject (anti-hallucination)
    if (loc.quote !== item.source_quote) repaired += 1;
    // The source remains recallable even when its claim is not durable enough.
    if (normalizedImportance(item.importance) < threshold) { drop.low_importance += 1; continue; }
    _valid.push({
      _oldIdx: _i,
      t: durableTitle(item.t, item.f),
      f: item.f.trim(),
      memory_type: kbMemoryType,
      claim_kind: KB_CLAIM_KINDS.has(String(item.claim_kind || '').toLowerCase())
        ? String(item.claim_kind).toLowerCase()
        : kbMemoryType,
      source_quote: loc.quote,
      source_start: loc.start,
      source_end: loc.start + loc.quote.length,
      importance: normalizedImportance(Number(item.importance)),
      entities: durableEntities(item.entities),
      ...normalizeClaimStructure(item),
      rels: (Array.isArray(item.rels) ? item.rels : [])
        .filter((rel) => rel && Number.isInteger(rel.to) && INTRA_WINDOW_REL_TYPES.includes(rel.type)).slice(0, 5),
    });
  }
  // Rank by importance, take the cap, then restore document order.
  // The importance sort is made STABLE by falling back to the original index, so
  // an all-equal-importance window (a real case — the extractor often returns a
  // flat 0.55) degrades to exactly the old prefix behaviour instead of an
  // arbitrary reshuffle.
  let _selected = _valid;
  if (_valid.length > maxFacts) {
    _selected = _valid
      .slice()
      .sort((a, b) => (b.importance - a.importance) || (a._oldIdx - b._oldIdx))
      .slice(0, maxFacts)
      .sort((a, b) => a._oldIdx - b._oldIdx);
    drop.capped = _valid.length - _selected.length;
  }
  const _keptOldIdx = _selected.map((x) => x._oldIdx); // for the rel remap below
  const out = _selected.map(({ _oldIdx, ...fact }) => fact);
  // REMAP INTRA-WINDOW RELATIONSHIP INDICES.
  // `rels[].to` is a POSITION in the model's own fact array, and the promoter
  // resolves it positionally against the SURVIVING facts (idByIdx[rel.to]). Any
  // fact dropped from the MIDDLE of the array therefore shifts every later fact
  // down one slot, and each surviving rel silently points at the wrong memory —
  // a real mis-wiring, not a missing edge. Live logs show this happening:
  // "in=8 kept=3 dropped=5{quote_absent:2 ...}". A prefix cap alone was safe
  // (survivors keep their positions), which is why it went unnoticed.
  // Translate old index -> new index, and drop any rel whose target did not
  // survive rather than let it resolve to a neighbour.
  const _newByOld = new Map(_keptOldIdx.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  let _relsDropped = 0;
  for (const item of out) {
    const before = item.rels.length;
    item.rels = item.rels
      .map((rel) => ({ ...rel, to: _newByOld.has(rel.to) ? _newByOld.get(rel.to) : -1 }))
      .filter((rel) => rel.to >= 0);
    _relsDropped += before - item.rels.length;
  }
  const dropped = arr.length - out.length;
  if (dropped > 0 || repaired > 0) {
    const _accounted = drop.quote_absent + drop.type + drop.short_quote + drop.noise
      + drop.shape + drop.low_importance + drop.capped;
    ingestDiagnostic.info(`[kb-normalize] in=${arr.length} kept=${out.length} repaired=${repaired} `
      + `dropped=${dropped}{quote_absent:${drop.quote_absent} type:${drop.type} `
      + `short_quote:${drop.short_quote} noise:${drop.noise} shape:${drop.shape} `
      + `low_importance:${drop.low_importance} capped:${drop.capped}}`
      // Self-check: if the buckets ever stop summing to the total, the log is
      // lying about why facts vanished. Say so rather than let it slide.
      + (_accounted !== dropped ? ` UNACCOUNTED=${dropped - _accounted}` : ''));
  }
  return out;
}

/** Split a provider-truncated extraction window at a real structural boundary. */
export function splitDenseExtractionContent(value, minPartChars = 320) {
  const content = String(value || '').trim();
  if (content.length < minPartChars * 2) return [];
  const midpoint = Math.floor(content.length / 2);
  const low = Math.max(minPartChars, Math.floor(content.length * 0.3));
  const high = Math.min(content.length - minPartChars, Math.ceil(content.length * 0.7));
  const boundaries = [];
  const addMatches = (pattern) => {
    for (const match of content.matchAll(pattern)) {
      const at = Number(match.index) + match[0].length;
      if (at >= low && at <= high) boundaries.push(at);
    }
  };
  addMatches(/\n\s*\n/gu);
  if (!boundaries.length) addMatches(/(?<=[.!?。！？])\s+/gu);
  if (!boundaries.length) addMatches(/\s+/gu);
  if (!boundaries.length) return [];
  const at = boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
  const left = content.slice(0, at).trim();
  const right = content.slice(at).trim();
  return left.length >= minPartChars && right.length >= minPartChars ? [left, right] : [];
}

export function resolveEvidenceSegment(sourceQuote, segments, fallbackId = null) {
  const quote = String(sourceQuote || '').trim();
  if (!quote) return fallbackId;
  const list = Array.isArray(segments) ? segments : [];
  // Same byte-exact bug as normalizeUnifiedClaims: a quote spanning a re-wrapped
  // line failed to bind to its segment. Exact fast-path first; then the
  // whitespace/unicode-tolerant locate so evidence still binds under formatting drift.
  const exact = list.find((segment) =>
    typeof segment?.content === 'string' && segment.content.includes(quote));
  if (exact) return exact.id || fallbackId;
  const drift = list.find((segment) =>
    typeof segment?.content === 'string' && locateSourceQuote(segment.content, quote).start !== -1);
  return drift?.id || fallbackId;
}

// Canonical V5 Phase 4 — coverage-aware curation ledger. Attaches (non-breaking,
// as an array property) which source candidates were PROMOTED vs OMITTED and why,
// so a high-importance claim can never silently vanish: every omitted candidate is
// recorded with a reason + its importance. Callers surface this in
// CanonicalIngestResult.coverage. Deterministic, language-neutral (segment-id set
// membership, no content parsing).
export function attachCoverageLedger(curatedOutput, pool) {
  try {
    const promotedSegIds = new Set();
    for (const m of (curatedOutput || [])) for (const sid of (m?.support_segment_ids || [])) promotedSegIds.add(sid);
    const omitted = [];
    let highValueOmitted = 0;
    for (const c of (pool || [])) {
      if (!promotedSegIds.has(c.segmentId)) {
        const imp = Number(c.importance || 0);
        if (imp >= 0.7) highValueOmitted += 1;
        omitted.push({ candidate_id: c.segmentId, reason: imp >= 0.7 ? 'high_value_omitted_by_curator' : 'low_salience_or_merged', importance: imp });
      }
    }
    const candidates = (pool || []).length;
    const promoted = candidates - omitted.length;
    Object.defineProperty(curatedOutput, '_coverage', {
      value: {
        candidates, promoted, merged: 0, omitted, rejected: [],
        highValueCoverage: candidates > 0 ? Number((promoted / candidates).toFixed(3)) : 1,
        highValueOmitted,
      },
      enumerable: false, writable: true, configurable: true,
    });
  } catch { /* ledger is best-effort observability — never block ingestion */ }
  return curatedOutput;
}

export function normalizeCuratedClaims(rawMemories, candidates, maxMemories = 8) {
  const pool = Array.isArray(candidates) ? candidates : [];
  const cap = Math.max(1, Math.min(60, Number(maxMemories) || 8));
  const output = [];
  for (const memory of (Array.isArray(rawMemories) ? rawMemories : []).slice(0, cap)) {
    const indices = [...new Set((memory?.support_indices || []).map(Number))]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < pool.length);
    if (!indices.length) continue;
    const rawMemoryType = String(memory?.memory_type || '').trim().toLowerCase();
    if (rawMemoryType === 'relationship') continue;
    const kbMemoryType = normalizeKbMemoryType(memory?.memory_type);
    if (!KB_CURATED_TYPES.includes(kbMemoryType)) continue;
    const supports = indices.map((index) => pool[index]).filter((item) => item?.segmentId && item?.source_quote);
    if (!supports.length) continue;
    const primary = supports[0];
    const content = String(memory.content || '').trim();
    if (content.length < 12) continue;
    const importance = Math.max(...supports.map((item) => Number(item.importance || 0.5)));
    const structured = normalizeClaimStructure(memory, supports.length === 1 ? supports[0] : {});
    output.push({
      t: durableTitle(memory.title || primary.t, content),
      f: content,
      memory_type: kbMemoryType,
      claim_kind: KB_CLAIM_KINDS.has(String(memory.claim_kind || primary.claim_kind || '').toLowerCase())
        ? String(memory.claim_kind || primary.claim_kind).toLowerCase()
        : kbMemoryType,
      importance: Math.max(0.65, Math.min(1, importance)),
      // Canonical entities come only from exact-span extraction. The curator
      // may merge claims but cannot introduce a new graph identity.
      // Dedupe by kind::name. durableEntities now returns typed pairs, and a Set of OBJECTS dedupes
      // by REFERENCE — every merged candidate would have contributed a duplicate of the same entity.
      entities: (() => {
        const seen = new Map();
        for (const e of supports.flatMap((item) => durableEntities(item.entities))) {
          const key = `${e.kind || ''}::${e.name.toLowerCase()}`;
          if (!seen.has(key)) seen.set(key, e);
        }
        return [...seen.values()].slice(0, 12);
      })(),
      ...structured,
      rels: [],
      // FORWARD THE HEADING. This explicit field list rebuilt each claim and dropped `heading`,
      // so the «filename : heading» prefix was empty no matter what the extractor or window
      // supplied — the reason two earlier attempts at this changed nothing. Curation merges
      // several candidates, so the PRIMARY support's heading is the claim's heading.
      heading: primary.heading || supports.find((it) => it?.heading)?.heading || null,
      segmentId: primary.segmentId,
      source_quote: primary.source_quote,
      source_start: primary.source_start,
      source_end: primary.source_end,
      support_segment_ids: [...new Set(supports.map((item) => item.segmentId))],
      support_quotes: supports.map((item) => item.source_quote),
      source_window_content: primary.source_window_content || null,
    });
  }
  return output;
}

// ── KB content-quality gates (P3) ─────────────────────────────────────────
// Magazines/brochures produce page furniture that Docling faithfully extracts:
// imprints, mastheads, photo credits, page headers, tables of contents. None of
// it is memory-worthy, and promoting it verbatim was the #1 source of "random
// fragment" memories (hauspost case). Deterministic regex — no LLM cost.
const BOILERPLATE_RES = [
  /\bimpressum\b/i,
  /\bherausgeber(?:in)?\b/i,
  /\bv\.?\s?i\.?\s?s\.?\s?d\.?\s?p\.?\b/i,                  // V.i.S.d.P. (German press law)
  /\b(?:redaktion|layout|gestaltung|satz|druck(?:erei)?|auflage|erscheinungsweise)\s*[:\n]/i,
  /\bfotos?\s*\/?\s*grafiken\b/i,
  /\b(?:bildnachweis|fotonachweis|titelbild|titelfoto)\b/i,
  /\bmarkenagentur\b/i,
  /\binhaltsverzeichnis\b|\btable of contents\b/i,
  /\b(?:bilder|fotos?|kartendaten)\s*©/i,                          // map/photo credit lines
  /©\s*\d{4}\s*(?:TerraMetrics|GeoBasis|GeoContent)/i,
  /(?:\.{3,}\s*\d{1,3}\s*){2,}/,                                   // dotted ToC leaders "..... 12"
  /^\s*\d+\s+\d+\s+[A-ZÄÖÜ //]+\s*$/m,                           // page-header rows "4 5 FLURFUNK //"
];

// Page-furniture headings ("5 4 FLURFUNK // hauspost 1/2021") are real article
// containers — keep the SEGMENT, but never use the furniture as the TITLE.
function isPageFurnitureHeading(heading) {
  const h = (heading || '').trim();
  if (!h) return false;
  return /^\d+\s+\d+/.test(h) || /\/\/\s*hauspost/i.test(h) || /hauspost\s+\d\s*\/\s*\d{2,4}/i.test(h);
}

// Strip repeated running headers/footers (page furniture) that recur across
// many segments — e.g. a logo/slogan line or the doc title printed on every
// page. Frequency-based + language/tenant-agnostic (NO hardcoded strings): a
// short line appearing in >=40% of segments (min 3) is furniture. Mutates the
// IN-MEMORY segments used for the MEMORY layer (titles/distill/embeddings) only
// — the persisted evidence segments stay verbatim. Without this, the running
// header becomes line 1 of every segment → identical titles + polluted vectors.
function stripRepeatedFurniture(segments) {
  if (!Array.isArray(segments) || segments.length < 4) return;
  const norm = (l) => l.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const freq = new Map();
  for (const s of segments) {
    const seen = new Set(
      String(s.content || '').split(/\r?\n/).map(norm).filter((l) => l && l.length <= 120)
    );
    for (const l of seen) freq.set(l, (freq.get(l) || 0) + 1);
  }
  const floor = Math.max(3, Math.ceil(segments.length * 0.4));
  const furniture = new Set([...freq.entries()].filter(([, c]) => c >= floor).map(([l]) => l));
  if (furniture.size === 0) return;
  for (const s of segments) {
    const kept = String(s.content || '').split(/\r?\n/).filter((l) => !furniture.has(norm(l)));
    s.content = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (s.metadata?.heading && furniture.has(norm(s.metadata.heading))) {
      s.metadata = { ...s.metadata, heading: null };
    }
  }
}

function isBoilerplateSegment(content, heading) {
  const text = `${heading || ''}\n${content || ''}`;
  if (BOILERPLATE_RES.some((re) => re.test(text))) return true;
  // Page-furniture heading like "4 5 FLURFUNK // hauspost 2/2022"
  if (/hauspost\s+\d\s*\/\s*\d{2,4}/i.test(heading || '') && (content || '').length < 400) return true;
  return false;
}

// A promotable segment must read like prose, not a fragment / credit line /
// number run. Cheap deterministic checks only.
function isQualityContent(content) {
  const text = (content || '').trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 15) return false;                                // fragments
  const letters = (text.match(/[\p{L}]/gu) || []).length;
  if (letters / Math.max(1, text.length) < 0.55) return false;        // number/symbol runs
  // Sentence-like: at least one terminator mid-text, or long-enough flowing prose
  if (!/[.!?…](\s|$)/.test(text) && text.length < 160) return false;
  // SHOUTING headers / collage of uppercase display text
  const upperTokens = words.filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-ZÄÖÜ]/.test(w)).length;
  if (upperTokens / words.length > 0.5) return false;
  return true;
}

// First-sentence title that NEVER cuts mid-word (the old slice(0,80) produced
// titles like "Um weiterhin attraktiven Wohnraum z").
// Detect letter-spaced OCR garbage ("S O L V I S G E M E I N W O H L") — the
// page-header furniture scanned PDFs emit on every page. When an LLM picks one
// as a fact title it pollutes recall (matches on the spaced glyphs, outranks
// real facts). True when most whitespace tokens are single glyphs.
function isGarbageTitle(t) {
  if (!t || typeof t !== 'string') return true;
  const s = t.trim();
  if (s.length < 2) return true;
  const toks = s.split(/\s+/).filter(Boolean);
  if (toks.length >= 5) {
    const singles = toks.filter((w) => w.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').length <= 1).length;
    if (singles / toks.length >= 0.6) return true;
  }
  return false;
}

function cleanTitleFrom(text, max = 80) {
  const raw = (text || '').trim();
  // Skip leading OCR page-furniture lines — use the first line/sentence that is
  // real prose, not letter-spaced glyphs, so the fallback title is meaningful.
  const segments = raw.split(/\n|(?<=[.!?])\s/).map((s) => s.trim()).filter(Boolean);
  const first = segments.find((s) => !isGarbageTitle(s)) || segments[0] || '';
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const atWord = cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max);
  return `${atWord.trim()}…`;
}

// Tolerant JSON-array extraction — gpt-oss models don't honor response_format,
// so pull the first balanced [...] from the completion text.
function extractJsonArray(text) {
  if (!text) return [];
  const start = text.indexOf('[');
  if (start === -1) return [];
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return []; } } }
  }
  return [];
}


// Path-safety for anything derived from a user-supplied filename. The upload
// route accepts an arbitrary multipart filename, and while the file WRITER
// already sanitises before touching disk (verified: "../../../etc/passwd"
// landed as ".._.._.._etc_passwd" and /etc/passwd was untouched), the recorded
// storageLocation kept the raw string:
//     kb/<user>/<sha>/../../../etc/passwd
// The write path was safe; the stored path was poisoned. Any later reader that
// resolves storageLocation — download, re-extract, export — would traverse out
// of the tenant directory. Sanitise at the point of RECORD so the stored value
// can never disagree with what is on disk.
function safePathSegment(name) {
  return String(name || 'file')
    .replace(/[\\/]/g, '_')      // path separators, both flavours
    .replace(/\.\./g, '_')        // parent-directory hops
    .replace(/^[.\s]+/, '')       // leading dots/space (hidden files, ". ." tricks)
    .replace(/[\u0000-\u001f]/g, '') // control bytes incl. NUL truncation
    .slice(0, 255) || 'file';
}

export class DocumentFirstIngestionService {
  constructor({ db, smartIngestRouter, memoryGraphEngine, doclingAdapter, embeddingService, entityExtractor = null, topicStateWriter = null, logger = console }) {
    this.db = db;
    this.smartIngestRouter = smartIngestRouter;
    this.memoryGraphEngine = memoryGraphEngine;
    this.doclingAdapter = doclingAdapter;
    this.embeddingService = embeddingService;
    this.entityExtractor = entityExtractor;
    this.topicStateWriter = topicStateWriter;
    this.logger = createIngestDiagnosticLogger(logger);
    // Collapse simultaneous first uploads of the same bytes into one pipeline.
    // Database constraints protect rows across processes; this prevents callers
    // in one process from racing before the unchanged-document check is visible.
    this.documentIngestFlights = new Map();
    this.entityExtractionFlights = new Map();
    this.cancelledEntityDocuments = new Set();
  }

  /** Fire-and-forget entity extraction over segments (P1 #9).
   *  Parallel workers — bound by ENTITY_EXTRACT_CONCURRENCY (default 6). */
  _extractEntitiesAsync({ segments, userId, orgId, documentId, force = false }) {
    if (!this.entityExtractor || process.env.ENABLE_ENTITY_EXTRACTION !== 'true') return null;
    // Skip entity extraction on tiny docs (single short segment) — no real value.
    const totalChars = segments.reduce((acc, s) => acc + (s.content?.length || 0), 0);
    if (!force && segments.length <= 2 && totalChars < 1500) {
      this.logger.info?.(`[entity-extractor] skipping tiny doc ${documentId} (${segments.length} segs, ${totalChars} chars)`);
      return null;
    }
    const CONCURRENCY = Number(process.env.ENTITY_EXTRACT_CONCURRENCY || 6);
    const flight = (async () => {
      let i = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, segments.length) }, async () => {
        while (true) {
          if (this.cancelledEntityDocuments.has(documentId)) return;
          const idx = i++;
          if (idx >= segments.length) return;
          const segment = segments[idx];
          try {
            await this.entityExtractor.extractFromSegment({
              segment, userId, orgId, documentId,
              shouldContinue: () => !this.cancelledEntityDocuments.has(documentId),
            });
          } catch (err) {
            this.logger.warn(`[entity-extractor] segment ${segment.id} failed: ${err.message}`);
          }
        }
      });
      await Promise.all(workers);
    })().catch(err => this.logger.warn(`[entity-extractor] batch failed: ${err.message}`))
      .finally(() => {
        if (this.entityExtractionFlights.get(documentId) === flight) this.entityExtractionFlights.delete(documentId);
        this.cancelledEntityDocuments.delete(documentId);
      });
    this.entityExtractionFlights.set(documentId, flight);
    return flight;
  }

  async cancelDocumentEnrichment(documentId, { waitMs = 5000 } = {}) {
    if (!documentId) return;
    this.cancelledEntityDocuments.add(documentId);
    const flight = this.entityExtractionFlights.get(documentId);
    if (!flight) return;
    await Promise.race([
      flight,
      new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(waitMs) || 0))),
    ]);
  }

  _extractPromotedEntitiesAsync({ memories, userId, orgId, documentId }) {
    const segments = (Array.isArray(memories) ? memories : [])
      .filter((memory) => memory?.id && memory?.content && !memory.isParent && memory.support_segment_ids?.[0])
      .map((memory) => ({
        id: memory.support_segment_ids[0],
        content: memory.content,
      }));
    this._extractEntitiesAsync({ segments, userId, orgId, documentId, force: true });
  }
  /**
   * V5 Phase 3 — async claim structuring (OFF the save hot path → zero added
   * latency). For committed memories, extract normalized {subject, predicate,
   * qualifiers} with a multilingual LLM and backfill the claim_* columns so
   * dreaming / clustering / graph intelligence have structured claim identity.
   * Language-agnostic (the model reads any language; we store canonical English
   * subject/predicate for cross-language clustering). Robust: fire-and-forget,
   * bounded concurrency, per-memory failure isolation, never blocks or fails a
   * save. Flag V5_CLAIM_STRUCTURING (default on). NOT wired to destructive dedup
   * (safe — enrichment only).
   */
  _structureClaimsAsync({ memories, orgId }) {
    if ((process.env.V5_CLAIM_STRUCTURING || 'true').toLowerCase() === 'false') return;
    const store = this.memoryGraphEngine?.store;
    if (!store?.updateMemory) return;
    const targets = (Array.isArray(memories) ? memories : [])
      .filter((m) => m?.id && typeof m.content === 'string' && m.content.trim().length >= 12)
      // Unified ingestion now obtains claim identity in the existing extraction
      // call. Only legacy/unstructured rows need this asynchronous repair call.
      .filter((m) => !m.claim_subject || !m.claim_predicate)
      .slice(0, 24);
    if (!targets.length) return;
    const model = process.env.CLAIM_STRUCTURING_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'deepseek/deepseek-v4-flash-0731';
    // BATCHED: ONE call for up to 24 memories, was one call PER memory.
    // This was the last per-item LLM fan-out in ingestion. Everything else is already 1-per-document
    // or 1-per-section-batch (kb-unified-extract returns facts AND entities together; kb-doc-relations
    // batches 40 candidate pairs into a single call). A 25-memory document therefore issued ~24 tiny
    // requests here — the flood of 500-1000-token calls visible in every ingest log, and the ones that
    // truncated at 86% after the model swap. The output per memory is a tiny
    // {subject, predicate, qualifiers}; 24 of them fit comfortably in one response.
    // Kept post-commit and fire-and-forget, exactly as V5 designed it: this runs on the FINAL memory
    // text, after atomic splitting, curation, dedup and prefix stamping, so it cannot be folded into
    // the extraction call — at that point these memories do not exist yet, and one extracted fact can
    // become several memories.
    const SINGLE_SYSTEM = `Extract the core CLAIM structure from one memory sentence, in ANY language.
Return ONLY JSON: {"subject":"<canonical English noun phrase of what the claim is ABOUT>","predicate":"<canonical English relation/attribute, lowercased>","qualifiers":{"<key>":"<value>"}}.
subject+predicate identify the claim across paraphrases and languages. Keep values short. If nothing durable, return empty strings.`;
    const system = `Extract the core CLAIM structure for EACH numbered memory below, in ANY language.
Return ONLY JSON: {"claims":[{"i":<the memory's number>,"subject":"<canonical English noun phrase of what the claim is ABOUT>","predicate":"<canonical English relation/attribute, lowercased, e.g. has_launch_date, rated_power, is_partner_of>","qualifiers":{"<key>":"<value>"}}, ...]}.
Emit one entry per input memory, using its exact number in "i". subject+predicate identify the claim across paraphrases and languages (normalize to English + lowercase). qualifiers holds scope/conditions/owner/time as key-value. Keep values short. For a memory with nothing durable, return empty strings for subject and predicate.`;
    (async () => {
      // Sub-batch so the profile budget (600 + n*420, capped 8000) is always reachable:
      // 17 x 420 = 7740 < 8000. One 24-claim batch would need >10k completion with the
      // verbose model — a guaranteed finish=length truncation, i.e. a guaranteed
      // fallback. Numbering restarts per sub-batch; "i" maps within the batch only.
      const BATCH_MAX = Math.max(1, Number(process.env.CLAIM_STRUCTURING_BATCH_MAX || 17));
      for (let b = 0; b < targets.length; b += BATCH_MAX) {
      const batch = targets.slice(b, b + BATCH_MAX);
      try {
        const numbered = batch
          .map((m, idx) => `${idx + 1}. ${String(m.content).slice(0, 800)}`)
          .join('\n\n');
        const parsed = await chatCompletionWithFallback({
          models: [model, ...(process.env.KB_UNIFIED_FALLBACK_MODELS
      || 'google/gemini-2.5-flash-lite,openai/gpt-oss-120b')
            .split(',').map((x) => x.trim()).filter(Boolean)],
          // Scales with the sub-batch and sized for the most verbose plausible model
          // (deepseek ~300-350/claim vs gpt-oss ~155, measured) — see LLM_PROFILES.
          temperature: 0,
          max_tokens: llmProfile('v5-claim-structuring', { batchSize: batch.length }).maxTokens,
          json_mode: true, feature: 'v5-claim-structuring',
          messages: [{ role: 'system', content: system }, { role: 'user', content: numbered }],
        });
        // Truncation salvage can expose nested qualifier objects alongside the
        // top-level claim rows. Accept at most one structurally valid row per
        // input index; otherwise one memory may be overwritten repeatedly by
        // unrelated nested objects (observed as "1 memories -> 18 structured").
        const rows = normalizeClaimStructuringRows(parsed, batch.length);
        let applied = 0;
        const structured = [];
        for (const row of rows) {
          // Map back by the model's index. A missing or out-of-range "i" is skipped rather than
          // guessed — writing a claim onto the WRONG memory would corrupt supersession, which keys on
          // (subject, predicate). Silence is recoverable; a mis-assigned claim identity is not.
          const idx = Number(row?.i) - 1;
          const m = Number.isInteger(idx) && idx >= 0 && idx < batch.length ? batch[idx] : null;
          if (!m) continue;
          const subj = typeof row?.subject === 'string' ? row.subject.trim().slice(0, 500) : '';
          const pred = typeof row?.predicate === 'string' ? row.predicate.trim().toLowerCase().slice(0, 500) : '';
          if (!subj && !pred) continue;
          const quals = (row && typeof row.qualifiers === 'object' && !Array.isArray(row.qualifiers)) ? row.qualifiers : undefined;
          const patch = {};
          if (subj) patch.claimSubject = subj;
          if (pred) patch.claimPredicate = pred;
          if (quals && Object.keys(quals).length) patch.claimQualifiers = quals;
          if (!Object.keys(patch).length) continue;
          // Per-memory isolation preserved: one bad row must not abort the rest of the batch.
          try {
            if (await applyClaimPatchIfLive(store, m.id, patch)) {
              applied += 1;
              structured.push(m.id);
            }
          } catch { /* enrichment only */ }
        }
        // VERIFY THE BATCH, THEN BACKFILL WHAT IT MISSED. Batching trades one risk for another: a
        // capped or truncated response returns FEWER claims than memories, and without a check those
        // memories would silently lose claim identity — the same silent-partial shape as the tail
        // drop. So coverage is verified against the input, and any memory the batch did not cover is
        // re-requested individually. The 1-call win holds in the common case; correctness does not
        // depend on the batch being complete.
        const covered = new Set(structured);
        const missed = batch.filter((m) => !covered.has(m.id));
        if (missed.length) {
          this.logger.warn?.(`[v5-claim-structuring] batch covered ${applied}/${batch.length}`
            + ` — re-requesting ${missed.length} individually (batch likely capped)`);
          let mi = 0;
          const CONC = Number(process.env.CLAIM_STRUCTURING_CONCURRENCY || 4);
          const workers = Array.from({ length: Math.min(CONC, missed.length) }, async () => {
            while (true) {
              const k = mi++;
              if (k >= missed.length) return;
              const m = missed[k];
              try {
                const one = await chatCompletionWithFallback({
                  models: [model, ...(process.env.KB_UNIFIED_FALLBACK_MODELS
      || 'google/gemini-2.5-flash-lite,openai/gpt-oss-120b')
                    .split(',').map((x) => x.trim()).filter(Boolean)],
                  temperature: 0, max_tokens: llmProfile('v5-claim-structuring-single').maxTokens, json_mode: true, feature: 'v5-claim-structuring-single',
                  messages: [
                    { role: 'system', content: SINGLE_SYSTEM },
                    { role: 'user', content: String(m.content).slice(0, 800) },
                  ],
                });
                const subj = typeof one?.subject === 'string' ? one.subject.trim().slice(0, 500) : '';
                const pred = typeof one?.predicate === 'string' ? one.predicate.trim().toLowerCase().slice(0, 500) : '';
                if (!subj && !pred) continue;
                const q = (one && typeof one.qualifiers === 'object' && !Array.isArray(one.qualifiers)) ? one.qualifiers : undefined;
                const patch = {};
                if (subj) patch.claimSubject = subj;
                if (pred) patch.claimPredicate = pred;
                if (q && Object.keys(q).length) patch.claimQualifiers = q;
                if (Object.keys(patch).length && await applyClaimPatchIfLive(store, m.id, patch)) applied += 1;
              } catch (e) {
                this.logger.warn?.(`[v5-claim-structuring] single ${String(m.id).slice(0, 8)}: ${e.message}`);
              }
            }
          });
          await Promise.all(workers);
        }
        this.logger.info?.(`[v5-claim-structuring] ${batch.length} memories → ${applied} structured`
          + ` (1 batch call${missed.length ? ` + ${missed.length} backfill` : ''})`);
      } catch (err) {
        // Batch threw outright — fall back to the per-memory path for EVERYTHING rather than leaving
        // the whole document without claim identity.
        this.logger.warn?.(`[v5-claim-structuring] batch call failed (${err.message}) — falling back to per-memory`);
        let fi = 0;
        const CONC = Number(process.env.CLAIM_STRUCTURING_CONCURRENCY || 4);
        const workers = Array.from({ length: Math.min(CONC, batch.length) }, async () => {
          while (true) {
            const k = fi++;
            if (k >= batch.length) return;
            const m = batch[k];
            try {
              const one = await chatCompletionWithFallback({
                models: [model, ...(process.env.KB_UNIFIED_FALLBACK_MODELS
                  || 'google/gemini-2.5-flash-lite,deepseek/deepseek-v4-flash-0731')
                  .split(',').map((x) => x.trim()).filter(Boolean)],
                temperature: 0, max_tokens: llmProfile('v5-claim-structuring-single').maxTokens, json_mode: true, feature: 'v5-claim-structuring-single',
                messages: [
                  { role: 'system', content: SINGLE_SYSTEM },
                  { role: 'user', content: String(m.content).slice(0, 800) },
                ],
              });
              const subj = typeof one?.subject === 'string' ? one.subject.trim().slice(0, 500) : '';
              const pred = typeof one?.predicate === 'string' ? one.predicate.trim().toLowerCase().slice(0, 500) : '';
              if (!subj && !pred) continue;
              const q = (one && typeof one.qualifiers === 'object' && !Array.isArray(one.qualifiers)) ? one.qualifiers : undefined;
              const patch = {};
              if (subj) patch.claimSubject = subj;
              if (pred) patch.claimPredicate = pred;
              if (q && Object.keys(q).length) patch.claimQualifiers = q;
              if (Object.keys(patch).length) await applyClaimPatchIfLive(store, m.id, patch);
            } catch { /* per-memory isolation */ }
          }
        });
        await Promise.all(workers);
      }
      }
    })();
  }


  /**
   * Deferred KB fact-distillation (P6). Big documents (>=30 segments) used to
   * SKIP fact extraction entirely for speed — so magazine/report uploads stored
   * raw chunks labeled 'fact' and nothing distilled (the hauspost complaint).
   * This runs the SAME MemoryProcessor LLM fact pass the inline path uses, but
   * AFTER promotion commits: batched workers, off the critical path, graceful
   * per-segment failure. Each distilled fact becomes its own memory with full
   * provenance + a Derives edge back to its section memory.
   *
   * Returns the background promise (callers fire-and-forget; reprocess scripts
   * can await it via service._distillPromise).
   */
  /**
   * Combined, batched KB fact distillation (latency levers #2/#3/#5). ONE cheap
   * LLM call per BATCH of sections returns facts + entities together (was one
   * call per section, facts only) — ~BATCH× fewer calls and more accurate
   * (shared context). Each fact → its own memory with provenance, a Derives edge
   * to its section, CONTEXTUAL embedding (doc title + heading prepended), and
   * entity:* tags from the same pass (no separate entity-link LLM on facts).
   * Async, concurrency-bounded, off the critical path. Off-switch KB_FACT_DISTILL=false.
   */
  async _batchExtractFacts(sections, { maxFacts = 5, entityContext = '' } = {}) {
    const apiKey = process.env.GROQ_API_KEY;
    // deepseek-v4-flash (was gpt-oss-120b, before that 20b). The history matters: 20b only
    // half-followed the entity rules (forked Wärmepumpe/heat-pump, emitted phrase-'entities' and
    // generic nouns), so this moved to 120b, which followed the English-canonical + concise-noun
    // rules far more reliably. What neither gpt-oss variant does reliably is EMIT VALID JSON:
    // measured on live uploads, `model=openai/gpt-oss-20b … finish=error` followed by
    // "Failed to parse JSON response", repeatedly, and 120b was its only configured fallback — the
    // same family, so the retry inherited the same weakness.
    // deepseek-v4-flash-0731 is pinned (not the floating ~latest alias), emits clean JSON, and at
    // $0.09/$0.18 per M with a 1M context is cheaper than both while removing the truncation
    // pressure that produced finish=length on long windows.
    const model = process.env.MEMORY_PROCESSOR_MODEL || 'deepseek/deepseek-v4-flash-0731';
    // Heuristic fallback (no key): sentence-split — degraded but never blocks.
    if (!apiKey) {
      return sections.map((sec) => ({
        facts: (sec.content || '').split(/(?<=[.!?])\s/).map((x) => x.trim()).filter((x) => x.length >= 25).slice(0, maxFacts)
          .map((f) => ({ t: cleanTitleFrom(f, 48), f })),
        entities: [],
      }));
    }
    const numbered = sections.map((sec, i) =>
      `SECTION ${i}${sec.heading ? ` [${sec.heading}]` : ''}:\n${(sec.content || '').slice(0, 2500)}`).join('\n\n---\n\n');
    // High-end extraction prompt. Two jobs, tenant- and domain-agnostic (works
    // for any vertical/language): (1) atomic self-contained facts, (2) CANONICAL
    // entities. The entity-naming rules mirror the co-mention linker so the same
    // real-world thing never forks across language/number/abbreviation — the LLM
    // does the semantic canon here; entity-normalize.js folds the mechanical noise
    // downstream. NO domain examples → generalizes to every tenant.
    const sys = `You are a precise information-extraction engine. From each numbered SECTION, extract atomic FACTS and the CANONICAL ENTITIES it mentions.

Return ONLY a JSON object: {"sections":[{"i":<section number>,"facts":[{"t":"<short title>","f":"complete standalone sentence"}, ...],"entities":["Canonical Name", ...]}]}.

FACT rules — extract the FEWEST, HIGHEST-SIGNAL facts (quality over coverage):
- Each fact is an OBJECT {"t","f"}: "f" = ONE complete, self-contained sentence (explicit subject, never a bare "it"/"they"/"this"); "t" = a SHORT 3–6 word title naming what the fact is ABOUT — its subject/topic, in Title Case, NO trailing punctuation, and NOT a restatement of the whole sentence. Good titles: "RAG grounding without retraining", "O-ring failure cause", "Q2 revenue target". Bad titles: the full sentence, "Company Info", "Fact".
- Extract ONLY the most important, decision-relevant information actually stated: names, roles, products, specs, numbers, dates, decisions, events, causal claims. A reader skimming ONLY your facts should grasp the section's essence — capture that, nothing more.
- NON-REDUNDANT: never restate the same point in different words. If two candidate facts overlap, keep the single most specific one and drop the rest.
- NEVER meta-commentary about the document/section/layout, filler, marketing fluff, or boilerplate.
- Preserve specific values verbatim (numbers, units, model names, dates). Do not invent or generalize.
- At MOST ${maxFacts} facts per section — FEWER is better. A thin or purely decorative section → "facts":[].

DO NOT EXTRACT — these are NOT facts, skip them entirely (a section that is ONLY these → "facts":[]):
- Page furniture: headers, footers, page numbers, document/article/part numbers (e.g. "33567-3", "Art.-Nr. 30792", "Dokument-Nr."), "Technische Änderungen vorbehalten"/copyright/legal-disclaimer lines, and table-of-contents or chapter-number lines.
- Contact/company blocks: postal addresses, phone/fax numbers, email addresses, company registration or legal-form lines (a company name followed by a street address and phone number is a contact block, not a claim).
- Raw tabular number dumps with no prose: a run of bare numbers, axis labels, or dimensions with no stated claim is NOT a fact (e.g. "0 0,5 1 1,5 2 2,5 ..."). Only extract a measurement when you can state it as a complete sentence naming WHAT the value is and for WHICH thing (state the named thing and its measured quantity in one complete sentence) — otherwise skip it.
- Garbled/unreadable text: if a passage is OCR garbage, mojibake, or non-language glyph soup (e.g. "ĞŝƐƚƵŶŐ ΀Ŭt΁"), SKIP it — never reconstruct or extract from it.

ENTITY rules — emit ONE canonical name per real-world thing so the same entity never forks into variants:
- TYPE + LENGTH: an entity is a SHORT noun — a specific person, organization, product/model, place, technology, or standard. 1–3 words. NEVER a phrase, clause, description, or generic concept. Reject anything that reads like a description (do NOT emit "modular system idea", "customer cluster", "key account photovoltaic cluster", "comfort scenario"). If unsure whether it is a real entity, OMIT it.
- LANGUAGE — CONSISTENCY OVER TRANSLATION: use the entity's name in the SOURCE LANGUAGE exactly as written in the document. Do NOT translate (translating half the mentions forks one thing into two — Wärmepumpe vs heat-pump). Pick ONE surface form per real-world thing and reuse it identically everywhere. A German document yields German entity names; an English one yields English — never a mix for the same entity.
- NUMBER: singular for a concept/category; never the plural.
- ABBREVIATIONS: prefer the full widely-recognized term over an abbreviation/acronym, UNLESS the abbreviation IS the entity's established proper name (HEMS, SunSpec stay).
- SUFFIXES: drop corporate/legal-form suffixes. FORM: the bare name only — no articles, quotes, or trailing qualifiers.
- The SAME thing mentioned twice (any language/case/number/abbreviation) MUST map to the SAME string. Prefer 3–7 high-signal entities per section over many noisy ones.

Output the JSON object and nothing else.`;
    const isGptOss = /gpt-oss/i.test(model);
    const SECTION_SCHEMA = {
      type: 'object',
      additionalProperties: false,
      required: ['sections'],
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['i', 'facts', 'entities'],
            properties: {
              i: { type: 'integer' },
              facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['t', 'f'], properties: { t: { type: 'string' }, f: { type: 'string' } } } },
              entities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    };
    const resp = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: sys },
          ...(entityContext
            ? [{ role: 'system', content: `KNOWN CANONICAL ENTITIES already in this workspace — when the SAME real-world thing appears in the text, reuse these EXACT spellings instead of inventing a variant:\n${entityContext}` }]
            : []),
          { role: 'user', content: numbered },
        ],
        // gpt-oss is a reasoning model — default effort burns latency on a pure
        // extraction task. 'low' keeps quality, cuts reasoning tokens (tunable).
        ...(isGptOss ? { reasoning_effort: process.env.KB_DISTILL_REASONING_EFFORT || 'low' } : {}),
        // Strict structured outputs (gpt-oss-20b/120b): constrained decoding =
        // guaranteed valid JSON, no salvage parsing, no silently-dropped batches.
        // Non-gpt-oss models fall back to JSON-object mode.
        response_format: isGptOss
          ? { type: 'json_schema', json_schema: { name: 'fact_extraction', strict: true, schema: SECTION_SCHEMA } }
          : { type: 'json_object' },
      }),
    });
    if (!resp.ok) throw new Error(`groq ${resp.status}`);
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    // Strict mode guarantees parseable JSON; keep a salvage path for the
    // non-gpt-oss / best-effort case so a stray prose wrapper never loses a batch.
    let arr = [];
    try {
      const parsed = JSON.parse(content);
      arr = Array.isArray(parsed?.sections) ? parsed.sections : (Array.isArray(parsed) ? parsed : []);
    } catch {
      arr = extractJsonArray(content);
    }
    const byI = new Map();
    arr.forEach((o, idx) => byI.set(typeof o?.i === 'number' ? o.i : idx, o));
    return sections.map((_, i) => {
      const o = byI.get(i) || {};
      // Normalize every fact to {t,f}. Strict-schema shape is already {t,f};
      // coerce any bare string (legacy / non-gpt-oss salvage) and backfill a
      // missing title from the sentence.
      const facts = (Array.isArray(o.facts) ? o.facts : []).map((x) => {
        if (typeof x === 'string') return { t: cleanTitleFrom(x, 48), f: x };
        if (x && typeof x === 'object' && typeof x.f === 'string') {
          return { t: (typeof x.t === 'string' && x.t.trim() && !isGarbageTitle(x.t)) ? x.t.trim() : cleanTitleFrom(x.f, 48), f: x.f };
        }
        return null;
      }).filter(Boolean);
      return { facts, entities: Array.isArray(o.entities) ? o.entities : [] };
    });
  }

  _distillFactsAsync({ targets, userId, orgId, metadata = {}, documentId }) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    if (process.env.KB_FACT_DISTILL === 'false') return null; // emergency off-switch
    const BATCH = Number(process.env.KB_DISTILL_BATCH || 6);
    // Concurrency 5 (was 3): the distill LLM calls are independent, so run all of
    // a typical doc's batches in one wave instead of two — the LLM calls were
    // serialized 3-at-a-time. Groq gpt-oss handles this concurrency comfortably.
    const CONCURRENCY = Number(process.env.KB_DISTILL_CONCURRENCY || 5);
    // 5 facts/section: 3 missed buried details (footnotes, names embedded in
    // dense paragraphs — e.g. competitor names) → memory-layer coverage gaps.
    // 5 captures them; the evidence layer still backs anything the distill skips.
    // Pure-insert keeps the extra per-fact cost cheap. Env-overridable.
    // Curated density (was 5 / 120 → avg ~26 facts/doc, p90 60: noise floor +
    // recall dilution + per-fact latency). Salience prompt + these tighter caps
    // target a few high-signal facts per section and a sane doc ceiling.
    const MAX_FACTS_PER_SEGMENT = Number(process.env.KB_DISTILL_MAX_FACTS || 3);
    const MAX_FACTS_PER_DOC = Number(process.env.KB_DISTILL_DOC_CAP || 40);
    const docTitle = metadata.documentTitle || metadata.filename || `Document ${String(documentId).slice(0, 8)}`;

    const run = (async () => {
      // entityContext: the org's existing canonical entities (ONE cheap query,
      // off the per-fact hot path) injected into the distill prompt so new facts
      // reuse canonical spellings instead of forking variants. Best-effort.
      let entityContext = '';
      try {
        const rows = await this.db.$queryRawUnsafe(
          `SELECT replace(tag, 'entity:', '') e
             FROM (SELECT unnest(tags) tag FROM memories WHERE org_id = $1::uuid AND deleted_at IS NULL) s
            WHERE tag LIKE 'entity:%'
            GROUP BY tag ORDER BY count(*) DESC LIMIT 40`,
          orgId,
        );
        entityContext = (rows || []).map((r) => r.e).filter(Boolean).join(', ');
      } catch (e) { this.logger.warn?.(`[kb-distill] entityContext fetch failed: ${e.message}`); }

      // Phase 2: collect {factId, vec} for the OFF-HOT-PATH async enrichment pass
      // (cross-doc dedup + relationship edges). Populated in flushEmbeds.
      const enrichRecs = [];
      const factObjs = []; // created fact memories (id+content+tags) — facts-only mode links them post-distill
      const canonicalItems = []; // {memoryId, entities:[raw names]} — post-commit canonical registry pass
      const evidenceLinks = [];

      // Only sections with enough prose to distill.
      const eligible = targets.filter((t) => (t.content || '').split(/\s+/).filter(Boolean).length >= 25);
      const batches = [];
      for (let i = 0; i < eligible.length; i += BATCH) batches.push(eligible.slice(i, i + BATCH));
      let created = 0, failed = 0, bidx = 0;

      const ingestFact = async (t, fact, entityTags, factTitle) => {
        const plannedMemoryId = crypto.randomUUID();
        const contentHash = crypto.createHash('sha256').update(fact.trim()).digest('hex');
        const provenance = buildMemoryProvenance({
          existing: { source_platform: 'knowledge_base', source_type: 'knowledge_fact',
            source_url: metadata.source_url || null, document_type: metadata.document_type || 'general' },
          memoryId: plannedMemoryId, documentId, sourceId: metadata.source_id || documentId,
          sourceTitle: docTitle, segmentIds: t.segmentId ? [t.segmentId] : [],
          userId, orgId, scope: t.scope, projectIds: t.project_ids,
          teamId: t.primary_team_id, documentDate: metadata.document_date,
          eventTime: metadata.event_time, validFrom: metadata.valid_from,
          validTo: metadata.valid_to, knownAt: metadata.known_at,
          claimKind: 'fact', language: metadata.language, contentHash,
        });
        const res = await this.memoryGraphEngine.ingestMemory({
          id: plannedMemoryId,
          user_id: userId,
          org_id: orgId,
          scope: t.scope,
          visibility: t.visibility || 'private',
          primary_team_id: t.primary_team_id || null,
          project_ids: Array.isArray(t.project_ids) ? t.project_ids : [],
          content: fact.trim(),
          // LLM-emitted concise title (its subject/topic), not the whole
          // sentence. Falls back to the first-clause heuristic if absent.
          title: provenanceMemoryTitle(
            docTitle,
            (factTitle && factTitle.trim() && !isGarbageTitle(factTitle))
              ? factTitle.trim().slice(0, 80)
              : cleanTitleFrom(fact),
          ),
          memory_type: 'fact',
          source_type: 'knowledge_fact',
          // Event date of the source document (connector occurredAt / meeting
          // date / KB document_date) → every distilled fact carries it, so
          // time-travel + recency ranking work on the real-world date, not the
          // ingest time. Null for plain uploads with no date (unchanged).
          document_date: metadata.document_date || null,
          tags: [
            ...(metadata.tags || []),
            'extracted-fact',
            'distilled-from-kb',
            ...entityTags,
            ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
            ...(documentId ? [`doc-id:${documentId}`] : []),
            ...(t.heading ? [`heading:${String(t.heading).toLowerCase().replace(/\s+/g, '-').slice(0, 50)}`] : []),
            ...(t.page ? [`page:${t.page}`] : []),
          ],
          source_metadata: provenance,
          metadata: { ...provenance, segment_memory_id: t.memoryId || null, distill_agent: 'kb_distill_v2' },
          skip_fact_extraction: true,
          defer_entity_linking: true,   // entities already extracted in the batch pass
          // KB distilled facts are append-only with explicit Derives-to-segment
          // provenance — they don't supersede/contradict each other and don't need
          // operator inference. Make each a PURE INSERT: skip the smart-router,
          // per-fact recall, the relationship-classifier LLM call, contradiction
          // detection, AND the per-user advisory lock that SERIALIZES every fact of
          // a doc. That per-fact stack (LLM classify + router + lock) was ~1.5s/fact
          // — the entire distill tail. ts: tags + entity-tag canonicalization still
          // apply (stamped/normalized before the lock); graph connectivity is via
          // shared entity: tags. Trades per-fact auto-edges for ~10x throughput.
          skipSmartRouting: true,
          skipPredictCalibrate: true,
          skipAdvisoryLock: true,
          skip_relationship_classification: true,
          skip_contradiction_detection: true,
        });
        const factId = res?.memoryId || res?.id || null;
        if (!factId || (res?.operation || '').startsWith('skipped')) return null;
        // Provenance: fact Derives-from its section — ONLY in legacy mode where a section memory exists.
        // In facts-only mode (t.memoryId null) the fact's provenance is the SEGMENT (evidence) via
        // metadata.segment_id + the filename/doc-id tags; no memory↔memory Derives is created (that was
        // the bulk of the "Derives noise"). Cross-fact relationships come from the co-mention linker.
        if (t.memoryId) {
          try {
            await this.memoryGraphEngine.store.createRelationship({
              org_id: orgId, // residency: worker context may not carry the org — see createRelationship
              id: crypto.randomUUID(), from_id: factId, to_id: t.memoryId,
              type: 'Derives', confidence: 0.9,
              metadata: { created_by: 'kb_distill_v2', document_id: documentId },
            });
          } catch { /* best-effort */ }
        }
        // Return a pending vector-index job. The CONTEXTUAL embedding (doc title +
        // heading prefix, Anthropic contextual-retrieval) is BATCHED by the caller
        // — one bge-m3 call per ≤20 facts instead of a network round-trip per fact,
        // which was the dominant per-fact latency in distill.
        const ctxInput = `${docTitle}${t.heading ? ` — ${t.heading}` : ''}\n${fact.trim()}`;
        return { factId, ctxInput, fact: fact.trim(), title: provenanceMemoryTitle(docTitle,
          (factTitle && factTitle.trim() && !isGarbageTitle(factTitle))
            ? factTitle.trim().slice(0, 80) : cleanTitleFrom(fact)),
          entityTags, t, provenance: { ...provenance, memory_id: factId }, contentHash };
      };

      // Batch the contextual embeds for a set of just-ingested facts: one embed
      // call (the service internally chunks at 20) + parallel Qdrant upserts.
      const flushEmbeds = async (pending) => {
        if (!pending.length) return;
        const vs = this.memoryGraphEngine.vectorStore;
        let vectors = [];
        try {
          vectors = (await vs?.generateEmbeddings?.(pending.map((p) => p.ctxInput), {
            workload: 'ingestion', tenantId: orgId,
          })) || [];
        } catch (e) {
          this.logger.warn?.(`[kb-distill] batch embed failed (${pending.length} facts): ${e.message}`);
          vectors = [];
        }
        await Promise.all(pending.map(async (p, idx) => {
          try {
            const vec = vectors[idx];
            if (!usableEmbedding(vec)) return; // authoritative memory remains; reconciler indexes it
            enrichRecs.push({ factId: p.factId, vec });
            await vs?.storeMemory({
              id: p.factId, user_id: userId, org_id: orgId, content: p.fact,
              title: p.title, memory_type: 'fact', is_latest: true, tags: p.entityTags,
              project_ids: Array.isArray(p.t.project_ids) ? p.t.project_ids : [],
              primary_team_id: p.t.primary_team_id || null, visibility: p.t.visibility || 'private',
              created_at: new Date().toISOString(), source_metadata: p.provenance,
              metadata: p.provenance, document_date: metadata.document_date || null,
              valid_from: metadata.valid_from || null, valid_to: metadata.valid_to || null,
              content_hash: p.contentHash,
            }, { vector: vec, embeddingWorkload: 'ingestion' });
          } catch (vecErr) {
            this.logger.warn?.(`[kb-distill] vector index failed for ${p.factId}: ${vecErr.message}`);
          }
        }));
      };

      const processBatch = async (batch) => {
        if (created >= MAX_FACTS_PER_DOC) return;
        let perSection;
        try {
          // Allow the LLM up to the batch's largest per-target cap (windowed facts-only passes bigger
          // caps for bigger windows); the per-section slice above still enforces each target's own cap.
          const _batchMax = metadata.perTargetMaxFacts
            ? Math.max(MAX_FACTS_PER_SEGMENT, ...batch.map((t) => Number(t.maxFacts) || 0))
            : MAX_FACTS_PER_SEGMENT;
          perSection = await this._batchExtractFacts(batch, { maxFacts: _batchMax, entityContext });
        } catch (err) {
          failed++;
          this.logger.warn?.(`[kb-distill] batch LLM failed: ${err.message}`);
          return;
        }
        const pending = [];
        for (let k = 0; k < batch.length; k++) {
          if (created >= MAX_FACTS_PER_DOC) break;
          const t = batch[k];
          const ex = perSection[k] || { facts: [], entities: [] };
          // Per-target cap (facts-only windowed distill passes t.maxFacts sized to content length);
          // falls back to the flat per-segment cap for the legacy path.
          const _capK = (metadata.perTargetMaxFacts && Number(t.maxFacts) > 0) ? Number(t.maxFacts) : MAX_FACTS_PER_SEGMENT;
          const facts = (ex.facts || []).filter((f) => f && typeof f.f === 'string' && f.f.trim().length >= 20).slice(0, _capK);
          // Canonicalize at the SOURCE (normalizeEntity), not via a raw
          // underscore-join. KB facts set defer_entity_linking=true so the
          // co-mention linker never re-tags them, and they do NOT reach the
          // createMemory chokepoint's tag-normalize — so writing raw here left
          // entity:SOLVIS / entity:WP_storage un-canonicalized in the DB.
          // Deterministic guard (belt-and-suspenders with the prompt rule): drop
          // "entities" that are actually source/file/artifact references — filenames,
          // extensions, article/part numbers, fonts, colours, format sizes, URLs.
          // These polluted the product registry ("SOLVIS_RG_4C.eps", "Art.-Nr.
          // 27770", "Calibri Regular", "DIN A5") and must never become entity tags.
          const _isArtifactRef = (name) => {
            const s = String(name || '').trim();
            if (!s) return true;
            if (/\.(pdf|eps|png|jpe?g|docx?|xlsx?|pptx?|csv|svg|ai|psd|zip|gif|webp|tiff?)\b/i.test(s)) return true; // filenames/extensions
            if (/\bart[.\-\s]*nr\b|\bartikel[- ]?nr\b|\border[- ]?nr\b|^\d[\d.\-\/ ]{3,}$/i.test(s)) return true;   // article/part/order numbers
            if (/\bDIN\s?[A-Z]?\d|\bA[3-6]\b|\b\d{2,4}\s?(x|×)\s?\d{2,4}\b/i.test(s)) return true;                  // paper/format sizes
            if (/\b(regular|bold|italic|light|medium|thin|black|condensed|extended|oblique)\b/i.test(s) && /^[A-Z][a-z]+(\s[A-Z]?[a-z]+)*$/.test(s)) return true; // font faces
            if (/^https?:\/\//i.test(s) || /\bwww\./i.test(s)) return true;                                        // URLs
            if (/[_\/]/.test(s) && !/\s/.test(s) && /[A-Z]/.test(s) && s.length > 8) return true;                  // asset/file identifiers (an all-caps token with underscores/slashes and no spaces)
            return false;
          };
          // TYPED ENTITIES. The extractor may return a bare string or {n, k}; both are accepted, so
          // this is additive and an older/simpler model response still works. Every canonical row was
          // landing with entity_kind='entity' — the persister already HAS a taxonomy and
          // normalizeEntityKind(), ingestion simply never sent a kind, so the graph could not
          // distinguish a person from a standard.
          const _entityPairs = (ex.entities || [])
            .map((e) => (typeof e === 'string'
              ? { name: e, kind: null }
              : (e && typeof e === 'object' && typeof e.n === 'string' ? { name: e.n, kind: e.k || null } : null)))
            .filter((e) => e && typeof e.name === 'string' && e.name.trim() && !_isArtifactRef(e.name))
            .slice(0, 8);
          const rawEntityNames = _entityPairs.map((e) => e.name);
          const entityTags = rawEntityNames
            .map((e) => { const slug = normalizeEntity(e); return slug ? `entity:${slug}` : null; })
            .filter(Boolean);
          for (const fact of facts) {
            if (created >= MAX_FACTS_PER_DOC) break;
            try {
              const p = await ingestFact(t, fact.f, entityTags, fact.t);
              // Re-check the cap in the same synchronous tick as the increment:
              // `created` is shared across CONCURRENCY workers and the await above
              // is a yield point, so the outer break alone lets the soft cap
              // overshoot. This keeps MAX_FACTS_PER_DOC effectively binding.
              if (p && created < MAX_FACTS_PER_DOC) {
                pending.push(p); created++;
                // Carry the kinds alongside the names; the persister normalizes them and leaves
                // unknown ones alone, so a bad kind cannot fragment the registry.
                // Pass the TYPED pairs as `entities`. The persister accepts string | {name, kind};
                // a separate parallel array would have been a second shape for one fact — and the
                // persister would have ignored it, leaving the whole typing chain dead.
                if (_entityPairs.length) canonicalItems.push({ memoryId: p.factId, entities: _entityPairs });
                factObjs.push({
                  id: p.factId, user_id: userId, org_id: orgId, content: p.fact,
                  title: p.title, memory_type: 'fact',
                  tags: [
                    ...p.entityTags,
                    ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
                    ...(documentId ? [`doc-id:${documentId}`] : []),
                  ],
                  project: Array.isArray(p.t.project_ids) ? p.t.project_ids[0] : null,
                  support_segment_ids: p.t.segmentId ? [p.t.segmentId] : [],
                });
                if (p.t.segmentId) evidenceLinks.push({ memoryId: p.factId, documentId,
                  segmentId: p.t.segmentId, linkType: 'supports', confidence: 1 });
              }
            } catch (err) { failed++; this.logger.warn?.(`[kb-distill] fact ingest failed: ${err.message}`); }
          }
        }
        // One batched contextual-embed pass for every fact created in this batch.
        await flushEmbeds(pending);
      };

      const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
        while (true) {
          const i = bidx++;
          if (i >= batches.length) return;
          await processBatch(batches[i]);
        }
      });
      await Promise.all(workers);
      if (evidenceLinks.length) {
        if (orgIsRemote(orgId)) {
          await amrKbProvenance(orgId, { evidence_links: evidenceLinks.map((link) => ({
            memory_id: link.memoryId, document_id: link.documentId, segment_id: link.segmentId,
            link_type: link.linkType, confidence: link.confidence,
          })), derivations: [] });
        } else {
          await this.db.memoryEvidenceLink.createMany({ data: evidenceLinks, skipDuplicates: true });
        }
      }
      this.logger.info?.(`[kb-distill] doc ${String(documentId).slice(0, 8)}: ${created} facts from ${eligible.length} sections in ${batches.length} LLM calls (failed=${failed})`);
      // Canonical-entity registry pass — AFTER all facts committed, off the hot
      // path (fire-and-forget). Creates org-scoped CanonicalEntity rows +
      // MemoryEntityLink rows from the extractor's canonical names; exact names
      // reuse existing entities, ambiguous fuzzy matches go to the review
      // queue. entity: tags above stay as the compatibility fallback.
      if (canonicalItems.length) {
        persistCanonicalLinks({
          prisma: this.db, organizationId: orgId, items: canonicalItems, logger: this.logger,
          sourceMeta: {
            filename: metadata?.filename || docTitle || null,
            documentId: documentId || null,
            seenAt: new Date().toISOString().slice(0, 10),
          },
        })
          .catch((e) => this.logger.warn?.(`[canonical-entities] ${e.message}`));
      }
      // Phase 2 enrichment — OFF the hot path, flag-gated (default off). Cross-doc
      // dedup + relationship edges, using vectors already computed during embed.
      if (process.env.KB_ENRICH_ENABLED === '1' && enrichRecs.length) {
        this._enrichDocAsync({ enrichRecs, orgId, documentId })
          .catch((e) => this.logger.warn?.(`[kb-enrich] ${e.message}`));
      }
      return { created, failed, factObjs };
    })().catch((err) => {
      this.logger.warn?.(`[kb-distill] batch failed: ${err.message}`);
      return null;
    });

    this._distillPromise = run; // reprocess scripts can await this
    return run;
  }

  /**
   * UNIFIED EXTRACTOR — one structured LLM call per window returns FACTS + canonical
   * ENTITIES + intra-window RELATIONSHIPS together. Replaces the separate distill +
   * intra-doc co-mention passes: the model decides facts, their entities, and the
   * edges BETWEEN them in ONE context → coherent, low-noise, entity-consistent
   * (aliases collapse inside the call), far fewer LLM calls. Cross-DOC/TIME edges
   * (Updates/Contradicts against prior org memories) are NOT this call's job — the
   * recall-based co-mention pass handles those afterward. Enterprise-robust: strict
   * json_schema on gpt-oss-120b + salvage; per-window bounded; caps on facts/entities/rels.
   * @returns {Promise<Array<{t,f,entities:string[],rels:Array<{to:number,type:string}>}>>}
   */
  async _extractUnified(window, { entityContext = '', maxFacts = 8, docTitle = '', compact = false, model: modelOverride = null } = {}) {
    // modelOverride lets the reliability layer ESCALATE a shortfall window to a
    // stronger model (P2) — distinct from re-sampling the same model at temp 0.
    const model = modelOverride || process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'deepseek/deepseek-v4-flash-0731';
    const content = (window.content || '').slice(0, 6000);
    if (content.trim().length < 40) {
      // Heuristic fallback: sentence-split facts, no entities/rels — never blocks.
      return content.split(/(?<=[.!?])\s/).map((x) => x.trim()).filter((x) => x.length >= 25).slice(0, maxFacts)
        .map((f) => ({ t: cleanTitleFrom(f, 48), f, entities: [], rels: [] }));
    }
    // Per-window candidate ceiling. This is the EVIDENCE-candidate stage — the
    // document curator downstream picks and merges the durable set, so the
    // extractor should surface EVERY distinct durable claim in a dense section
    // rather than self-limit to 4 (a 'The Asset' section carries bootstrapped
    // status + sole-IP + three products + replacement cost = >4 distinct claims;
    // capping at 4 dropped them before the curator ever saw them). minImportance
    // (0.65) + the curator keep the extra candidates from becoming noise.
    const factCap = Math.max(1, Math.min(Number(maxFacts) || 1,
      compact ? 3 : Number(process.env.KB_UNIFIED_WINDOW_MAX_FACTS || 10)));
    const sys = `Extract only high-value durable workspace memory from the SECTION.
LANGUAGE: infer the SECTION's language semantically and write every "t" and "f" in that same language. Do not translate. These instructions are not a language sample. For mixed-language sources, preserve the language of each supported claim. Only JSON keys, memory_type and the canonical predicate use English.
Return ONLY valid JSON:
{"facts":[{"t":"short topic","f":"one complete standalone contextual claim","memory_type":"fact|event","claim_kind":"fact|event|decision|preference|policy|goal|commitment|procedure|lesson","importance":0.0,"extraction_confidence":0.0,"source_quote":"exact verbatim substring from SECTION","subject":{"n":"exact canonical subject","k":"person|organization|product|place|technology|standard"},"predicate":"canonical_english_relation","object":{"value":"exact source-language value","type":"semantic category or empty"},"qualifiers":{"scope":"only material conditions, dates, units, negation, uncertainty or rationale"},"entities":[{"n":"Canonical Name","k":"person|organization|product|place|technology|standard"}],"relationships":[{"from":{"n":"Canonical Name","k":"allowed kind"},"type":"semantic_relation","to":{"n":"Canonical Name","k":"allowed kind"}}]}]}

SUBJECT RULE — the single most important rule. Every claim must NAME WHAT IT IS ABOUT, inside the claim text, so it still makes sense with the document gone. The memory is stored alone and retrieved by meaning; a reader who never saw this document must be able to tell what it concerns.
Judge each claim by SHAPE, not by wording — these patterns are abstract and carry no example text:
BAD   <bare role or kinship> + <attribute>        — the role is not a subject; whose?
BAD   <attribute or deficiency> with no owner     — belongs to nobody, cannot be retrieved
BAD   <pronoun> + <attribute>                     — the referent is lost once stored alone
GOOD  <named entity, persona, or document topic> + <attribute, scope, numbers>
If the subject of a claim is a bare role, kinship term, pronoun, or unnamed person or organisation, RESOLVE it: carry the named person, organisation, persona, product, or the document's own topic from the surrounding section INTO the claim text. Resolve pronouns to their referent. A claim you cannot give a concrete subject is not durable — drop it rather than emit it subjectless.
Rules: up to ${factCap} facts. Capture every distinct durable claim (decision, commitment, requirement, metric, figure, date, named party, defining fact) — but a CLAIM IS NOT A ROW.
MERGE LINE ITEMS OF ONE CATEGORY INTO ONE MEMORY, CARRYING EVERY FIGURE. A price list, budget table, cost breakdown, schedule or feature list under one heading is ONE durable fact stating the whole set with all its numbers and labels, not one fact per line. Measured failure to avoid: a 5-page budget produced 30 separate memories averaging 154 characters — "The cost for 1 brand strategy is EUR 8,000.", "The cost for identity development is EUR 24,500.", "The cost for consulting and project management is ...", each a table row stored alone. Correct output is a single memory naming the section and listing every item with its amount, so a reader who retrieves only that memory can answer any question about the breakdown. Splitting it loses the comparison AND wastes the budget above.
Emit a separate fact only when a claim stands on a DIFFERENT subject or decision, not when it is another row of the same table. Do NOT drop a distinct high-value claim to keep the count low — merge related ones instead. A memory is a durable contextual unit, not a line-item: preserve the subject plus the decision, requirement, scope, owner, rationale, constraints, numbers, dates, and outcome when those details belong together in the source. Do not split one coherent decision or plan into separate mini-facts, and merge only genuine restatements of the same claim. Prefer 1-3 concise sentences (about 180-700 characters) when the section supports that context; keep a shorter claim only when the source fact is truly indivisible. Never repeat wording just to reach a length.

Promote only decisions, commitments, requirements, metrics, named parties, dates, concrete specifications, products and their exact categories or variants, roles, responsibilities, status changes, risks, constraints, dependencies, policies and durable organization or customer facts. Skip slogans, generic marketing, headers, footers, contacts, disclaimers, repeated descriptions and OCR noise. Every source_quote must be one exact contiguous substring from SECTION that supports the entire claim; use 40-900 characters when needed for contextual support. memory_type is only fact or event; preserve the narrower enterprise meaning in claim_kind. Preserve exact names, dates, quantities, units, categorical nouns, negation and uncertainty. Never broaden or guess a category. The subject, predicate and object must express the same complete claim as "f"; prefer one complete claim over fragments. Relationships are structured claim metadata only and must be explicitly supported by the same source_quote; do not invent causal or organizational links. Entities are named people, organizations, products, places, technologies, or standards only — a real proper noun a person would recognize. CAPITALISATION IS NOT EVIDENCE: a generic kind is not an entity. Give each entity a "k" from the listed kinds; if none fits, omit it. Never emit source filenames, document titles, file extensions, part numbers, fonts, colours, format sizes, URLs or asset identifiers as entities.
FINAL AND OVERRIDING: write every "t" and "f" in the SECTION's own language, whatever that language is. These rules are written in English for your benefit only — they are instructions, NOT a language sample. Never translate the section's content into the language of these instructions.
"t" and "f" MUST be in the same language as each other: "f" is a verbatim substring of the SECTION, so if "t" is in a different language from its own "f" you have translated, and that is wrong. Keep the SECTION's own names and number formats as written (not 1.240 -> 1,240, not Hannover -> Hanover).`;
// REVERTED, DO NOT REINTRODUCE: an earlier version of this paragraph also said every "t" must be
// "readable as a sentence lifted from the SECTION itself". Deployed, that produced 0 facts from 4
// windows on a document holding 30-46 fact-bearing sentences each ("EXTRACTION SHORTFALL: kept 0
// facts", four times, model answering normally with finish=stop). It reads as "copy the section
// verbatim", which collides with the atomicity and paraphrase rules above and made every candidate
// unusable. Constraining the LANGUAGE of a claim is safe; constraining its FORM to a copy is not.
    // Model fallback: if the primary extraction model fails (provider error,
    // finish=error, unparseable), fall through to a DIFFERENT family so a
    // section's facts are never lost to one model/provider hiccup. Configurable
    // via KB_UNIFIED_FALLBACK_MODELS (comma-separated).
    const _fallbacks = (process.env.KB_UNIFIED_FALLBACK_MODELS
      || 'google/gemini-2.5-flash-lite,openai/gpt-oss-120b').split(',').map((x) => x.trim()).filter(Boolean);
    const parsed = await chatCompletionWithFallback({
      // Dense sections emit up to 8 facts × (180-700 char claim + 40-900 char
      // source_quote + entities). 1800 tokens overflowed → finish=length →
      // truncated JSON → whole-section fact loss (~28% of calls). Give ample
      // headroom. A provider-confirmed finish=length is rejected as incomplete;
      // the reliability layer tries another model, then bounded structural splits.
      models: [model, ..._fallbacks], temperature: 0,
      max_tokens: llmProfile('kb-unified-extract', { compact }).maxTokens,
      json_mode: true, reject_truncated_json: true,
      response_format: QWEN_UNIFIED_FACTS_RESPONSE_FORMAT,
      prefer_truncated_if_more_items: true, feature: 'kb-unified-extract',
      messages: [
        { role: 'system', content: sys },
        ...(entityContext ? [{ role: 'system', content: `KNOWN CANONICAL ENTITIES already in this workspace — reuse these EXACT spellings when the same thing appears:\n${entityContext}` }] : []),
        { role: 'user', content: `SECTION${window.heading ? ` [${window.heading}]` : ''}:\n${content}` },
      ],
    });
    let rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
    // TRANSLATION DETECTOR — language-neutral, no detector library, no per-language rules.
    // The prompt forbids translating the section, but compliance was only ever assessed by eye.
    // Measured by hand on a German upload: memories came back as "Phase 1 starts in April 2026 with
    // the pilot installation in Hanover" from "Phase 1 startet im April 2026 mit der
    // Pilotinstallation in Hannover" — and MANDI rows from 2026-07-22 show the same mix, so this
    // long predates any model change and was never quantified.
    // The signal: a fact's own `f` quote is REQUIRED to be a verbatim substring of the section, so a
    // faithful fact shares many tokens with its quote and a translated one shares almost none. That
    // holds in any language and privileges none. Logged, never dropped — a wrong count must not
    // delete a user's fact.
    if (rawFacts.length) {
      // Pure numerals are EXCLUDED: dates, prices and part numbers survive translation unchanged and
      // inflate the overlap. Measured on the real observed pair, keeping numerals scored 0.50 and hid
      // the translation; dropping them scores it 0.40 against 0.75-1.00 for faithful facts.
      // Threshold validated on 7 hand-built pairs drawn from actual output (3 translated / 4 faithful),
      // separating 0.00-0.40 from 0.75-1.00. Directional instrumentation, not proof.
      const _norm = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
        // Pure numerals are EXCLUDED: dates, prices and part numbers survive translation unchanged
        // and inflate the overlap. Keeping them scored the real observed pair 0.50 and MISSED it;
        // dropping them scores it 0.40 against 0.75-1.00 for faithful facts.
        .filter((t) => t.length > 3 && /\p{L}/u.test(t));
      const _langThreshold = Number(process.env.KB_LANG_DRIFT_THRESHOLD || 0.45);
      let _suspect = 0;
      let _judged = 0;
      for (const f of rawFacts) {
        // COMPARE THE CLAIM AGAINST ITS OWN QUOTE. My first version compared `t` (the SHORT TOPIC)
        // against `f` (the full claim) — two fields that legitimately share few tokens, so it
        // reported drift on faithful facts. Measured on an English PDF: 7 of 7 flagged when nothing
        // had been translated. The contract is {t: short topic, f: claim, source_quote: verbatim
        // substring}, and the only pair whose languages MUST match is the claim and its quote.
        const claim = f?.f || f?.content;
        const quote = f?.source_quote;
        if (!claim || !quote) continue;          // nothing to compare — say nothing
        const t = new Set(_norm(claim));
        const q = _norm(quote);
        if (!t.size || q.length < 4) continue;   // too short to judge
        _judged += 1;
        const shared = q.filter((w) => t.has(w)).length / q.length;
        if (shared < _langThreshold) _suspect += 1;
      }
      if (_suspect) {
        // Print the ACTUAL threshold, not a literal. The first version hardcoded "<15%" while the
        // threshold had already moved to 0.45, so the log understated the bar it was applying.
        ingestDiagnostic.warn(`[kb-unified] LANGUAGE DRIFT: ${_suspect}/${_judged} judged facts share under `
          + `${Math.round(_langThreshold * 100)}% of tokens with their own source quote — likely `
          + `translated away from the section's language, which the prompt forbids. Facts kept; this `
          + `is a measurement, not a filter.`);
      }
    }
    // ATOMICITY. Measured on a real ingest: 23 of 29 claims were already single-sentence,
    // avg 119 chars — so the extractor is close. The 6 multi-sentence ones are what make
    // supersession ambiguous, because "latest" is only definable per (entity, attribute).
    // Split on sentence boundaries and keep the parts that still carry a verb, preserving
    // each part's grounding quote. Cheap, deterministic, no extra LLM call.
    if (String(process.env.KB_ATOMIC_FACTS ?? 'true').toLowerCase() !== 'false') {
      const split = [];
      for (const f of rawFacts) {
        const text = String(f?.content || f?.text || '').trim();
        const parts = text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/).map((t) => t.trim())
          .filter((t) => t.length >= 12 && /\p{L}{3}/u.test(t));
        // Owner directive: memories may carry 2-4 sentences of RELATED detail — only
        // split when a claim packs 3+ sentences (those are almost always unrelated facts).
        if (parts.length >= 3) {
          for (const part of parts) split.push({ ...f, content: part, _atomized: true });
        } else {
          split.push(f);
        }
      }
      if (split.length !== rawFacts.length) {
        ingestDiagnostic.info(`[kb-atomic] ${rawFacts.length} claim(s) -> ${split.length} atomic fact(s)`);
      }
      rawFacts = split;
    }
    // IMPORTANCE GATE REMOVED (default was 0.65). An importance threshold is incompatible
    // with the facts users actually ask for: "Peter Stahlgrimm age 58", a part number, a
    // kW rating all score LOW by any model's judgement and are exactly the answer. Measured
    // on org 1380251c: 0 of 485 memories held the 5 small facts under test; all 5 were in
    // segments. Importance is query-dependent and cannot be known at ingest time.
    // Env override honoured only if someone deliberately sets it ABOVE 0.
    const minImportance = Number(process.env.KB_UNIFIED_MIN_IMPORTANCE || 0);
    return normalizeUnifiedClaims(rawFacts, content, factCap, minImportance);
  }

  async _recoverTruncatedUnified(window, options, error, depth = 0) {
    const content = String(window?.content || '').trim();
    const maxFacts = Math.max(1, Number(options?.maxFacts) || 8);
    const rawPartial = Array.isArray(error?.partial?.facts)
      ? error.partial.facts : (Array.isArray(error?.partial) ? error.partial : []);
    const partial = normalizeUnifiedClaims(rawPartial, content, maxFacts, 0);
    const maxDepth = Math.max(0, Math.min(3, Number(process.env.KB_TRUNCATION_SPLIT_DEPTH ?? 2)));
    const parts = depth < maxDepth ? splitDenseExtractionContent(content) : [];
    if (parts.length !== 2) {
      this.logger.warn?.(`[kb-unified] truncation recovery exhausted at depth=${depth}; retaining `
        + `${partial.length} grounded complete claim(s), evidence remains authoritative`);
      return partial;
    }

    const recovered = [];
    const partBudget = Math.max(2, Math.min(maxFacts, Math.ceil(maxFacts / 2) + 1));
    let searchFrom = 0;
    for (const part of parts) {
      const partOffset = Math.max(0, content.indexOf(part, searchFrom));
      searchFrom = partOffset + part.length;
      const child = { ...window, content: part };
      try {
        const childClaims = await this._extractUnified(child, { ...options, maxFacts: partBudget });
        recovered.push(...childClaims.map((claim) => ({
          ...claim,
          source_start: Number.isInteger(claim?.source_start) ? claim.source_start + partOffset : claim?.source_start,
          source_end: Number.isInteger(claim?.source_end) ? claim.source_end + partOffset : claim?.source_end,
        })));
      } catch (childError) {
        if (childError?.code === 'LLM_JSON_TRUNCATED') {
          const childClaims = await this._recoverTruncatedUnified(child, { ...options, maxFacts: partBudget }, childError, depth + 1);
          recovered.push(...childClaims.map((claim) => ({
            ...claim,
            source_start: Number.isInteger(claim?.source_start) ? claim.source_start + partOffset : claim?.source_start,
            source_end: Number.isInteger(claim?.source_end) ? claim.source_end + partOffset : claim?.source_end,
          })));
        } else {
          this.logger.warn?.(`[kb-unified] truncated child recovery failed: ${childError.message}`);
        }
      }
    }

    // Prefer complete child responses, then use the original grounded prefix only
    // to fill gaps. Deduplication is content-based and language-independent.
    const combined = [...recovered, ...partial];
    const unique = [];
    const seen = new Set();
    for (const claim of combined) {
      const key = String(claim?.f || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(claim);
    }
    this.logger.info?.(`[kb-unified] provider truncation recovered by semantic split depth=${depth}: `
      + `${unique.length} unique grounded claim(s)`);
    return unique.slice(0, maxFacts);
  }

  async _extractUnifiedReliable(window, options = {}) {
    const attempts = 1 + Math.max(0, Math.min(2, Number(process.env.KB_UNIFIED_EMPTY_RETRIES ?? 1)));
    let lastError = null;
    let best = [];
    const contentLength = String(window?.content || '').trim().length;
    const maxFacts = Math.max(1, Number(options.maxFacts) || 8);
    // "Good enough" must scale with the budget. A flat 3 meant EVERY section over
    // 700 chars was satisfied at three facts — a 5000-char window allowed 10 facts
    // returned 3 and never retried. Measured on the ingest canary: extraction
    // reported `3 candidates` on every run while the same call on the same segment
    // returned 5-7 when sampled directly, and only 3/7 of the fixture's stated
    // facts reached the user. Scale to ~60% of budget, floor 3.
    const expected = contentLength >= 700
      ? Math.min(maxFacts, Math.max(3, Math.round(maxFacts * Number(process.env.KB_UNIFIED_EXPECTED_RATIO || 0.6))))
      : 1;
    // A SPARSE result and a MALFORMED result need opposite retries, and conflating
    // them made sparse extraction unrecoverable: the retry shrank the budget to 2
    // and set compact, so a thin first pass could only ever be followed by a
    // thinner second one. Shrink only after a real failure; re-sample at full
    // budget when the completion was fine but under-delivered.
    // DON'T PAY FOR A RETRY WHEN THE INPUT IS THE PROBLEM. The re-sample below fires
    // whenever a window under-delivers, on the assumption the model was unlucky. That is
    // right for good text and pure waste for damaged text: on a PDF whose fast-pdf output
    // was letter-spaced ("S O L V I S  G E M E I N W O H L"), EVERY window logged
    // "sparse extraction (0/6)" and every one paid a second LLM call — 12 calls to extract
    // zero facts. Detect unusable input first and take the single pass.
    const _wc = String(window?.content || '');
    const _tokens = _wc.split(/\s+/).filter(Boolean);
    const _singleCharRatio = _tokens.length ? _tokens.filter((t) => t.length === 1).length / _tokens.length : 0;
    const _letterSpaced = _tokens.length >= 20 && _singleCharRatio > 0.45;
    const _wordish = (_wc.match(/\p{L}{4,}/gu) || []).length;
    const _tooFewWords = _wc.length > 400 && _wordish < 12;
    const _inputUnusable = _letterSpaced || _tooFewWords;
    if (_inputUnusable) {
      ingestDiagnostic.warn(`[kb-unified] input unusable (single_char_ratio=${_singleCharRatio.toFixed(2)} `
        + `words4=${_wordish} chars=${_wc.length}) — ONE pass, no re-sample. Fix the parse tier, not the prompt.`);
    }
    // A SUCCESSFUL EXTRACTION IS NEVER RE-ASKED. Only an EXCEPTION retries.
    //
    // The old loop re-sampled whenever a window "under-delivered" against
    // `expected = round(maxFacts * 0.6)`. That retry could not work, by construction:
    //   - it re-sent the SAME window with the SAME prompt and the SAME maxFacts
    //     (the sparse branch left `degraded` false), and _extractUnified calls the model
    //     at temperature 0 — so a deterministic question got the deterministic answer.
    //     Measured live: both attempts returned identical facts, every time.
    //   - it re-generated the WHOLE fact list, not the missing ones: the entire window
    //     as input, every fact as output. Full token cost for one perceived miss.
    //   - results were never unioned — `best` took whichever attempt had the higher
    //     COUNT, so a fact found only by the losing attempt was discarded. With model
    //     fallback the attempts can differ, which made this a way to LOSE a real fact.
    // ~95s of a measured 139s extraction stage went into this. Accuracy comes from using
    // a model that extracts correctly the first time, not from asking twice.
    //
    // Capacity is still estimated — but ONLY to report a shortfall, never to re-sample.
    // A window whose facts we failed to capture must say so out loud (the verbatim text
    // is still in segments, so evidence recall can answer it and synthesis cannot);
    // silence there is the silent-partial-completion shape this pipeline keeps producing.
    for (let attempt = 1; attempt <= (_inputUnusable ? 1 : attempts); attempt++) {
      try {
        // attempt > 1 is only ever reached from the catch below, i.e. after a real
        // failure — so a second pass is always the degraded/compact one.
        const degraded = attempt > 1;
        const claims = await this._extractUnified(window, {
          ...options,
          maxFacts: degraded ? Math.min(maxFacts, 2) : maxFacts,
          compact: degraded,
        });
        if (claims.length > best.length) best = claims;
        const { sentences: _sentencesLen, factBearing: _factBearing } = estimateFactBearingSentences(window?.content);
        const _capacity = Math.max(1, Math.min(maxFacts, _factBearing));
        // P2 ESCALATION — a USABLE, fact-bearing window that the fast extractor
        // under-delivered gets ONE pass on a STRONGER model. This is NOT the rejected
        // same-model re-sample (identical at temp 0): a different, stronger model
        // captures what the fast one missed. Guarded: input usable, real capacity
        // (>=2 fact-bearing), not already escalated, and the escalation model differs
        // from the primary. Union — keep whichever set is larger. Off via
        // KB_EXTRACT_ESCALATION_MODEL='' (disable) — default gpt-oss-120b.
        const _escModel = process.env.KB_EXTRACT_ESCALATION_MODEL ?? 'openai/gpt-oss-120b';
        const _primaryModel = options.model || process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || '';
        const _needsEscalation = best.length === 0
          || (_capacity >= 2 && best.length < Math.ceil(_capacity * 0.5));
        if (_needsEscalation
            && !_inputUnusable && !options._escalated
            && _escModel && _escModel !== _primaryModel) {
          try {
            const _esc = await this._extractUnified(window, { ...options, maxFacts, compact: false, model: _escModel, _escalated: true });
            if (Array.isArray(_esc) && _esc.length > best.length) best = _esc;
            this.logger.info?.(`[kb-unified] escalated shortfall → ${_escModel}: now ${best.length} facts (capacity≈${_capacity})`);
          } catch (e) { this.logger.warn?.(`[kb-unified] escalation to ${_escModel} failed: ${e.message}`); }
        }
        if (best.length < Math.ceil(_capacity * 0.5)) {
          this.logger.warn?.(`[kb-unified] EXTRACTION SHORTFALL: kept ${best.length} facts from a window `
            + `holding ${_factBearing}/${_sentencesLen} fact-bearing sentences (capacity≈${_capacity}) `
            + `— escalation exhausted. Those facts are absent from the MEMORY lane; the verbatim `
            + `text is still in segments, so evidence recall can answer them and synthesis cannot. `
            + `If this fires often, change the MODEL or the prompt.`);
        } else if (claims.length < expected) {
          this.logger.info?.(`[kb-unified] ${claims.length} facts (capacity≈${_capacity} from `
            + `${_factBearing}/${_sentencesLen} fact-bearing sentences) — plausible, single pass`);
        }
        return best;
      } catch (error) {
        if (error?.code === 'LLM_JSON_TRUNCATED') {
          return this._recoverTruncatedUnified(window, { ...options, maxFacts }, error);
        }
        lastError = error;
        if (attempt === attempts) throw error;
        this.logger.warn?.(`[kb-unified] extraction failed; retrying degraded (${attempt}/${attempts}): ${error.message}`);
      }
    }
    if (lastError) throw lastError;
    return best;
  }

  /**
   * Ingest ONE window via the unified extractor: create the fact memories (provenance +
   * canonical entity tags), contextual-embed them, and create the intra-window typed edges.
   * Returns factObjs (for the cross-doc co-mention pass). Self-contained + residency-safe
   * (ingestMemory → agent, createRelationship → amrAddEdge for remote).
   */
  async _ingestUnifiedWindow(window, {
    userId, orgId, documentId, metadata = {}, docTitle = '', entityContext = '', preExtractedFacts = null,
    evidenceProvenance = null, supportingEvidenceProvenance = [],
  }) {
    if (!window?.segmentId) return [];
    const memoryContext = promotionMemoryContext({
      evidenceProvenance,
      supportingEvidenceProvenance,
      documentId,
      metadata,
      userId,
    });
    const extractionModel = process.env.KB_UNIFIED_MODEL || memoryLLMRoute()?.model
      || process.env.MEMORY_FAST_MODEL || 'llama-3.1-8b-instant';
    let facts = Array.isArray(preExtractedFacts) ? preExtractedFacts : [];
    if (!preExtractedFacts) {
      try {
        facts = await this._extractUnifiedReliable(window, { entityContext, maxFacts: window.maxFacts || 8, docTitle });
      } catch (e) {
        this.logger.warn?.(`[kb-unified] extract failed: ${e.message}`);
        return [];
      }
    }
    if (!facts.length) return [];
    const vs = this.memoryGraphEngine.vectorStore;
    const idByIdx = new Array(facts.length).fill(null);
    const factObjs = [];
    const embedPending = [];
    const evidenceLinks = [];
    const derivations = [];
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      // Tags key off the NAME regardless of shape (string or typed pair) — these tags are the
      // compatibility fallback for anything not yet reading canonical entities.
      const entityTags = (fact.entities || [])
        .map((e) => normalizeEntity(typeof e === 'string' ? e : (e?.name || e?.n || '')))
        .map((sl) => (sl ? `entity:${sl}` : null)).filter(Boolean);
      // ts: date tag (the previous-version rule) — derived from the doc's event
      // date (document_date) else ingest time. Put it in the fact's OWN tags so
      // BOTH the engine write AND the vector re-upsert carry it (the ingestMemory
      // ts-stamp gets clobbered by the 2-phase write; this is the durable source).
      const _tsd = (() => { try { const d = memoryContext.documentDate ? new Date(memoryContext.documentDate) : new Date(); return Number.isNaN(d.getTime()) ? new Date() : d; } catch { return new Date(); } })();
      const _tsDay = `ts:${_tsd.toISOString().slice(0, 10)}`;
      const tags = normalizeTagsArray([
        ...(metadata.tags || []), 'promoted-memory', `memory-type:${fact.memory_type}`, 'distilled-from-kb', _tsDay, ...entityTags,
        `claim-kind:${fact.claim_kind || fact.memory_type}`,
        ...(metadata.document_type ? [`document-type:${safeDocumentType(metadata.document_type)}`] : []),
        ...(fact.memory_type === 'fact' ? ['extracted-fact'] : []),
        ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
        ...(documentId ? [`doc-id:${documentId}`] : []),
      ]);
      try {
        const claimStructure = normalizeClaimStructure(fact);
        const claimKey = stableClaimKey(claimStructure);
        const plannedMemoryId = crypto.randomUUID();
        const memoryContentHash = crypto.createHash('sha256').update(fact.f).digest('hex');
        const eventTime = claimStructure.qualifiers?.event_time || claimStructure.qualifiers?.eventTime
          || memoryContext.eventTime || null;
        const validFrom = claimStructure.qualifiers?.valid_from || claimStructure.qualifiers?.validFrom
          || memoryContext.validFrom || null;
        const validTo = claimStructure.qualifiers?.valid_to || claimStructure.qualifiers?.validTo
          || memoryContext.validTo || null;
        const res = await this.memoryGraphEngine.ingestMemory({
          id: plannedMemoryId,
          user_id: userId, org_id: orgId,
          scope: memoryContext.scope, visibility: memoryContext.visibility,
          primary_team_id: memoryContext.teamId,
          project_ids: memoryContext.projectIds,
          content: fact.f, title: provenanceMemoryTitle(docTitle, fact.t), memory_type: normalizeKbMemoryType(fact.memory_type), tags,
          importance_score: fact.importance,           // LLM-rated salience (same-pass) → confidence/recall ranking + FE score
          ...(claimKey ? { claim_key: claimKey } : {}),
          ...(claimStructure.subject?.name ? { claim_subject: claimStructure.subject.name } : {}),
          ...(claimStructure.predicate ? { claim_predicate: claimStructure.predicate } : {}),
          ...(Object.keys(claimStructure.qualifiers || {}).length ? { claim_qualifiers: claimStructure.qualifiers } : {}),
          extraction_confidence: claimStructure.extractionConfidence ?? fact.importance,
          document_date: memoryContext.documentDate,
          source_metadata: buildMemoryProvenance({
            existing: { ...memoryContext.existing, source_platform: memoryContext.sourcePlatform,
              source_type: 'knowledge_fact', source_url: memoryContext.sourceUrl,
              document_type: metadata.document_type || 'general' },
            memoryId: plannedMemoryId, sourceKind: memoryContext.sourceKind,
            documentId, sourceId: memoryContext.sourceId, sourceTitle: memoryContext.sourceTitle || docTitle,
            segmentIds: fact.support_segment_ids || [window.segmentId], userId: memoryContext.uploaderUserId, orgId,
            scope: memoryContext.scope, projectIds: memoryContext.projectIds, teamId: memoryContext.teamId,
            documentDate: memoryContext.documentDate, eventTime, validFrom, validTo,
            knownAt: memoryContext.knownAt, claimKind: fact.claim_kind,
            language: memoryContext.language, contentHash: memoryContentHash,
          }),
          metadata: buildMemoryProvenance({
            existing: {
            ...memoryContext.existing,
            document_id: documentId,
            document_type: metadata.document_type || 'general',
            document_type_confidence: metadata.document_type_confidence ?? null,
            segment_id: window.segmentId || null,
            source_start: fact.source_start,
            source_end: fact.source_end,
            source_quote: fact.source_quote,
            support_segment_ids: fact.support_segment_ids || [window.segmentId],
            support_quotes: fact.support_quotes || [fact.source_quote],
            claim: {
              key: claimKey,
              subject: claimStructure.subject,
              predicate: claimStructure.predicate || null,
              object: claimStructure.object,
              qualifiers: claimStructure.qualifiers,
              extraction_confidence: claimStructure.extractionConfidence ?? fact.importance,
            },
            distill_agent: 'kb_unified_v2',
            },
            memoryId: plannedMemoryId, sourceKind: memoryContext.sourceKind,
            documentId, sourceId: memoryContext.sourceId, sourceTitle: memoryContext.sourceTitle || docTitle,
            segmentIds: fact.support_segment_ids || [window.segmentId], userId: memoryContext.uploaderUserId, orgId,
            scope: memoryContext.scope, projectIds: memoryContext.projectIds, teamId: memoryContext.teamId,
            documentDate: memoryContext.documentDate, eventTime, validFrom, validTo,
            knownAt: memoryContext.knownAt, claimKind: fact.claim_kind,
            language: memoryContext.language, contentHash: memoryContentHash,
          }),
          skip_fact_extraction: true, defer_entity_linking: true,
          // Memories carry their authoritative document/event time as the
          // canonical suffix. Evidence remains verbatim in knowledge_segments;
          // this suffix is intentionally limited to promoted memory rows.
          append_timestamp_to_content: true,
          skipSmartRouting: true, skipPredictCalibrate: true, skipAdvisoryLock: true,
          skip_relationship_classification: true, skip_contradiction_detection: true,
        });
        const id = res?.memoryId || res?.id || null;
        if (!id || (res?.operation || '').startsWith('skipped')) continue;
        idByIdx[i] = id;
        const memoryVectorProvenance = buildMemoryProvenance({
          existing: { ...memoryContext.existing, source_platform: memoryContext.sourcePlatform,
            source_type: 'knowledge_fact', document_type: metadata.document_type || 'general' },
          memoryId: id, sourceKind: memoryContext.sourceKind, documentId, sourceId: memoryContext.sourceId,
          sourceTitle: memoryContext.sourceTitle || docTitle, segmentIds: fact.support_segment_ids || [window.segmentId],
          userId: memoryContext.uploaderUserId, orgId, scope: memoryContext.scope, projectIds: memoryContext.projectIds,
          teamId: memoryContext.teamId, documentDate: memoryContext.documentDate,
          eventTime, validFrom, validTo, knownAt: memoryContext.knownAt,
          claimKind: fact.claim_kind, language: memoryContext.language,
          contentHash: memoryContentHash,
        });
        factObjs.push({
          id, user_id: userId, org_id: orgId, content: fact.f, title: provenanceMemoryTitle(docTitle, fact.t),
          memory_type: normalizeKbMemoryType(fact.memory_type), tags,
          claim_key: claimKey,
          claim_subject: claimStructure.subject?.name || null,
          claim_predicate: claimStructure.predicate || null,
          claim_qualifiers: Object.keys(claimStructure.qualifiers || {}).length ? claimStructure.qualifiers : null,
          extraction_confidence: claimStructure.extractionConfidence ?? fact.importance,
          project: memoryContext.projectIds[0] || null,
          support_segment_ids: fact.support_segment_ids,
          support_quotes: fact.support_quotes,
          source_metadata: memoryVectorProvenance,
        });
        embedPending.push({ id, fact: fact.f, title: provenanceMemoryTitle(docTitle, fact.t),
          memory_type: normalizeKbMemoryType(fact.memory_type),
          ctxInput: `${docTitle}${window.heading ? ` — ${window.heading}` : ''}\n${fact.f}`,
          tags, project_ids: memoryContext.projectIds, primary_team_id: memoryContext.teamId,
          visibility: memoryContext.visibility, source_metadata: memoryVectorProvenance,
          metadata: memoryVectorProvenance, document_date: memoryContext.documentDate,
          valid_from: validFrom, valid_to: validTo, content_hash: memoryContentHash });
        // Collected for EVERY storage mode now. These used to be gathered only for central orgs
        // because the tables were central-only and hard-FK'd to hivemind.memories; the .amr agents
        // now carry the same two tables in their own schema, so the rows are written next to the
        // memories they describe (see the flush below, which routes central vs agent).
        evidenceLinks.push({ memoryId: id, documentId, segmentId: window.segmentId || null, linkType: 'supports', confidence: fact.importance, excerpt: fact.source_quote });
        derivations.push({ memoryId: id, derivationMethod: 'llm_extract', derivationAgent: String(extractionModel).slice(0, 100), confidence: fact.importance, metadata: { document_id: documentId, segment_id: window.segmentId, source_start: fact.source_start, source_end: fact.source_end } });
      } catch (e) { this.logger.warn?.(`[kb-unified] fact ingest failed: ${e.message}`); }
    }
    // Enrich the authoritative evidence rows with the semantic metadata learned
    // by this same extraction pass. Content remains verbatim; only filterable
    // metadata changes. This lets entity/type/temporal recall constrain evidence
    // and memory lanes symmetrically after hydration.
    try {
      const semanticBySegment = new Map();
      for (const fact of facts) {
        const ids = fact.support_segment_ids?.length ? fact.support_segment_ids : [window.segmentId];
        for (const segmentId of ids.filter(Boolean)) {
          const entry = semanticBySegment.get(segmentId) || { memoryTypes: new Set(), claimKinds: new Set(), entities: new Set() };
          entry.memoryTypes.add(normalizeKbMemoryType(fact.memory_type));
          entry.claimKinds.add(fact.claim_kind || fact.memory_type);
          for (const entity of fact.entities || []) {
            const name = typeof entity === 'string' ? entity : (entity?.name || entity?.n);
            if (name) entry.entities.add(String(name));
          }
          semanticBySegment.set(segmentId, entry);
        }
      }
      if (orgIsRemote(orgId)) {
        await amrKbProvenance(orgId, {
          evidence_links: [], derivations: [],
          segment_metadata: [...semanticBySegment.entries()].map(([segmentId, semantic]) => ({
            segment_id: segmentId,
            memory_types: [...semantic.memoryTypes],
            claim_kinds: [...semantic.claimKinds],
            entities: [...semantic.entities],
          })),
        });
      } else {
        const rows = await this.db.knowledgeSegment.findMany({
          where: { id: { in: [...semanticBySegment.keys()] }, orgId },
          select: { id: true, metadata: true },
        });
        await Promise.all(rows.map((row) => {
          const semantic = semanticBySegment.get(row.id);
          return this.db.knowledgeSegment.update({
            where: { id: row.id },
            data: { metadata: {
              ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
              memory_types: [...semantic.memoryTypes],
              claim_kinds: [...semantic.claimKinds],
              entities: [...semantic.entities],
            } },
          });
        }));
      }
    } catch (metadataError) {
      this.logger.warn?.(`[kb-unified] evidence metadata enrichment failed: ${metadataError.message}`);
    }
    // Contextual embeds (one batched call) so the facts are vector-recallable.
    if (embedPending.length && vs) {
      try {
        const vecs = (await vs.generateEmbeddings?.(embedPending.map((p) => p.ctxInput), {
          workload: 'ingestion', tenantId: orgId,
        })) || [];
        let deferredVectors = 0;
        await Promise.all(embedPending.map(async (p, idx) => {
          try {
            const vec = vecs[idx];
            if (!usableEmbedding(vec)) { deferredVectors += 1; return; }
            // Store the CLEAN fact as content; the contextual ctxInput (docTitle+heading+fact) is the
            // EMBEDDING input only (vec), never the stored content — else the filename/title leaks into
            // every fact ("loi.txt Every second…"). Mirrors the distill's flushEmbeds contract.
            await vs.storeMemory({ id: p.id, user_id: userId, org_id: orgId, content: p.fact,
              title: p.title, memory_type: p.memory_type, is_latest: true, tags: p.tags,
              project_ids: Array.isArray(p.project_ids) ? p.project_ids : [],
              primary_team_id: p.primary_team_id || null, visibility: p.visibility || 'private',
              created_at: new Date().toISOString(), source_metadata: p.source_metadata,
              metadata: p.metadata, document_date: p.document_date, valid_from: p.valid_from,
              valid_to: p.valid_to, content_hash: p.content_hash },
            { vector: vec, embeddingWorkload: 'ingestion' });
          } catch (ve) { this.logger.warn?.(`[kb-unified] embed failed: ${ve.message}`); }
        }));
        if (deferredVectors) {
          this.logger.warn?.(`[kb-unified] deferred ${deferredVectors}/${embedPending.length} fact vector(s) to reconciler after batch embedding returned incomplete rows`);
        }
      } catch (e) { this.logger.warn?.(`[kb-unified] batch embed failed: ${e.message}`); }
    }
    // ROUTED, like the batch flush further down. I broke this once: after making the collection
    // above unconditional, this site still wrote to CENTRAL Prisma for remote orgs, whose memory
    // ids do not exist in hivemind.memories — so every .amr upload threw
    // "Foreign key constraint violated: memory_evidence_links_memory_id_fkey", which aborted the
    // window and produced 53 segments and ZERO memories. Collect everywhere, write where the
    // memories actually live.
    if (evidenceLinks.length) {
      if (orgIsRemote(orgId)) {
        const res = await amrKbProvenance(orgId, {
          evidence_links: evidenceLinks.map((r) => ({
            memory_id: r.memoryId, document_id: r.documentId, segment_id: r.segmentId,
            link_type: r.linkType, confidence: r.confidence, excerpt: r.excerpt,
          })),
          derivations: derivations.map((r) => ({
            memory_id: r.memoryId, derivation_method: r.derivationMethod,
            derivation_agent: r.derivationAgent, confidence: r.confidence, metadata: r.metadata,
          })),
        });
        if (!res) this.logger.warn?.(`[kb-unified] provenance not written for remote org ${orgId} — memories still landed`);
      } else {
        await this.db.memoryEvidenceLink.createMany({ data: evidenceLinks, skipDuplicates: true });
        await this.db.memoryDerivation.createMany({ data: derivations, skipDuplicates: true });
      }
    }
    // Intra-window typed edges (from the SAME structured call — coherent, no recall race).
    for (let i = 0; i < facts.length; i++) {
      const fromId = idByIdx[i];
      if (!fromId) continue;
      for (const rel of (facts[i].rels || [])) {
        const toId = idByIdx[rel.to];
        if (!toId || toId === fromId) continue;
        try {
          await this.memoryGraphEngine.store.createRelationship({
            org_id: orgId, // residency: worker context may not carry the org — see createRelationship
            id: crypto.randomUUID(), from_id: fromId, to_id: toId, type: rel.type,
            confidence: rel.type === 'Derives' ? 0.6 : 0.85,
            metadata: { created_by: 'kb_unified_v2', document_id: documentId, intra_window: true,
              ...(rel.type === 'Derives' ? { inferred: true } : {}) },
          });
        } catch { /* best-effort; dup/FK tolerated */ }
      }
    }
    // Canonical-entity registry: turn the extractor's canonical NAMES into
    // durable CanonicalEntity + MemoryEntityLink rows. This is the LIVE KB path
    // (KB_UNIFIED_EXTRACT default on); the mirror hook in _distillFactsAsync
    // covers the legacy fallback. Awaited (not fire-and-forget) so serial
    // window calls can't race-create duplicate entities; it's already off the
    // ingest lock (post-commit) so latency lands in background Tier-2.
    const _canonItems = [];
    for (let i = 0; i < facts.length; i++) {
      if (idByIdx[i] && Array.isArray(facts[i].entities) && facts[i].entities.length) {
        _canonItems.push({ memoryId: idByIdx[i], entities: facts[i].entities });
      }
    }
    if (_canonItems.length) {
      try {
        await persistCanonicalLinks({
          prisma: this.db, organizationId: orgId, items: _canonItems, logger: this.logger,
          // Mandatory entity provenance: which file, which document, when first seen.
          sourceMeta: {
            filename: metadata.filename || docTitle || null,
            documentId,
            seenAt: new Date().toISOString().slice(0, 10),
          },
        });
      } catch (e) { this.logger.warn?.(`[canonical-entities] ${e.message}`); }
    }
    return factObjs;
  }

  /**
   * ALGORITHMIC cross-doc entity linking for KB facts (KB_ENTITY_LINK_MODE=algo) — the token
   * optimization: the unified extractor ALREADY produced each fact's canonical entities (written
   * as entity:* tags at insert), so paying one co-mention LLM call PER FACT (~24 calls/doc, each
   * carrying the full canonicalization prompt + candidate list) just to re-derive tags + edges is
   * redundant. This replaces that per-fact LLM pass with ONE candidate-pool fetch + exact
   * entity-tag intersection: cross-doc memories sharing >=1 entity tag get a Mentions edge
   * (confidence scaled by shared-tag count, capped per fact). Zero LLM tokens. The LLM co-mention
   * path stays for chat/manual memories, whose entities are NOT pre-extracted.
   * Residency-safe: pool via listLatestMemories (agent-routed for remote orgs), edges via
   * store.createRelationship (same seam the intra-window rels use).
   * @returns {Promise<number>} edges created
   */
  async _algoLinkKbFacts(uFacts, { orgId, userId, documentId, skipHybrid = false, skipMentions = false }) {
    const store = this.memoryGraphEngine?.store;
    if (!store?.createRelationship || !store?.listLatestMemories) return 0;
    const facts = (uFacts || []).filter((f) => f?.id && Array.isArray(f.tags));
    if (!facts.length) return 0;
    // ONE pool fetch for the whole doc (the per-fact LLM path re-fetched candidates per memory).
    const pool = await store.listLatestMemories({ user_id: userId, org_id: orgId, scope: 'organization' }).catch(() => []);
    const docTag = documentId ? `doc-id:${documentId}` : null;
    const batchIds = new Set(facts.map((f) => f.id));
    // entityTag -> [{id}] over OTHER-doc pool memories.
    const byEntity = new Map();
    for (const m of (pool || [])) {
      if (!m?.id || batchIds.has(m.id)) continue;
      const tags = m.tags || [];
      if (docTag && tags.includes(docTag)) continue; // same-doc: intra-doc rels already exist
      for (const t of tags) {
        if (typeof t === 'string' && t.startsWith('entity:')) {
          let arr = byEntity.get(t);
          if (!arr) { arr = []; byEntity.set(t, arr); }
          arr.push(m.id);
        }
      }
    }
    if (!byEntity.size) return 0;
    const MAX_EDGES_PER_FACT = Number(process.env.KB_ALGO_LINK_MAX_EDGES || 3);
    const poolById = new Map((pool || []).map((m) => [m.id, m]));
    let created = 0;
    for (const f of facts) {
      const shared = new Map(); // peerId -> shared-entity count
      for (const t of f.tags) {
        if (!t.startsWith('entity:')) continue;
        for (const peerId of (byEntity.get(t) || [])) shared.set(peerId, (shared.get(peerId) || 0) + 1);
      }
      const ranked = [...shared.entries()].sort((a, b) => b[1] - a[1]);
      // (a) Mentions edges — co-mention topology (cap per fact). skipMentions when the co-mention
      // LLM (llm mode) already produces Mentions; this pass then only adds deterministic evolution.
      if (!skipMentions) {
        for (const [peerId, n] of ranked.slice(0, MAX_EDGES_PER_FACT)) {
          try {
            await store.createRelationship({
              org_id: orgId, // residency: worker context may not carry the org — see createRelationship
              id: crypto.randomUUID(), from_id: f.id, to_id: peerId, type: 'Mentions',
              confidence: Math.min(0.9, 0.6 + n * 0.1),
              metadata: { created_by: 'kb_algo_link_v1', document_id: documentId, shared_entities: n },
            });
            created++;
          } catch { /* best-effort; dup/FK tolerated */ }
        }
      }
      // (b) EVOLUTION edges — Updates / Extends / Contradicts + is_latest supersession. The
      // co-mention LLM used to emit these; the unified path never had the enrich pass, so `algo`
      // mode would have dropped them. detectAndLinkContradictionsFor is ALGORITHMIC (token-sim +
      // negation/change/value-divergence regex, entity-overlap-gated, strict thresholds) — ZERO
      // LLM. Feed it the SAME entity-overlapping candidates (content already in the pool). This
      // is what keeps the graph EVOLVING (belief change, supersession, contradiction) without the
      // per-fact LLM. `Derives` (multi-source synthesis) is NOT produced here — it's a
      // cognition/dreaming-layer product, unaffected by this path.
      if (process.env.KB_ENABLE_ALGO_VERSION_EDGES === 'true'
          && typeof this.memoryGraphEngine.detectAndLinkContradictionsFor === 'function') {
        const cands = ranked.slice(0, Number(process.env.KB_ALGO_REL_MAX_CANDS || 8))
          .map(([pid]) => poolById.get(pid)).filter((m) => m && m.content);
        if (cands.length) {
          try {
            await this.memoryGraphEngine.detectAndLinkContradictionsFor(f, cands, { store, strictMode: true, maxResults: 5 });
          } catch (e) { this.logger.warn?.(`[kb-algo-rel] ${f.id?.slice?.(0, 8)}: ${e.message}`); }
        }
      }
    }
    // HYBRID (mode 'hybrid', default): the algo pass above nails the HIGH-CONFIDENCE edges
    // (explicit change verbs, negation, numeric divergence, exact entity co-mention) for free.
    // It MISSES the subtle cases — semantic contradiction with no shared words, entity-
    // canonicalization drift across docs, non-numeric updates ("CTO"→"CEO"). Escalate ONLY those
    // gray-zone pairs to ONE batched LLM call/doc (vs the old ~24 per-fact calls). Idempotent:
    // any edge the LLM re-affirms that algo already made is a no-op (createRelationship dup-tolerant).
    if (!skipHybrid && String(process.env.KB_ENTITY_LINK_MODE || 'llm') === 'hybrid') {
      try { created += await this._hybridClassifyRelations(facts, pool, poolById, byEntity, { documentId }); }
      catch (e) { this.logger.warn?.(`[kb-hybrid-rel] batched classify failed (algo edges kept): ${e.message}`); }
    }
    return created;
  }

  /**
   * ONE batched LLM call per doc to catch the relationships the algorithmic pass misses. Builds a
   * bounded set of gray-zone (fact, candidate) pairs — entity-overlapping peers PLUS the top
   * token-similar peers even without a shared entity tag (this is what catches canonicalization
   * drift: "TU München" vs "Technical University Munich" never share an entity tag) — and asks the
   * LLM to classify each as Updates/Extends/Contradicts/Mentions/none in a single call.
   * Derives is intentionally excluded: inference belongs to the asynchronous
   * cognition queue and requires independent confidence verification.
   * @returns {Promise<number>} edges created
   */
  async _hybridClassifyRelations(facts, pool, poolById, byEntity, { documentId }) {
    const store = this.memoryGraphEngine?.store;
    if (!store?.createRelationship) return 0;
    const MAX_PAIRS = Number(process.env.KB_HYBRID_MAX_PAIRS || 40);
    const PER_FACT = Number(process.env.KB_HYBRID_PER_FACT || 4);
    const SIM_FLOOR = Number(process.env.KB_HYBRID_SIM_FLOOR || 0.12);
    const otherPool = (pool || []).filter((m) => m?.id && m.content && !facts.some((f) => f.id === m.id));
    if (!otherPool.length) return 0;
    const pairs = [];
    const seen = new Set();
    for (const f of facts) {
      const cand = new Map(); // peerId -> score
      // entity-overlap peers (already ranked in the caller, recompute cheaply here)
      for (const t of (f.tags || [])) {
        if (!t.startsWith('entity:')) continue;
        for (const pid of (byEntity.get(t) || [])) cand.set(pid, (cand.get(pid) || 0) + 1);
      }
      // token-similar peers WITHOUT a shared entity tag (canonicalization-drift catch)
      for (const m of otherPool) {
        if (cand.has(m.id)) continue;
        const sim = computeTokenSimilarity(f.content || '', m.content || '');
        if (sim >= SIM_FLOOR) cand.set(m.id, sim); // score < 1 keeps them below entity-overlap peers
      }
      const top = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, PER_FACT);
      for (const [pid] of top) {
        const key = `${f.id}|${pid}`;
        if (seen.has(key)) continue;
        const peer = poolById.get(pid) || otherPool.find((m) => m.id === pid);
        if (!peer) continue;
        seen.add(key);
        pairs.push({ fromId: f.id, toId: pid, a: (f.content || '').slice(0, 220), b: (peer.content || '').slice(0, 220) });
        if (pairs.length >= MAX_PAIRS) break;
      }
      if (pairs.length >= MAX_PAIRS) break;
    }
    if (!pairs.length) return 0;

    const model = process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'deepseek/deepseek-v4-flash-0731';
    const isGptOss = /gpt-oss/i.test(model);
    const list = pairs.map((p, i) => `${i}. NEW: ${p.a}\n   PRIOR: ${p.b}`).join('\n');
    const sys = `You classify the relationship of a NEW memory to a PRIOR memory. For each numbered pair output the type of NEW relative to PRIOR:
- "Updates": NEW supersedes/corrects PRIOR (belief changed, value revised, role changed, location moved) — even if worded differently.
- "Extends": NEW adds detail to PRIOR without conflicting.
- "Contradicts": NEW conflicts with PRIOR and neither clearly supersedes.
- "Mentions": same subject/entity but otherwise unrelated facts.
- "none": unrelated.
Judge MEANING, not shared words ("HQ in Berlin" vs "relocated ops to Munich" = Updates; "TU München" vs "Technical University Munich" = same entity → Mentions/Updates as fits). Output STRICT JSON: {"edges":[{"i":<pair index>,"type":<one of the above>}]}. Omit pairs that are "none".`;
    const GS = { type: 'object', additionalProperties: false, required: ['edges'], properties: { edges: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['i', 'type'],
      properties: { i: { type: 'integer' }, type: { type: 'string', enum: ['Updates', 'Extends', 'Contradicts', 'Mentions', 'none'] } } } } } };
    const resp = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 2000,
        ...(isGptOss ? { reasoning_effort: 'low' } : {}),
        response_format: isGptOss
          ? { type: 'json_schema', json_schema: { name: 'rel_edges', strict: true, schema: GS } }
          : { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: list }],
      }),
    });
    if (!resp.ok) throw new Error(`hybrid LLM ${resp.status}`);
    const j = await resp.json();
    let parsed; try { parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
    const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
    let created = 0;
    const factById = new Map(facts.map((fact) => [fact.id, fact]));
    for (const e of edges) {
      const p = pairs[Number(e.i)];
      if (!p || !e.type || e.type === 'none') continue;
      try {
        await this._applyCuratedRelationship(e.type, p, { factById, store, documentId });
        created++;
      } catch { /* dup/FK tolerated (algo may have made the same edge) */ }
    }
    if (created) this.logger.info?.(`[kb-hybrid-rel] doc ${String(documentId).slice(0, 8)}: 1 batched LLM call over ${pairs.length} gray-zone pairs → ${created} edges`);
    return created;
  }

  async _applyCuratedRelationship(type, pair, { factById, store, documentId }) {
    if (!['Updates', 'Extends', 'Contradicts', 'Mentions'].includes(type)) {
      throw new Error(`unsupported curated relationship: ${type}`);
    }
    const source = factById.get(pair.fromId);
    if (!source?.user_id || !source?.org_id) throw new Error('curated relationship source scope missing');
    // STRICT VALIDATOR for the destructive types: the gray-zone LLM's opinion
    // alone must not create Updates (demotes is_latest) or Contradicts. Same
    // canonical subject required beyond the corpus-dominant hub entity (e.g.
    // the manufacturer org tagging every fact), no exclusive-subject conflict
    // (SolvisPia vs SolvisLea), and a same-attribute content overlap. On
    // failure the edge is DOWNGRADED to Mentions with the refusal reason kept
    // in metadata — shared-entity context is preserved, nothing is demoted.
    if (type === 'Updates' || type === 'Contradicts') {
      const _mode = relationshipValidatorMode();
      if (_mode !== 'off') {
        const target = factById.get(pair.toId);
        const hubSlugs = computeHubEntitySlugs([...factById.values()]);
        const verdict = validateSupersedingEdge(source, target || {}, { hubSlugs, requireChangeEvidence: type === 'Updates' });
        if (!verdict.ok) {
          const downgradeType = verdict.reason.startsWith('no-change-evidence') ? 'Extends' : 'Mentions';
          if (_mode === 'shadow') {
            // Observe-only: create the ORIGINAL edge type but tag the shadow verdict
            // so we can measure precision without changing graph behaviour yet.
            ingestDiagnostic.info(`[rel-validator][shadow] kb-hybrid WOULD-DOWNGRADE ${type}→${downgradeType} (${pair.fromId.slice(0,8)}→${pair.toId.slice(0,8)}): ${verdict.reason}`);
          } else { // enforce
            return store.createRelationship({
              id: crypto.randomUUID(), from_id: pair.fromId, to_id: pair.toId, type: downgradeType, confidence: 0.6,
              metadata: { created_by: 'kb_hybrid_v1', document_id: documentId, downgraded_from: type, downgrade_reason: verdict.reason },
            });
          }
        }
      }
    }
    if (type === 'Updates') {
      return this.memoryGraphEngine.applyUpdate(pair.fromId, pair.toId, {
        user_id: source.user_id, org_id: source.org_id, confidence: 0.8,
      });
    }
    if (type === 'Extends') {
      return this.memoryGraphEngine.applyExtends(pair.fromId, pair.toId, {
        user_id: source.user_id, org_id: source.org_id, confidence: 0.8,
      });
    }
    return store.createRelationship({
      id: crypto.randomUUID(), from_id: pair.fromId, to_id: pair.toId, type, confidence: 0.8,
      metadata: { created_by: 'kb_hybrid_v1', document_id: documentId },
    });
  }

  /**
   * Convert window-local extraction candidates into a small document-level
   * memory set before persistence. Evidence segments remain independently
   * searchable; this pass only decides what deserves durable-memory status.
   */
  async _curateDocumentClaims(candidates, { docTitle = '', maxMemories = 6 } = {}) {
    const incoming = Array.isArray(candidates) ? candidates : [];
    // This prefilter silently discarded any candidate lacking source_quote, BEFORE
    // the curator model ever saw it — so a claim the extractor found but did not
    // quote was lost with no log line, and the loss was indistinguishable from the
    // curator exercising judgement. Log the breakdown so "N candidates -> M
    // memories" can be attributed rather than guessed at.
    const pool = incoming
      .filter((candidate) => candidate?.segmentId && candidate?.f && candidate?.source_quote)
      .slice(0, 48);
    const droppedNoQuote = incoming.filter((c) => c?.segmentId && c?.f && !c?.source_quote).length;
    const droppedMalformed = incoming.length - pool.length - droppedNoQuote;
    if (droppedNoQuote || droppedMalformed) {
      ingestDiagnostic.warn(`[kb-curate] prefilter dropped ${droppedNoQuote + droppedMalformed} of `
        + `${incoming.length} candidates (no_source_quote=${droppedNoQuote}, `
        + `malformed=${droppedMalformed}) — these never reached the curator`);
    }
    if (incoming.length > 48) {
      ingestDiagnostic.warn(`[kb-curate] pool truncated ${incoming.length} → 48 before curation`);
    }
    if (!pool.length) return [];

    const cap = Math.max(1, Math.min(60, Number(maxMemories) || 6));
    const fallback = () => [...pool]
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
      .slice(0, cap)
      .map((candidate) => ({
        ...candidate,
        support_segment_ids: [candidate.segmentId],
        support_quotes: [candidate.source_quote],
        rels: [],
      }));

    if (pool.length === 1) return fallback();
    // Curator intentionally has an independent model policy from atomic
    // ingestion. Do not inherit KB_UNIFIED_MODEL here: that switch belongs to
    // Qwen fact/entity/relation extraction, while this stage needs the proven
    // multi-candidate grounding model until Qwen passes its own corpus.
    const model = process.env.KB_CURATOR_MODEL || 'google/gemini-2.5-flash-lite';
    const input = pool.map((candidate, index) => ({
      i: index,
      type: candidate.memory_type,
      claim_kind: candidate.claim_kind || candidate.memory_type,
      claim: String(candidate.f).slice(0, 500),
      importance: Number(candidate.importance || 0.5),
      // Names only for the curator's eyes; it reasons about text, not our internal shape.
      entities: (candidate.entities || []).slice(0, 8)
        .map((e) => (typeof e === 'string' ? e : (e?.name || e?.n || ''))).filter(Boolean),
      source: String(candidate.source_quote).slice(0, 500),
    }));
    const system = `You curate durable organizational memory from source-grounded candidates extracted from ONE document.
Return up to ${cap} memories that TOGETHER COVER EVERY distinct important claim in the document — each decision, commitment, requirement, metric, figure, date, event, validated lesson, stable preference, and defining fact. Coverage is the goal: do NOT drop a distinct high-value claim (a funding status, ownership term, price, deadline, named role) just to keep the count low. One memory per distinct claim.
Merge compatible candidates into one complete, information-dense memory. Never merge unrelated subjects. A strong memory keeps the subject together with the relevant decision or requirement, scope, owner, rationale, constraints, numbers, dates, and outcome. Do not split one coherent plan or decision into mini-facts. Prefer 1-3 concise sentences when the supporting candidates contain that context; do not pad or repeat content.
Omit slogans, generic descriptions, contact-directory trivia, repeated examples, and details useful only when reading the raw source. Every memory MUST be fully supported by its support_indices. Do not invent, infer, or add facts. Preserve names, numbers, dates, conditions, owners, and outcomes. A memory may cite multiple candidates. Use the source language. Merge ONLY genuine duplicates (the same claim restated); never merge or drop two DISTINCT claims to reduce the count.

Return ONLY valid JSON. Do not add prose, markdown, or an explanation before or after the JSON. The complete response must exactly match this shape:
{"memories":[{"title":"short descriptive title","memory_type":"fact|event|summary|synthesis","claim_kind":"fact|event|decision|preference|policy|goal|commitment|procedure|lesson|summary|synthesis","content":"1-3 source-grounded sentences","claim_subject":{"n":"canonical subject","k":"person|organization|product|place|technology|standard"},"claim_predicate":"canonical_english_relation","claim_object":{"value":"exact source-language value","type":"semantic category or empty"},"claim_qualifiers":{"scope":"only material conditions, dates, units, negation, uncertainty or rationale"},"support_indices":[0,1]}]}
Every item must include a non-empty content field and one or more valid support_indices from the supplied candidate list.`;
    // Model fallback + headroom (rosemary Bug C): the curator previously used a
    // bare chatCompletion with max_tokens:1400, so a single provider hiccup
    // (finish=error) or a truncated long-document response (finish=length) dumped
    // the ENTIRE document to the low-quality salience fallback (importance-sort +
    // top-N slice, no merge/dedup/rels). Mirror the extractor's hardening: a
    // cross-family model fallback list + ample tokens. Configurable via
    // KB_CURATOR_FALLBACK_MODELS (defaults to the extractor's chain).
    const _curatorFallbacks = (process.env.KB_CURATOR_FALLBACK_MODELS
      || process.env.KB_UNIFIED_FALLBACK_MODELS
      || 'google/gemini-2.5-flash-lite,openai/gpt-oss-120b').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const parsed = await chatCompletionWithFallback({
        // Qwen is used for atomic fact/entity/relation extraction. The
        // document curator has a stricter multi-candidate grounding contract;
        // its Qwen canary fabricated unsupported context and hit its output
        // limit, so retain the proven curator family until it passes a
        // dedicated acceptance corpus.
        models: [process.env.KB_CURATOR_MODEL || model, ..._curatorFallbacks], temperature: 0,
        max_tokens: llmProfile('kb-document-curator').maxTokens,
        json_mode: true, honorModelPolicy: false, feature: 'kb-document-curator',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Document: ${docTitle}\nCandidates:\n${JSON.stringify(input)}` },
        ],
      });
      const output = normalizeCuratedClaims(parsed.memories, pool, cap);
      const result = output.length ? output : fallback();
      // Attribute the loss. "19 candidates → 9 memories" was previously one
      // number with three possible causes — prefilter, the cap, or the model
      // merging — and they need different fixes. Name which one bound.
      const modelReturned = Array.isArray(parsed.memories) ? parsed.memories.length : 0;
      if (result.length < pool.length) {
        const bound = result.length >= cap ? 'cap'
          : modelReturned < pool.length ? 'model-merged' : 'normalize';
        ingestDiagnostic.info(`[kb-curate] pool=${pool.length} model_returned=${modelReturned} `
          + `kept=${result.length} cap=${cap} bound_by=${bound}`);
      }
      attachCoverageLedger(result, pool);
      return result;
    } catch (error) {
      this.logger.warn?.(`[kb-curator] ${String(docTitle).slice(0, 80)}: ${error.message}; using salience fallback`);
      const fb = fallback();
      attachCoverageLedger(fb, pool);
      return fb;
    }
  }

  /**
   * Cross-window fact consolidation (KB_CONSOLIDATE=1). Different windows of the same document
   * extract near-duplicate facts independently ("X was founded in 1998" appears in the intro AND
   * the timeline). One structured LLM call groups near-duplicates; for each group we KEEP the
   * canonical fact (unioning the dupes' tags into it) and DELETE the duplicates — fewer, richer
   * memories per doc, less graph noise. Mutates `uFacts` in place (removes deleted entries) so the
   * document-parent PartOf pass that follows only wires the kept set. Residency-safe: tag update +
   * delete both route through the store's remote seam for self-host orgs. Best-effort — any
   * failure keeps all facts.
   * @returns {Promise<number>} how many duplicate facts were merged away
   */
  async _consolidateDocFacts(uFacts, { docTitle = '', documentId = null } = {}) {
    const model = process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'deepseek/deepseek-v4-flash-0731';
    const isGptOss = /gpt-oss/i.test(model);
    const list = uFacts.map((f, i) => `${i}: ${String(f.content || '').slice(0, 240)}`).join('\n');
    const sys = `You deduplicate extracted document facts. Group facts that state the SAME underlying fact (same subject + same attribute/claim, possibly different wording or detail level). Do NOT group facts that are merely about the same topic — only true near-duplicates. Output STRICT JSON: {"groups":[{"keep":<index of the most complete/specific fact>,"drop":[<indexes of its duplicates>]}]}. Facts with no duplicate are omitted entirely. If there are no duplicates output {"groups":[]}.`;
    // gpt-oss is a reasoning model: with a plain json_object format it can emit its chain-of-thought
    // as `content` (prose, unparseable). Strict json_schema + low reasoning_effort forces clean JSON
    // — the exact pattern _extractUnified uses.
    const GROUP_SCHEMA = {
      type: 'object', additionalProperties: false, required: ['groups'],
      properties: { groups: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['keep', 'drop'],
        properties: { keep: { type: 'integer' }, drop: { type: 'array', items: { type: 'integer' } } },
      } } },
    };
    const resp = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 1600,
        ...(isGptOss ? { reasoning_effort: 'low' } : {}),
        response_format: isGptOss
          ? { type: 'json_schema', json_schema: { name: 'fact_dedup_groups', strict: true, schema: GROUP_SCHEMA } }
          : { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `Document: ${docTitle}\nFacts:\n${list}` },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`consolidate LLM ${resp.status}`);
    const j = await resp.json();
    let parsed;
    try { parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    if (!groups.length) return 0;

    const store = this.memoryGraphEngine?.store;
    if (!store?.deleteMemory) return 0;
    const dropSet = new Set();
    let removed = 0;
    for (const g of groups) {
      const keepIdx = Number(g.keep);
      const drops = (Array.isArray(g.drop) ? g.drop : []).map(Number)
        .filter((d) => Number.isInteger(d) && d >= 0 && d < uFacts.length && d !== keepIdx && !dropSet.has(d));
      if (!Number.isInteger(keepIdx) || keepIdx < 0 || keepIdx >= uFacts.length || !drops.length) continue;
      if (dropSet.has(keepIdx)) continue; // canonical already merged away by an earlier group — skip
      const keep = uFacts[keepIdx];
      // Union the dupes' tags into the canonical (entity:/ts:/filename: coverage survives the merge).
      const mergedTags = new Set(keep.tags || []);
      for (const d of drops) for (const t of (uFacts[d].tags || [])) mergedTags.add(t);
      try {
        if (mergedTags.size > (keep.tags || []).length && store.updateMemory) {
          await store.updateMemory(keep.id, { tags: [...mergedTags] });
          keep.tags = [...mergedTags];
        }
      } catch { /* tag union is best-effort */ }
      for (const d of drops) {
        try {
          await store.deleteMemory(uFacts[d].id);
          dropSet.add(d);
          removed++;
        } catch (e) {
          this.logger.warn?.(`[kb-consolidate] delete ${String(uFacts[d].id).slice(0, 8)} failed: ${e.message}`);
        }
      }
    }
    if (dropSet.size) {
      const keptEntries = uFacts.filter((_, i) => !dropSet.has(i));
      uFacts.length = 0;
      uFacts.push(...keptEntries);
    }
    return removed;
  }

  /**
   * Canonical Document parent + PartOf edges for the facts-only / unified paths.
   * Per-doc: create ONE document-anchor memory (title=filename, summary, high
   * importance, ts tag) and wire every distilled fact to it via a PartOf edge.
   * This is the doc→fact hierarchy the FE graph + "show source" rely on; the
   * facts-only/unified paths previously returned documentParentId:null (no
   * structure). Best-effort + residency-safe (ingestMemory→agent, edges→amrAddEdge).
   * @returns {Promise<string|null>} the document-parent memory id
   */
  async _attachDocumentParent({ memories, userId, orgId, documentId, metadata = {}, totalFacts = 0, firstContent = '' }) {
    const childIds = (memories || [])
      .filter((m) => m?.id && !(m?.operation || '').startsWith('skipped') && !m?.isParent)
      .map((m) => m.id);
    if (!childIds.length) return null;
    let docParentId = null;
    try {
      const docTitle = metadata.documentTitle || metadata.filename || `Document ${String(documentId).slice(0, 8)}`;
      // A `summary` memory must SAY something. This previously emitted a manifest:
      //   Document: canary-1785528669.txt
      //   Durable memories: 3
      //   Key topics: Altoform GmbH Employee Count and Location; ...
      // — a filename, an internal counter, and a list of topic TITLES, carrying
      // zero facts. It is typed memory_type:'summary' and indexed for recall, so
      // 57 such rows were competing with real memories while being unable to
      // answer anything. A reader who retrieves only this learns nothing.
      //
      // Build the summary from the child facts' CONTENT instead, so the document
      // parent is a self-contained account of what the document establishes.
      const childFacts = (memories || [])
        .filter((memory) => memory?.id && !memory.isParent)
        .map((memory) => String(memory.content || memory.title || '').replace(/\s+/g, ' ').trim())
        .filter((text) => text.length >= 20);
      const _summaryCap = Number(process.env.KB_DOC_SUMMARY_MAX_CHARS || 1200);
      let docSummary = '';
      if (childFacts.length) {
        // Deterministic first — this alone is strictly better than the manifest
        // and cannot fail. The LLM pass below only refines it.
        docSummary = childFacts.join(' ').slice(0, _summaryCap);
        try {
          const refined = await chatCompletionWithFallback({
            models: [process.env.KB_DOC_SUMMARY_MODEL || process.env.KB_UNIFIED_MODEL
              || process.env.MEMORY_PROCESSOR_MODEL || 'deepseek/deepseek-v4-flash-0731'],
            temperature: 0.2, max_tokens: llmProfile('kb-doc-summary').maxTokens, feature: 'kb-doc-summary',
            messages: [
              { role: 'system', content: 'Write ONE self-contained paragraph, in the SAME LANGUAGE as the supplied '
                + 'facts, stating what those facts establish. Use ONLY the supplied facts — do not add, infer, or '
                + 'TRANSLATE (a German fact stays German). Name the real subjects that appear in the facts (people, '
                + 'organisations, products, places). NEVER invent an umbrella subject out of the document title or '
                + 'filename: do not write "the <Title> project/initiative/document establishes…" when no such named '
                + 'entity appears in the facts — state what the facts say directly. Forbidden openers: "the document", '
                + '"this file", a filename, a document title, or a count of memories. Preserve figures, units, dates '
                + 'and proper nouns verbatim — never re-spell a name or reformat a number. Where the facts enumerate '
                + 'a set (supported brands, covered regions, required steps), keep the FULL enumeration in one '
                + 'sentence rather than naming one example. No preamble, no markdown.' },
              { role: 'user', content: childFacts.slice(0, 30).join('\n') },
            ],
          });
          // chatCompletion returns a raw STRING when json_mode is off (litellm-client
          // `return content`) — reading .text/.content off it yields undefined and
          // would silently fall back to the deterministic join forever.
          const text = String(typeof refined === 'string' ? refined : (refined?.content || ''))
            .replace(/\s+/g, ' ').trim();
          if (text.length >= 40) docSummary = text.slice(0, _summaryCap);
        } catch (summaryError) {
          this.logger?.warn?.(`[kb-doc-summary] refine failed, using deterministic join: ${summaryError.message}`);
        }
      } else {
        docSummary = `${docTitle} was ingested but produced no durable facts.`;
      }
      const _tsd = (() => { try { const d = metadata.document_date ? new Date(metadata.document_date) : new Date(); return Number.isNaN(d.getTime()) ? new Date() : d; } catch { return new Date(); } })();
      const parentContent = (() => {
        const _fn = (metadata.filename || docTitle || '').toString().slice(0, 80);
        const _day = _tsd.toISOString().slice(0, 10);
        let out = String(docSummary || '');
        if (_fn && !out.startsWith('\u00ab')) out = `\u00ab${_fn} : summary\u00bb ${out}`;
        if (!/\(recorded \d{4}-\d{2}-\d{2}\)\s*$/.test(out)) out = `${out.replace(/\s+$/, '')} (recorded ${_day})`;
        return out;
      })();
      const parentMemoryId = crypto.randomUUID();
      const supportSegmentIds = [...new Set((memories || []).flatMap((memory) => memory?.support_segment_ids || []).filter(Boolean))];
      const supportEvidence = [];
      const seenEvidenceSegments = new Set();
      for (const memory of memories || []) {
        const source = memory?.source_metadata || memory?.metadata || {};
        const candidates = [
          source?.evidence_provenance,
          ...(Array.isArray(source?.supporting_evidence) ? source.supporting_evidence : []),
        ];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
          const segmentId = candidate.segment_id || candidate.segmentId || JSON.stringify(candidate);
          if (seenEvidenceSegments.has(segmentId)) continue;
          seenEvidenceSegments.add(segmentId);
          supportEvidence.push(candidate);
        }
      }
      const parentContext = promotionMemoryContext({
        evidenceProvenance: supportEvidence[0] || null,
        supportingEvidenceProvenance: supportEvidence,
        documentId,
        metadata,
        userId,
      });
      const parentProvenance = buildMemoryProvenance({
        existing: { ...parentContext.existing, source_platform: parentContext.sourcePlatform,
          source_type: 'document_summary', semantic_role: 'document', ingest_tree_role: 'parent',
          document_type: metadata.document_type || 'general' },
        memoryId: parentMemoryId, sourceKind: parentContext.sourceKind, documentId,
        sourceId: parentContext.sourceId, sourceTitle: parentContext.sourceTitle || docTitle,
        segmentIds: supportSegmentIds, userId: parentContext.uploaderUserId, orgId,
        scope: parentContext.scope, projectIds: parentContext.projectIds, teamId: parentContext.teamId,
        documentDate: parentContext.documentDate, eventTime: parentContext.eventTime,
        validFrom: parentContext.validFrom, validTo: parentContext.validTo, knownAt: parentContext.knownAt,
        claimKind: 'summary', language: parentContext.language,
        contentHash: crypto.createHash('sha256').update(parentContent).digest('hex'),
      });
      const parentRes = await this.memoryGraphEngine.ingestMemory({
        id: parentMemoryId,
        user_id: userId, org_id: orgId,
        scope: parentContext.scope || (parentContext.projectIds.length > 0 ? 'project' : parentContext.teamId ? 'team' : undefined),
        visibility: parentContext.visibility,
        primary_team_id: parentContext.teamId,
        project_ids: parentContext.projectIds,
        // Same shape as every other memory: «filename : summary» header + trailing (recorded …).
        // The fact path applies this in _persistOne, which the summary does NOT go through — so
        // measured 24 of 25 memories compliant and the summary the lone exception. A summary is the
        // memory most likely to be read on its own, so it is the one that can least afford to omit
        // which file it describes or when it was recorded.
        content: parentContent,
        title: provenanceMemoryTitle(docTitle, 'Summary'), memory_type: 'summary',
        // The parent is source-local navigation context, not a durable claim.
        importance_score: 0.45,
        document_date: parentContext.documentDate,
        tags: normalizeTagsArray([
          ...(metadata.tags || []), 'knowledge-base', 'document', 'document-summary',
          `ts:${_tsd.toISOString().slice(0, 10)}`,
          ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
          ...(documentId ? [`doc-id:${documentId}`] : []),
          ...(metadata.document_type ? [`document-type:${safeDocumentType(metadata.document_type)}`] : []),
        ]),
        source_metadata: parentProvenance,
        metadata: { ...parentProvenance, document_type_confidence: metadata.document_type_confidence ?? null,
          child_count: childIds.length, total_facts: totalFacts },
        skip_fact_extraction: true, skipPredictCalibrate: true, skip_contradiction_detection: true,
        append_timestamp_to_content: true,
        skip_relationship_classification: true, smartIngest: false, skipAdvisoryLock: true, defer_entity_linking: true,
      });
      docParentId = parentRes?.memoryId || parentRes?.id || null;
      if (docParentId) {
        if (supportSegmentIds.length) {
          const summaryLinks = supportSegmentIds.map((segmentId) => ({
            memoryId: docParentId, documentId, segmentId, linkType: 'supports', confidence: 1,
          }));
          if (orgIsRemote(orgId)) {
            await amrKbProvenance(orgId, {
              evidence_links: summaryLinks.map((link) => ({ memory_id: link.memoryId,
                document_id: link.documentId, segment_id: link.segmentId,
                link_type: link.linkType, confidence: link.confidence })), derivations: [],
            });
          } else {
            await this.db.memoryEvidenceLink.createMany({ data: summaryLinks, skipDuplicates: true });
          }
        }
        const createPartOf = async (childId) => {
          const base = { id: crypto.randomUUID(), from_id: childId, to_id: docParentId, confidence: 1.0, created_by: 'document_first_ingestion', created_at: new Date().toISOString() };
          try {
            await this.memoryGraphEngine.store.createRelationship({ ...base, type: 'PartOf', metadata: { ingest_tree: true, document_id: documentId, parent_role: 'document' } });
          } catch (err) {
            this.logger.warn?.(`[doc-first] PartOf ${String(childId).slice(0, 8)}→${String(docParentId).slice(0, 8)} failed: ${err.message}`);
          }
        };
        await Promise.all(childIds.map(createPartOf));
        memories.push({ id: docParentId, operation: 'document_parent', isParent: true });
      }
    } catch (e) { this.logger.warn?.(`[doc-first] document parent attach failed: ${e.message}`); }
    return docParentId;
  }

  /**
   * Phase 2 — async enrichment pass (OFF the ingest hot path, flag-gated).
   * For each just-created fact, find its nearest existing same-org memory:
   *   • sim >= SUPPRESS  → the fact is a near-duplicate of an ALREADY-stored
   *     (different-doc) memory → soft-delete the NEW fact (keep the established
   *     one). True cross-doc dedup the salience prompt can't catch.
   *   • RELATE_MIN..SUPPRESS → attach a 'Related' edge for graph connectivity
   *     beyond shared entity: tags (the relationship-aware traversal goal).
   * Uses vectors already computed at embed time, so NO extra embedding calls.
   */
  async _enrichDocAsync({ enrichRecs, orgId, documentId }) {
    const vs = this.memoryGraphEngine?.vectorStore;
    if (!vs || typeof vs.searchMemories !== 'function') return;
    const SUPPRESS = Number(process.env.KB_ENRICH_SUPPRESS_SIM || 0.93);
    const RELATE_MIN = Number(process.env.KB_ENRICH_RELATE_MIN || 0.80);
    const docFactIds = new Set(enrichRecs.map((r) => r.factId));
    let suppressed = 0, related = 0, contradicts = 0, updates = 0, extendsN = 0;
    for (const rec of enrichRecs) {
      if (!Array.isArray(rec.vec)) continue;
      let hits = [];
      try {
        hits = await vs.searchMemories({
          vector: rec.vec, limit: 5, score_threshold: RELATE_MIN,
          filter: { must: [{ key: 'org_id', match: { value: orgId } }] },
        });
      } catch { continue; }
      // Nearest neighbour that is NOT this fact and NOT from this same doc
      // (intra-doc redundancy is already handled by the salience prompt).
      const ext = (hits || [])
        .map((h) => ({ id: h.id || h.payload?.memory_id, score: h.score ?? h.similarity ?? 0 }))
        .filter((h) => h.id && h.id !== rec.factId && !docFactIds.has(h.id));
      const top = ext[0];
      if (!top) continue;
      if (top.score >= SUPPRESS) {
        // Redundant with an established memory → drop the new duplicate.
        await this.db.memory.update({ where: { id: rec.factId }, data: { deletedAt: new Date() } }).catch(() => {});
        suppressed++;
        continue;
      }
      // PHASE-3 relationship intelligence: run the (algorithmic) contradiction
      // detector + reconciliation on this fact vs its cross-doc entity-overlapping
      // neighbours → mints Contradicts/Updates/Extends + supersession that the
      // pure-insert KB path skips. Hydrate fresh so any deferred entity: tags that
      // have landed are seen (the detector is entity-overlap-gated + strict).
      try {
        const candIds = ext.slice(0, 6).map((e) => e.id);
        const mems = this.memoryGraphEngine.store?.getMemories
          ? await this.memoryGraphEngine.store.getMemories([rec.factId, ...candIds])
          : null;
        const fact = mems?.get?.(rec.factId);
        const cands = mems ? candIds.map((id) => mems.get?.(id)).filter(Boolean) : [];
        if (fact && cands.length && this.memoryGraphEngine.detectAndLinkContradictionsFor) {
          const r = await this.memoryGraphEngine.detectAndLinkContradictionsFor(fact, cands, {
            store: this.memoryGraphEngine.store, strictMode: true, maxResults: 5,
          });
          contradicts += r.contradicts; updates += r.updates; extendsN += r.extends;
        }
      } catch (relErr) { this.logger.warn?.(`[kb-enrich] rel-detect ${String(rec.factId).slice(0, 8)}: ${relErr.message}`); }
      // Connectivity fallback: a Mentions edge to the nearest neighbour (cheap graph link).
      if (top.score >= RELATE_MIN && this.memoryGraphEngine.store?.createRelationship) {
        await this.memoryGraphEngine.store.createRelationship({
          org_id: orgId, // residency: worker context may not carry the org — see createRelationship
          id: crypto.randomUUID(), from_id: rec.factId, to_id: top.id,
          type: 'Mentions', confidence: Number(top.score.toFixed(2)),
          metadata: { created_by: 'kb_enrich', kind: 'semantic_related', document_id: documentId },
        }).catch(() => {});
        related++;
      }
    }
    this.logger.info?.(`[kb-enrich] doc ${String(documentId).slice(0, 8)}: suppressed=${suppressed} related=${related} contradicts=${contradicts} updates=${updates} extends=${extendsN} of ${enrichRecs.length}`);
  }

  /**
   * Ingest KB document upload into document-backed structure
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.filename
   * @param {Buffer} params.fileBuffer
   * @param {string} params.contentType
   * @param {Object} params.metadata
   * @returns {Promise<{documentId, segmentCount, candidateCount, promotedCount}>}
   */
  async ingestKnowledgeDocument(opts) {
    // IMAGES NEVER TAKE THE DOCUMENT PATH — enforced here, not left to callers.
    //
    // An image is not a document. There is no text to segment, so the evidence
    // rows this path would create are chunks of a vision description pointing at
    // themselves: self-referential provenance that adds rows without adding
    // proof. services/image-ingest.js is the correct owner and is explicit that
    // its description "becomes the ONE and ONLY memory of this image — nothing
    // else is stored".
    //
    // The FE already routes images to uploadImage(), but this entry point is
    // reachable directly over the API and would build a knowledge_document,
    // knowledge_segments and memory_evidence_links for a PNG. That is how
    // image-upload memories ended up 27 of 38 anchored to evidence they should
    // never have had. Fail closed with an actionable message rather than
    // silently producing the wrong shape.
    const _ext = String(opts?.filename || '').split('.').pop()?.toLowerCase();
    const _isImage = String(opts?.contentType || '').toLowerCase().startsWith('image/')
      || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif'].includes(_ext);
    if (_isImage && String(process.env.KB_ALLOW_IMAGE_DOCUMENTS || '').toLowerCase() !== 'true') {
      const err = new Error(
        `"${opts?.filename || 'image'}" is an image and must be ingested via the image endpoint `
        + '(/api/ingest/image), which stores exactly one memory and no evidence rows. '
        + 'The document path would create segments and evidence links an image cannot support.');
      err.code = 'IMAGE_NOT_A_DOCUMENT';
      err.statusCode = 415;
      this.logger?.warn?.(`[kb] rejected image on the document path: ${opts?.filename}`);
      throw err;
    }
    if (opts?.orgId && currentOrg() !== opts.orgId) return runWithOrg(opts.orgId, () => this.ingestKnowledgeDocument(opts)); // residency: org's store
    const metadata = opts?.metadata || {};
    const scopeKey = metadata.primary_team_id
      ? `team:${metadata.primary_team_id}`
      : (metadata.project_id || (Array.isArray(metadata.project_ids) && metadata.project_ids[0]))
        ? `project:${metadata.project_id || metadata.project_ids[0]}`
        : metadata.scope === 'organization'
          ? `org:${opts.orgId}`
          : `personal:${opts.userId}`;
    const checksum = crypto.createHash('sha256').update(opts.fileBuffer).digest('hex');
    const flightKey = [opts.orgId, opts.userId, opts.filename, checksum, scopeKey].join(':');
    const existingFlight = this.documentIngestFlights.get(flightKey);
    if (existingFlight) {
      const result = await existingFlight;
      return { ...result, skippedUnchanged: true, coalescedConcurrent: true };
    }

    const flight = this._ingestKnowledgeDocumentOnce(opts);
    this.documentIngestFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.documentIngestFlights.get(flightKey) === flight) {
        this.documentIngestFlights.delete(flightKey);
      }
    }
  }

  async _ingestKnowledgeDocumentOnce(opts) {
    // Remote (self-host) orgs: KB writes route to the agent — assertKbAllowedForOrg is lifted.
    // All other paths (enterprise, connector) still block via their own assertKbAllowedForOrg calls.
    if (!orgIsRemote(opts?.orgId)) assertKbAllowedForOrg(opts?.orgId);
    let { userId, orgId, filename, fileBuffer, contentType, metadata = {}, onProgress = null } = opts;
    metadata = sanitizeKnowledgeJson(metadata);
    const ingestMode = metadata.ingest_mode === 'evidence' ? 'evidence' : 'both';
    const forceReprocess = metadata.force_reprocess === true;
    const emit = (stage, progress, extra = {}) => { try { onProgress?.({ stage, progress, ...extra }); } catch { /* never let telemetry break ingest */ } };
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    // TRUE unit count, read straight from the container (slides / sheets / PDF
    // pages) by the SAME function the pre-admit quota check uses, so what we admit
    // and what we bill cannot drift apart. null = genuinely unknowable for this
    // format; the settle below then falls back to its previous evidence chain.
    const _truePageCount = await countPages(fileBuffer, filename).catch(() => null);

    // Step 1: Store raw source artifact — skipped for remote orgs (residency: raw bytes stay on agent).
    let sourceArtifact = { id: crypto.randomUUID() };
    if (!orgIsRemote(orgId)) {
      sourceArtifact = await this.db.sourceArtifact.upsert({
        where: {
          userId_orgId_checksum_sourcePlatform: {
            userId,
            orgId,
            checksum,
            sourcePlatform: 'knowledge_upload'
          }
        },
        create: {
          userId,
          orgId,
          artifactType: 'upload',
          sourcePlatform: 'knowledge_upload',
          sourceId: filename,
          contentType,
          sizeBytes: BigInt(fileBuffer.length),
          checksum,
          storageLocation: `kb/${userId}/${checksum}/${safePathSegment(filename)}`,
          payload: { filename, uploadedAt: new Date().toISOString() },
          metadata
        },
        update: {}
      });
    }

    // Step 2: Parse document with Docling
    const _tParse = Date.now();
    emit('parsing', 10);
    const rawParseResult = await this._parseDocument(fileBuffer, contentType, filename, {
      smart: metadata?.smart === true,
      // Image descriptions default ON. This was opt-in via metadata, and the KB
      // upload path never passes it — so every figure, chart and diagram in every
      // PDF was silently discarded. For a slide deck or a report that is most of
      // the document: a market-adoption chart or a compatibility table carries
      // facts that exist nowhere in the prose. The caller can still force it off.
      picture_descriptions: metadata?.picture_descriptions !== undefined
        ? metadata.picture_descriptions === true
        : String(process.env.KB_PICTURE_DESCRIPTIONS ?? 'true').toLowerCase() !== 'false',
    });
    // SECURITY BOUNDARY: parser output is untrusted document content. Redact
    // reusable authentication material once, before classification, retained
    // source text, segments, embeddings, extraction prompts, or memories see it.
    // Applying this centrally keeps evidence-only and both-mode behavior equal.
    // The parser is an untrusted boundary. Sanitize its complete structured
    // result before it can reach JSONB, segment metadata, embeddings, or a
    // remote agent. This applies identically to evidence-only and both mode.
    const parseResult = redactParsedDocument(sanitizeKnowledgeJson(rawParseResult));
    const documentClassification = metadata.document_type
      ? { type: safeDocumentType(metadata.document_type), confidence: 1 }
      : await classifyKnowledgeDocument(parseResult.text || parseResult.markdown, filename);
    const documentType = safeDocumentType(metadata.document_type || documentClassification.type);
    const documentTypeTag = `document-type:${documentType}`;
    const _msParse = Date.now() - _tParse;
    emit('parsed', 35, { parse_ms: _msParse, pages: parseResult.pages, word_count: parseResult.wordCount });

    // Step 2b: RETAIN the parsed text on the artifact.
    //
    // Step 1 says "Store raw source artifact", but it only ever wrote
    // {filename, uploadedAt} plus a COMPUTED `storageLocation` string — no bytes
    // and no text were persisted anywhere, so the source was destroyed the moment
    // this function returned. Consequence: every extractor improvement applied to
    // NEW uploads only; the existing corpus stayed frozen at whatever quality the
    // extractor had on ingest day, with no way to re-derive it (measured: 44 docs
    // at ~2.7 canonical claims each, un-reprocessable). Retaining the parsed text
    // is what makes `processing_version` mean something — a later backfill can
    // re-extract from here instead of asking the user to re-upload.
    //
    // Residency: remote (self-host) orgs deliberately keep raw content on their
    // own agent, so they are skipped here exactly as Step 1 skips them.
    if (!orgIsRemote(orgId) && sourceArtifact?.id) {
      // Prefer MARKDOWN over flat text. Docling returns both; `text` has already
      // lost the headings, tables and list structure that tell a reader — and the
      // extractor — where one distinct claim ends and the next begins. Retaining
      // the flattened form meant a future re-extraction could never recover that
      // structure, which is the whole point of retaining the source at all.
      const _parsedText = String(parseResult.markdown || parseResult.text || '');
      // Bounded so one pathological upload cannot bloat the row. Default 4MB of
      // text (~600k words) covers every document seen so far; the flag records
      // truncation so a backfill never silently re-extracts a partial source.
      const _retainCap = Math.max(0, Number(process.env.KB_RETAIN_TEXT_MAX_CHARS ?? 4_000_000));
      if (_parsedText && _retainCap > 0) {
        try {
          await this.db.sourceArtifact.update({
            where: { id: sourceArtifact.id },
            data: {
              payload: {
                ...(sourceArtifact.payload && typeof sourceArtifact.payload === 'object' ? sourceArtifact.payload : {}),
                content: _parsedText.slice(0, _retainCap),
                content_chars: _parsedText.length,
                content_truncated: _parsedText.length > _retainCap,
                parse_engine: parseResult.engine || null,
                retained_at: new Date().toISOString(),
              },
            },
          });
        } catch (retainError) {
          // Never fail an ingest because retention failed — the memories are the
          // primary product. Surface it so a silent regression is visible.
          this.logger?.warn?.(`[kb-retain] could not retain source text for ${sourceArtifact.id}: ${retainError.message}`);
        }
      }
    }

    // Step 3: Create knowledge document
    // sourceId scoped per checksum + UPLOAD SCOPE, so identical bytes in a
    // different scope (personal / project / team / org-wide) become a
    // SEPARATE document row — what the user wants when, say, an owner files
    // org-wide and an employee files the same brochure under a project.
    // Same scope + same checksum still upserts into the same row (idempotent).
    //
    // scopeKey derived from the same fields the upload-route gate uses:
    //   team:<id>      when metadata.primary_team_id
    //   project:<id>   when metadata.project_id / project_ids[0]
    //   org:<orgId>    when metadata.scope === 'organization' and no project/team
    //   personal:<uid> otherwise
    const _scopeKey = metadata.primary_team_id
      ? `team:${metadata.primary_team_id}`
      : (metadata.project_id || (Array.isArray(metadata.project_ids) && metadata.project_ids[0]))
        ? `project:${metadata.project_id || metadata.project_ids[0]}`
        : (metadata.scope === 'organization')
          ? `org:${orgId}`
          : `personal:${userId}`;
    const _scopedSourceId = `${filename}#${checksum.slice(0, 12)}#${_scopeKey}`;
    // scope-key tag enables the upload route's per-scope dedup query without
    // any schema change — gin-indexed tags[] is already there.
    const _scopeTag = `scope-key:${_scopeKey}`;
    const _docTags = Array.from(new Set([...(metadata.tags || []), _scopeTag, documentTypeTag]));

    // Canonical V5 identity: content_hash = the file checksum (sha256 of bytes);
    // canonical_ingest_key = a globally-unique hash of (org, source type, provider,
    // external id, version, content hash) — the idempotency key for this source
    // VERSION. Same bytes + same scope re-upload → identical key → the partial
    // UNIQUE (org_id, canonical_ingest_key) collapses to one document row.
    const _canonicalIngestKey = crypto.createHash('sha256')
      .update([orgId, 'knowledge_base', 'knowledge_upload', _scopedSourceId, '1', checksum].join('\u0000'))
      .digest('hex').slice(0, 64);

    // SKIP-UNCHANGED (dirty-tracking): identical bytes + same scope ALREADY parsed + distilled →
    // return the existing document's counts and spend ZERO tokens (no docling parse, no distill
    // windows, no consolidation, no entity linking). Re-uploading the same file used to re-run the
    // FULL pipeline (observed: same PDF uploaded twice → 2×675s + 2× the LLM spend).
    // Disable with KB_SKIP_UNCHANGED=0.
    if (!forceReprocess && String(process.env.KB_SKIP_UNCHANGED ?? '1') !== '0') {
      try {
        if (!orgIsRemote(orgId)) {
          // Central orgs: exact scoped-sourceId match on the central KB tables.
          const prior = await this.db.knowledgeDocument.findFirst({
            where: { orgId, sourceId: _scopedSourceId, archivedAt: null, parseStatus: 'parsed' },
            select: { id: true },
          });
          if (prior) {
            const [segs, memLinks] = await Promise.all([
              this.db.knowledgeSegment.count({ where: { documentId: prior.id } }),
              this.db.memoryEvidenceLink.count({ where: { documentId: prior.id } }).catch(() => 0),
            ]);
            if (segs > 0 && memLinks > 0) {
              this.logger.info?.(`[kb-ingest] SKIP unchanged ${filename} (checksum+scope match doc ${String(prior.id).slice(0, 8)}, ${segs} segs) — zero tokens`);
              emit('skipped-unchanged', 100, { documentId: prior.id });
              return { documentId: prior.id, segmentCount: segs, candidateCount: 0, promotedCount: memLinks, skippedUnchanged: true };
            }
          }
        } else {
          const { agentFor } = await import('../vector/mneme/remote-backend.js');
          if (agentFor(orgId)?.url === 'local:') {
            // Embedded (.amr-central) orgs: their kb rows live in schema hm ON CENTRAL — query it
            // directly. Agent rows persist checksum + the caller metadata (scope/team/project), so
            // match those (the agent table has no source_id column). Scope fields compared so the
            // same file legitimately filed under a DIFFERENT scope still ingests fresh.
            const scopeVal = metadata.scope || null;
            const teamVal = metadata.primary_team_id || null;
            const projVal = metadata.project_id || (Array.isArray(metadata.project_ids) && metadata.project_ids[0]) || null;
            const rows = await this.db.$queryRawUnsafe(
              `SELECT d.id, (SELECT count(*)::int FROM hm.knowledge_segments s WHERE s.document_id = d.id) AS segs
                 FROM hm.knowledge_documents d
                WHERE d.org_id = $1::uuid AND d.checksum = $2 AND d.filename = $3 AND d.deleted_at IS NULL
                  AND (d.metadata->>'scope') IS NOT DISTINCT FROM $4
                  AND (d.metadata->>'primary_team_id') IS NOT DISTINCT FROM $5
                  AND COALESCE(d.metadata->>'project_id', d.metadata->'project_ids'->>0) IS NOT DISTINCT FROM $6
                LIMIT 1`,
              orgId, checksum, filename, scopeVal, teamVal, projVal,
            ).catch(() => []);
            const prior = rows?.[0];
            if (prior && Number(prior.segs) > 0) {
              this.logger.info?.(`[kb-ingest] SKIP unchanged ${filename} (embedded org, checksum+scope match doc ${String(prior.id).slice(0, 8)}, ${prior.segs} segs) — zero tokens`);
              emit('skipped-unchanged', 100, { documentId: prior.id });
              return { documentId: prior.id, segmentCount: Number(prior.segs), candidateCount: 0, promotedCount: 0, skippedUnchanged: true };
            }
          }
          // True self-host (agent on the customer box): no cheap checksum probe route yet — full
          // ingest proceeds (honest gap; add a /v1/kb-doc-by-checksum probe later).
        }
      } catch (e) { this.logger.warn?.(`[kb-ingest] skip-unchanged check failed (proceeding with full ingest): ${e.message}`); }
    }

    // Step 3: Create knowledge document — route to agent for remote orgs.
    let knowledgeDoc;
    if (orgIsRemote(orgId)) {
      // A forced reprocess retains document identity. The remote agent has no
      // in-place segment reconciliation API, so atomically clear its old
      // derived rows first; otherwise re-chunking would leave duplicate
      // evidence/vector points beside the new `both` projection.
      let docId = forceReprocess && metadata.reprocess_document_id
        ? metadata.reprocess_document_id
        : crypto.randomUUID();
      if (forceReprocess && metadata.reprocess_document_id) {
        const removed = await amrKbDocDelete(orgId, { documentId: docId });
        // A document can be deleted outside the upload job lifecycle. In that
        // specific case a forced reprocess is an honest fresh ingest, not an
        // error; retain the job but allocate a new remote document id. Any
        // transport/agent failure remains terminal to avoid duplicate evidence.
        if (removed?.error === 'document not found') {
          docId = crypto.randomUUID();
        } else if (!removed?.ok) {
          const err = new Error(`Remote document reprocess cleanup failed for ${docId}: ${removed?.error || 'agent unavailable'}`);
          err.code = 'KB_REPROCESS_CLEANUP_FAILED';
          throw err;
        }
      }
      const docPayload = {
        id: docId,
        userId,
        orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType,
        title: filename,
        sourcePlatform: 'knowledge_upload',
        sourceId: _scopedSourceId,
        documentDate: new Date().toISOString(),
        wordCount: parseResult.wordCount,
        parseStatus: parseResult.success ? 'parsed' : 'failed',
        parseEngine: parseResult.engine,
        parseMetadata: parseResult.metadata || {},
        ingestMode,
        structureExtracted: parseResult.success,
        tags: _docTags,
        checksum,
        contentType,
        filename,
        createdAt: new Date().toISOString(),
        metadata: {
          ...metadata, ingest_mode: ingestMode,
          document_type: documentType, document_type_confidence: documentClassification.confidence,
        },
      };
      await amrKbDoc(orgId, docPayload);
      knowledgeDoc = { id: docId };
    } else {
      knowledgeDoc = await this.db.knowledgeDocument.upsert({
        where: {
          userId_orgId_sourcePlatform_sourceId: {
            userId,
            orgId,
            sourcePlatform: 'knowledge_upload',
            sourceId: _scopedSourceId,
          }
        },
        create: {
          ingestMode,
          userId,
          orgId,
          sourceArtifactId: sourceArtifact.id,
          documentType,
          title: filename,
          sourcePlatform: 'knowledge_upload',
          sourceId: _scopedSourceId,
          documentDate: new Date(),
          wordCount: parseResult.wordCount,
          parseStatus: parseResult.success ? 'parsed' : 'failed',
          parseEngine: parseResult.engine,
          parseMetadata: { ...(parseResult.metadata || {}), document_type: documentType, document_type_confidence: documentClassification.confidence },
          structureExtracted: parseResult.success,
          tags: _docTags,
          // Canonical V5 identity
          canonicalIngestKey: _canonicalIngestKey,
          sourceExternalId: _scopedSourceId,
          sourceVersion: '1',
          contentHash: checksum,
          processingVersion: 1,
        },
        update: {
          // Backfill provenance on pre-existing rows so document filters and
          // memory citations expose the same classification after re-upload.
          documentType,
          ingestMode,
          // Backfill canonical identity on legacy rows (idempotent).
          canonicalIngestKey: _canonicalIngestKey,
          sourceExternalId: _scopedSourceId,
          contentHash: checksum,
          parseMetadata: { ...(parseResult.metadata || {}), document_type: documentType, document_type_confidence: documentClassification.confidence },
          tags: _docTags,
        }
      });
    }

    // Step 4: Create segments from parsed structure (idempotent — re-uploads
    // of identical content reuse existing segments).
    // Remote orgs: _createSegments returns in-memory objects (no DB); no re-query needed.
    // Scope + crucial doc metadata to denormalise onto EVERY segment, so evidence
    // self-describes its scope (personal/project/team/organization) — recall,
    // chat scope lenses, and citation display then apply the same scope to
    // memories AND evidence without a document join, and the .amr/byod agent
    // (which stores segments without central's document-tag join) stays scoped too.
    const _segDocScope = {
      scope: metadata.scope
        || (_scopeKey.startsWith('project:') ? 'project'
          : _scopeKey.startsWith('team:') ? 'team'
            : _scopeKey.startsWith('org:') ? 'organization' : 'personal'),
      scopeKey: _scopeKey,
      scopeTag: _scopeTag,
      projectId: metadata.project_id || (Array.isArray(metadata.project_ids) && metadata.project_ids[0]) || null,
      projectIds: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
      teamId: metadata.primary_team_id || null,
      documentTitle: metadata.documentTitle || metadata.filename || null,
      sourceId: metadata.source_id || _scopedSourceId || knowledgeDoc.id,
      sourceKind: metadata.source_kind || metadata.source_platform || 'document',
      sourceType: metadata.source_type || 'upload',
      // All uploaded documents share one canonical retrieval platform. Preserve
      // the parser/connector origin separately in source_kind/source_id.
      sourcePlatform: 'knowledge_base',
      language: metadata.language || parseResult.metadata?.language || null,
      documentDate: metadata.document_date || knowledgeDoc.documentDate || null,
      knownAt: knowledgeDoc.createdAt || new Date().toISOString(),
    };
    const _tSeg = Date.now();
    emit('segmenting', 40);
    let segments;
    let _segmentsNeedEmbed = false; // true only when segments were freshly created this request
    if (orgIsRemote(orgId)) {
      // Always rebuild in-memory for remote — there are no central DB rows to dedup against.
      segments = await this._createSegments({
        documentId: knowledgeDoc.id,
        userId,
        orgId,
        parseResult,
        docScope: _segDocScope,
      });
      _segmentsNeedEmbed = segments.length > 0;
    } else {
      segments = await this.db.knowledgeSegment.findMany({
        where: { documentId: knowledgeDoc.id },
        orderBy: { segmentIndex: 'asc' },
      });
      if (!segments.length) {
        segments = await this._createSegments({
          documentId: knowledgeDoc.id,
          userId,
          orgId,
          parseResult,
          docScope: _segDocScope,
        });
        _segmentsNeedEmbed = segments.length > 0;
      }
    }
    // Defence in depth: stamp scope onto ANY segment a non-semantic tier
    // (fast-pdf / vision / table / enterprise) or the remote in-memory path
    // built without it, so every returned segment self-carries scope before
    // embedding + write-to-agent. Never overwrites a scope already set.
    for (const _s of (segments || [])) {
      if (_s && typeof _s === 'object') {
        const md = (_s.metadata && typeof _s.metadata === 'object') ? _s.metadata : {};
        _s.metadata = buildEvidenceMetadata({
          existing: { ...md, scope_key: md.scope_key || _segDocScope.scopeKey },
          documentId: _s.documentId || knowledgeDoc.id,
          sourceId: md.source_id || _segDocScope.sourceId,
          sourceTitle: md.source_title || _segDocScope.documentTitle,
          sourceKind: md.source_kind || _segDocScope.sourceKind,
          segmentId: _s.id, segmentIndex: _s.segmentIndex, segmentType: _s.segmentType,
          userId: _s.userId || userId, orgId: _s.orgId || orgId,
          scope: md.scope || _segDocScope.scope,
          projectId: md.project_id || _segDocScope.projectId,
          projectIds: md.project_ids || _segDocScope.projectIds,
          teamId: md.team_id || _segDocScope.teamId,
          startPage: _s.startPage, endPage: _s.endPage, headingPath: md.heading_path,
          createdAt: _s.createdAt, documentDate: md.document_date || _segDocScope.documentDate,
          eventTime: md.event_time, validFrom: md.valid_from, validTo: md.valid_to,
          knownAt: md.known_at || _segDocScope.knownAt,
          language: md.language || _segDocScope.language, contentHash: _s.contentHash,
          sourceType: md.source_type || _segDocScope.sourceType,
          sourcePlatform: md.source_platform || _segDocScope.sourcePlatform,
        });
      }
    }
    emit('segmented', 45, { segments: segments.length });
    let _msEmbed = 0;
    let _evEmbedCov = null; // P1b/P3: evidence-embed coverage {total,embedded,failed,healed}
    if (_segmentsNeedEmbed) {
      // Step 5: Embed segments.
      // Central path: store vector in Qdrant + update DB row (vectorStored=true).
      // Remote path: embed and push segment + vector to the agent via amrKbSegment.
      const _tEmbed = Date.now();
      emit('embedding', 50, { segments: segments.length, processed: 0, total: segments.length });
      _evEmbedCov = await this._embedSegments(segments, orgId, {
        onProgress: ({ processed, total }) => emit(
          'embedding',
          50 + Math.floor(20 * (total > 0 ? processed / total : 1)),
          { segments: segments.length, processed, total },
        ),
      });
      _msEmbed = Date.now() - _tEmbed;
    }
    const _msSeg = Date.now() - _tSeg;
    emit('embedded', 70, { segments: segments.length, embed_ms: _msEmbed });

    // ── PERSIST THE GRID (P3) ────────────────────────────────────────────────
    // A spreadsheet's questions are "how many", "which is highest", "what is the
    // value for X" — none answerable by similarity over prose. The parser already
    // returns {sheet, headers, rows}; the pipeline carried it and dropped it, so
    // Solvis-Mediennutzung.xlsx became 11 readable claims that cannot be counted,
    // filtered or summed. Keep the grid ALONGSIDE the claims: semantic recall is
    // unchanged, and tabular questions get an exact SQL answer.
    //
    // Best-effort — a table-persist failure must never fail an ingest that
    // otherwise succeeded.
    try {
      const _tables = Array.isArray(parseResult?.tables) ? parseResult.tables : [];
      // Say WHY when we skip. The first version of this guard short-circuited
      // silently, so a run that persisted 0 tables was indistinguishable from a
      // document that had none — the same blind spot this codebase keeps
      // producing (a hardcoded `remaining: 0`, an inert thin-extraction warning).
      if (!_tables.length) {
        if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[kb-tables] doc ${String(knowledgeDoc.id).slice(0, 8)}: parser returned no tables `
          + `(engine=${parseResult?.engine || '?'}) — nothing to persist`);
      } else if (!this.db?.documentTable) {
        ingestDiagnostic.warn('[kb-tables] db.documentTable missing — prisma client lacks the model; grid NOT persisted');
      }
      // ROUTED. This was `!orgIsRemote(...)`, so a self-host tenant's spreadsheet grids were never
      // stored anywhere. Removing the guard alone would have been WRONG: MNEME_MODE is dual, so
      // wrapPrisma hands back the real client and the rows would land in CENTRAL Postgres pointing at
      // a document that only exists in the agent's schema — the same FK-violation shape that broke
      // .amr ingestion earlier tonight, and tenant cell data in the box the tenant chose to avoid.
      if (_tables.length && orgIsRemote(orgId)) {
        const _tr = await amrKbTables(orgId, {
          document_id: knowledgeDoc.id, user_id: userId,
          tables: _tables.map((t) => ({ sheet: t?.sheet || null, headers: t?.headers || [], rows: t?.rows || [] })),
        });
        if (_tr?.error === 'document_not_found') {
          // Benign on a re-ingest pass: the skip-unchanged path can carry a document id that was
          // never persisted to the agent. Named explicitly so it is not mistaken for data loss on a
          // FIRST ingest, which would be a real bug.
          this.logger.warn?.(`[kb-tables] doc ${String(knowledgeDoc.id).slice(0, 8)} not present on the agent — `
            + `grids skipped. Expected on a re-ingest pass; on a FIRST ingest it means the document write did not land.`);
        } else if (_tr) {
          if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[kb-tables] remote doc ${String(knowledgeDoc.id).slice(0, 8)}: tables=${_tr.tables} rows=${_tr.rows}`);
        } else {
          this.logger.warn?.(`[kb-tables] remote write FAILED for doc ${knowledgeDoc.id} — grids not stored`);
        }
      } else if (_tables.length && this.db?.documentTable) {
        let _rowsTotal = 0;
        for (let ti = 0; ti < _tables.length; ti++) {
          const t = _tables[ti] || {};
          const headers = (Array.isArray(t.headers) ? t.headers : []).map((h) => String(h ?? '').slice(0, 300));
          const rows = Array.isArray(t.rows) ? t.rows : [];
          if (!rows.length) continue;
          const created = await this.db.documentTable.upsert({
            where: { documentId_tableIndex: { documentId: knowledgeDoc.id, tableIndex: ti } },
            create: {
              documentId: knowledgeDoc.id, orgId, userId,
              sheet: t.sheet ? String(t.sheet).slice(0, 255) : null,
              tableIndex: ti, headers, rowCount: rows.length,
            },
            update: { headers, rowCount: rows.length },
          });
          // cells keyed by header where available, else positional — so a query can
          // say cells->>'city' rather than guessing a column offset.
          await this.db.documentTableRow.createMany({
            skipDuplicates: true,
            data: rows.slice(0, 20000).map((r, ri) => {
              const arr = Array.isArray(r) ? r : [r];
              const cells = {};
              arr.forEach((v, ci) => {
                const key = headers[ci] && String(headers[ci]).trim() ? String(headers[ci]).trim() : `col_${ci}`;
                cells[key] = v === null || v === undefined ? null : String(v).slice(0, 2000);
              });
              return { tableId: created.id, orgId, rowIndex: ri, cells };
            }),
          });
          _rowsTotal += rows.length;
        }
        if (_rowsTotal) {
          if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[kb-tables] doc ${String(knowledgeDoc.id).slice(0, 8)}: persisted `
            + `${_tables.length} table(s), ${_rowsTotal} rows — now exactly queryable`);
        }
      }
    } catch (e) {
      ingestDiagnostic.warn(`[kb-tables] persist skipped (ingest unaffected): ${e.message}`);
    }

    // Intentional evidence-only ingest stops at the durable hybrid evidence
    // boundary. Lexical recall reads these scope-stamped segment rows (or the
    // corresponding AMR rows); semantic recall requires every segment vector.
    // Do not enter any memory-generation, curator, entity, relationship, or
    // claim-structuring path below this return.
    if (ingestMode === 'evidence') {
      if (!_evEmbedCov && !orgIsRemote(orgId)) {
        const embedded = await this.db.knowledgeSegment.count({
          where: { documentId: knowledgeDoc.id, vectorStored: true },
        });
        _evEmbedCov = {
          total: segments.length,
          embedded,
          failed: Math.max(0, segments.length - embedded),
          healed: 0,
        };
      }
      const semanticReady = Number(_evEmbedCov?.total || 0) === segments.length
        && Number(_evEmbedCov?.embedded || 0) === segments.length
        && Number(_evEmbedCov?.failed || 0) === 0;
      const lexicalReady = segments.length > 0;
      if (!semanticReady || !lexicalReady) {
        const err = new Error(
          `Evidence indexing incomplete: semantic=${Number(_evEmbedCov?.embedded || 0)}/${segments.length}, lexical=${lexicalReady ? segments.length : 0}/${segments.length}`,
        );
        err.code = 'EVIDENCE_INDEX_INCOMPLETE';
        throw err;
      }
      const pages = _truePageCount
        || Number(parseResult?.metadata?.pages)
        || new Set(segments.map((s) => s.startPage).filter((p) => p != null && p > 0)).size
        || 1;
      const coverage = {
        evidence_embed: _evEmbedCov,
        evidence_lexical: { total: segments.length, indexed: segments.length, failed: 0 },
      };
      if (KB_INGEST_VERBOSE) this.logger.info?.(`[kb-unified] EVIDENCE-ONLY doc=${String(knowledgeDoc.id).slice(0, 8)} `
        + `segments=${segments.length} semantic=${_evEmbedCov.embedded} lexical=${segments.length}; memory pipeline skipped`);
      return {
        documentId: knowledgeDoc.id,
        segmentCount: segments.length,
        candidateCount: 0,
        promotedCount: 0,
        promotedMemoryIds: [],
        evidenceOnlyReason: 'user_selected',
        pages,
        coverage,
        timings: { parse: _msParse, segment: _msSeg, embed: _msEmbed, promote: 0 },
      };
    }

    // Step 6: Promote candidate memories
    emit('promoting', 80, { segments: segments.length });
    const _tPromote = Date.now();
    // EVIDENCE MUST SURVIVE A MEMORY FAILURE — the document and all of its segments (plus their
    // embeddings) are ALREADY COMMITTED by this point, and segmentation is lossless while extraction
    // is lossy. So a promotion failure must degrade to "evidence-only", never fail the document.
    //
    // Before this guard, `await this._promoteMemories(...)` was unwrapped: any throw propagated out
    // of the whole ingest, the job was marked `failed`, and complete() never ran — so a document
    // whose segments were perfectly intact and searchable REPORTED as a failed upload. The likely
    // real-world consequence is worse than the cosmetic one: a user sees "failed", re-uploads, and
    // now has two documents (the duplicate-rows report).
    //
    // Degrading here keeps the guarantee the SHORTFALL log already promises: "the verbatim text is
    // still in segments, so evidence recall can answer them and synthesis cannot."
    let promoted;
    try {
      promoted = await this._promoteMemoriesGuarded({
      documentId: knowledgeDoc.id,
      segments,
      userId,
      orgId,
      metadata: {
        ...metadata,
        filename,
        documentTitle: filename,
        documentId: knowledgeDoc.id,
        documentHash: checksum.slice(0, 16),
        document_type: documentType,
        document_type_confidence: documentClassification.confidence,
        tags: [...(metadata.tags || []), documentTypeTag],
      },
      onProgress: ({ processed, total, promoted: promotedSoFar }) => emit(
        'promoting',
        80 + Math.floor(15 * (total > 0 ? processed / total : 1)),
        { processed, total, promoted: promotedSoFar, segments: segments.length },
      ),
    });
    } catch (err) {
      // The document + segments are durable. Report evidence-only success.
      ingestDiagnostic.error(`[kb-unified] PROMOTION FAILED doc=${String(knowledgeDoc.id).slice(0, 8)}: ${err.message}`);
      ingestDiagnostic.error(`[kb-unified] DEGRADED TO EVIDENCE-ONLY — ${segments.length} segments are COMMITTED, `
        + `embedded and searchable; the MEMORY lane is empty for this document. Evidence recall can `
        + `answer from the verbatim text; synthesis and graph traversal cannot. The document is NOT a `
        + `failed upload and must not be re-uploaded.`);
      promoted = {
        memories: [], candidates: [],
        coverage: { promotion_failed: true, promotion_error: String(err.message).slice(0, 300) },
      };
    }
    this._extractPromotedEntitiesAsync({ memories: promoted.memories, userId, orgId, documentId: knowledgeDoc.id });
    this._structureClaimsAsync({ memories: promoted.memories, orgId });
    const _msPromote = Date.now() - _tPromote;
    ingestDiagnostic.info(`[phase1-timing] parse=${_msParse}ms seg=${_msSeg}ms embed=${_msEmbed}ms promote=${_msPromote}ms segs=${segments.length} memories=${promoted.memories.length}`);
    // Per-stage drop counter (#3 observability): how many segments survived to
    // candidates → promoted memories. Surfaces silent loss ("167 segs → 13").
    emit('promoted', 95, {
      segments: segments.length,
      candidates: promoted.candidates.length,
      promoted: promoted.memories.filter(m => m?.id).length,
      timings_ms: { parse: _msParse, segment: _msSeg, embed: _msEmbed, promote: _msPromote },
    });

    // Canonical V5 result: coverage ledger + timings (additive — existing keys kept).
    // Prefer the CURATOR ledger (Phase 4: real omitted[{candidate_id,reason,importance}]
    // + highValueOmitted, so a high-value claim can't silently vanish); fall back to
    // the coarse candidate→promoted shortfall when the curator path didn't run.
    const _promotedOk = promoted.memories.filter(m => m?.id).length;
    const _cands = promoted.candidates.length;
    const coverage = promoted.coverage || {
      candidates: _cands,
      promoted: _promotedOk,
      merged: 0,
      omitted: Math.max(0, _cands - _promotedOk),
      rejected: 0,
      highValueCoverage: _cands > 0 ? Number((_promotedOk / _cands).toFixed(3)) : 1,
    };
    coverage.evidence_embed = _evEmbedCov; // segments embedded/failed/healed (P3 no-silent-partial)
    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: _cands,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id),
      evidenceOnlyReason: promoted.memories.length === 0
        ? (promoted.coverage?.promotion_failed ? 'promotion_failed' : 'extraction_yield_zero')
        : null,
      // REAL page count so the durable kbPages meter settles true pages, not
      // `Math.max(1, result.pages ?? 1)` = always 1. parseResult.metadata.pages
      // is the docling page-array length (PDFs, office decks); fall back to the
      // count of DISTINCT pages actually segmented, then 1 for text/csv.
      // TRUE unit count first. `metadata.pages` is empty for OOXML, so this used
      // to fall through to "distinct pages actually segmented" — which counts what
      // the SEGMENTER happened to attribute, not what the document contains. A real
      // 15-slide deck settled 5, so the org was billed a third of what it used and
      // the kbPages limit could not be enforced. countPages reads the container
      // directly (slides / sheets / PDF pages) and is the same function the
      // pre-admit check uses, so admit and settle can no longer disagree. The old
      // chain remains as the fallback for formats it cannot know (plain text, csv,
      // and docx whose writer left no <Pages>).
      pages: _truePageCount
        || Number(parseResult?.metadata?.pages)
        || new Set(segments.map((s) => s.startPage).filter((p) => p != null && p > 0)).size
        || 1,
      coverage,
      timings: { parse: _msParse, segment: _msSeg, embed: _msEmbed, promote: _msPromote },
    };
  }

  /**
   * Ingest enterprise document with schema extraction
   */
  async ingestEnterpriseDocument(opts) {
    if (opts?.orgId && currentOrg() !== opts.orgId) return runWithOrg(opts.orgId, () => this.ingestEnterpriseDocument(opts)); // residency
    assertKbAllowedForOrg(opts?.orgId);
    let { userId, orgId, filename, fileBuffer, contentType, schema, metadata = {} } = opts;
    metadata = sanitizeKnowledgeJson(metadata);
    schema = sanitizeKnowledgeJson(schema || {});
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Step 1: Store raw artifact
    const sourceArtifact = await this.db.sourceArtifact.upsert({
      where: {
        userId_orgId_checksum_sourcePlatform: {
          userId,
          orgId,
          checksum,
          sourcePlatform: 'enterprise_upload'
        }
      },
      create: {
        userId,
        orgId,
        artifactType: 'upload',
        sourcePlatform: 'enterprise_upload',
        sourceId: filename,
        contentType,
        sizeBytes: BigInt(fileBuffer.length),
        checksum,
        storageLocation: `enterprise/${userId}/${checksum}/${safePathSegment(filename)}`,
        payload: { filename, schema, uploadedAt: new Date().toISOString() },
        metadata
      },
      update: {}
    });

    // Step 2: Parse with Docling
    const parseResult = sanitizeKnowledgeJson(await this._parseDocument(fileBuffer, contentType, filename));

    // Step 3: Create parent knowledge document
    const parentDoc = await this.db.knowledgeDocument.create({
      data: {
        userId,
        orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType: schema?.documentType || 'enterprise_document',
        title: schema?.title || filename,
        sourcePlatform: 'enterprise_upload',
        sourceId: filename,
        documentDate: new Date(),
        wordCount: parseResult.wordCount,
        parseStatus: parseResult.success ? 'parsed' : 'failed',
        parseEngine: parseResult.engine,
        parseMetadata: { ...parseResult.metadata, schema },
        structureExtracted: parseResult.success,
        tags: metadata.tags || []
      }
    });

    // Step 4: Create schema-aware segments
    const segments = await this._createEnterpriseSegments({
      documentId: parentDoc.id,
      userId,
      orgId,
      schema,
      parseResult
    });

    // Step 5: Embed segments
    await this._embedSegments(segments);

    // Step 6: Promote canonical memories (more selective for enterprise)
    const promoted = await this._promoteMemories({
      documentId: parentDoc.id,
      segments,
      userId,
      orgId,
      metadata: {
        ...metadata,
        filename,
        documentTitle: filename,
        documentId: parentDoc.id,
        documentHash: checksum.slice(0, 16),
      },
      promotionStrategy: 'enterprise_selective'
    });
    this._extractPromotedEntitiesAsync({ memories: promoted.memories, userId, orgId, documentId: parentDoc.id });

    return {
      documentId: parentDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id)
    };
  }

  /**
   * Ingest a connector record (Slack message, Notion page, GitHub issue, etc.)
   * Text already extracted by adapter — no Docling needed. Creates
   * source_artifact + knowledge_document + 1+ knowledge_segments + memories
   * with full evidence-layer provenance.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.providerKey - slack | notion | github | linear | jira | confluence
   * @param {string} params.sourceId - provider's own ID (channel-ts, page_id, issue_id, ...)
   * @param {string} params.title
   * @param {string} params.content - full text body
   * @param {string} [params.sourceUrl]
   * @param {Date} [params.documentDate]
   * @param {Object} [params.metadata]
   */
  async ingestConnectorRecord(opts) {
    if (opts?.orgId && currentOrg() !== opts.orgId) return runWithOrg(opts.orgId, () => this.ingestConnectorRecord(opts)); // residency
    // Remote (self-host) orgs: KB writes route to the agent — guard lifted for connector path.
    if (!orgIsRemote(opts?.orgId)) assertKbAllowedForOrg(opts?.orgId);
    const { userId, orgId, providerKey, sourceId, title, content, sourceUrl = null, documentDate = null, metadata = {} } = opts;
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return { skipped: true, reason: 'empty_content' };
    }
    const checksum = crypto.createHash('sha256').update(`${providerKey}:${sourceId}:${content}`).digest('hex');

    // Step 1: source artifact (immutable evidence)
    // Remote orgs: raw content must not persist on central store (residency). Use stub id.
    const sourceArtifact = orgIsRemote(orgId)
      ? { id: crypto.randomUUID() }
      : await this.db.sourceArtifact.upsert({
          where: {
            userId_orgId_checksum_sourcePlatform: {
              userId, orgId, checksum, sourcePlatform: providerKey,
            },
          },
          create: {
            userId, orgId,
            artifactType: 'connector_record',
            sourcePlatform: providerKey,
            sourceId,
            contentType: 'text/plain',
            sizeBytes: BigInt(Buffer.byteLength(content, 'utf8')),
            checksum,
            storageLocation: `connector/${providerKey}/${userId}/${sourceId}`,
            payload: { title, content, sourceUrl, ...metadata },
            metadata,
          },
          update: {},
        });

    // Step 2: knowledge_document
    // Remote orgs: push via amrKbDoc to the agent (residency). Central path unchanged.
    let knowledgeDoc;
    if (orgIsRemote(orgId)) {
      const docId = crypto.randomUUID();
      await amrKbDoc(orgId, {
        id: docId,
        userId,
        orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType: 'connector_record',
        filename: title || `${providerKey}:${sourceId}`,
        contentType: 'text/plain',
        status: 'ready',
        checksum,
        metadata: { sourcePlatform: providerKey, sourceId, sourceUrl },
        createdAt: new Date().toISOString(),
      });
      knowledgeDoc = { id: docId };
    } else {
      knowledgeDoc = await this.db.knowledgeDocument.create({
        data: {
          userId, orgId,
          sourceArtifactId: sourceArtifact.id,
          documentType: 'connector_record',
          title: title || `${providerKey}:${sourceId}`,
          sourcePlatform: providerKey,
          sourceId,
          sourceUrl,
          documentDate: documentDate || new Date(),
          wordCount: content.split(/\s+/).filter(Boolean).length,
          parseStatus: 'parsed',
          parseEngine: 'connector-native',
          parseMetadata: {},
          structureExtracted: true,
          tags: metadata.tags || [],
        },
      });
    }

    // Step 3: single segment (whole record body) — adapter could split later.
    // Remote orgs: build in-memory segment object (no central DB write); _embedSegments
    // will push it to the agent via amrKbSegment when callerOrgId is remote.
    // Denormalise scope onto the connector/atomic segment too (mirrors the
    // document-upload path), so evidence from this path is scope-filterable and
    // self-describing on central + .amr alike.
    // Scope fields arrive either as opts.* (the ingest envelope: scope/projectId/
    // primaryTeamId) or inside opts.metadata.* (connector callers) — read both.
    const _sScope = opts.scope || metadata.scope || null;
    const _sProj = opts.projectId || metadata.project_id || (Array.isArray(metadata.project_ids) && metadata.project_ids[0]) || null;
    const _sTeam = opts.primaryTeamId || metadata.primary_team_id || null;
    const _cScopeKey = _sTeam ? `team:${_sTeam}`
      : _sProj ? `project:${_sProj}`
        : (_sScope === 'organization') ? `org:${orgId}` : `personal:${userId}`;
    const _cScopeMeta = {
      scope: _sScope
        || (_cScopeKey.startsWith('project:') ? 'project'
          : _cScopeKey.startsWith('team:') ? 'team'
            : _cScopeKey.startsWith('org:') ? 'organization' : 'personal'),
      scope_key: _cScopeKey,
      project_id: _sProj,
      team_id: _sTeam,
      document_title: title || metadata.documentTitle || null,
    };
    let segments;
    if (orgIsRemote(orgId)) {
      const segment = {
        id: crypto.randomUUID(),
        userId, orgId,
        documentId: knowledgeDoc.id,
        segmentType: 'chunk',
        segmentIndex: 0,
        content,
        contentHash: crypto.createHash('sha256').update(content).digest('hex'),
        wordCount: content.split(/\s+/).filter(Boolean).length,
        previousSegmentId: null,
        metadata: { providerKey, sourceId, ..._cScopeMeta },
        createdAt: new Date().toISOString(),
      };
      segments = [segment];
    } else {
      const segment = await this.db.knowledgeSegment.create({
        data: {
          userId, orgId,
          documentId: knowledgeDoc.id,
          segmentType: 'chunk',
          segmentIndex: 0,
          content,
          // contentHash is required (NOT NULL) — the remote branch above sets it
          // but the central insert omitted it, so connector ingestion on
          // central (managed/personal) orgs threw "Argument contentHash is
          // missing". Same sha256(content) the remote/KB paths use (dedup key).
          contentHash: crypto.createHash('sha256').update(content).digest('hex'),
          wordCount: content.split(/\s+/).filter(Boolean).length,
          startPage: null, endPage: null,
          metadata: { providerKey, sourceId, ..._cScopeMeta },
        },
      });
      segments = [segment];
    }

    // Step 4: embed segment — pass orgId so _embedSegments routes to agent for remote.
    const _evEmbedC = await this._embedSegments(segments, orgId);

    // Step 5: promote memories
    const promoted = await this._promoteMemories({
      documentId: knowledgeDoc.id,
      segments,
      userId, orgId,
      metadata: {
        ...metadata,
        filename: metadata.filename || knowledgeDoc.filename || null,
        documentTitle: metadata.filename || knowledgeDoc.filename || null,
        documentId: knowledgeDoc.id,
      },
      promotionStrategy: `connector_${providerKey}`,
    });
    this._extractPromotedEntitiesAsync({ memories: promoted.memories, userId, orgId, documentId: knowledgeDoc.id });
    this._structureClaimsAsync({ memories: promoted.memories, orgId });

    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id).filter(Boolean),
      coverage: { evidence_embed: _evEmbedC || null },
    };
  }

  /**
   * Canonical ingest front door — the SINGLE entry where memory creation starts.
   *
   * Every source (KB upload, connector record, MCP save, meeting notes, chat
   * autosave, raw API) builds a canonical {@link IngestEnvelope} and calls this.
   * Provenance is normalized ONCE here, then dispatched to the existing proven
   * pipeline by mode — identical downstream regardless of source:
   *   - document → file ? ingestKnowledgeDocument : ingestConnectorRecord (text doc)
   *               → _promoteMemories (chunk → unified extract → fact memories)
   *   - atomic   → memoryGraphEngine.ingestMemory (one memory, smart-router, edges)
   *
   * Residency is preserved automatically: every downstream entry re-enters the
   * org context (runWithOrg) and routes to the org's store (central / per-tenant
   * / self-host agent).
   *
   * @param {import('./canonical-ingest.js').IngestEnvelope} envelope
   * @returns {Promise<{ok:boolean, mode?:string, source?:string, documentId?:string,
   *   memoryIds?:string[], promotedCount?:number, segmentCount?:number,
   *   skipped?:boolean, reason?:string, error?:string}>}
   */
  async ingestSource(envelope) {
    const v = validateEnvelope(envelope);
    if (!v.ok) return { ok: false, error: v.error };

    const { userId, orgId } = envelope;
    // Run the whole ingest inside the org context so every nested store resolves
    // to this org's backend (central / per-tenant / self-host agent).
    if (currentOrg() !== orgId) {
      return runWithOrg(orgId, () => this.ingestSource(envelope));
    }

    const prov = normalizeProvenance(envelope);
    const mode = detectMode(envelope);
    const ingestMode = envelope.ingestMode === 'evidence' ? 'evidence' : 'both';
    const sourceType = envelope.source.type;
    const callerTags = Array.isArray(envelope.tags) ? envelope.tags : [];

    // Scope mapping shared by both modes (matches the upload-route / save shape).
    const scope = envelope.scope || null;
    const metadataProjectIds = Array.isArray(envelope.metadata?.project_ids)
      ? envelope.metadata.project_ids.filter(id => typeof id === 'string' && id.trim())
      : [];
    const projectId = envelope.projectId || envelope.metadata?.project_id || metadataProjectIds[0] || null;
    const projectIds = projectId ? [projectId] : metadataProjectIds;
    const primaryTeamId = envelope.primaryTeamId || null;

    if (mode === 'document') {
      // Common provenance carried via metadata → _promoteMemories stamps it on
      // every distilled fact (source_metadata + filename/doc-id tags).
      const docMeta = {
        ...(envelope.metadata || {}),
        ingest_mode: ingestMode,
        source_platform: prov.sourcePlatform,
        source_id: prov.sourceMetadata.source_id,
        source_url: prov.sourceMetadata.source_url,
        ingest_source: sourceType,
        document_date: prov.documentDate ? prov.documentDate.toISOString() : null,
        tags: [...callerTags, ...prov.provenanceTags],
        ...(scope ? { scope } : {}),
        // Thread BOTH project_id (legacy) and project_ids[] — the distill path
        // (_ingestUnifiedWindow / ingestFact) reads metadata.project_ids, and the
        // engine THROWS on scope:'project' with an empty project_ids[]. When the
        // caller passed project_ids in metadata (KB upload routes) it is already
        // spread above; envelope.projectId (meeting/MCP) is normalized to [id].
        ...(projectIds.length ? { project_id: projectIds[0], project_ids: projectIds } : {}),
        ...(primaryTeamId ? { primary_team_id: primaryTeamId } : {}),
      };

      if (envelope.file) {
        const { buffer, contentType, filename } = envelope.file;
        const r = await this.ingestKnowledgeDocument({
          userId, orgId, filename, fileBuffer: buffer, contentType,
          metadata: { ...docMeta, filename },
          // Internal callers (KB upload queue/routes) stream per-stage progress
          // into the job tracker. Not an HTTP-envelope field — undefined for
          // remote callers, which is harmless.
          onProgress: envelope.onProgress || null,
        });
        // Spread the underlying result so existing callers keep reading pages /
        // candidateCount / segmentCount / documentId; add the canonical fields.
        return { ...r, ok: true, mode, source: sourceType, memoryIds: r.promotedMemoryIds || [] };
      }

      // Text document (connector record / long note / meeting transcript):
      // reuse the connector-record pipeline (text → segment → _promoteMemories).
      const r = await this.ingestConnectorRecord({
        userId, orgId,
        providerKey: prov.sourcePlatform,
        sourceId: prov.sourceMetadata.source_id || crypto.randomUUID(),
        title: prov.title || `${sourceType}:${prov.sourceMetadata.source_id || 'record'}`,
        content: envelope.content,
        sourceUrl: prov.sourceMetadata.source_url,
        documentDate: prov.documentDate,
        metadata: { ...docMeta, filename: prov.title || undefined },
      });
      if (r.skipped) return { ok: true, mode, source: sourceType, skipped: true, reason: r.reason };
      return { ...r, ok: true, mode, source: sourceType, memoryIds: r.promotedMemoryIds || [] };
    }

    // ── evidence mode ── store the raw content as ONE recall-excluded,
    // non-distilled memory (e.g. a meeting transcript). It grounds facts by
    // shared tag but never surfaces in recall (persisted-retrieval honours
    // metadata.recall_exclude). No fact distillation, no smart-router, no edges.
    if (mode === 'evidence') {
      const evRes = await this.memoryGraphEngine.ingestMemory({
        user_id: userId,
        org_id: orgId,
        content: envelope.content,
        title: prov.title || undefined,
        memory_type: envelope.metadata?.memory_type || 'event',
        source_type: sourceType,
        source_platform: prov.sourcePlatform,
        source_metadata: prov.sourceMetadata,
        document_date: prov.documentDate || undefined,
        scope: scope || undefined,
        project_ids: projectIds,
        primary_team_id: primaryTeamId || undefined,
        visibility: envelope.metadata?.visibility || undefined,
        tags: normalizeTagsArray([...callerTags, ...prov.provenanceTags, 'evidence']),
        metadata: { ...(envelope.metadata || {}), recall_exclude: true, evidence_only: true },
        skip_fact_extraction: true,
        defer_entity_linking: true,
        skipSmartRouting: true,
        skipPredictCalibrate: true,
        skipAdvisoryLock: true,
        skip_relationship_classification: true,
        skip_contradiction_detection: true,
      });
      const evId = evRes?.memoryId || evRes?.id || null;
      // V5: evidence rows also get async claim structuring so meeting/transcript
      // sources carry the same subject/predicate/qualifiers identity for clustering.
      if (evId) this._structureClaimsAsync({ memories: [{ id: evId, content: envelope.content }], orgId });
      return { ok: true, mode, source: sourceType, memoryIds: evId ? [evId] : [], promotedCount: evId ? 1 : 0, memoryId: evId };
    }

    // ── atomic mode ── one memory through the canonical engine gateway.
    // Append the ingest-time (known_at) stamp to the CONTENT body so the
    // timestamp survives into recall/synthesis prose, matching the existing
    // "(2026-07-13T13:51Z)"-style convention. Atomic only: document mode is
    // distilled into many facts downstream, so a single raw-content suffix
    // there would be wrong. Idempotent — skip if a trailing ISO stamp is
    // already present (re-ingest / dedup), using the same recorded_at the
    // metadata + ts: tag carry so all three agree.
    const _recStamp = `(${prov.recordedAtIso.slice(0, 16)}Z)`;
    const _rawContent = typeof envelope.content === 'string' ? envelope.content : '';
    const _alreadyStamped = /\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\s*$/.test(_rawContent.trimEnd());
    const atomicContent = _alreadyStamped ? _rawContent : `${_rawContent.trimEnd()} ${_recStamp}`;
    const res = await this.memoryGraphEngine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      content: atomicContent,
      title: prov.title || undefined,
      memory_type: envelope.metadata?.memory_type || 'fact',
      source_type: sourceType,
      source_platform: prov.sourcePlatform,
      source_metadata: prov.sourceMetadata,
      document_date: prov.documentDate || undefined,
      valid_from: envelope.metadata?.valid_from || prov.documentDate || undefined,
      valid_to: envelope.metadata?.valid_to || undefined,
      scope: scope || undefined,
      primary_team_id: primaryTeamId || undefined,
      visibility: envelope.metadata?.visibility || undefined,
      // Atomic-save semantics (MCP save_memory / chat autosave): supersession
      // relationship + project_ids[] flow straight to the engine. The engine
      // (smart-router) owns the actual update/extend/contradict logic — we only
      // forward, never reimplement it here ("memory engine left untouched").
      relationship: envelope.relationship || undefined,
      relationship_explicit: Boolean(envelope.relationship),
      related_to: envelope.relatedTo || undefined,
      project_ids: projectIds,
      project: envelope.metadata?.project || undefined,
      tags: normalizeTagsArray([...callerTags, ...prov.provenanceTags]),
      code_metadata: envelope.metadata?.code_metadata || undefined,
      metadata: {
        ...(envelope.metadata || {}),
        ...(Array.isArray(envelope.metadata?.extracted_entities)
          ? { extracted_entities: envelope.metadata.extracted_entities.slice(0, 12) }
          : {}),
      },
      // V5: bounded engine processing-flag passthrough (see legacyPayloadToEnvelope).
      skip_fact_extraction: envelope.metadata?.skip_fact_extraction === true || undefined,
      skipPredictCalibrate: envelope.metadata?.skipPredictCalibrate === true || undefined,
      skipProcessing: envelope.metadata?.skipProcessing === true || undefined,
      smartIngest: envelope.metadata?.smartIngest === false ? false : undefined,
      // V5: pure-insert flags — forwarded so a caller can request the engine's
      // "nothing to serialize" fast path (graph-engine _pureInsert). Together with
      // skipPredictCalibrate + smartIngest:false these skip contradiction detection,
      // the legacy relationship classifier, and the per-user advisory lock, so
      // verbatim snapshots (e.g. meeting sections) are NOT mangled by post-commit
      // dedup/supersede under concurrency. Entity linking (defer_entity_linking-gated)
      // is untouched -> entities + typed graph edges still land. Undefined for every
      // caller that does not set them -> no behavior change for existing paths.
      skip_contradiction_detection: envelope.metadata?.skip_contradiction_detection === true || undefined,
      skip_relationship_classification: envelope.metadata?.skip_relationship_classification === true || undefined,
      skipAdvisoryLock: envelope.metadata?.skipAdvisoryLock === true || undefined,
    });
    if (res?.skipped) return { ok: true, mode, source: sourceType, skipped: true, reason: res.reason };
    const memoryIds = Array.isArray(res?.results)
      ? res.results.map(x => x?.memoryId || x?.id).filter(Boolean)
      : [res?.memoryId || res?.id].filter(Boolean);
    // Canonical-entity persistence for ATOMIC ingestion (chat / save_memory /
    // API). Document mode persists canonical entities inline; atomic went
    // through ingestMemory which tags entity:<slug> but never populated the
    // CanonicalEntity/MemoryEntityLink registry — so cross-source stitching
    // silently excluded chat/atomic memories. Derive names from the committed
    // memory's entity tags (same contract as the KB path + backfill).
    try {
      const store = this.memoryGraphEngine?.store;
      if (memoryIds.length && this.db?.canonicalEntity && store?.getMemories) {
        const mems = await store.getMemories(memoryIds);
        const items = [];
        for (const id of memoryIds) {
          const m = mems.get(id);
          const names = (m?.tags || [])
            .filter((t) => typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('person:')))
            .map((t) => t.replace(/^(entity|person):/, '').replace(/-/g, ' ').trim())
            .filter(Boolean);
          for (const e of (m?.metadata?.extracted_entities || envelope.metadata?.extracted_entities || [])) {
            if (typeof e === 'string' && e.trim()) names.push(e.trim());
            else if (e && typeof e.name === 'string' && e.name.trim()) names.push(e);
          }
          if (names.length) items.push({ memoryId: id, entities: names });
        }
        if (items.length) await persistCanonicalLinks({ prisma: this.db, organizationId: orgId, items, logger: this.logger });
      }
    } catch (e) { this.logger.warn?.(`[canonical-entities][atomic] ${e.message}`); }
    // V5 Phase 3: async claim structuring for the committed atomic memory (off hot path).
    if (memoryIds.length) this._structureClaimsAsync({ memories: [{ id: memoryIds[0], content: atomicContent }], orgId });
    return {
      ok: true, mode, source: sourceType, memoryIds,
      promotedCount: memoryIds.length, memoryId: memoryIds[0] || null,
      operation: res?.operation || null,
      // Atomic = at most one claim; coverage reflects promoted vs the single candidate.
      coverage: {
        candidates: 1, promoted: memoryIds.length, merged: 0,
        omitted: memoryIds.length ? 0 : 1, rejected: 0,
        highValueCoverage: memoryIds.length ? 1 : 0,
      },
    };
  }

  /**
   * Parse document with Docling (or fallback parsers)
   * @private
   */
  async _parseDocument(fileBuffer, contentType, filename, opts = {}) {
    try {
      if (this.doclingAdapter && process.env.DOCLING_URL) {
        const doclingResult = await this.doclingAdapter.parseBuffer(fileBuffer, {
          filename,
          contentType,
          smart: opts.smart === true,
          picture_descriptions: opts.picture_descriptions === true,
        });

        if (doclingResult) {
          // Treat parse + chunk as independent — chunker may succeed even when parser fails.
          const parseOk = !doclingResult.error && (doclingResult.text || doclingResult.markdown);
          const chunkCount = Array.isArray(doclingResult.hybridChunks) ? doclingResult.hybridChunks.length : 0;
          if (parseOk || chunkCount > 0) {
            // Synthesize text from chunks if parse failed
            const synthesizedText = parseOk
              ? doclingResult.text
              : (doclingResult.hybridChunks || []).map(c => c.text).join('\n\n');
            const rebuilt = completeChunkMarkdown(synthesizedText, doclingResult.hybridChunks);
            if (!doclingResult.markdown && rebuilt.coverage > 0 && !rebuilt.markdown) {
              ingestDiagnostic.warn(`[segments] rejected partial reconstructed markdown: chunks cover `
                + `${Math.round(rebuilt.coverage * 100)}% of parser text; preserving full text`);
            }
            return {
              success: true,
              // REPORT THE TIER THAT ACTUALLY RAN. This hardcoded 'docling', overwriting the
              // adapter's own label — it emits at least eight (plain-text, groq-image, sheet-direct,
              // csv-direct, groq-vision, pdf-parse, docling-fallback-vision/-fastpdf, seam:*).
              // Verified on one upload batch: four documents logged `tier=fast-pdf` and every row
              // recorded parse_engine='docling'. That makes "which path produced this document?"
              // unanswerable from the data and corrupts any per-tier measurement taken from it — the
              // "55 of 61 docling documents carry no heading_path" figure was mostly fast-pdf.
              // Chunks-only is a property of THIS layer (parser failed, chunker did not), so it
              // still qualifies whatever the adapter reported.
              engine: parseOk
                ? (doclingResult.engine || 'docling')
                : `${doclingResult.engine || 'docling'}-chunks-only`,
              text: synthesizedText,
              // ITEM 3: no aliasing. If docling gave us real markdown use it; otherwise rebuild it
              // from the chunk headings we already fetched (chunks-only = parser failed, chunker
              // did not), and only then fall back to NULL — so a consumer can still tell "no
              // structure available" from "structure that happens to be flat".
              markdown: doclingResult.markdown || rebuilt.markdown || null,
              structure: doclingResult.json,
              tables: doclingResult.tables || [],
              pages: doclingResult.pages || [],
              wordCount: synthesizedText.split(/\s+/).length,
              metadata: {
                confidence: doclingResult.confidence,
                pages: doclingResult.pages?.length,
                hybridChunks: Array.isArray(doclingResult.hybridChunks) ? doclingResult.hybridChunks : [],
                chunkerError: doclingResult.chunkerError || null,
                parseError: doclingResult.error || null,
              }
            };
          }
        }
      }

      // LAST RESORT. This used to `return { success: true, text: fileBuffer.toString('utf-8') }`
      // under a comment claiming it fell back "to existing parsers" — it called no parser at all,
      // it stringified the raw bytes and declared success. Measured damage in production: 4
      // documents (2 branding PDFs where the vision tier failed, 2 PPTX) produced 642 segments of
      // which 636 (99%) were the raw ZIP/PDF container, then chunked, embedded and indexed into a
      // tenant's Qdrant collection. A tier that cannot parse must FAIL, loudly — turning failure
      // into plausible-looking text is how this stayed invisible for 12 days.
      const _asText = fileBuffer.toString('utf-8');
      if (looksBinary(_asText)) {
        const _pct = Math.round(100 * binaryRatio(_asText));
        return {
          success: false,
          engine: 'unparsed',
          text: '',
          markdown: null,
          wordCount: 0,
          error: `no parser produced text for ${filename || 'this file'} and the raw bytes are `
            + `${_pct}% non-text (binary container). Nothing was indexed. Likely causes: the format `
            + `needs docling (docx/pptx/xlsx/odt/rtf/epub) and DOCLING_URL is unset or docling `
            + `failed, or a PDF needed the vision tier and it errored. Check the tier logs for this `
            + `upload rather than re-uploading.`,
          metadata: { binary_ratio: binaryRatio(_asText) },
        };
      }
      return {
        success: true,
        engine: 'plain-text',
        text: _asText,
        // ITEM 3: markdown is NULL unless it really is markdown. It must never alias flat text —
        // ingestion prefers `parseResult.markdown`, so aliasing made a flat tier claim structure it
        // does not have, and the chunker's '#' section detection then found nothing.
        markdown: /(^|\n)#{1,6}\s/.test(_asText) ? _asText : null,
        wordCount: _asText.split(/\s+/).filter(Boolean).length,
        metadata: {}
      };
    } catch (error) {
      ingestDiagnostic.error('[DocumentFirstIngestion] Parse failed:', error);
      return {
        success: false,
        engine: 'none',
        error: error.message,
        wordCount: 0,
        metadata: {}
      };
    }
  }

  /**
   * Create knowledge segments from parse result.
   * Preferred path: Docling hybrid chunker (structure-aware: respects
   * headings, paragraphs, tables). Fallback: sliding window.
   * @private
   */
  /**
   * P0.2 — heal evidence segments that never got a vector.
   *
   * The embed-reconciler guards MEMORIES only. Segments had exactly one safety
   * net: the single ingest-time re-embed in _embedSegments. When that also failed
   * — a transient embed outage, an agent write aborting under load, or the worker
   * dying between the segment insert and the vector upsert — nothing ever tried
   * again. The row sits in Postgres with vectorStored=false, so the document looks
   * complete and healthy in every UI while its evidence is permanently
   * unsearchable. That was the last silent data-loss path in ingestion.
   *
   * Deliberately reuses _embedSegments rather than reimplementing embedding:
   * per-tenant collection resolution, the batched upsert, the vectorStored flip,
   * the remote .amr path and the heal-once retry all live there, and a second copy
   * would drift the moment either changed.
   *
   * vectorStored=false is the authoritative signal: it is set only AFTER a
   * successful upsert, so a false negative costs one idempotent re-embed while a
   * false positive cannot occur.
   */
  async healUnembeddedSegments({ limit = 200, sinceHours = null, logger = console } = {}) {
    const stats = { candidates: 0, healed: 0, failed: 0, orgs: 0 };
    if (!this.db?.knowledgeSegment) return stats;
    let rows = [];
    try {
      rows = await this.db.knowledgeSegment.findMany({
        where: {
          vectorStored: false,
          ...(sinceHours ? { createdAt: { gt: new Date(Date.now() - sinceHours * 3600 * 1000) } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(2000, Number(limit) || 200)),
      });
    } catch (err) {
      logger.warn?.(`[segment-reconciler] scan failed: ${err.message}`);
      return stats;
    }
    stats.candidates = rows.length;
    if (!rows.length) return stats;

    // Group by org: _embedSegments resolves the collection per org, and mixing
    // tenants in one call would land evidence in the wrong collection.
    const byOrg = new Map();
    for (const r of rows) {
      if (!byOrg.has(r.orgId)) byOrg.set(r.orgId, []);
      byOrg.get(r.orgId).push(r);
    }
    stats.orgs = byOrg.size;
    for (const [orgId, segs] of byOrg) {
      try {
        const cov = await this._embedSegments(segs, orgId, { workload: 'maintenance' });
        stats.healed += Number(cov?.embedded || 0) + Number(cov?.healed || 0);
        stats.failed += Number(cov?.failed || 0);
      } catch (err) {
        stats.failed += segs.length;
        logger.warn?.(`[segment-reconciler] org=${String(orgId).slice(0, 8)} heal threw: ${err.message}`);
      }
    }
    if (stats.candidates > 0) {
      logger.warn?.(`[segment-reconciler] pass done: orgs=${stats.orgs} candidates=${stats.candidates} `
        + `healed=${stats.healed} failed=${stats.failed}`);
    }
    return stats;
  }

  async _createSegments({ documentId, userId, orgId, parseResult, docScope = {} }) {
    // Defend direct callers as well as ingestKnowledgeDocument's parser
    // boundary. All segment writers below now receive safe content and JSONB.
    parseResult = sanitizeKnowledgeJson(parseResult || {});
    docScope = sanitizeKnowledgeJson(docScope || {});
    const remote = orgIsRemote(orgId);
    const hybridChunks = parseResult?.metadata?.hybridChunks;
    const hasChunks = Array.isArray(hybridChunks) && hybridChunks.length > 0;
    // If parse failed AND no chunks, nothing to segment.
    if ((!parseResult.success || !parseResult.text) && !hasChunks) {
      return [];
    }
    if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[segments] hybridChunks=${hasChunks ? hybridChunks.length : 'none'} parseText=${(parseResult?.text || '').length}ch for doc ${documentId}`);

    // SEMANTIC SEGMENTS (default; reversible via KB_SEMANTIC_SEGMENTS=false). Docling's HybridChunker
    // text can start/end MID-WORD (token-window artifacts: "...doc" | "ents to share…"), poisoning the
    // evidence layer (recall hop-2) + embeddings. Re-segment the CLEAN docling markdown (or text) with
    // boundary-aware chunkText — splits only at heading/paragraph/sentence edges (forceSplit is
    // sentence-safe), never mid-word; heading-aware via markdown ##. Falls through to hybrid/fallback
    // if it yields nothing. Same clean units the distill re-windows over → uniform, no mid-word anywhere.
    if (String(process.env.KB_SEMANTIC_SEGMENTS ?? 'true').toLowerCase() !== 'false') {
      const _srcRaw = (parseResult.markdown && parseResult.markdown.trim().length > 40)
        ? parseResult.markdown : (parseResult.text || '');
      // Markers out of the CONTENT, into a map. Everything downstream — chunkText,
      // the prefix anchor, the offset->page lookup — then works on one clean string
      // in one coordinate system. See stripPageMarkers() for why this matters.
      const { text: src, marks: _seedPageMarks } = stripPageMarkers(_srcRaw);
      if (src && src.trim().length >= 40) {
        let chunks = [];
        try {
          const { chunkText } = await import('./document-chunker.js');
          // 1500 sized the segment to the EMBEDDING WINDOW (~512 BGE-M3 tokens),
          // not to a unit of meaning — and fitting the window is a ceiling, not a
          // target. Measured on a real 54-page deck: the parser handed us 53
          // chunks and this collapsed them into 20 at ~1273 chars each. Two costs,
          // both observed on that document:
          //   retrieval  — one vector averaging several topics is far less precise
          //                than one vector per topic (supermemory chunks the same
          //                file into 86, ~one claim each, incl. one per table ROW);
          //   extraction — a 7-row compatibility matrix landing inside a single
          //                segment reaches the extractor as a wall of pipe-
          //                delimited text, and came back as four partial rows with
          //                three rows dropped entirely.
          const TARGET = Number(process.env.KB_SEGMENT_CHARS || 700);
          // overlapSize was 0, so a claim straddling a boundary was cut in half and
          // NEITHER side held it whole. Carry roughly a sentence across the seam.
          const OVERLAP = Number(process.env.KB_SEGMENT_OVERLAP_CHARS || 120);
          chunks = (chunkText(src, { targetSize: TARGET, maxSize: Math.round(TARGET * 1.5), minSize: 200, overlapSize: OVERLAP }) || [])
            .map((c) => (c && c.text ? c.text.trim() : '')).filter((t) => t.length >= 20);
        } catch (e) { ingestDiagnostic.warn(`[segments] semantic chunk failed: ${e.message}`); }
        if (chunks.length) {
          const segments = [];
          let segmentIndex = 0;
          let previousSegmentId = null;
          // METADATA-AWARE SEGMENTATION. The schema has declared segment_type (with an
          // enum in its own comment), depth, start_page, end_page and metadata since it was
          // written — AND an index on segment_type — but the writer filled 'structured'
          // (a value not even in that enum), depth 0 and null pages. Measured: 0 of 101
          // segments had a page, and every row said 'structured'. Populating them is
          // additive, needs no migration, and cannot regress anything.
          //
          // Everything below is DETERMINISTIC — no LLM. It also lands on the shared `base`
          // object, so hybrid, amr_embedded and byod_amr get identical metadata rather than
          // the central path being richer.

          // offset -> page, from Docling's own `<!-- page N -->` markers in the markdown.
          // Already extracted, in cleaned-string coordinates, by stripPageMarkers().
          const _pageMarks = _seedPageMarks.slice();
          // pdf-parse (the fast-pdf tier) emits `-- N of M --` instead of Docling's HTML
          // comment. Without this, every text-native PDF got start_page=null — measured
          // 0/53 on a paper that fast-pdf handled perfectly otherwise, so citations could
          // not name a page. Same markers the tier already splits on for hybridChunks.
          // (fast-pdf's `-- N of M --` is handled by stripPageMarkers too.)
          // AUTHORITATIVE SOURCE — the parser already knows the page.
          //
          // Every tier that can paginate emits hybridChunks as
          // { text, headings, page }, built from the PDF's own page structure
          // (fast-pdf splits on the real page markers to form pageBlocks). Re-deriving
          // pages by sniffing markers out of the FLATTENED text is lossy: the split that
          // produced those chunks can consume the markers, so `src` may carry none at
          // all — measured live on a 12-page upload that produced 21 correctly-paged
          // chunks and still logged `with_page=0/44`, leaving citations unable to name a
          // page. Map the parser's own assignment onto text offsets instead.
          //
          // Guard: require MORE THAN ONE distinct page. A single page means the parser
          // hit its own `pageBlocks.length === 0` fallback and labelled the whole
          // document page 1; stamping that on every segment would FABRICATE citations
          // pointing at a page nobody verified. An honest null beats a confident wrong
          // page, so in that case we fall through and leave the page unset.
          if (!_pageMarks.length && Array.isArray(hybridChunks) && hybridChunks.length) {
            const _pages = new Set(hybridChunks
              .map((c) => Number(c?.page))
              .filter((p) => Number.isFinite(p) && p > 0));
            if (_pages.size > 1) {
              const _s = String(src);
              let _pcur = 0;
              for (const c of hybridChunks) {
                const _pg = Number(c?.page);
                const _anchor = String(c?.text || '').trim().slice(0, 60);
                if (!Number.isFinite(_pg) || _pg <= 0 || _anchor.length < 12) continue;
                let _at = _s.indexOf(_anchor, _pcur);
                if (_at < 0) _at = _s.indexOf(_anchor); // wrap once — chunks may overlap
                if (_at < 0) continue;
                _pageMarks.push({ at: _at, page: _pg });
                _pcur = _at + 1;
              }
              _pageMarks.sort((a, b) => a.at - b.at);
              if (_pageMarks.length) {
                if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[segments] page map from parser chunks: ${_pageMarks.length} anchors across ${_pages.size} pages`);
              }
            }
          }
          // Fallback: form-feed (\f, ASCII 12) page breaks. pdf-parse / pdfjs text
          // extraction inserts these at page boundaries when neither Docling HTML comments
          // nor "-- N of M --" markers are present — the fast-pdf/vision tiers that left
          // start_page=null (P6). Page 1 begins at offset 0; each \f starts the next page.
          // A tier that emits no page signal at all (some OCR) still yields no marks and is
          // logged honestly below rather than guessed.
          if (!_pageMarks.length && String(src).indexOf('\f') !== -1) {
            _pageMarks.push({ at: 0, page: 1 });
            const _s = String(src);
            let _pg = 1;
            for (let i = 0; i < _s.length; i += 1) {
              if (_s[i] === '\f') { _pg += 1; _pageMarks.push({ at: i, page: _pg }); }
            }
          }
          const _pageAt = (off) => {
            if (!_pageMarks.length || off == null) return null;
            let page = null;
            for (const mk of _pageMarks) { if (mk.at <= off) page = mk.page; else break; }
            // Text BEFORE the first anchor belongs to the first anchored page —
            // nothing can sit earlier than the document's first page. Without this
            // the leading segment came back null even on a fully mapped document
            // (measured: with_page=7/8, the miss being segment 0). This is not a
            // guess: the first mark is the earliest page the parser identified.
            if (page === null && off < _pageMarks[0].at) page = _pageMarks[0].page;
            return page;
          };
          // running cursor so repeated text does not resolve to the first occurrence
          let _cursor = 0;
          // heading stack -> full hierarchy path, not just the nearest heading
          const _hstack = [];
          for (const text of chunks) {
            const contentHash = crypto.createHash('sha256').update(text).digest('hex');
            const hm = text.match(/^(#{1,6})\s+(.+)$/m);
            let heading = hm ? hm[2].slice(0, 500) : null;
            let level = hm ? hm[1].length : 0;
            // FLAT TEXT (fast-pdf / whisper / txt) has no '#'. Without a fallback,
            // heading_path was 0/53 on a text-native PDF — the metadata-aware work was
            // inert on that tier. Deterministic heuristics only, no LLM:
            //   "3.2 Method"  -> level 2 (dot depth)   |   "INTRODUCTION" -> level 1
            // Guarded: short line, no terminal period, at least one letter run.
            if (!heading) {
              const _lines = text.split('\n');
              // Window widened 4 -> 8: on fast-pdf output a page marker and blank lines often
              // precede the heading, so a 4-line window missed it entirely.
              for (let _li = 0; _li < Math.min(_lines.length, 8); _li += 1) {
                const raw = _lines[_li];
                const line = raw.trim();
                if (!line || line.length > 90 || /[.;,]$/.test(line) || !/\p{L}{3}/u.test(line)) continue;
                // A trailing colon is a heading marker ("Zusammenfassung:"), not a disqualifier —
                // the old guard rejected it along with sentence punctuation. Strip it and continue.
                const _bare = line.replace(/:$/, '').trim();
                if (!_bare || !/\p{L}{3}/u.test(_bare)) continue;
                // NUMBERED SECTIONS — but a decimal VALUE in a table row is not a section number.
                // Measured on a real document: "0.88 Internal claim database [5]" was accepted as a
                // heading, and because heading_path is INHERITED down the _hstack it then stamped itself
                // onto 39 of 53 segments and into their «filename : heading» prefixes. A wrong heading is
                // worse than none. Rejected now: a leading 0. (decimals, not sections), a bracketed
                // citation/table ref [5], and components above 99 (measurements, not section numbers).
                const numbered = /\[\d+\]/.test(_bare) ? null
                  : _bare.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(\p{Lu}[^\n]{2,80})$/u);
                if (numbered && !/^0\./.test(numbered[1])
                    && numbered[1].split('.').every((n) => Number(n) > 0 && Number(n) <= 99)) {
                  heading = line.slice(0, 500);
                  level = numbered[1].split('.').length;
                  break;
                }
                const letters = _bare.replace(/[^\p{L}]/gu, '');
                if (letters.length >= 6 && letters === letters.toUpperCase() && _bare.split(/\s+/).length <= 9) {
                  heading = _bare.slice(0, 500); level = 1; break;
                }
                // TITLE CASE / ISOLATED SHORT LINE — the style most real documents actually use
                // ("Executive Summary", "Marktumfeld und Wettbewerb"). Neither numbered nor ALL-CAPS,
                // so both tiers above miss it, which is why corpus coverage sat at 993/3744 (27%).
                // The discriminator is STRUCTURAL, not lexical: a heading is isolated — the next line
                // is blank (or it is the last line). A sentence of similar length is not. That keeps
                // the rule deterministic and avoids treating ordinary short sentences as headings.
                const _next = (_lines[_li + 1] ?? '').trim();
                const _isolated = _next === '' || _li === _lines.length - 1;
                if (_isolated && _bare.length <= 80) {
                  const words = _bare.split(/\s+/).filter(Boolean);
                  const capped = words.filter((w) => /^[\p{Lu}\d]/u.test(w)).length;
                  // >=60% of words start capitalised (or one long capitalised word), and it does not
                  // read as a sentence fragment (no lowercase-only opener).
                  if (words.length >= 1 && words.length <= 12 && capped / words.length >= 0.6
                      && /^\p{Lu}/u.test(_bare)) {
                    heading = _bare.slice(0, 500); level = 2; break;
                  }
                }
              }
            }
            if (heading) {
              while (_hstack.length && _hstack[_hstack.length - 1].level >= level) _hstack.pop();
              _hstack.push({ level, title: heading });
            }
            const headingPath = _hstack.map((h) => h.title);

            // chunkText returns `{ text: currentChunk.trim(), index }` — no offsets — and the
            // .trim() means indexOf(fullChunk) MISSES. Measured: 90 of 93 segments got no
            // offset and therefore no page. Anchor on a PREFIX instead: the chunk's interior
            // is a verbatim substring of src, only its edges were trimmed.
            const _anchor = text.slice(0, 60);
            let found = _anchor.length >= 12 ? String(src).indexOf(_anchor, _cursor) : -1;
            if (found < 0 && _anchor.length >= 12) found = String(src).indexOf(_anchor); // wrap once
            if (found < 0) found = String(src).indexOf(text.slice(0, 24), _cursor);
            const startOffset = found >= 0 ? found : null;
            const endOffset = startOffset != null ? startOffset + text.length : null;
            if (found >= 0) _cursor = found + Math.max(1, text.length - 250); // allow for overlap
            const startPage = _pageAt(startOffset);
            const endPage = _pageAt(endOffset);

            // HONEST segment_type, matching the enum the schema documents.
            const _lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
            const _pipeRows = _lines.filter((l) => l.startsWith('|') && l.endsWith('|')).length;
            const segmentType = _pipeRows >= 2 ? 'table'
              : /^\s*(!\[|<!--\s*image|Figure|Abbildung|Diagram)/i.test(text) ? 'figure'
                : _lines.filter((l) => /^([-*+]|\d+\.)\s/.test(l)).length >= Math.max(2, Math.ceil(_lines.length * 0.6)) ? 'list'
                  : (heading && _lines.length <= 2) ? 'heading'
                    : 'paragraph';

            const base = {
              // Control bytes never reach a segment, whichever tier produced the text. The seam sanitises
      // its own output, but server.js's upload tier chain does not go through it yet, so this is the
      // one place every tier's text converges before it is stored, embedded and indexed.
      documentId, userId, orgId, segmentType, content: sanitizeSegmentText(text), contentHash,
              segmentIndex, previousSegmentId, depth: _hstack.length, startOffset, endOffset,
              startPage, endPage,
              wordCount: text.split(/\s+/).length,
              metadata: buildEvidenceMetadata({
                existing: { heading, heading_path: headingPath, page: startPage, source: 'semantic_chunk', scope_key: docScope.scopeKey || null },
                documentId, sourceId: docScope.sourceId || documentId,
                sourceTitle: docScope.documentTitle, sourceKind: docScope.sourceKind || 'document',
                segmentIndex, segmentType, userId, orgId,
                scope: docScope.scope, projectId: docScope.projectId, projectIds: docScope.projectIds,
                teamId: docScope.teamId, startPage, endPage, headingPath,
                documentDate: docScope.documentDate, knownAt: docScope.knownAt,
                language: docScope.language, contentHash, sourceType: docScope.sourceType,
                sourcePlatform: docScope.sourcePlatform,
              }),
            };
            if (remote) {
              const segment = { id: crypto.randomUUID(), ...base, createdAt: new Date().toISOString() };
              segments.push(segment); previousSegmentId = segment.id; segmentIndex++;
            } else {
              try {
                const segment = await this.db.knowledgeSegment.create({ data: base });
                segments.push(segment); previousSegmentId = segment.id; segmentIndex++;
              } catch (err) { ingestDiagnostic.warn(`[segments] semantic insert failed: ${err.message}`); }
            }
          }
          if (segments.length) {
            const _types = segments.reduce((acc, sg) => { acc[sg.segmentType] = (acc[sg.segmentType] || 0) + 1; return acc; }, {});
            const _withPage = segments.filter((sg) => sg.startPage != null).length;
            const _withOffset = segments.filter((sg) => sg.startOffset != null).length;
            const _withHeading = segments.filter((sg) => sg.metadata?.heading_path?.length).length;
            if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[segments] semantic: ${segments.length} clean segments for doc ${documentId} (no mid-word) `
              + `types=${JSON.stringify(_types)} with_offset=${_withOffset}/${segments.length} with_page=${_withPage}/${segments.length} with_heading_path=${_withHeading}/${segments.length}`);
            if (!_withPage) ingestDiagnostic.warn('[segments] no start_page on ANY segment — citations cannot name a page. Docling <!-- page N --> markers absent from this parse tier.');
            return segments;
          }
        }
      }
    }

    if (Array.isArray(hybridChunks) && hybridChunks.length > 0) {
      const segments = [];
      let segmentIndex = 0;
      let previousSegmentId = null;
      for (const hc of hybridChunks) {
        const text = String(hc.text || '').trim();
        if (text.length < 20) continue;
        const contentHash = crypto.createHash('sha256').update(text).digest('hex');
        const heading = Array.isArray(hc.headings) && hc.headings.length
          ? hc.headings.join(' › ').slice(0, 500) : null;
        if (remote) {
          // Remote: build in-memory segment object — no central DB write.
          const segment = {
            id: crypto.randomUUID(),
            documentId, userId, orgId,
            segmentType: 'structured',
            content: text,
            contentHash,
            segmentIndex,
            previousSegmentId,
            depth: Array.isArray(hc.headings) ? hc.headings.length : 0,
            startOffset: null, endOffset: null,
            wordCount: text.split(/\s+/).length,
            metadata: buildEvidenceMetadata({ existing: { heading, page: hc.page || null, source: 'docling_hybrid' }, documentId, sourceId: docScope.sourceId || documentId, sourceTitle: docScope.documentTitle, sourceKind: docScope.sourceKind || 'document', segmentIndex, segmentType: 'structured', userId, orgId, scope: docScope.scope, projectId: docScope.projectId, projectIds: docScope.projectIds, teamId: docScope.teamId, startPage: hc.page || null, endPage: hc.page || null, headingPath: hc.headings, documentDate: docScope.documentDate, knownAt: docScope.knownAt, language: docScope.language, contentHash, sourceType: docScope.sourceType, sourcePlatform: docScope.sourcePlatform }),
            createdAt: new Date().toISOString(),
          };
          segments.push(segment);
          previousSegmentId = segment.id;
          segmentIndex++;
        } else {
          try {
            const segment = await this.db.knowledgeSegment.create({
              data: {
                documentId, userId, orgId,
                segmentType: 'structured',
                content: text,
                contentHash,
                segmentIndex,
                previousSegmentId,
                depth: Array.isArray(hc.headings) ? hc.headings.length : 0,
                startOffset: null, endOffset: null,
                wordCount: text.split(/\s+/).length,
                metadata: buildEvidenceMetadata({ existing: { heading, page: hc.page || null, source: 'docling_hybrid' }, documentId, sourceId: docScope.sourceId || documentId, sourceTitle: docScope.documentTitle, sourceKind: docScope.sourceKind || 'document', segmentIndex, segmentType: 'structured', userId, orgId, scope: docScope.scope, projectId: docScope.projectId, projectIds: docScope.projectIds, teamId: docScope.teamId, startPage: hc.page || null, endPage: hc.page || null, headingPath: hc.headings, documentDate: docScope.documentDate, knownAt: docScope.knownAt, language: docScope.language, contentHash, sourceType: docScope.sourceType, sourcePlatform: docScope.sourcePlatform }),
              },
            });
            segments.push(segment);
            previousSegmentId = segment.id;
            segmentIndex++;
          } catch (err) {
            ingestDiagnostic.warn(`[segments] hybrid chunk insert failed: ${err.message}`);
          }
        }
      }
      if (segments.length) return segments;
    }

    // Fallback chunking (only when Docling HybridChunker produced nothing — the
    // primary path above is already structure-aware: respects headings/tables/
    // lists, never splits mid-structure). Structural fallback: accumulate whole
    // PARAGRAPHS up to a soft cap so we never cut mid-sentence/mid-structure;
    // carry one trailing paragraph as overlap for context continuity.
    const segments = [];
    const text = parseResult.text;
    const SOFT_CAP = 1200;

    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let buf = '';
    for (const para of paragraphs) {
      // A single oversized paragraph (e.g. a table block): flush buffer, emit it whole.
      if (para.length >= SOFT_CAP) {
        if (buf) { chunks.push(buf); buf = ''; }
        chunks.push(para);
        continue;
      }
      if (buf && (buf.length + para.length + 2) > SOFT_CAP) {
        chunks.push(buf);
        // overlap: keep the last paragraph of the flushed chunk for continuity
        const prevParas = buf.split(/\n{2,}/);
        buf = (prevParas[prevParas.length - 1] || '') + '\n\n' + para;
      } else {
        buf = buf ? `${buf}\n\n${para}` : para;
      }
    }
    if (buf.trim()) chunks.push(buf);
    // Last resort: if the text had no paragraph breaks at all, hard-split.
    if (chunks.length === 0 && text.trim()) {
      for (let i = 0; i < text.length; i += 1000) chunks.push(text.slice(i, i + 1000));
    }

    let segmentIndex = 0;
    let previousSegmentId = null;

    for (const chunk of chunks) {
      if (chunk.trim().length === 0) continue;

      const contentHash = crypto.createHash('sha256').update(chunk).digest('hex');

      if (remote) {
        // Remote: build in-memory segment object — no central DB write.
        const segment = {
          id: crypto.randomUUID(),
          documentId,
          userId,
          orgId,
          segmentType: 'chunk',
          content: chunk,
          contentHash,
          segmentIndex,
          previousSegmentId,
          depth: 0,
          startOffset: null,
          endOffset: null,
          wordCount: chunk.split(/\s+/).length,
          metadata: buildEvidenceMetadata({ existing: { source: 'paragraph_fallback' }, documentId, sourceId: docScope.sourceId || documentId, sourceTitle: docScope.documentTitle, sourceKind: docScope.sourceKind || 'document', segmentIndex, segmentType: 'chunk', userId, orgId, scope: docScope.scope, projectId: docScope.projectId, projectIds: docScope.projectIds, teamId: docScope.teamId, documentDate: docScope.documentDate, knownAt: docScope.knownAt, language: docScope.language, contentHash, sourceType: docScope.sourceType, sourcePlatform: docScope.sourcePlatform }),
          createdAt: new Date().toISOString(),
        };
        segments.push(segment);
        previousSegmentId = segment.id;
        segmentIndex++;
      } else {
        const segment = await this.db.knowledgeSegment.create({
          data: {
            documentId,
            userId,
            orgId,
            segmentType: 'chunk',
            content: chunk,
            contentHash,
            segmentIndex,
            previousSegmentId,
            depth: 0,
            startOffset: null,
            endOffset: null,
            wordCount: chunk.split(/\s+/).length,
            metadata: buildEvidenceMetadata({ existing: { source: 'paragraph_fallback' }, documentId, sourceId: docScope.sourceId || documentId, sourceTitle: docScope.documentTitle, sourceKind: docScope.sourceKind || 'document', segmentIndex, segmentType: 'chunk', userId, orgId, scope: docScope.scope, projectId: docScope.projectId, projectIds: docScope.projectIds, teamId: docScope.teamId, documentDate: docScope.documentDate, knownAt: docScope.knownAt, language: docScope.language, contentHash, sourceType: docScope.sourceType, sourcePlatform: docScope.sourcePlatform })
          }
        });
        segments.push(segment);
        previousSegmentId = segment.id;
        segmentIndex++;
      }
    }

    return segments;
  }

  /**
   * Create enterprise schema-aware segments
   * @private
   */
  async _createEnterpriseSegments({ documentId, userId, orgId, schema, parseResult }) {
    // For now, use same chunking as KB
    // Future: use schema.fields to create structured segments
    return this._createSegments({ documentId, userId, orgId, parseResult });
  }

  /**
   * Embed segments into evidence vector collection.
   * For remote (self-host) orgs: embeds each segment and pushes the row + vector
   * to the agent via amrKbSegment — no central Qdrant write, no central DB update.
   * For central orgs: unchanged behaviour (Qdrant upsert + DB vectorStored=true).
   * @private
   * @param {Array} segments - segment objects (DB rows for central, in-memory for remote)
   * @param {string} [callerOrgId] - orgId hint; falls back to segment.orgId
   */
  async _embedSegments(segments, callerOrgId, { workload = 'ingestion', onProgress = null } = {}) {
    if (!this.embeddingService) return;

    // Legacy: a dedicated hivemind_evidence collection. Per-tenant: evidence
    // lives in the org container alongside memory, separated by layer=evidence.
    const legacyEvidence = process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence';

    // THE 630-SECOND BUG. This loop was fully sequential with THREE network round trips
    // per segment — embed (remote API) + storeVector (Qdrant upsert with wait=true, ONE
    // point per call) + a per-row DB update. 45 segments = 135 serial round trips.
    // Measured on a 173KB/11-page PDF: seg=630863ms / embed=630626ms. Because _msSeg
    // WRAPS _msEmbed, that reads as "segmentation is slow" — segmentation was 237ms.
    // Everything here is independent per segment, so: embed TRUE PROVIDER BATCHES
    // (up to 20 texts/request) with bounded, process-wide admission; upsert vectors
    // in ONE batched Qdrant call; and flip vectorStored with ONE updateMany. The old
    // per-document `concurrency=8` limit multiplied across concurrent documents and
    // exhausted both embedding providers during large uploads.
    const _tEmb = Date.now();
    const _conc = Math.max(1, Number(process.env.KB_EMBED_CONCURRENCY || 8));
    const _isRemote = orgIsRemote(callerOrgId || segments[0]?.orgId);
    const _vectorRows = [];       // central: collected for one batched upsert
    const _embeddedIds = [];      // central: for one updateMany
    let _failed = 0;
    const _embeddingModel = process.env.SINGULANCE_EMBED_MODEL
      || process.env.EMBEDDING_MODEL_NAME || process.env.BLAIQ_EMBED_MODEL
      || process.env.OPENROUTER_EMBED_MODEL || 'bge-m3';
    const _embeddingVersion = String(process.env.EMBEDDING_VERSION || process.env.EMBEDDING_MODEL_VERSION || '1');
    const _remotePayload = (segment) => ({
      id: segment.id, userId: segment.userId, documentId: segment.documentId,
      content: segment.content, contentHash: segment.contentHash,
      segmentType: segment.segmentType, segmentIndex: segment.segmentIndex,
      previousSegmentId: segment.previousSegmentId || null,
      startPage: segment.startPage || null, endPage: segment.endPage || null,
      wordCount: segment.wordCount || null, metadata: segment.metadata || {},
      createdAt: segment.createdAt || new Date().toISOString(),
    });
    const _batchSize = Math.max(1, Math.min(20, Number(process.env.KB_EMBED_BATCH_SIZE || 20)));
    const _batches = [];
    for (let i = 0; i < segments.length; i += _batchSize) _batches.push(segments.slice(i, i + _batchSize));
    let _batchIndex = 0;
    let _processed = 0;
    await Promise.all(Array.from({ length: Math.min(_conc, _batches.length) }, async () => {
      while (_batchIndex < _batches.length) {
        const batch = _batches[_batchIndex++];
        const inputs = batch.map((segment) => contextualEmbedInputForSegment(segment));
        let vectors;
        try {
          const output = await this.embeddingService.embed(
            batch.length === 1 ? inputs[0] : inputs,
            { workload, tenantId: callerOrgId || batch[0]?.orgId },
          );
          vectors = batch.length === 1 && Array.isArray(output) && output.every(Number.isFinite)
            ? [output] : output;
          if (!Array.isArray(vectors) || vectors.length !== batch.length) {
            throw new Error(`embedding row count=${vectors?.length ?? 'none'}, want ${batch.length}`);
          }
        } catch (error) {
          for (const segment of batch) {
            _failed += 1;
          }
          ingestDiagnostic.error(`[DocumentFirstIngestion] Failed to embed segment batch (${batch.length}):`, error.message);
          _processed += batch.length;
          try { onProgress?.({ processed: _processed, total: segments.length }); } catch { /* telemetry only */ }
          continue;
        }
        for (let index = 0; index < batch.length; index += 1) {
          const segment = batch[index];
          const segOrgId = callerOrgId || segment.orgId;
          const embedding = vectors[index];
          if (!usableEmbedding(embedding)) {
            _failed += 1;
            ingestDiagnostic.error(`[DocumentFirstIngestion] Invalid embedding for segment ${segment.id}; deferring to reconciliation`);
            continue;
          }
          if (_isRemote) {
            try {
              segment.embeddingModel = _embeddingModel;
              segment.embeddingVersion = _embeddingVersion;
              segment.metadata = buildEvidenceVectorPayload(segment);
              assertEvidenceVectorPayload(segment.metadata);
              const _ok = await amrKbSegment(segOrgId, _remotePayload(segment), embedding);
              if (!_ok) _failed += 1;
            } catch (error) {
              _failed += 1;
              ingestDiagnostic.error(`[DocumentFirstIngestion] Failed to store remote segment ${segment.id}:`, error.message);
            }
          } else {
            let payload;
            try {
              segment.embeddingModel = _embeddingModel;
              segment.embeddingVersion = _embeddingVersion;
              payload = assertEvidenceVectorPayload(buildEvidenceVectorPayload(segment));
            } catch (metadataError) {
              _failed += 1;
              ingestDiagnostic.error(`[DocumentFirstIngestion] Invalid vector metadata for segment ${segment.id}; deferring to reconciliation: ${metadataError.message}`);
              continue;
            }
            _vectorRows.push({
              orgId: segment.orgId,
              segment,
              segOrgId,
              point: {
                id: segment.id, vector: embedding,
                payload,
              },
            });
          }
        }
        _processed += batch.length;
        try { onProgress?.({ processed: _processed, total: segments.length }); } catch { /* telemetry only */ }
      }
    }));

    if (!_isRemote && _vectorRows.length) {
      // ONE upsert per collection instead of one per segment.
      const byCollection = new Map();
      for (const row of _vectorRows) {
        const collectionName = PER_TENANT ? await resolveCollectionForOrg(row.orgId) : legacyEvidence;
        if (!byCollection.has(collectionName)) byCollection.set(collectionName, []);
        byCollection.get(collectionName).push(row);
      }
      for (const [collectionName, rows] of byCollection) {
        const points = rows.map((row) => row.point);
        try {
          if (typeof this.embeddingService.storeVectors === 'function') {
            await this.embeddingService.storeVectors({ collectionName, points });
          } else {
            // no batch API on this service — at least issue them concurrently
            await Promise.all(points.map((point) => this.embeddingService.storeVector({
              collectionName, id: point.id, vector: point.vector, payload: point.payload,
            })));
          }
          _embeddedIds.push(...rows.map((row) => row.segment.id));
        } catch (error) {
          ingestDiagnostic.error(`[DocumentFirstIngestion] batched vector upsert failed (${collectionName}): ${error.message}`);
          _failed += rows.length;
        }
      }
      // ONE update instead of 45.
      if (_embeddedIds.length) {
        try {
          await this.db.knowledgeSegment.updateMany({
            where: { id: { in: _embeddedIds } }, data: { vectorStored: true },
          });
        } catch (error) {
          ingestDiagnostic.error(`[DocumentFirstIngestion] vectorStored updateMany failed: ${error.message}`);
        }
      }
    }
    // Never turn a failed provider batch into N immediate per-segment retries.
    // The persisted row and vectorStored=false are the durable recovery queue;
    // the maintenance-priority reconciler retries later under global admission.
    // This protects interactive recall and avoids repeating a provider outage.
    const _healed = 0;
    const _finalFailed = _failed;
    if (KB_INGEST_VERBOSE) ingestDiagnostic.info(`[kb-embed] n=${segments.length} concurrency=${_conc} remote=${_isRemote} `
      + `failed=${_finalFailed} healed=${_healed} ms=${Date.now() - _tEmb} ms_per_segment=${segments.length ? Math.round((Date.now() - _tEmb) / segments.length) : 0}`);
    return { total: segments.length, embedded: segments.length - _finalFailed, failed: _finalFailed, healed: _healed };
  }

  /**
   * Promote candidate memories from segments
   * Selective: only segments that represent reusable organizational truths
   * @private
   */
  // Alias kept so the guarded call site reads as intent; implementation unchanged.
  async _promoteMemoriesGuarded(args) { return this._promoteMemories(args); }

  /**
   * Upgrade an evidence-only document using its persisted segments. This is the
   * only path for evidence -> both: source bytes are neither loaded nor parsed.
   */
  async promoteStoredEvidence({ documentId, userId, orgId, metadata = {}, onProgress = null,
    promotionStrategy = 'upgrade_evidence_to_both' }) {
    const remote = orgIsRemote(orgId);
    const detail = remote
      ? await amrKbDocDetail(orgId, documentId, { userId })
      : await this.db.knowledgeDocument.findFirst({
        where: { id: documentId, orgId },
        select: {
          id: true, userId: true, ingestMode: true, title: true, documentType: true, sourcePlatform: true,
          sourceId: true, sourceUrl: true, documentDate: true, tags: true, parseMetadata: true,
          segments: { orderBy: { segmentIndex: 'asc' }, select: {
            id: true, content: true, segmentIndex: true, segmentType: true, startPage: true,
            endPage: true, metadata: true, createdAt: true,
          } },
        },
      });
    if (!detail) throw Object.assign(new Error('Stored evidence document was not found.'), { code: 'DOCUMENT_NOT_FOUND' });

    const document = detail.document || detail;
    const segments = (detail.segments || []).filter((segment) => String(segment?.content || '').trim());
    const currentMode = document.ingestMode || document.metadata?.ingest_mode || 'both';
    if (currentMode !== 'evidence') {
      throw Object.assign(new Error('Stored document is not evidence-only.'), { code: 'DOCUMENT_NOT_EVIDENCE_ONLY' });
    }
    if (!segments.length) throw Object.assign(new Error('Stored evidence document has no promotable segments.'), { code: 'NO_EVIDENCE_SEGMENTS' });

    const promotionMetadata = {
      ...(document.parseMetadata || document.metadata || {}),
      ...metadata,
      filename: document.filename || document.title || metadata.filename || '',
      documentTitle: document.title || metadata.documentTitle || document.filename || '',
      document_type: document.documentType || metadata.document_type || null,
      source_platform: document.sourcePlatform || metadata.source_platform || null,
      source_id: document.sourceId || metadata.source_id || null,
      source_url: document.sourceUrl || metadata.source_url || null,
      document_date: document.documentDate || metadata.document_date || null,
      tags: document.tags || metadata.tags || [],
      ingest_mode: 'both',
      original_ingest_mode: 'evidence',
    };
    onProgress?.({ stage: 'generating_memories', progress: 70 });
    const promoted = await this._promoteMemories({
      documentId: document.id,
      userId: document.userId || userId,
      orgId,
      segments,
      metadata: promotionMetadata,
      promotionStrategy,
    });

    const promotedAt = new Date().toISOString();
    if (remote) {
      await amrKbDoc(orgId, {
        id: document.id,
        userId: document.userId || userId,
        filename: document.filename || document.title || null,
        contentType: document.contentType || document.content_type || document.documentType || null,
        status: document.status || document.parseStatus || 'ready',
        createdAt: document.createdAt || new Date().toISOString(),
        ingestMode: 'both',
        metadata: { ...(document.metadata || {}), ...promotionMetadata, promoted_from_evidence_at: promotedAt },
      });
    } else {
      await this.db.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          ingestMode: 'both',
          parseMetadata: { ...(document.parseMetadata || {}), original_ingest_mode: 'evidence', promoted_from_evidence_at: promotedAt },
        },
      });
    }
    const memories = (promoted?.memories || []).filter((memory) => memory?.id);
    onProgress?.({ stage: 'linking_provenance', progress: 92 });
    return {
      documentId: document.id,
      segmentCount: segments.length,
      candidateCount: Array.isArray(promoted?.candidates) ? promoted.candidates.length : segments.length,
      promotedCount: memories.length,
      promotedMemoryIds: memories.map((memory) => memory.id),
      pages: Number(document.pageCount || 1),
      evidenceOnlyReason: memories.length ? null : 'memory_generation_yield_zero',
      promotionMode: 'from_existing_evidence',
    };
  }

  async _promoteMemories({ documentId, segments, userId, orgId, metadata, promotionStrategy = 'kb_default', onProgress = null }) {
    const candidates = [];
    const memories = [];
    const entityLinkTargets = []; // collected during promote, entity-linked concurrently after commit
    const distillTargets = [];    // big-doc deferred fact distillation (P6) — fed after commit
    const evidenceLinkRows = []; // #6 — batched provenance inserts (was per-section)
    const derivationRows = [];

    // Strategy: diversity-sampled promotion
    // 1. Always include first + last (document boundaries)
    // 2. Always include heading-rooted segments (Docling structure)
    // 3. Add evenly-spaced samples to fill up to MAX_PROMOTE
    // 4. Dedup by heading + content-prefix hash
    const MAX_PROMOTE = Number(process.env.PHASE1_MAX_PROMOTE || 20);
    const MIN_PROMOTE = Number(process.env.PHASE1_MIN_PROMOTE || 5);
    // Remove repeated page furniture (running header/footer) from the in-memory
    // segments BEFORE titling/promotion/distill — evidence (already persisted) is
    // untouched. Fixes identical "page-header" titles + header-polluted embeddings.
    stripRepeatedFurniture(segments);
    const promotableSegments = (() => {
      if (!Array.isArray(segments) || segments.length === 0) return [];
      // P3 quality gate FIRST: drop boilerplate (imprint/masthead/ToC/page
      // furniture) and non-prose fragments BEFORE any selection, so boundary/
      // heading/sampling picks come from the clean pool. Fallback to the raw
      // list when the filter is too aggressive (tiny or unusual docs).
      const cleanPool = segments.filter((s) =>
        !isBoilerplateSegment(s.content, s.metadata?.heading) && isQualityContent(s.content));
      const pool = cleanPool.length >= Math.min(MIN_PROMOTE, segments.length) ? cleanPool : segments;
      if (pool.length !== segments.length) {
        this.logger.info?.(`[kb-quality] ${documentId.slice(0, 8)}: ${segments.length - pool.length}/${segments.length} segments dropped as boilerplate/low-quality`);
      }
      if (pool.length <= MIN_PROMOTE) return pool.slice();

      const segmentsForPick = pool;
      const picked = new Map(); // segmentId -> segment
      const dedupKeys = new Set();
      // Dedup by (heading + content-prefix) so single-H1 docs aren't squashed.
      const keyFor = (s) => {
        const h = (s.metadata?.heading || '').toLowerCase().trim();
        const prefix = (s.content || '').slice(0, 100).toLowerCase().replace(/\s+/g, ' ').trim();
        return `${h}|${prefix}`;
      };
      const tryAdd = (s) => {
        if (!s || picked.has(s.id)) return false;
        const k = keyFor(s);
        if (dedupKeys.has(k)) return false;
        dedupKeys.add(k);
        picked.set(s.id, s);
        return true;
      };

      // Boundaries first
      tryAdd(segmentsForPick[0]);
      tryAdd(segmentsForPick[segmentsForPick.length - 1]);

      // All distinct-heading segments
      for (const s of segmentsForPick) {
        if (picked.size >= MAX_PROMOTE) break;
        if (s.metadata?.heading) tryAdd(s);
      }

      // Even sampling to fill remaining
      const target = Math.min(MAX_PROMOTE, Math.max(MIN_PROMOTE, Math.ceil(segmentsForPick.length / 10)));
      if (picked.size < target) {
        const step = Math.max(1, Math.floor(segmentsForPick.length / target));
        for (let i = 0; i < segmentsForPick.length && picked.size < target; i += step) {
          tryAdd(segmentsForPick[i]);
        }
      }
      return Array.from(picked.values());
    })();

    // ── FACTS-ONLY memory creation (canonical) ───────────────────────────────────────────────────────
    // Segments are EVIDENCE (hop-2). Memories = the LLM-distilled atomic FACTS only. We do NOT promote
    // raw segments as "section" memories — those duplicated evidence, carried mid-word chunk text, and
    // spawned a fact→section Derives edge per fact (the bulk of the "Derives noise"). Instead: distill the
    // segments straight into clean fact memories (with filename/doc-id provenance), then run the
    // co-mention linker over the FACTS so they gain real cross-fact relationships (Updates/Extends/
    // Mentions via shared entities) + intra-doc cohesion (batch peers). Result: fewer, richer, fully
    // attributable memories — uniform for central/managed/self-host (the distill + linker both route by
    // org type at their own seams).
    // Raw segment promotion is intentionally no longer feature-flag reversible:
    // KnowledgeSegment is the evidence authority; Memory is distilled knowledge.
    {
      // Window the content for distillation so fact yield tracks CONTENT VOLUME, not the (highly
      // variable) evidence-chunk size — a doc that the chunker split into one giant segment OR many tiny
      // fragments both produce a sensible fact set. Merge adjacent segments up to ~WIN chars; set the
      // per-window fact cap proportional to length (clamped) so dense windows yield more, thin ones fewer.
      const WIN = Number(process.env.KB_DISTILL_WINDOW_CHARS || 500);
      const FACTS_PER_K = Number(process.env.KB_FACTS_PER_1K_CHARS || 11); // ~salient facts / 1000 chars (tuned)
      // Re-window the WHOLE doc semantically (boundary-aware chunkText splits big segments AND merges
      // small ones at heading/paragraph/sentence boundaries — never mid-word). This decouples fact
      // COVERAGE from the evidence chunker: a doc that arrived as one giant segment or many tiny
      // fragments both get ~WIN-sized windows spanning the whole doc, so the tail (metrics/timeline)
      // isn't starved by a single front-loaded window.
      const fullText = promotableSegments.map((s) => (s.content || '').trim()).filter(Boolean).join('\n\n');
      let winChunks = [];
      try {
        const { chunkText } = await import('./document-chunker.js');
        winChunks = (chunkText(fullText, { targetSize: WIN, maxSize: Math.round(WIN * 1.6), minSize: 200, overlapSize: 0 }) || [])
          .map((c) => (c && c.text ? c.text : '')).filter((t) => t && t.trim().length >= 40);
      } catch (e) {
        this.logger.warn?.(`[kb-facts-only] re-window failed, using segments: ${e.message}`);
      }
      if (!winChunks.length) winChunks = promotableSegments.map((s) => s.content).filter(Boolean);
      const targets = winChunks.map((content, i) => ({
        segmentId: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.id || null,
        content,
        // The SECOND of the "TWO places" the comment below refers to: still hardcoded null, so any
        // document taking this fallback path lost its headings entirely.
        heading: segmentHeading(promotableSegments[Math.min(i, promotableSegments.length - 1)]),
        page: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.startPage || null,
        maxFacts: Math.max(3, Math.min(12, Math.round((content.length / 1000) * FACTS_PER_K))),
        scope: metadata.scope,
        visibility: metadata.visibility,
        primary_team_id: metadata.primary_team_id || null,
        project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
      }));
      // Canonical path: one structured LLM call per window emits facts,
      // entities, evidence spans, and intra-window relationships together.
      // Set KB_UNIFIED_EXTRACT=false only for an emergency rollback.
      // emits facts + canonical entities + intra-window relationships TOGETHER (coherent, low-noise,
      // alias-collapsed, ~1 call/window). The recall co-mention pass below then adds CROSS-DOC/TIME edges
      // only (no batch peers → no duplicate intra-doc edges).
      if (String(process.env.KB_UNIFIED_EXTRACT ?? 'true').toLowerCase() !== 'false' && String(process.env.KB_UNIFIED_EXTRACT ?? '') !== '0') {
        const docTitle = metadata.documentTitle || metadata.filename || '';
        // Extraction windows are independent LLM calls; the only shared state is uBudget,
        // mutated only between awaits (single-threaded), so the cap stays hard at any width.
        // 4 -> 8: with promote=69.7s dominated by these calls, and embed/persist now
        // parallel (630s->2.3s, 325s->3.9s), this is the remaining serial-ish stage.
        const uConc = Math.max(1, Number(process.env.KB_UNIFIED_CONCURRENCY || 8));
        const _docChars = (fullText || '').length;
        // DOC_CAP SCALES WITH THE DOCUMENT. It was a FLAT 24, which made it the binding
        // constraint on every long document: the window loop below exits on BUDGET, not on
        // windows, so a 62,867-char deck (~25 windows at 2500) had its budget reserved by
        // ~3 windows and never sent windows ~6-25 to the LLM AT ALL. Measured: 16 memories
        // from 7,584 words, and _dynamicCap reconciled exactly with the flat cap rather
        // than with the document.
        // 550 chars/fact is supermemory's measured density (83 memories from one ~15-page
        // PDF = ~1.8 facts per 1k chars). Env override REMOVED deliberately: a flat number
        // in .env silently defeats the formula — the exact class of bug that hid this.
        const DOC_CAP = adaptiveAtomicMemoryBudget(_docChars);
        // Re-window LARGER for unified (fewer, context-rich windows → the model dedups within a window
        // and we don't multiply small-window caps into over-extraction). Falls back to `targets`.
        const UWIN = Number(process.env.KB_UNIFIED_WINDOW_CHARS || 1500);
        // 8/1k throttled SHORT dense sections: a 711-char window with 7 distinct facts
        // was allowed only 6, and the model returns conservatively under whatever
        // ceiling it is given (told 6 -> returned 3; told 10 -> returned all 7).
        // UWMAX remains the real bound; this rate only stops tiny fragments from
        // claiming a full budget.
        const UFPK = Number(process.env.KB_FACTS_PER_1K_CHARS || 12);
        // Per-window ceiling. This was a hardcoded 4, which made it THE binding
        // constraint on density for every document: min(4, ...) meant no window
        // ever yielded more than 4 facts no matter how much it said, so a rich
        // 1500-char window capped at ~2.7 facts/1k chars.
        //
        // Measured against cognee on an identical 97-word German fixture: cognee
        // extracted 17 entities / 51 edges, this pipeline extracted 2 claims, and
        // the two recall misses were facts that had never been extracted at all —
        // the revenue figure, the kW rating, the supplier weightings, the board's
        // pricing decision. Retrieval was not at fault; there was nothing to find.
        //
        // Density is safe to raise here because the rails are downstream and
        // already enforced: DOC_CAP (30), the dynamic 70%-of-candidates cap,
        // _curateDocumentClaims dedup, minImportance, and cross-window
        // consolidation. Ingest is async (HTTP 202) so a slower, richer extraction
        // costs the user no perceived latency — unlike query-time synthesis, which
        // is what makes cognee's search 6.6-28s against our 0.26-0.70s.
        const UWMAX = Number(process.env.KB_UNIFIED_WINDOW_MAX_FACTS || 10);
        // Hard ceiling for density-floored asks. The floor (measured fact-bearing
        // sentences) may exceed UWMAX on dense windows; the hard cap keeps a
        // pathological window (e.g. a 40-row table) from claiming the whole budget.
        const UWHARD = Number(process.env.KB_UNIFIED_WINDOW_HARD_MAX_FACTS || 24);
        let uWindows = targets;
        try {
          const { chunkText } = await import('./document-chunker.js');
          // overlapSize was 0: a claim whose subject sat in window N and predicate in N+1
          // was seen whole by NEITHER window. 200 chars of overlap fixes that.
          const uc = (chunkText(fullText, { targetSize: UWIN, maxSize: Math.round(UWIN * 1.6), minSize: 250, overlapSize: 200 }) || [])
            .map((c) => (c && c.text ? c.text.trim() : '')).filter((t) => t.length >= 40);
          if (uc.length) uWindows = uc.map((content, i) => ({
            segmentId: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.id || null,
            content,
            // was `heading: null, page: null` — hardcoded, in TWO places, so the extractor
            // saw window text + filename only. Subject-less claims and ungrounded
            // importance both trace back to here.
            heading: segmentHeading(promotableSegments[Math.min(i, promotableSegments.length - 1)]),
            page: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.startPage || null,
            // Floor the ask at the window's MEASURED fact count, not just its length.
            // Measured live: a 735-char doc with ~12 fact-bearing sentences across 3
            // sections was assigned maxFacts=5 by the flat rate and the model returned
            // exactly 5 — the other 7 facts existed in no layer. Over-asking is safe:
            // unused grants refund into factBudget and the curator dedups downstream.
            maxFacts: Math.max(1, Math.min(UWHARD, Math.max(
              Math.min(UWMAX, Math.round((content.length / 1000) * UFPK)),
              estimateFactBearingSentences(content).factBearing))),
            scope: metadata.scope, visibility: metadata.visibility,
            primary_team_id: metadata.primary_team_id || null,
            project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
          }));
        } catch { /* keep targets */ }
        const extractedCandidates = [];
        let wi = 0;
        // RESERVE the budget synchronously BEFORE each window's async call. The old code clamped
        // against the result length, which is stale while other workers are mid-flight — 4 workers ×
        // up-to-12 facts overshot the cap (observed: 47 facts with DOC_CAP=30). `budget` is only
        // mutated between awaits (single-threaded), so Σ granted ≤ DOC_CAP — the cap is hard.
        const _tExtract = Date.now();
        // TWO SEPARATE CONCERNS, previously ONE VARIABLE — this is the seam, not a tuning knob.
        // DOC_CAP bounded the OUTPUT (how many facts a document may produce) and simultaneously gated
        // the INPUT (`while (wi < len && uBudget > 0)`), so when earlier windows spent it the tail of
        // the document was never sent to the LLM at all: "TAIL DROPPED: 1 of 6 windows never sent to
        // the LLM (budget 30 exhausted)" on a 12175-char file. Those facts existed in NO layer and
        // could not be recovered without a re-ingest, because nothing recorded which window was skipped.
        // My first fix floored the shared budget so it could not reach zero. That worked but left one
        // variable owning both jobs, so the next person tuning the cap would re-break reading.
        // Now: READING IS UNCONDITIONAL, the cap bounds output only.
        //   readAllWindows  — every window is sent, always. Not negotiable, not a budget.
        //   factBudget      — how many facts we ASK for in total; when it runs low a window still
        //                     gets MIN_FACTS_PER_WINDOW so it is read and can still contribute.
        // Consequence, stated plainly: total facts can exceed FACT_CAP by at most
        // windows x MIN_FACTS_PER_WINDOW. That is the deliberate trade — a slightly soft output cap
        // in exchange for never silently discarding part of a document.
        const MIN_FACTS_PER_WINDOW = Number(process.env.KB_MIN_FACTS_PER_WINDOW || 3);
        const FACT_CAP = DOC_CAP;
        let factBudget = FACT_CAP;
        const uWorkers = Array.from({ length: Math.min(uConc, uWindows.length) }, async () => {
          while (wi < uWindows.length) {   // <- no budget term: every window is read
            const w = { ...uWindows[wi++] };
            const grant = Math.max(MIN_FACTS_PER_WINDOW,
              Math.min(w.maxFacts || 8, Math.max(0, factBudget)));
            factBudget -= grant;
            w.maxFacts = grant;
            let claims = [];
            try {
              claims = await this._extractUnifiedReliable(w, {
                // entityContext was an EMPTY STRING. supermemory exposes this exact field
                // publicly (<=1500 chars) as their anti-drift primitive; we had the
                // parameter and passed nothing. Ground the window in its own section and
                // document so a fact keeps its subject.
                entityContext: [
                  w.heading ? `Section: ${w.heading}` : '',
                  docTitle ? `Document: ${docTitle}` : '',
                  metadata?.documentSummary ? `About: ${String(metadata.documentSummary).slice(0, 600)}` : '',
                ].filter(Boolean).join('\n').slice(0, 1500),
                maxFacts: w.maxFacts, docTitle });
            } catch (error) {
              this.logger.warn?.(`[kb-unified] candidate extract failed: ${error.message}`);
            }
            const got = Array.isArray(claims) ? claims.length : 0;
            if (got) {
              extractedCandidates.push(...claims.map((claim) => ({
                ...claim,
                segmentId: resolveEvidenceSegment(claim.source_quote, promotableSegments, w.segmentId),
                // THE ACTUAL ROOT CAUSE of the missing «filename : heading» prefix. The window knows
                // its heading and the segments carry it, but the claim never inherited it here — so
                // `claim.heading` was undefined by the time _persistOne built the prefix, which then
                // degraded silently to «filename» for every fact. Measured 2/30, then 1/25; the one
                // that did have a heading was the summary, stamped on a different path.
                // I first "fixed" this by widening the segment→heading fallback. That was the wrong
                // layer: the value was already available and simply never copied onto the claim.
                heading: claim.heading || w.heading || null,
                source_window_content: w.content,
              })));
            }
            factBudget += Math.max(0, grant - got); // return the unused part of the reservation
          }
        });
        await Promise.all(uWorkers);
        const _msExtract = Date.now() - _tExtract;
        // NEVER exit a document silently. The tail-drop above survived because nothing
        // reported it: a truncated document and a thin document produced identical logs.
        ingestDiagnostic.info(`[kb-unified] windows_total=${uWindows.length} windows_processed=${wi} `
          + `fact_budget_left=${factBudget} fact_cap=${FACT_CAP} chars=${_docChars} `
          + `candidates=${extractedCandidates.length}`);
        // INVARIANT, not an expected outcome. Reading no longer depends on any budget, so this can
        // only fire if a future change reintroduces a gate on the read loop. Kept deliberately: the
        // original defect was silent, and the whole point is that it can never be silent again.
        if (wi < uWindows.length) {
          ingestDiagnostic.error(`[kb-unified] INVARIANT VIOLATED — TAIL DROPPED: ${uWindows.length - wi} of `
            + `${uWindows.length} windows never sent to the LLM. Reading is supposed to be `
            + `unconditional; a budget gate has been reintroduced on the read loop. Facts in those `
            + `windows exist in NO layer.`);
        }
        // Coverage: the per-doc memory cap must scale with how much distinct
        // signal the document actually holds. A flat cap of 6 truncated dense
        // multi-topic documents (a 10-section proposal dropped its bootstrapped
        // status, IP ownership, revenue share, and replacement cost). Scale to
        // ~70% of distinct candidates, floored at 8 and ceilinged at 30, so a
        // rich document keeps its distinct claims while a thin one stays small.
        // Dedup (upstream curation + cross-window consolidation) prevents the
        // extra headroom from re-admitting duplicates. Env override wins.
        // The 70%-of-candidates cap discarded 30% of everything extracted, by a SECOND LLM's
        // judgement, on top of a working extractor. Dedup is deterministic; "which facts
        // matter" is not knowable at ingest time because the question has not been asked.
        // Keep every distinct candidate and let cross-window consolidation dedup.
        const _dynamicCap = adaptiveAtomicMemoryBudget(_docChars, extractedCandidates.length);
        // The evidence lane preserves every searchable segment, so the memory
        // lane should remain a compact semantic index rather than mirror the
        // document. Keep the curator adaptive for short/thin documents, but
        // bound the default durable output to 14 high-salience atomic memories;
        // the canonical document-summary parent added below makes 15 total. An
        // explicit deployment override remains available for controlled
        // backfills; it is parsed and bounded here so a malformed value cannot
        // accidentally create an unbounded promotion run.
        const _configuredCuratedCap = Number(process.env.KB_CURATED_MEMORY_CAP);
        const _curatedCap = Number.isFinite(_configuredCuratedCap) && _configuredCuratedCap > 0
          ? Math.max(3, Math.min(30, Math.floor(_configuredCuratedCap)))
          : Math.min(14, _dynamicCap);
        const _tCurate = Date.now();
        // `let`: the duplicate-claim collapse below narrows this list, and every downstream
        // reader (persist pool, 5b relations, counts) must see the narrowed one.
        let curated = await this._curateDocumentClaims(extractedCandidates, {
          docTitle,
          maxMemories: _curatedCap,
        });
        // NOTE: a whole-document summary memory ALREADY EXISTS on this path —
        // memory_type 'summary', ~1200 chars of LLM prose, tagged `document-summary` +
        // `doc-id:<uuid>`, verified on p3d-probe.pdf. I added a second one here from
        // generateDocumentSummary() and dedup correctly rejected it; the block is removed
        // rather than left as a fallback (no second path). What misled me: the summary has
        // NO row in memory_evidence_links, so a join on document_id shows zero summaries.
        // If you need document->summary traceability, add the evidence link — do not add a
        // second generator.
        const _msCurate = Date.now() - _tCurate;
        ingestDiagnostic.info(`[kb-promote-timing] extract=${_msExtract}ms curate=${_msCurate}ms `
          + `windows=${uWindows.length} conc=${uConc} candidates=${extractedCandidates.length} curated=${curated.length}`);
        const uFacts = [];
        let _docRelWritten = 0; // P5 coverage: doc-level relationship edges written
        const extraEvidenceLinks = [];
        const persistedSegmentsById = new Map((segments || [])
          .filter((segment) => segment?.id)
          .map((segment) => [segment.id, segment]));
        const evidenceContextForClaim = (claim) => {
          const supportIds = [...new Set([
            claim?.segmentId,
            ...(Array.isArray(claim?.support_segment_ids) ? claim.support_segment_ids : []),
          ].filter(Boolean))];
          const support = supportIds
            .map((segmentId) => persistedSegmentsById.get(segmentId))
            .filter(Boolean)
            .map((segment) => promotionProvenance(segment, documentId, metadata));
          return {
            primary: support.find((item) => item.segment_id === claim?.segmentId) || support[0] || null,
            supporting: support,
          };
        };
        // Persist with BOUNDED CONCURRENCY. This loop was sequential — 27 claims x
        // (embed + entity pass + writes) = promote 325s of a 398s ingest.
        //
        // CORRECTION (2026-08-03): an earlier version of this comment claimed a MEASURED
        // duplicate-memory defect here ("24 rows, 22 distinct md5"). That measurement was
        // WRONG — the query counted join rows over memory_evidence_links, and a memory
        // legitimately carries several evidence links to the same document (see
        // extraEvidenceLinks below), so one memory was counted more than once. Counting
        // DISTINCT memories shows zero duplicates on every run measured (15/15, 22/22,
        // 18/18). There was no defect to fix.
        //
        // The collapse below is KEPT anyway, as a cheap invariant rather than a bug fix:
        // window overlap (overlapSize 200) genuinely can hand two windows the same sentence,
        // store-side dedup only sees COMMITTED rows, and the persist pool runs 3 claims
        // concurrently — so identical claim text CAN race. It is deterministic, independent
        // of insert ordering, and it logs when it collapses anything. In practice that log
        // has never fired, which is consistent with the corrected measurement above.
        //
        // Keyed on the claim text as extracted: the «title : heading» prefix is applied
        // inside _persistOne, so keying after it would compare already-decorated strings.
        // If you are here because you suspect duplicate memories, verify with
        //   select count(*), count(distinct md5(content)) from (select distinct m.id, m.content ...)
        // and NOT with a plain join through memory_evidence_links.
        const _seenClaim = new Set();
        const _curatedUnique = curated.filter((c) => {
          const k = String(c?.f || '').toLowerCase().replace(/\s+/g, ' ').trim();
          if (!k) return true;
          if (_seenClaim.has(k)) return false;
          _seenClaim.add(k);
          return true;
        });
        if (_curatedUnique.length !== curated.length) {
          ingestDiagnostic.info(`[kb-persist] collapsed ${curated.length - _curatedUnique.length} `
            + `duplicate claim(s) before persist (${curated.length} -> ${_curatedUnique.length})`);
        }
        curated = _curatedUnique;
        const _persistPool = Math.max(1, Number(process.env.KB_PERSIST_CONCURRENCY || 3));
        const _tPersist = Date.now();
        let _ci = 0;
        // ONE ingest-day stamp for the whole document, computed once. Deliberately NOT per-memory
        // `new Date()`: memories of one document must all carry the same date, and a value that
        // changes per row would make otherwise-identical content differ between rows.
        const _ingestDay = new Date().toISOString().slice(0, 10);
        const _persistOne = async (claim) => {
          // SUBJECT HEADER: «filename : heading». Owner requirement — a memory read outside its
          // document must still say WHAT it came from. Note the source is metadata.filename FIRST:
          // docTitle prefers metadata.documentTitle, which is a derived/LLM title, so the header
          // could read as something the user never named. The filename is what they uploaded.
          if (claim?.f && String(process.env.KB_MEMORY_CONTEXT_PREFIX ?? 'true').toLowerCase() !== 'false') {
            const _h = (claim.heading || '').toString().slice(0, 80);
            const _d = (metadata.filename || docTitle || '').toString().slice(0, 80);
            const _pfx = _d ? (`\u00ab${_d}${_h ? ' : ' + _h : ''}\u00bb `) : '';
            if (_pfx && !claim.f.startsWith('\u00ab')) claim.f = _pfx + claim.f;
          }
          // CREATION DATE IN THE TEXT. Owner requirement: every memory states when it was recorded,
          // in the content itself and not only in the ts: tag — so the date survives into recall
          // output, chat context and any export, where tags do not travel. Idempotent: re-running
          // never stacks a second stamp.
          if (claim?.f && !/\(recorded \d{4}-\d{2}-\d{2}\)\s*$/.test(claim.f)) {
            claim.f = `${claim.f.replace(/\s+$/, '')} (recorded ${_ingestDay})`;
          }
          const sourceWindow = {
            segmentId: claim.segmentId,
            content: claim.source_window_content || claim.source_quote,
            heading: claim.heading || null,
            page: claim.page || null,
          };
          const evidenceContext = evidenceContextForClaim(claim);
          const persisted = await this._ingestUnifiedWindow(sourceWindow, {
            userId, orgId, documentId, metadata, docTitle, preExtractedFacts: [claim],
            evidenceProvenance: evidenceContext.primary,
            supportingEvidenceProvenance: evidenceContext.supporting,
          });
          const memory = persisted?.[0];
          if (!memory) return;
          uFacts.push(memory);
          // Collected for every mode; the flush below routes. Guarding the COLLECTION meant
          // remote orgs silently lost the 2nd..Nth supporting segment for a multi-segment claim.
          {
            for (let index = 1; index < (claim.support_segment_ids || []).length; index++) {
              extraEvidenceLinks.push({
                memoryId: memory.id, documentId,
                segmentId: claim.support_segment_ids[index], linkType: 'supports',
                confidence: claim.importance, excerpt: claim.support_quotes?.[index] || null,
              });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(_persistPool, curated.length) }, async () => {
          while (_ci < curated.length) { const c = curated[_ci++]; await _persistOne(c); }
        }));
        ingestDiagnostic.info(`[kb-persist] n=${curated.length} concurrency=${_persistPool} ms=${Date.now() - _tPersist}`);

        // ── 5b: DOCUMENT-LEVEL SEMANTIC RELATIONS ──────────────────────────────
        // Intra-window rels only see facts that shared one 2500-char window, so a
        // subject in window 2 and its update in window 5 never get an edge — measured:
        // a full ingest produced ONLY PartOf. One cheap call over the persisted atomic
        // facts (~10-30 short lines) proposes typed edges across the WHOLE document.
        // Grounding: both endpoints are already source_quote-verified memories; the
        // edge itself is validated by index + type allow-list. Derives is INFERRED —
        // metadata.inferred=true, confidence 0.6, never citable, never supersedes.
        if (uFacts.length >= 2 && String(process.env.KB_DOC_RELATIONS ?? 'true').toLowerCase() !== 'false') {
          try {
            const _relList = uFacts.map((m, idx) => `${idx}: ${String(m.content || '').slice(0, 200)}`).join('\n');
            // P5 explicit retry: the relations proposer is the one relationship
            // pass with no retry — a transient LLM/provider hiccup dropped ALL
            // doc-level edges (only the intra-window PartOf survived). Retry once
            // before giving up; chatCompletionWithFallback still rotates models
            // within each attempt.
            let _relParsed = null;
            for (let _relTry = 0; _relTry < 2; _relTry += 1) {
              try {
                _relParsed = await chatCompletionWithFallback({
                  models: [process.env.KB_UNIFIED_MODEL || 'deepseek/deepseek-v4-flash-0731',
                    ...(process.env.KB_UNIFIED_FALLBACK_MODELS || 'google/gemini-2.5-flash-lite,openai/gpt-oss-120b').split(',').map((x) => x.trim()).filter(Boolean)],
                  temperature: 0, max_tokens: llmProfile('kb-doc-relations').maxTokens, json_mode: true,
                  response_format: QWEN_RELATION_EDGES_RESPONSE_FORMAT, feature: 'kb-doc-relations',
                  messages: [
                    { role: 'system', content: 'You link facts extracted from ONE document. Given numbered facts, output JSON {"edges":[{"from":<idx>,"to":<idx>,"type":"Updates"|"Extends"|"Contradicts"|"Derives"}]}. Updates: from REPLACES to (newer value of the same attribute). Extends: from adds detail to to. Contradicts: they cannot both hold. Derives: from is an inference implied by to. Only edges you are CONFIDENT of — an empty list is a good answer. Never invent facts.' },
                    { role: 'user', content: `Document: ${docTitle}\nFacts:\n${_relList}` },
                  ],
                });
                break;
              } catch (e) {
                if (_relTry === 1) throw e;
                ingestDiagnostic.warn(`[kb-relations] proposer transient failure — retrying once: ${e.message}`);
              }
            }
            const _edges = (Array.isArray(_relParsed?.edges) ? _relParsed.edges : [])
              .filter((e) => Number.isInteger(e?.from) && Number.isInteger(e?.to)
                && e.from !== e.to && uFacts[e.from] && uFacts[e.to]
                && ['Updates', 'Extends', 'Contradicts', 'Derives'].includes(e.type))
              .slice(0, 24);
            let _written = 0;
            for (const e of _edges) {
              try {
                await this.memoryGraphEngine.store.createRelationship({
                  org_id: orgId, // residency: worker context may not carry the org — see createRelationship
                  id: crypto.randomUUID(), from_id: uFacts[e.from].id, to_id: uFacts[e.to].id, type: e.type,
                  confidence: e.type === 'Derives' ? 0.6 : 0.8,
                  metadata: { created_by: 'kb_doc_relations_5b', document_id: documentId,
                    ...(e.type === 'Derives' ? { inferred: true } : {}) },
                });
                _written += 1;
              } catch { /* dup/FK tolerated */ }
            }
            _docRelWritten = _written;
            ingestDiagnostic.info(`[kb-relations] doc=${String(documentId).slice(0, 8)} facts=${uFacts.length} proposed=${Array.isArray(_relParsed?.edges) ? _relParsed.edges.length : 0} valid=${_edges.length} written=${_written}`);
          } catch (error) {
            ingestDiagnostic.warn(`[kb-relations] 5b pass failed (non-fatal): ${error.message}`);
          }
        }
        if (extraEvidenceLinks.length && orgIsRemote(orgId)) {
          await amrKbProvenance(orgId, {
            evidence_links: extraEvidenceLinks.map((r) => ({
              memory_id: r.memoryId, document_id: r.documentId, segment_id: r.segmentId,
              link_type: r.linkType, confidence: r.confidence, excerpt: r.excerpt,
            })),
            derivations: [],
          });
        } else if (extraEvidenceLinks.length) {
          await this.db.memoryEvidenceLink.createMany({ data: extraEvidenceLinks, skipDuplicates: true });
        }
        // Cross-window consolidation — a long document (e.g. a 12-page proposal)
        // repeats the same claim across many sections; each window extracts it
        // independently, so the doc ships near-duplicate memories ("bootstrapped
        // status" x3, "B&B partnership" x2). Within-window NON-REDUNDANT can't
        // see across windows. Merge near-duplicates here → fewer, richer memories
        // (keep the most complete, union the dupes' tags into it, delete the rest).
        // Runs BEFORE entity-linking so edges attach only to survivors. Default
        // ON; KB_CONSOLIDATE=0 disables. Best-effort: on failure facts ship as-is.
        // Deterministic exact-duplicate pass BEFORE the LLM consolidator. An
        // identical claim should never need a model to notice it, and relying on
        // one meant real duplicates shipped: a 54-page deck stored "Home Energy
        // Management Systems (HEMS) like E3DC Hauskraftwerk / One, Fenecon Home 10,
        // and Huawei's EMMA-A02…" TWICE in a single run while KB_CONSOLIDATE=1 and
        // the consolidator logged nothing in three hours of ingests. Source decks
        // legitimately repeat pages verbatim, so identical windows extract
        // identical claims; comparing normalised text catches that for free and
        // leaves the LLM to do what it is actually good at — near-duplicates that
        // differ in wording.
        if (uFacts.length >= 2) {
          const seenClaim = new Map();
          const exactDupes = [];
          for (const f of uFacts) {
            const norm = String(f?.f || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
            if (!norm) continue;
            if (seenClaim.has(norm)) { exactDupes.push(f); continue; }
            seenClaim.set(norm, f);
          }
          if (exactDupes.length) {
            const drop = new Set(exactDupes);
            for (let i = uFacts.length - 1; i >= 0; i--) if (drop.has(uFacts[i])) uFacts.splice(i, 1);
            this.logger.info?.(`[kb-unified] dropped ${exactDupes.length} EXACT duplicate claim(s) `
              + `for doc ${String(documentId).slice(0, 8)} → ${uFacts.length} kept`);
          }
        }
        if (uFacts.length >= 2 && String(process.env.KB_CONSOLIDATE || '1') !== '0') {
          try {
            const before = uFacts.length;
            const removed = await this._consolidateDocFacts(uFacts, { docTitle, documentId });
            // Log unconditionally. This previously logged only when removed > 0, so
            // a consolidator that silently caught NOTHING was indistinguishable from
            // one that was never called — which is exactly the state it was in.
            this.logger.info?.(`[kb-unified] consolidate doc ${String(documentId).slice(0, 8)}: `
              + `${before} facts → removed ${removed || 0} → ${uFacts.length} kept`);
          } catch (e) { this.logger.warn?.(`[kb-unified] consolidation failed (facts kept as-is): ${e.message}`); }
        }
        if (uFacts.length) {
          // KB_ENTITY_LINK_MODE=algo → zero-LLM cross-doc edges from the entity:* tags the unified
          // extractor already produced (one pool fetch + tag intersection).
          // MODES (KB_ENTITY_LINK_MODE):
          //   'llm'  (DEFAULT — graph-intelligence-first): full per-fact co-mention LLM (richest
          //          edges — Mentions/Updates/Extends/Contradicts/Derives, best semantic recall)
          //          PLUS the deterministic algo supersession sweep (guarantees numeric/negation
          //          Updates the LLM might phrase-miss). Belt-and-suspenders = maximum graph quality.
          //   'hybrid': algo edges + ONE batched LLM/doc for the gray-zone (cost-leaning).
          //   'algo' : pure algorithmic, 0 LLM (cheapest, higher miss).
          const configuredLinkMode = String(process.env.KB_ENTITY_LINK_MODE || 'hybrid');
          // Per-fact LLM linking magnifies noisy extraction into noisy graph
          // topology. Keep it only as an explicit diagnostic escape hatch.
          const _linkMode = configuredLinkMode === 'llm' && process.env.KB_ALLOW_PER_FACT_LLM_LINKING !== 'true'
            ? 'hybrid'
            : configuredLinkMode;
          if (_linkMode === 'algo' || _linkMode === 'hybrid') {
            this._algoLinkKbFacts(uFacts, { orgId, userId, documentId })
              .then((n) => this.logger.info?.(`[kb-unified] ${_linkMode} cross-doc linked ${uFacts.length} facts → ${n} edges`))
              .catch((e) => this.logger.warn?.(`[kb-unified] ${_linkMode} link failed: ${e.message}`));
          } else if (typeof this.memoryGraphEngine.linkEntitiesForMemories === 'function') {
            // Co-mention LLM (per-fact, all edge types incl Derives) — the richest relationship pass.
            this.memoryGraphEngine.linkEntitiesForMemories(uFacts, { concurrency: Number(process.env.PHASE1_ENTITY_LINK_CONCURRENCY || 6), noPeers: true })
              .then(() => this.logger.info?.(`[kb-unified] llm cross-doc co-mention linked ${uFacts.length} facts`))
              .catch((e) => this.logger.warn?.(`[kb-unified] llm cross-doc link failed: ${e.message}`));
            // PLUS deterministic supersession (Updates/Extends/Contradicts via the algorithmic
            // conflict-detector, 0 extra LLM) — catches numeric/negation cases the LLM occasionally
            // phrases past. Idempotent with the LLM's edges (dup-tolerant). skipHybrid: no 2nd LLM.
            this._algoLinkKbFacts(uFacts, { orgId, userId, documentId, skipHybrid: true, skipMentions: true })
              .then((n) => n && this.logger.info?.(`[kb-unified] llm+algo supersession added ${n} deterministic edges`))
              .catch((e) => this.logger.warn?.(`[kb-unified] llm+algo supersession failed: ${e.message}`));
          }
        }
        // Document anchor + PartOf edges → the doc→fact hierarchy (was dropped on this path).
        const uDocParent = await this._attachDocumentParent({ memories: uFacts, userId, orgId, documentId, metadata, totalFacts: uFacts.length, firstContent: fullText });
        this.logger.info?.(`[kb-unified] doc ${String(documentId).slice(0, 8)}: ${extractedCandidates.length} candidates → ${uFacts.length} curated memories + parent=${uDocParent ? 'y' : 'n'}`);
        // OBSERVABILITY: a silently THIN extraction was previously invisible without
        // a hand-written SQL query — a 54-page deck yielding 8 memories logged
        // exactly like a one-page note yielding 8, and the corpus quietly degraded.
        // Warn when yield falls below the expected rate so it shows up in the log
        // stream a human already reads. Rate, not absolute count, so a genuinely
        // short document never trips it.
        try {
          // THIRD attempt at this line, so it is worth stating what failed.
          //   v1 read `wordCount` — not in scope; the catch below swallowed the
          //      ReferenceError and the warning could never fire.
          //   v2 summed `segments[].wordCount` — `segments` IS in scope (2150) but
          //      its rows do not carry wordCount, so the sum was always 0 and the
          //      `_srcWords >= 500` guard never passed. Silent again.
          // Verified inert against a real 12,245-word document that yielded 10
          // memories (0.8/1k, floor 2/1k) and printed nothing.
          // Now measured from the parse output itself, which is the same text the
          // segments were cut from and is always populated on this path — plus a
          // segment-content fallback so a thin/empty parseResult cannot re-mute it.
          const _parseText = String(parseResult?.text || parseResult?.markdown || '');
          const _segChars = (segments || []).reduce((n, sg) => n + String(sg?.content || '').length, 0);
          const _srcWords = _parseText.trim()
            ? _parseText.split(/\s+/).filter(Boolean).length
            : Math.round(_segChars / 6);
          const _per1k = _srcWords > 0 ? (uFacts.length / (_srcWords / 1000)) : 0;
          const _floor = Number(process.env.KB_THIN_EXTRACTION_PER_1K || 2);
          if (_srcWords >= 500 && _per1k < _floor) {
            this.logger.warn?.(`[kb-unified] THIN EXTRACTION doc ${String(documentId).slice(0, 8)}: `
              + `${uFacts.length} memories from ${_srcWords} words (${_per1k.toFixed(1)}/1k, floor ${_floor}/1k) — `
              + `check parse tier, segment count, and the curator cap`);
          }
        } catch { /* observability must never break ingest */ }
        const promotionFailed = uFacts.length === 0;
        return {
          // Candidates are extracted, grounded claims. `targets` are merely LLM
          // input windows and reporting them as candidates made a zero-yield
          // extraction look like "1 candidate, 0 memories".
          candidates: extractedCandidates,
          memories: uFacts,
          documentParentId: uDocParent,
          coverage: {
            ...(curated._coverage || {}),
            relations_written: _docRelWritten,
            memories_promoted: uFacts.length,
            ...(promotionFailed ? {
              promotion_failed: true,
              promotion_error: 'No grounded durable claims were produced.',
            } : {}),
          },
        };
      }

      let factObjs = [];
      try {
        const distill = await this._distillFactsAsync({ targets, userId, orgId, documentId, metadata: { ...metadata, perTargetMaxFacts: true } });
        factObjs = (distill && Array.isArray(distill.factObjs)) ? distill.factObjs : [];
      } catch (e) {
        this.logger.warn?.(`[kb-facts-only] distill failed: ${e.message}`);
      }
      // Cross-fact relationships + intra-doc cohesion (batch peers passed to the co-mention linker).
      if (factObjs.length && typeof this.memoryGraphEngine.linkEntitiesForMemories === 'function') {
        const linkConcurrency = Number(process.env.PHASE1_ENTITY_LINK_CONCURRENCY || 6);
        this.memoryGraphEngine.linkEntitiesForMemories(factObjs, { concurrency: linkConcurrency })
          .then(() => this.logger.info?.(`[kb-facts-only] linked ${factObjs.length} fact memories`))
          .catch((e) => this.logger.warn?.(`[kb-facts-only] entity-link failed: ${e.message}`));
      }
      const dDocParent = await this._attachDocumentParent({ memories: factObjs, userId, orgId, documentId, metadata, totalFacts: factObjs.length, firstContent: fullText });
      this.logger.info?.(`[kb-facts-only] doc ${String(documentId).slice(0, 8)}: ${factObjs.length} fact memories from ${promotableSegments.length} segments + parent=${dDocParent ? 'y' : 'n'} (no raw-segment promotion)`);
      return { candidates: targets.map((t) => ({ segmentId: t.segmentId, content: t.content, reason: 'distill_source' })), memories: factObjs, documentParentId: dDocParent };
    }

    const promoteOne = async (segment) => {
      candidates.push({
        segmentId: segment.id,
        content: segment.content,
        reason: 'boundary_segment'
      });

      try {
        const segmentProvenance = promotionProvenance(segment, documentId, metadata);
        // Route through SmartIngestRouter for deterministic edges
        const payload = {
          userId,
          orgId,
          user_id: userId,
          org_id: orgId,
          // Honor explicit scope (e.g. 'organization' from an org-targeted KB
          // upload) before project/team inference; lift visibility to TOP level
          // so graph-engine infers scope='organization' for org uploads.
          scope: segmentProvenance.scope || metadata.scope || (Array.isArray(metadata.project_ids) && metadata.project_ids.length > 0
            ? 'project'
            : metadata.primary_team_id ? 'team' : undefined),
          visibility: metadata.visibility || 'private',
          primary_team_id: segmentProvenance.primary_team_id || metadata.primary_team_id || null,
          project_ids: Array.isArray(segmentProvenance.project_ids) && segmentProvenance.project_ids.length
            ? segmentProvenance.project_ids
            : (Array.isArray(metadata.project_ids) ? metadata.project_ids : []),
          content: segment.content,
          // Title: prefer the chunk heading; else first sentence/line of the
          // segment (meaningful + searchable) instead of the opaque
          // "Extracted from <hash>" fallback that produced unusable titles.
          title: (segment.metadata?.heading && !isPageFurnitureHeading(segment.metadata.heading))
            ? String(segment.metadata.heading).slice(0, 200)
            : cleanTitleFrom(segment.content) || `Segment ${documentId.slice(0, 8)}`,
          source_type: 'knowledge_segment',
          source_metadata: {
            ...segmentProvenance,
            segment_id: segment.id,
            document_id: documentId,
            heading: segment.metadata?.heading || null,
            page: segment.metadata?.page || null,
          },
          tags: [
            ...(metadata.tags || []),
            'promoted-from-segment',
            // Filename + doc-hash anchors so recall can find every chunk
            // by literal filename via the tag-indexed FTS path. Without
            // these tags a query for "Branding Skizze1 (1).pdf" never
            // hits any of its chunks — title contains only the heading
            // and content is the chunk text. See aebf344.
            ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
            ...(metadata.documentTitle && metadata.documentTitle !== metadata.filename
              ? [`filename:${metadata.documentTitle}`] : []),
            ...(metadata.documentHash ? [`doc-hash:${metadata.documentHash}`] : []),
            ...(metadata.documentId ? [`doc-id:${metadata.documentId}`] : []),
            ...(segment.metadata?.heading
              ? [`heading:${String(segment.metadata.heading).toLowerCase().replace(/\s+/g, '-').slice(0, 50)}`]
              : []),
            ...(segment.metadata?.page ? [`page:${segment.metadata.page}`] : []),
          ],
          // Section promotion is a pure insert. Fact extraction has one owner:
          // the batched deferred distiller below. Allowing small documents to run
          // the graph engine's inline LLM here duplicated extraction and put one
          // provider straggler on the synchronous upload critical path.
          skip_fact_extraction: true,
          // Strict contradiction mode for KB: only fires when BOTH sides
          // carry negation/change language AND token-similarity ≥0.65.
          // Catches real "value updated" cases (e.g. price change in newer
          // catalog), skips noise from unrelated facts.
          strict_contradictions: true,
          documentDate: segmentProvenance.document_date || metadata.document_date || new Date(),
          metadata: {
            ...(metadata || {}),
            // Retain the complete evidence envelope on the memory itself. The
            // source_metadata projection is for recall; this copy is the durable
            // provenance authority for export, audit, and future re-promotion.
            evidence_provenance: segmentProvenance,
            project_id: Array.isArray(metadata.project_ids) && metadata.project_ids.length === 1
              ? metadata.project_ids[0]
              : metadata.project_id || null,
          }
        };

        // FAST-PATH (no per-section LLM/recall). smartIngestRouter.route() runs
        // _enrichWithTripleOperator → a searchMemories RECALL per section, purely
        // to infer Updates/Extends operators. For document chunks that's wasted
        // work (sections don't supersede each other) AND it's the dominant bulk
        // latency: N sections = N serialized recalls. We skip route() entirely
        // and pass the already-complete payload straight to ingestMemory with
        // smartIngest:false (engine won't re-route). _smart_routed belt-and-braces.
        // Content is clean Docling text; ts:* stamping still happens in the engine.
        const routedPayloads = [{ ...payload, _smart_routed: true }];

        for (const routed of routedPayloads) {
          // #7 — KB section promotion fast-path. Sections are document chunks:
          // they do NOT supersede/contradict each other, so the per-section
          // PredictCalibrate similarity search + conflict-detection +
          // relationship-classification are pure waste (they dominated promote
          // at ~3s/section). Skip them — the section is already routed by dfi's
          // explicit route() above (smartIngest:false avoids a redundant second
          // routing pass). Entity-linking stays deferred to the post-commit
          // batch. Net: the per-user advisory lock is held ~100ms not ~3s, so
          // the write queue drains fast — addresses the #6 serialization symptom
          // WITHOUT unsafe lock removal.
          const result = await this.memoryGraphEngine.ingestMemory({
            ...routed,
            defer_entity_linking: true,
            smartIngest: false,
            skipPredictCalibrate: true,
            skip_contradiction_detection: true,
            skip_relationship_classification: true,
            // #6: with all dedup/classification skipped this is a pure insert —
            // the per-user advisory lock guards nothing, so bypass it. Section
            // writes no longer serialize; PartOf + deferred entity tags still
            // attach. Facts (separate path) keep the full locked pipeline.
            skipAdvisoryLock: true,
          });
          // graph-engine returns { memoryId, operation, ... }
          // operation = 'skipped_*' means memory NOT persisted to DB -> FK would fail
          const memoryId = result?.memoryId || result?.id || null;
          const persisted = memoryId && !(result?.operation || '').startsWith('skipped');
          if (!persisted) {
            memories.push(result);
            continue;
          }
          // Defense-in-depth: verify row actually exists before FK insert.
          // RESIDENCY: a remote (self-host) org's memory lives on the AGENT, not central — a central
          // findUnique returns null and would wrongly skip promotion, dropping entity-linking +
          // provenance + relations (the bug that left a self-host PDF's 21 segments → 0 useful memories).
          // Trust the agent write: ingestMemory→amrWrite already landed it and the agent enforces its own
          // existence; the deferred co-mention linker self-fetches candidates.
          if (!orgIsRemote(orgId)) {
            const exists = await this.db.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
            if (!exists) {
              memories.push(result);
              continue;
            }
          }
          memories.push({ ...result, id: memoryId });
          entityLinkTargets.push({
            id: memoryId, user_id: routed.user_id, org_id: routed.org_id,
            project: routed.project || null, content: routed.content,
            tags: routed.tags || [], memory_type: routed.memory_type,
          });
          distillTargets.push({
            memoryId,
            content: segment.content,
            heading: segment.metadata?.heading || null,
            page: segment.metadata?.page || null,
            scope: routed.scope,
            visibility: routed.visibility,
            primary_team_id: routed.primary_team_id || null,
            project_ids: Array.isArray(routed.project_ids) ? routed.project_ids : [],
          });

          // #6 — collect provenance rows; batch-insert after the loop (was 2
          // synchronous round-trips per section).
          evidenceLinkRows.push({
            memoryId, segmentId: segment.id, documentId,
            linkType: 'supports', confidence: 0.9, excerpt: segment.content.slice(0, 500),
          });
          derivationRows.push({
            memoryId, derivationMethod: 'promoted_from_segment',
            derivationAgent: 'document_first_ingestion_v1', confidence: 0.8,
            metadata: { segment_id: segment.id, document_id: documentId, promotion_strategy: promotionStrategy },
          });

          // P1 #12 — entity-aware memory linking
          // Mirror segment's entity_mentions onto the promoted memory so
          // memory recall can filter/rank by entity.
          this._linkEntitiesToMemoryAsync({
            memoryId, segmentId: segment.id, orgId, documentId, memoryContent: segment.content,
          });
        }
      } catch (error) {
        ingestDiagnostic.error(`[DocumentFirstIngestion] Failed to promote segment ${segment.id}:`, error);
      }
    };

    // Promotion concurrency. NOTE: every ingestMemory acquires a PER-USER
    // advisory lock (graph-engine advisoryLock) that serializes all of a user's
    // writes — so concurrency >1 for the same user gains NO parallelism (the
    // lock queues them) and actively HARMS: waiting workers sit inside an open
    // Prisma transaction whose timeout ticks during the wait, blowing it →
    // P2010 aborts under bulk ingest. Default 2 keeps a shallow pipeline (next
    // worker preps while one holds the lock) without a deep timeout-prone queue.
    const PROMOTE_CONCURRENCY = Number(process.env.PHASE1_PROMOTE_CONCURRENCY || 4);
    let nextIdx = 0;
    let processedPromotions = 0;
    const workers = Array.from({ length: Math.min(PROMOTE_CONCURRENCY, promotableSegments.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= promotableSegments.length) return;
        await promoteOne(promotableSegments[i]);
        processedPromotions += 1;
        try {
          onProgress?.({
            processed: processedPromotions,
            total: promotableSegments.length,
            promoted: memories.filter((m) => m?.id).length,
          });
        } catch { /* telemetry only */ }
      }
    });
    await Promise.all(workers);

    // #6 — batched provenance inserts (2 round-trips total vs 2×N). Append-only
    // link rows, no advisory-lock semantics — safe + contained to the KB path.
    // RESIDENCY: memoryEvidenceLink + memoryDerivation are CENTRAL-only provenance tables FK'd to the
    // memory. For a remote (self-host) org the memory is on the agent, so these createMany throw + are
    // pointless. Skip for remote — segment↔memory traceability for self-host is the agent's concern.
    // ROUTED, not skipped. Previously both writes were guarded by !orgIsRemote, so .amr/byod orgs
    // got no provenance at all — the FE's "Evidence - source segments and citations" tab was
    // permanently empty for them and derivations were unanswerable. The agents now hold the same
    // two tables, so remote rows go to the agent (snake_case wire shape) and central rows to Prisma.
    if (orgIsRemote(orgId)) {
      if (evidenceLinkRows.length || derivationRows.length) {
        const res = await amrKbProvenance(orgId, {
          evidence_links: evidenceLinkRows.map((r) => ({
            memory_id: r.memoryId, document_id: r.documentId, segment_id: r.segmentId,
            link_type: r.linkType, confidence: r.confidence, excerpt: r.excerpt,
          })),
          derivations: derivationRows.map((r) => ({
            memory_id: r.memoryId, derivation_method: r.derivationMethod,
            derivation_agent: r.derivationAgent, confidence: r.confidence, metadata: r.metadata,
          })),
        });
        if (!res) {
          this.logger.warn?.(`[kb] provenance NOT written for remote org ${orgId} — the agent call failed. `
            + `Memories and segments landed; the Evidence tab will be empty for this document.`);
        } else {
          ingestDiagnostic.info(`[kb-provenance] remote org=${String(orgId).slice(0, 8)} linked=${res.linked} derived=${res.derived}`);
        }
      }
    } else {
      if (evidenceLinkRows.length) {
        await this.db.memoryEvidenceLink.createMany({ data: evidenceLinkRows, skipDuplicates: true })
          .catch((e) => this.logger.warn?.(`[kb] evidence-link batch failed: ${e.message}`));
      }
      if (derivationRows.length) {
        await this.db.memoryDerivation.createMany({ data: derivationRows, skipDuplicates: true })
          .catch((e) => this.logger.warn?.(`[kb] derivation batch failed: ${e.message}`));
      }
    }

    if (entityLinkTargets.length && typeof this.memoryGraphEngine.linkEntitiesForMemories === 'function') {
      const linkConcurrency = Number(process.env.PHASE1_ENTITY_LINK_CONCURRENCY || 6);
      this.memoryGraphEngine.linkEntitiesForMemories(entityLinkTargets, { concurrency: linkConcurrency })
        .then(() => this.logger.info?.(`[entity-link:deferred] linked ${entityLinkTargets.length} promoted memories`))
        .catch((err) => this.logger.warn?.(`[entity-link:deferred] batch failed: ${err.message}`));
    }

    // P6 — deferred fact distillation for big docs. The per-segment payloads set
    // skip_fact_extraction for >=30-segment documents (speed guard); instead of
    // losing distillation entirely (old behavior: raw chunks stored as 'facts'),
    // run it NOW in the background over the promoted sections.
    // Deferred distillation is now the ONLY fact source for KB docs (sections
    // ingest as pure inserts with smartIngest:false — no inline processor), so
    // it must fire for EVERY doc, not just >=30-segment ones. The old >=30 gate
    // was inherited from the inline-skip logic and silently left small docs
    // (e.g. an 11-segment pitch deck) with zero facts. Async + batched — an
    // 11-section doc costs 2 background LLM calls.
    if (distillTargets.length) {
      this._distillFactsAsync({ targets: distillTargets, userId, orgId, metadata, documentId });
    }

    // ── Canonical Document parent + PartOf edges (Supermemory-shape graph) ──
    // Per-segment promotion above wrote N standalone Memory rows but no
    // connection back to a "this is the document" node. Build that node
    // now and wire every promoted child to it via PartOf-encoded edges
    // (RelationshipType enum currently lacks PartOf → encode as
    // Extends + metadata.subtype='PartOf' until the enum migration).
    //
    // Net effect: KB upload from FE produces 1 Document + N Sections +
    // N PartOf edges, matching the contract the /api/memories route
    // already emits via SmartIngestRouter._routeKnowledgeBase tree.
    const persistedChildIds = memories
      .filter(m => m?.id && !(m?.operation || '').startsWith('skipped'))
      .map(m => m.id);

    let docParentId = null;
    if (persistedChildIds.length > 0) {
      try {
        // Synthesize a short doc summary: title + N section count + first 280
        // chars from the first child. Cheap, no LLM. Cognition-loop can refine.
        const firstContent = promotableSegments[0]?.content || '';
        const docTitle =
          metadata.documentTitle
          || metadata.filename
          || `Document ${documentId.slice(0, 8)}`;
        const docSummary = [
          `Document: ${docTitle}`,
          `Sections promoted: ${persistedChildIds.length}/${segments.length}`,
          '',
          firstContent.slice(0, 280),
        ].join('\n');

        const parentRes = await this.memoryGraphEngine.ingestMemory({
          user_id: userId,
          org_id: orgId,
          // Same scope/visibility fix as the segment payload — doc parent node
          // must also become org-visible for org-targeted uploads.
          scope: metadata.scope || (Array.isArray(metadata.project_ids) && metadata.project_ids.length > 0
            ? 'project'
            : metadata.primary_team_id ? 'team' : undefined),
          visibility: metadata.visibility || 'private',
          primary_team_id: metadata.primary_team_id || null,
          project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
          content: docSummary,
          title: docTitle,
          memory_type: 'fact',
          tags: [
            ...(metadata.tags || []),
            'knowledge-base',
            'document',
            'document-summary',
          ],
          source_metadata: {
            source_platform: 'knowledge_base',
            source_type: 'document',
            document_id: documentId,
            filename: metadata.filename || null,
          },
          metadata: {
            semantic_role: 'document',
            ingest_tree_role: 'parent',
            document_id: documentId,
            child_count: persistedChildIds.length,
            total_segments: segments.length,
          },
          skip_fact_extraction: true,                // parent is itself a summary
          skipPredictCalibrate: true,                // never dedup the doc node
          // Doc node is unique per document — nothing to supersede/contradict/
          // classify; make it a pure lock-free insert too (#6/#7). PartOf edges
          // to children + deferred entity tags still attach below.
          skip_contradiction_detection: true,
          skip_relationship_classification: true,
          smartIngest: false,
          skipAdvisoryLock: true,
          defer_entity_linking: true,
        });

        docParentId = parentRes?.memoryId || parentRes?.id || null;

        if (docParentId) {
          // Native PartOf edge (enum migration 20260521120000 added it).
          // Falls back to Extends + metadata.subtype='PartOf' if the
          // running Prisma client predates the migration so KB ingest
          // never crashes mid-rollout.
          const createPartOf = async (childId) => {
            try {
              await this.memoryGraphEngine.store.createRelationship({
                org_id: orgId, // residency: worker context may not carry the org — see createRelationship
                id: crypto.randomUUID(),
                from_id: childId,
                to_id: docParentId,
                type: 'PartOf',
                confidence: 1.0,
                created_by: 'document_first_ingestion',
                created_at: new Date().toISOString(),
                metadata: { ingest_tree: true, document_id: documentId, parent_role: 'document' },
              });
            } catch (err) {
              try {
                await this.memoryGraphEngine.store.createRelationship({
                  org_id: orgId, // residency: worker context may not carry the org — see createRelationship
                  id: crypto.randomUUID(),
                  from_id: childId,
                  to_id: docParentId,
                  type: 'Extends',
                  confidence: 1.0,
                  created_by: 'document_first_ingestion',
                  created_at: new Date().toISOString(),
                  metadata: { ingest_tree: true, subtype: 'PartOf', document_id: documentId, parent_role: 'document', fallback_reason: err.message },
                });
              } catch (err2) {
                ingestDiagnostic.warn(`[doc-first] PartOf edge ${childId.slice(0, 8)}→${docParentId.slice(0, 8)} failed (native + fallback):`, err2.message);
              }
            }
          };
          const edgeTasks = persistedChildIds.map(childId => createPartOf(childId));
          await Promise.all(edgeTasks);

          memories.push({ id: docParentId, operation: 'document_parent', isParent: true });
        }
      } catch (parentErr) {
        ingestDiagnostic.warn('[doc-first] Failed to attach Document parent:', parentErr.message);
      }
    }

    return { candidates, memories, documentParentId: docParentId };
  }

  /** Fire-and-forget: copy segment's entity mentions onto memory + update topic state. */
  _linkEntitiesToMemoryAsync({ memoryId, segmentId, orgId, documentId, memoryContent }) {
    if (process.env.ENABLE_ENTITY_EXTRACTION !== 'true') return;
    // RESIDENCY: this mirrors central segment entity_mentions onto the memory via central entityMention
    // + memory.update — all FK'd to central rows the agent doesn't have. For a remote (self-host) org the
    // memory's entity tags + edges are built on the AGENT by the deferred co-mention linker
    // (_attachEntityCoMentionEdges → amrUpdateTags + amrAddEdge). Skip the central mirror for remote.
    if (orgIsRemote(orgId)) return;
    (async () => {
      try {
        await new Promise(r => setTimeout(r, 500));
        const segMentions = await this.db.entityMention.findMany({
          where: { segmentId },
          select: { entityId: true, mentionText: true, confidence: true, context: true },
        });
        if (!segMentions.length) return;
        await this.db.entityMention.createMany({
          data: segMentions.map(m => ({
            entityId: m.entityId,
            memoryId,
            mentionText: m.mentionText,
            confidence: m.confidence,
            context: m.context,
          })),
          skipDuplicates: true,
        });

        // Auto-tag the memory with entity tags for fast filtered recall
        try {
          const entityIds = [...new Set(segMentions.map(m => m.entityId))];
          const entitiesForTags = await this.db.entity.findMany({
            where: { id: { in: entityIds } },
            select: { canonicalName: true, entityType: true },
          });
          // Canonicalize the entity NAME with the same deterministic slugger
          // used everywhere else, preserving the entity-type prefix. This raw
          // db.memory.update bypasses the createMemory chokepoint, so the tag
          // must already be canonical before it lands.
          const newTags = entitiesForTags
            .map(e => { const slug = normalizeEntity(e.canonicalName); return slug ? `${e.entityType}:${slug}` : null; })
            .filter(Boolean)
            .slice(0, 25);
          if (newTags.length) {
            const existing = await this.db.memory.findUnique({
              where: { id: memoryId },
              select: { tags: true },
            });
            if (existing) {
              // normalizeTagsArray re-canonicalizes any legacy entity: tags on
              // the row too, so a pre-fix entity:Foo can't coexist with the new
              // canonical form (this update bypasses the chokepoint).
              const merged = normalizeTagsArray(
                Array.from(new Set([...(existing.tags || []), ...newTags])).slice(0, 80),
              );
              await this.db.memory.update({
                where: { id: memoryId },
                data: { tags: merged },
              });
            }
          }
        } catch (tagErr) {
          this.logger.warn?.(`[entity-memory-tags] ${memoryId}: ${tagErr.message}`);
        }

        // P1 #11 — update rolling topic state per linked entity
        if (this.topicStateWriter && process.env.ENABLE_TOPIC_STATE === 'true') {
          for (const m of segMentions) {
            this.topicStateWriter.recordMemoryForEntity({
              orgId,
              entityId: m.entityId,
              memoryId,
              documentId,
              memoryContent,
            }).catch(() => {});
          }
        }
      } catch (err) {
        this.logger.warn(`[entity-memory-link] memory ${memoryId} failed: ${err.message}`);
      }
    })();
  }
}
