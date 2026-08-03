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
import { orgIsRemote, amrKbDoc, amrKbSegment } from '../vector/mneme/driver.js';

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

const DURABLE_EXTRACT_TYPES = ['fact', 'preference', 'decision', 'lesson', 'goal', 'event'];
const INTRA_WINDOW_REL_TYPES = ['Extends', 'Mentions', 'Contradicts'];

function safeDocumentType(value) {
  const type = String(value || '').toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return type || 'general';
}

async function classifyKnowledgeDocument(text, filename) {
  const preview = String(text || '').slice(0, 6000).trim();
  if (!preview) return { type: 'general', confidence: 0.1 };
  try {
    const model = process.env.KB_DOCUMENT_TYPE_MODEL || process.env.MEMORY_FAST_MODEL || memoryLLMRoute()?.model || 'openai/gpt-oss-120b';
    const parsed = await chatCompletion({
      model, temperature: 0, max_tokens: 256, json_mode: true, feature: 'kb-document-type',
      messages: [{ role: 'system', content: 'Classify this document. Return only JSON: {"type":"short_lowercase_snake_case_label","confidence":0.0}. Use a specific type such as payment_record, invoice, contract, meeting_notes, policy, contact_list, report, spreadsheet, or general. Do not use the filename as the type unless content supports it.' }, { role: 'user', content: `Filename: ${filename || 'unknown'}\n\n${preview}` }],
    });
    const confidence = Number(parsed.confidence);
    return { type: safeDocumentType(parsed.type), confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.3 };
  } catch (error) {
    console.warn(`[kb-ingest] document type classification unavailable: ${error.message}`);
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
  return (Array.isArray(entities) ? entities : [])
    .filter((entity) => typeof entity === 'string' && entity.trim())
    // Measurements, percentages, and dates are values on claims, not graph
    // identities. This language-agnostic structural gate drops numeric-led
    // phrases without maintaining a domain dictionary.
    .filter((entity) => /^\p{L}/u.test(entity.trim()))
    .slice(0, 8);
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
  return (Array.isArray(rawFacts) ? rawFacts : [])
    .filter((item) => item && typeof item.f === 'string' && item.f.trim().length >= 4
      && DURABLE_EXTRACT_TYPES.includes(item.memory_type)
      && typeof item.source_quote === 'string' && item.source_quote.length >= 4
      && content.includes(item.source_quote)
      && !isStructuredSourceNoise(item.f)
      && !isStructuredSourceNoise(item.source_quote)
      // The source remains recallable even when its claim is not durable enough.
      && normalizedImportance(item.importance) >= threshold)
    .slice(0, maxFacts)
    .map((item) => {
      const start = content.indexOf(item.source_quote);
      const rated = Number(item.importance);
      return {
        t: durableTitle(item.t, item.f),
        f: item.f.trim(),
        memory_type: item.memory_type,
        source_quote: item.source_quote,
        source_start: start,
        source_end: start + item.source_quote.length,
        importance: normalizedImportance(rated),
        entities: durableEntities(item.entities),
        rels: (Array.isArray(item.rels) ? item.rels : [])
          .filter((rel) => rel && Number.isInteger(rel.to) && INTRA_WINDOW_REL_TYPES.includes(rel.type)).slice(0, 5),
      };
    });
}

export function resolveEvidenceSegment(sourceQuote, segments, fallbackId = null) {
  const quote = String(sourceQuote || '').trim();
  if (!quote) return fallbackId;
  const exact = (Array.isArray(segments) ? segments : []).find((segment) =>
    typeof segment?.content === 'string' && segment.content.includes(quote));
  return exact?.id || fallbackId;
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
  const cap = Math.max(1, Math.min(30, Number(maxMemories) || 8));
  const output = [];
  for (const memory of (Array.isArray(rawMemories) ? rawMemories : []).slice(0, cap)) {
    const indices = [...new Set((memory?.support_indices || []).map(Number))]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < pool.length);
    if (!indices.length || !DURABLE_EXTRACT_TYPES.includes(memory?.memory_type)) continue;
    const supports = indices.map((index) => pool[index]).filter((item) => item?.segmentId && item?.source_quote);
    if (!supports.length) continue;
    const primary = supports[0];
    const content = String(memory.content || '').trim();
    if (content.length < 12) continue;
    const importance = Math.max(...supports.map((item) => Number(item.importance || 0.5)));
    output.push({
      t: durableTitle(memory.title || primary.t, content),
      f: content,
      memory_type: memory.memory_type,
      importance: Math.max(0.65, Math.min(1, importance)),
      // Canonical entities come only from exact-span extraction. The curator
      // may merge claims but cannot introduce a new graph identity.
      entities: [...new Set(supports.flatMap((item) => durableEntities(item.entities)))].slice(0, 12),
      rels: [],
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
    this.logger = logger;
    // Collapse simultaneous first uploads of the same bytes into one pipeline.
    // Database constraints protect rows across processes; this prevents callers
    // in one process from racing before the unchanged-document check is visible.
    this.documentIngestFlights = new Map();
  }

  /** Fire-and-forget entity extraction over segments (P1 #9).
   *  Parallel workers — bound by ENTITY_EXTRACT_CONCURRENCY (default 6). */
  _extractEntitiesAsync({ segments, userId, orgId, documentId, force = false }) {
    if (!this.entityExtractor || process.env.ENABLE_ENTITY_EXTRACTION !== 'true') return;
    // Skip entity extraction on tiny docs (single short segment) — no real value.
    const totalChars = segments.reduce((acc, s) => acc + (s.content?.length || 0), 0);
    if (!force && segments.length <= 2 && totalChars < 1500) {
      this.logger.info?.(`[entity-extractor] skipping tiny doc ${documentId} (${segments.length} segs, ${totalChars} chars)`);
      return;
    }
    const CONCURRENCY = Number(process.env.ENTITY_EXTRACT_CONCURRENCY || 6);
    (async () => {
      let i = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, segments.length) }, async () => {
        while (true) {
          const idx = i++;
          if (idx >= segments.length) return;
          const segment = segments[idx];
          try {
            await this.entityExtractor.extractFromSegment({ segment, userId, orgId, documentId });
          } catch (err) {
            this.logger.warn(`[entity-extractor] segment ${segment.id} failed: ${err.message}`);
          }
        }
      });
      await Promise.all(workers);
    })().catch(err => this.logger.warn(`[entity-extractor] batch failed: ${err.message}`));
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
      .slice(0, 24);
    if (!targets.length) return;
    const model = process.env.CLAIM_STRUCTURING_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
    const CONC = Number(process.env.CLAIM_STRUCTURING_CONCURRENCY || 4);
    const system = `Extract the core CLAIM structure from one memory sentence, in ANY language.
Return ONLY JSON: {"subject":"<canonical English noun phrase of what the claim is ABOUT>","predicate":"<canonical English relation/attribute, lowercased, e.g. has_launch_date, rated_power, is_partner_of>","qualifiers":{"<key>":"<value>"}}.
subject+predicate identify the claim across paraphrases and languages (normalize to English + lowercase). qualifiers holds scope/conditions/owner/time as key-value. Keep values short. If nothing durable, return {"subject":"","predicate":"","qualifiers":{}}.`;
    (async () => {
      let i = 0;
      const workers = Array.from({ length: Math.min(CONC, targets.length) }, async () => {
        while (true) {
          const idx = i++;
          if (idx >= targets.length) return;
          const m = targets[idx];
          try {
            const parsed = await chatCompletion({
              model, temperature: 0, max_tokens: 800, json_mode: true, feature: 'v5-claim-structuring',
              messages: [{ role: 'system', content: system }, { role: 'user', content: String(m.content).slice(0, 800) }],
            });
            const subj = typeof parsed?.subject === 'string' ? parsed.subject.trim().slice(0, 500) : '';
            const pred = typeof parsed?.predicate === 'string' ? parsed.predicate.trim().toLowerCase().slice(0, 500) : '';
            if (!subj && !pred) continue;
            const quals = (parsed && typeof parsed.qualifiers === 'object' && !Array.isArray(parsed.qualifiers)) ? parsed.qualifiers : undefined;
            const patch = {};
            if (subj) patch.claimSubject = subj;
            if (pred) patch.claimPredicate = pred;
            if (quals && Object.keys(quals).length) patch.claimQualifiers = quals;
            if (Object.keys(patch).length) await store.updateMemory(m.id, patch);
          } catch (err) {
            this.logger.warn?.(`[v5-claim-structuring] ${String(m.id).slice(0, 8)}: ${err.message}`);
          }
        }
      });
      await Promise.all(workers);
    })().catch((err) => this.logger.warn?.(`[v5-claim-structuring] batch: ${err.message}`));
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
    // gpt-oss-120b (was 20b): the 20b model only half-followed the entity rules
    // (forked Wärmepumpe/heat-pump, emitted phrase-'entities' + generic nouns).
    // 120b follows the English-canonical + concise-noun rules far more reliably;
    // still supports strict json_schema + reasoning_effort=low, and the distill
    // is async (4 calls) so the extra per-call latency is acceptable for quality.
    const model = process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
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

      // Only sections with enough prose to distill.
      const eligible = targets.filter((t) => (t.content || '').split(/\s+/).filter(Boolean).length >= 25);
      const batches = [];
      for (let i = 0; i < eligible.length; i += BATCH) batches.push(eligible.slice(i, i + BATCH));
      let created = 0, failed = 0, bidx = 0;

      const ingestFact = async (t, fact, entityTags, factTitle) => {
        const res = await this.memoryGraphEngine.ingestMemory({
          user_id: userId,
          org_id: orgId,
          scope: t.scope,
          visibility: t.visibility || 'private',
          primary_team_id: t.primary_team_id || null,
          project_ids: Array.isArray(t.project_ids) ? t.project_ids : [],
          content: fact.trim(),
          // LLM-emitted concise title (its subject/topic), not the whole
          // sentence. Falls back to the first-clause heuristic if absent.
          title: (factTitle && factTitle.trim() && !isGarbageTitle(factTitle)) ? factTitle.trim().slice(0, 80) : cleanTitleFrom(fact),
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
          source_metadata: { source_platform: metadata.source_platform || 'knowledge_base', source_type: 'knowledge_fact', document_id: documentId, source_id: metadata.source_id || documentId, source_url: metadata.source_url || null },
          metadata: { document_id: documentId, segment_memory_id: t.memoryId || null, segment_id: t.segmentId || null, distill_agent: 'kb_distill_v2' },
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
        return { factId, ctxInput, fact: fact.trim(), entityTags, t };
      };

      // Batch the contextual embeds for a set of just-ingested facts: one embed
      // call (the service internally chunks at 20) + parallel Qdrant upserts.
      const flushEmbeds = async (pending) => {
        if (!pending.length) return;
        const vs = this.memoryGraphEngine.vectorStore;
        let vectors = [];
        try {
          vectors = (await vs?.generateEmbeddings?.(pending.map((p) => p.ctxInput))) || [];
        } catch (e) {
          this.logger.warn?.(`[kb-distill] batch embed failed (${pending.length} facts): ${e.message}`);
          vectors = [];
        }
        await Promise.all(pending.map(async (p, idx) => {
          try {
            const vec = vectors[idx];
            if (vec) enrichRecs.push({ factId: p.factId, vec });
            await vs?.storeMemory({
              id: p.factId, user_id: userId, org_id: orgId, content: p.fact,
              memory_type: 'fact', is_latest: true, tags: p.entityTags,
              project_ids: Array.isArray(p.t.project_ids) ? p.t.project_ids : [],
              primary_team_id: p.t.primary_team_id || null, visibility: p.t.visibility || 'private',
              created_at: new Date().toISOString(),
            }, vec ? { vector: vec } : {});
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
          const rawEntityNames = (ex.entities || [])
            .filter((e) => typeof e === 'string' && e.trim() && !_isArtifactRef(e))
            .slice(0, 8);
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
                if (rawEntityNames.length) canonicalItems.push({ memoryId: p.factId, entities: rawEntityNames });
                factObjs.push({
                  id: p.factId, user_id: userId, org_id: orgId, content: p.fact,
                  title: (p.fact || '').slice(0, 80), memory_type: 'fact',
                  tags: [
                    ...p.entityTags,
                    ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
                    ...(documentId ? [`doc-id:${documentId}`] : []),
                  ],
                  project: Array.isArray(p.t.project_ids) ? p.t.project_ids[0] : null,
                });
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
      this.logger.info?.(`[kb-distill] doc ${String(documentId).slice(0, 8)}: ${created} facts from ${eligible.length} sections in ${batches.length} LLM calls (failed=${failed})`);
      // Canonical-entity registry pass — AFTER all facts committed, off the hot
      // path (fire-and-forget). Creates org-scoped CanonicalEntity rows +
      // MemoryEntityLink rows from the extractor's canonical names; exact names
      // reuse existing entities, ambiguous fuzzy matches go to the review
      // queue. entity: tags above stay as the compatibility fallback.
      if (canonicalItems.length) {
        persistCanonicalLinks({ prisma: this.db, organizationId: orgId, items: canonicalItems, logger: this.logger })
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
  async _extractUnified(window, { entityContext = '', maxFacts = 8, docTitle = '', compact = false } = {}) {
    const model = process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
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
    // DETERMINISTIC LANGUAGE PIN. Telling the model to "use the section's language"
    // does not hold: the surrounding prompt is entirely English and the model reads
    // that as the target. Measured twice — a German document produced 16 English /
    // 2 German claims even WITH an explicit final override line, and a German
    // spreadsheet produced 10 English / 0 German.
    //
    // So decide it in code and NAME the language in the instruction. Function words
    // rather than characters, because diacritics are absent from plenty of real
    // German text and common in French/Spanish/Portuguese. Fully tenant-neutral —
    // a generic marker table, no customer terms — and it degrades to the generic
    // wording when undecided rather than guessing and translating the corpus.
    const _langProbe = String(content).slice(0, 4000).toLowerCase();
    const _langHits = (words) => words.reduce((n, w) => {
      const m = _langProbe.match(new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'gu'));
      return n + (m ? m.length : 0);
    }, 0);
    const _LANG_MARKERS = [
      ['German', ['der', 'die', 'das', 'und', 'nicht', 'mit', 'für', 'ist', 'ein', 'auch', 'werden']],
      ['French', ['le', 'la', 'les', 'des', 'et', 'pour', 'dans', 'est', 'une', 'avec']],
      ['Spanish', ['el', 'los', 'las', 'de', 'para', 'con', 'una', 'que', 'por']],
      ['Italian', ['il', 'lo', 'gli', 'delle', 'per', 'con', 'una', 'che', 'sono']],
      ['Dutch', ['het', 'een', 'niet', 'voor', 'met', 'zijn', 'wordt']],
      ['Portuguese', ['os', 'as', 'do', 'da', 'para', 'com', 'uma', 'não']],
      ['English', ['the', 'and', 'of', 'for', 'with', 'that', 'this', 'are']],
    ];
    let _bestLang = null; let _bestScore = 0;
    for (const [name, markers] of _LANG_MARKERS) {
      const score = _langHits(markers);
      if (score > _bestScore) { _bestScore = score; _bestLang = name; }
    }
    const _langLine = (_bestLang && _bestScore >= 5)
      ? `LANGUAGE: the SECTION is written in ${_bestLang}. Write every "t" and "f" in ${_bestLang}. Do NOT translate.`
      : 'LANGUAGE: write "t" and "f" in the SAME language the SECTION is written in. Do NOT translate.';
    const sys = `Extract only high-value durable workspace memory from the SECTION.
${_langLine} These instructions are in English for your benefit only — they are NOT a language sample. A tenant must be able to quote their own memories back to their own stakeholders, and same-language recall degrades when claims are silently translated. Only "memory_type" and the JSON keys stay English.
Return ONLY valid JSON:
{"facts":[{"t":"short topic","f":"one complete standalone contextual claim","memory_type":"fact|decision|preference|goal|event|lesson","importance":0.0,"source_quote":"exact verbatim substring from SECTION","entities":["Canonical Name"]}]}

SUBJECT RULE — the single most important rule. Every claim must NAME WHAT IT IS ABOUT, inside the claim text, so it still makes sense with the document gone. The memory is stored alone and retrieved by meaning; a reader who never saw this document must be able to tell what it concerns.
Judge each claim by SHAPE, not by wording — these patterns are abstract and carry no example text:
BAD   <bare role or kinship> + <attribute>        — the role is not a subject; whose?
BAD   <attribute or deficiency> with no owner     — belongs to nobody, cannot be retrieved
BAD   <pronoun> + <attribute>                     — the referent is lost once stored alone
GOOD  <named entity, persona, or document topic> + <attribute, scope, numbers>
If the subject of a claim is a bare role, kinship term, pronoun, or unnamed person or organisation, RESOLVE it: carry the named person, organisation, persona, product, or the document's own topic from the surrounding section INTO the claim text. Resolve pronouns to their referent. A claim you cannot give a concrete subject is not durable — drop it rather than emit it subjectless.
Rules: up to ${factCap} facts — capture EVERY distinct durable claim the section states (each decision, commitment, requirement, metric, figure, date, named party, defining fact). Do NOT drop a distinct high-value claim to keep the count low. A memory is a durable contextual unit, not a line-item: preserve the subject plus the decision, requirement, scope, owner, rationale, constraints, numbers, dates, and outcome when those details belong together in the source. Do not split one coherent decision or plan into separate mini-facts, and merge only genuine restatements of the same claim. Prefer 1-3 concise sentences (about 180-700 characters) when the section supports that context; keep a shorter claim only when the source fact is truly indivisible. Never repeat wording just to reach a length.

Promote only decisions, commitments, requirements, metrics, named parties, dates, and concrete specifications. Skip slogans, generic marketing, headers, footers, contacts, disclaimers, and OCR noise. Every source_quote must be one exact contiguous substring from SECTION that supports the entire claim; use 40-900 characters when needed for contextual support. Use fact when no other memory_type fits. Entities are named people, organizations, products, places, technologies, or standards only — a real proper noun a person would recognize. NEVER treat any of the following as an entity: source filenames or document titles (any source filename or document title), file names or extensions (.pdf/.eps/.png/.docx/.jpg), article/part/order numbers (article, part or order numbers in any format), fonts or typefaces (any font or typeface name), colours (any colour name, including brand-prefixed colours), paper/format sizes (any paper or format size code), URLs, or asset/file identifiers. Do not emit an entity that is merely a source or file reference. Do not add relationships; they are derived from verified facts after promotion.
FINAL AND OVERRIDING: write every "t" and "f" in the SECTION's own language, whatever that language is. These rules are written in English for your benefit only — they are instructions, NOT a language sample. Never translate the section's content into the language of these instructions.`;
    // Model fallback: if the primary extraction model fails (provider error,
    // finish=error, unparseable), fall through to a DIFFERENT family so a
    // section's facts are never lost to one model/provider hiccup. Configurable
    // via KB_UNIFIED_FALLBACK_MODELS (comma-separated).
    const _fallbacks = (process.env.KB_UNIFIED_FALLBACK_MODELS
      || 'google/gemini-2.5-flash-lite,openai/gpt-oss-20b').split(',').map((x) => x.trim()).filter(Boolean);
    const parsed = await chatCompletionWithFallback({
      // Dense sections emit up to 8 facts × (180-700 char claim + 40-900 char
      // source_quote + entities). 1800 tokens overflowed → finish=length →
      // truncated JSON → whole-section fact loss (~28% of calls). Give ample
      // headroom; the truncation-salvage in litellm-client is the backstop.
      models: [model, ..._fallbacks], temperature: 0, max_tokens: compact ? 2200 : 4500, json_mode: true, feature: 'kb-unified-extract',
      messages: [
        { role: 'system', content: sys },
        ...(entityContext ? [{ role: 'system', content: `KNOWN CANONICAL ENTITIES already in this workspace — reuse these EXACT spellings when the same thing appears:\n${entityContext}` }] : []),
        { role: 'user', content: `SECTION${window.heading ? ` [${window.heading}]` : ''}:\n${content}` },
      ],
    });
    let rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
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
        if (parts.length > 1) {
          for (const part of parts) split.push({ ...f, content: part, _atomized: true });
        } else {
          split.push(f);
        }
      }
      if (split.length !== rawFacts.length) {
        console.log(`[kb-atomic] ${rawFacts.length} claim(s) -> ${split.length} atomic fact(s)`);
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
    let sparseOnly = true;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const degraded = attempt > 1 && !sparseOnly;
        const claims = await this._extractUnified(window, {
          ...options,
          maxFacts: degraded ? Math.min(maxFacts, 2) : maxFacts,
          compact: degraded,
        });
        if (claims.length > best.length) best = claims;
        if (claims.length >= expected || attempt === attempts) return best;
        sparseOnly = true;
        this.logger.warn?.(`[kb-unified] sparse extraction (${claims.length}/${expected}); re-sampling at full budget (${attempt}/${attempts})`);
      } catch (error) {
        lastError = error;
        sparseOnly = false;
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
  async _ingestUnifiedWindow(window, { userId, orgId, documentId, metadata = {}, docTitle = '', entityContext = '', preExtractedFacts = null }) {
    if (!window?.segmentId) return [];
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
      const entityTags = fact.entities.map((e) => { const s = normalizeEntity(e); return s ? `entity:${s}` : null; }).filter(Boolean);
      // ts: date tag (the previous-version rule) — derived from the doc's event
      // date (document_date) else ingest time. Put it in the fact's OWN tags so
      // BOTH the engine write AND the vector re-upsert carry it (the ingestMemory
      // ts-stamp gets clobbered by the 2-phase write; this is the durable source).
      const _tsd = (() => { try { const d = metadata.document_date ? new Date(metadata.document_date) : new Date(); return Number.isNaN(d.getTime()) ? new Date() : d; } catch { return new Date(); } })();
      const _tsDay = `ts:${_tsd.toISOString().slice(0, 10)}`;
      const tags = normalizeTagsArray([
        ...(metadata.tags || []), 'promoted-memory', `memory-type:${fact.memory_type}`, 'distilled-from-kb', _tsDay, ...entityTags,
        ...(metadata.document_type ? [`document-type:${safeDocumentType(metadata.document_type)}`] : []),
        ...(fact.memory_type === 'fact' ? ['extracted-fact'] : []),
        ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
        ...(documentId ? [`doc-id:${documentId}`] : []),
      ]);
      try {
        const res = await this.memoryGraphEngine.ingestMemory({
          user_id: userId, org_id: orgId,
          scope: metadata.scope, visibility: metadata.visibility || 'private',
          primary_team_id: metadata.primary_team_id || null,
          project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
          content: fact.f, title: fact.t, memory_type: fact.memory_type, tags,
          importance_score: fact.importance,           // LLM-rated salience (same-pass) → confidence/recall ranking + FE score
          document_date: metadata.document_date || null,
          source_metadata: { source_platform: metadata.source_platform || 'knowledge_base', source_type: 'knowledge_fact', document_id: documentId, source_id: metadata.source_id || documentId, source_url: metadata.source_url || null, document_type: metadata.document_type || 'general' },
          metadata: {
            document_id: documentId,
            document_type: metadata.document_type || 'general',
            document_type_confidence: metadata.document_type_confidence ?? null,
            segment_id: window.segmentId || null,
            source_start: fact.source_start,
            source_end: fact.source_end,
            source_quote: fact.source_quote,
            support_segment_ids: fact.support_segment_ids || [window.segmentId],
            support_quotes: fact.support_quotes || [fact.source_quote],
            distill_agent: 'kb_unified_v2',
          },
          skip_fact_extraction: true, defer_entity_linking: true,
          append_timestamp_to_content: false,
          skipSmartRouting: true, skipPredictCalibrate: true, skipAdvisoryLock: true,
          skip_relationship_classification: true, skip_contradiction_detection: true,
        });
        const id = res?.memoryId || res?.id || null;
        if (!id || (res?.operation || '').startsWith('skipped')) continue;
        idByIdx[i] = id;
        factObjs.push({ id, user_id: userId, org_id: orgId, content: fact.f, title: fact.t, memory_type: fact.memory_type, tags, project: Array.isArray(metadata.project_ids) ? metadata.project_ids[0] : null, support_segment_ids: fact.support_segment_ids, support_quotes: fact.support_quotes });
        embedPending.push({ id, fact: fact.f, memory_type: fact.memory_type, ctxInput: `${docTitle}${window.heading ? ` — ${window.heading}` : ''}\n${fact.f}`, tags, project_ids: metadata.project_ids, primary_team_id: metadata.primary_team_id, visibility: metadata.visibility });
        if (!orgIsRemote(orgId)) {
          evidenceLinks.push({ memoryId: id, documentId, segmentId: window.segmentId || null, linkType: 'supports', confidence: fact.importance, excerpt: fact.source_quote });
          derivations.push({ memoryId: id, derivationMethod: 'llm_extract', derivationAgent: String(extractionModel).slice(0, 100), confidence: fact.importance, metadata: { document_id: documentId, segment_id: window.segmentId, source_start: fact.source_start, source_end: fact.source_end } });
        }
      } catch (e) { this.logger.warn?.(`[kb-unified] fact ingest failed: ${e.message}`); }
    }
    // Contextual embeds (one batched call) so the facts are vector-recallable.
    if (embedPending.length && vs) {
      try {
        const vecs = (await vs.generateEmbeddings?.(embedPending.map((p) => p.ctxInput))) || [];
        await Promise.all(embedPending.map(async (p, idx) => {
          try {
            const vec = vecs[idx];
            // Store the CLEAN fact as content; the contextual ctxInput (docTitle+heading+fact) is the
            // EMBEDDING input only (vec), never the stored content — else the filename/title leaks into
            // every fact ("loi.txt Every second…"). Mirrors the distill's flushEmbeds contract.
            await vs.storeMemory({ id: p.id, user_id: userId, org_id: orgId, content: p.fact, memory_type: p.memory_type, is_latest: true, tags: p.tags, project_ids: Array.isArray(p.project_ids) ? p.project_ids : [], primary_team_id: p.primary_team_id || null, visibility: p.visibility || 'private', created_at: new Date().toISOString() }, vec ? { vector: vec } : {});
          } catch (ve) { this.logger.warn?.(`[kb-unified] embed failed: ${ve.message}`); }
        }));
      } catch (e) { this.logger.warn?.(`[kb-unified] batch embed failed: ${e.message}`); }
    }
    if (evidenceLinks.length) {
      await this.db.memoryEvidenceLink.createMany({ data: evidenceLinks, skipDuplicates: true });
      await this.db.memoryDerivation.createMany({ data: derivations, skipDuplicates: true });
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
            id: crypto.randomUUID(), from_id: fromId, to_id: toId, type: rel.type, confidence: 0.85,
            metadata: { created_by: 'kb_unified_v2', document_id: documentId, intra_window: true },
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
        await persistCanonicalLinks({ prisma: this.db, organizationId: orgId, items: _canonItems, logger: this.logger });
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

    const model = process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
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
            console.log(`[rel-validator][shadow] kb-hybrid WOULD-DOWNGRADE ${type}→${downgradeType} (${pair.fromId.slice(0,8)}→${pair.toId.slice(0,8)}): ${verdict.reason}`);
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
      console.warn(`[kb-curate] prefilter dropped ${droppedNoQuote + droppedMalformed} of `
        + `${incoming.length} candidates (no_source_quote=${droppedNoQuote}, `
        + `malformed=${droppedMalformed}) — these never reached the curator`);
    }
    if (incoming.length > 48) {
      console.warn(`[kb-curate] pool truncated ${incoming.length} → 48 before curation`);
    }
    if (!pool.length) return [];

    const cap = Math.max(1, Math.min(30, Number(maxMemories) || 6));
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
    const model = process.env.KB_CURATOR_MODEL || process.env.KB_UNIFIED_MODEL
      || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
    const input = pool.map((candidate, index) => ({
      i: index,
      type: candidate.memory_type,
      claim: String(candidate.f).slice(0, 500),
      importance: Number(candidate.importance || 0.5),
      entities: (candidate.entities || []).slice(0, 8),
      source: String(candidate.source_quote).slice(0, 500),
    }));
    const system = `You curate durable organizational memory from source-grounded candidates extracted from ONE document.
Return up to ${cap} memories that TOGETHER COVER EVERY distinct important claim in the document — each decision, commitment, requirement, metric, figure, date, event, validated lesson, stable preference, and defining fact. Coverage is the goal: do NOT drop a distinct high-value claim (a funding status, ownership term, price, deadline, named role) just to keep the count low. One memory per distinct claim.
Merge compatible candidates into one complete, information-dense memory. Never merge unrelated subjects. A strong memory keeps the subject together with the relevant decision or requirement, scope, owner, rationale, constraints, numbers, dates, and outcome. Do not split one coherent plan or decision into mini-facts. Prefer 1-3 concise sentences when the supporting candidates contain that context; do not pad or repeat content.
Omit slogans, generic descriptions, contact-directory trivia, repeated examples, and details useful only when reading the raw source. Every memory MUST be fully supported by its support_indices. Do not invent, infer, or add facts. Preserve names, numbers, dates, conditions, owners, and outcomes. A memory may cite multiple candidates. Use the source language. Merge ONLY genuine duplicates (the same claim restated); never merge or drop two DISTINCT claims to reduce the count.

Return ONLY valid JSON. Do not add prose, markdown, or an explanation before or after the JSON. The complete response must exactly match this shape:
{"memories":[{"title":"short descriptive title","memory_type":"fact|decision|preference|goal|event|lesson|summary|synthesis","content":"1-3 source-grounded sentences","support_indices":[0,1]}]}
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
      || 'google/gemini-2.5-flash-lite,openai/gpt-oss-20b').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const parsed = await chatCompletionWithFallback({
        models: [model, ..._curatorFallbacks], temperature: 0, max_tokens: 4000, json_mode: true, feature: 'kb-document-curator',
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
        console.log(`[kb-curate] pool=${pool.length} model_returned=${modelReturned} `
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
    const model = process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
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
              || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b'],
            temperature: 0.2, max_tokens: 420, feature: 'kb-doc-summary',
            messages: [
              { role: 'system', content: 'Write ONE self-contained paragraph stating what this document establishes. '
                + 'Use only the supplied facts. Name the subjects explicitly — never "the document", "this file", '
                + 'a filename, or a count of memories. Preserve figures, units, dates and proper nouns verbatim. '
                + 'Where the facts enumerate a set (supported brands, covered regions, required steps), keep the '
                + 'FULL enumeration in one sentence rather than naming one example. No preamble, no markdown.' },
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
      const parentRes = await this.memoryGraphEngine.ingestMemory({
        user_id: userId, org_id: orgId,
        scope: metadata.scope || (Array.isArray(metadata.project_ids) && metadata.project_ids.length > 0 ? 'project' : metadata.primary_team_id ? 'team' : undefined),
        visibility: metadata.visibility || 'private',
        primary_team_id: metadata.primary_team_id || null,
        project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
        content: docSummary, title: docTitle, memory_type: 'summary',
        // The parent is source-local navigation context, not a durable claim.
        importance_score: 0.45,
        document_date: metadata.document_date || null,
        tags: normalizeTagsArray([
          ...(metadata.tags || []), 'knowledge-base', 'document', 'document-summary',
          `ts:${_tsd.toISOString().slice(0, 10)}`,
          ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
          ...(documentId ? [`doc-id:${documentId}`] : []),
          ...(metadata.document_type ? [`document-type:${safeDocumentType(metadata.document_type)}`] : []),
        ]),
        source_metadata: { source_platform: metadata.source_platform || 'knowledge_base', source_type: 'document', document_id: documentId, source_id: metadata.source_id || documentId, filename: metadata.filename || null, document_type: metadata.document_type || 'general' },
        metadata: { semantic_role: 'document', ingest_tree_role: 'parent', document_id: documentId, document_type: metadata.document_type || 'general', document_type_confidence: metadata.document_type_confidence ?? null, child_count: childIds.length, total_facts: totalFacts },
        skip_fact_extraction: true, skipPredictCalibrate: true, skip_contradiction_detection: true,
        append_timestamp_to_content: false,
        skip_relationship_classification: true, smartIngest: false, skipAdvisoryLock: true, defer_entity_linking: true,
      });
      docParentId = parentRes?.memoryId || parentRes?.id || null;
      if (docParentId) {
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
    const { userId, orgId, filename, fileBuffer, contentType, metadata = {}, onProgress = null } = opts;
    const emit = (stage, progress, extra = {}) => { try { onProgress?.({ stage, progress, ...extra }); } catch { /* never let telemetry break ingest */ } };
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

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
    const parseResult = await this._parseDocument(fileBuffer, contentType, filename, {
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
      .update([orgId, 'knowledge_base', 'knowledge_upload', _scopedSourceId, '1', checksum].join(' '))
      .digest('hex').slice(0, 64);

    // SKIP-UNCHANGED (dirty-tracking): identical bytes + same scope ALREADY parsed + distilled →
    // return the existing document's counts and spend ZERO tokens (no docling parse, no distill
    // windows, no consolidation, no entity linking). Re-uploading the same file used to re-run the
    // FULL pipeline (observed: same PDF uploaded twice → 2×675s + 2× the LLM spend).
    // Disable with KB_SKIP_UNCHANGED=0.
    if (String(process.env.KB_SKIP_UNCHANGED ?? '1') !== '0') {
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
      // Pre-generate a stable doc id so segments can reference it on both sides.
      const docId = crypto.randomUUID();
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
        structureExtracted: parseResult.success,
        tags: _docTags,
        checksum,
        contentType,
        filename,
        createdAt: new Date().toISOString(),
        metadata: { ...metadata, document_type: documentType, document_type_confidence: documentClassification.confidence },
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
    const _tSeg = Date.now();
    let segments;
    let _segmentsNeedEmbed = false; // true only when segments were freshly created this request
    if (orgIsRemote(orgId)) {
      // Always rebuild in-memory for remote — there are no central DB rows to dedup against.
      segments = await this._createSegments({
        documentId: knowledgeDoc.id,
        userId,
        orgId,
        parseResult
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
          parseResult
        });
        _segmentsNeedEmbed = segments.length > 0;
      }
    }
    let _msEmbed = 0;
    if (_segmentsNeedEmbed) {
      // Step 5: Embed segments.
      // Central path: store vector in Qdrant + update DB row (vectorStored=true).
      // Remote path: embed and push segment + vector to the agent via amrKbSegment.
      const _tEmbed = Date.now();
      await this._embedSegments(segments, orgId);
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
        console.log(`[kb-tables] doc ${String(knowledgeDoc.id).slice(0, 8)}: parser returned no tables `
          + `(engine=${parseResult?.engine || '?'}) — nothing to persist`);
      } else if (!this.db?.documentTable) {
        console.warn('[kb-tables] db.documentTable missing — prisma client lacks the model; grid NOT persisted');
      }
      if (_tables.length && !orgIsRemote(orgId) && this.db?.documentTable) {
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
          console.log(`[kb-tables] doc ${String(knowledgeDoc.id).slice(0, 8)}: persisted `
            + `${_tables.length} table(s), ${_rowsTotal} rows — now exactly queryable`);
        }
      }
    } catch (e) {
      console.warn(`[kb-tables] persist skipped (ingest unaffected): ${e.message}`);
    }

    // Step 6: Promote candidate memories
    emit('promoting', 80, { segments: segments.length });
    const _tPromote = Date.now();
    const promoted = await this._promoteMemories({
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
    });
    this._extractPromotedEntitiesAsync({ memories: promoted.memories, userId, orgId, documentId: knowledgeDoc.id });
    this._structureClaimsAsync({ memories: promoted.memories, orgId });
    const _msPromote = Date.now() - _tPromote;
    console.log(`[phase1-timing] parse=${_msParse}ms seg=${_msSeg}ms embed=${_msEmbed}ms promote=${_msPromote}ms segs=${segments.length} memories=${promoted.memories.length}`);
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
    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: _cands,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id),
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
    const { userId, orgId, filename, fileBuffer, contentType, schema, metadata = {} } = opts;
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
    const parseResult = await this._parseDocument(fileBuffer, contentType, filename);

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
        metadata: { providerKey, sourceId },
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
          metadata: { providerKey, sourceId },
        },
      });
      segments = [segment];
    }

    // Step 4: embed segment — pass orgId so _embedSegments routes to agent for remote.
    await this._embedSegments(segments, orgId);

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
            return {
              success: true,
              engine: parseOk ? 'docling' : 'docling-chunks-only',
              text: synthesizedText,
              markdown: doclingResult.markdown || synthesizedText,
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

      // Fallback to existing parsers
      return {
        success: true,
        engine: 'fallback',
        text: fileBuffer.toString('utf-8'),
        wordCount: fileBuffer.toString('utf-8').split(/\s+/).length,
        metadata: {}
      };
    } catch (error) {
      console.error('[DocumentFirstIngestion] Parse failed:', error);
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
  async _createSegments({ documentId, userId, orgId, parseResult }) {
    const remote = orgIsRemote(orgId);
    const hybridChunks = parseResult?.metadata?.hybridChunks;
    const hasChunks = Array.isArray(hybridChunks) && hybridChunks.length > 0;
    // If parse failed AND no chunks, nothing to segment.
    if ((!parseResult.success || !parseResult.text) && !hasChunks) {
      return [];
    }
    console.log(`[segments] hybridChunks=${hasChunks ? hybridChunks.length : 'none'} parseText=${(parseResult?.text || '').length}ch for doc ${documentId}`);

    // SEMANTIC SEGMENTS (default; reversible via KB_SEMANTIC_SEGMENTS=false). Docling's HybridChunker
    // text can start/end MID-WORD (token-window artifacts: "...doc" | "ents to share…"), poisoning the
    // evidence layer (recall hop-2) + embeddings. Re-segment the CLEAN docling markdown (or text) with
    // boundary-aware chunkText — splits only at heading/paragraph/sentence edges (forceSplit is
    // sentence-safe), never mid-word; heading-aware via markdown ##. Falls through to hybrid/fallback
    // if it yields nothing. Same clean units the distill re-windows over → uniform, no mid-word anywhere.
    if (String(process.env.KB_SEMANTIC_SEGMENTS ?? 'true').toLowerCase() !== 'false') {
      const src = (parseResult.markdown && parseResult.markdown.trim().length > 40)
        ? parseResult.markdown : (parseResult.text || '');
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
        } catch (e) { console.warn(`[segments] semantic chunk failed: ${e.message}`); }
        if (chunks.length) {
          const segments = [];
          let segmentIndex = 0;
          let previousSegmentId = null;
          for (const text of chunks) {
            const contentHash = crypto.createHash('sha256').update(text).digest('hex');
            const hm = text.match(/^#{1,6}\s+(.+)$/m);
            const heading = hm ? hm[1].slice(0, 500) : null;
            const base = {
              documentId, userId, orgId, segmentType: 'structured', content: text, contentHash,
              segmentIndex, previousSegmentId, depth: 0, startOffset: null, endOffset: null,
              wordCount: text.split(/\s+/).length, metadata: { heading, source: 'semantic_chunk' },
            };
            if (remote) {
              const segment = { id: crypto.randomUUID(), ...base, createdAt: new Date().toISOString() };
              segments.push(segment); previousSegmentId = segment.id; segmentIndex++;
            } else {
              try {
                const segment = await this.db.knowledgeSegment.create({ data: base });
                segments.push(segment); previousSegmentId = segment.id; segmentIndex++;
              } catch (err) { console.warn(`[segments] semantic insert failed: ${err.message}`); }
            }
          }
          if (segments.length) {
            console.log(`[segments] semantic: ${segments.length} clean segments for doc ${documentId} (no mid-word)`);
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
            metadata: { heading, page: hc.page || null, source: 'docling_hybrid' },
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
                metadata: { heading, page: hc.page || null, source: 'docling_hybrid' },
              },
            });
            segments.push(segment);
            previousSegmentId = segment.id;
            segmentIndex++;
          } catch (err) {
            console.warn(`[segments] hybrid chunk insert failed: ${err.message}`);
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
          metadata: { source: 'paragraph_fallback' },
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
            metadata: { source: 'paragraph_fallback' }
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
  async _embedSegments(segments, callerOrgId) {
    if (!this.embeddingService) return;

    // Legacy: a dedicated hivemind_evidence collection. Per-tenant: evidence
    // lives in the org container alongside memory, separated by layer=evidence.
    const legacyEvidence = process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence';

    for (const segment of segments) {
      const segOrgId = callerOrgId || segment.orgId;
      try {
        const embedding = await this.embeddingService.embed(segment.content);

        if (orgIsRemote(segOrgId)) {
          // Remote path: push segment row + vector to the agent. No central DB or Qdrant write.
          await amrKbSegment(segOrgId, {
            id: segment.id,
            userId: segment.userId,
            documentId: segment.documentId,
            content: segment.content,
            contentHash: segment.contentHash,
            segmentType: segment.segmentType,
            segmentIndex: segment.segmentIndex,
            previousSegmentId: segment.previousSegmentId || null,
            metadata: segment.metadata || {},
            createdAt: segment.createdAt || new Date().toISOString(),
          }, Array.isArray(embedding) ? embedding : []);
        } else {
          const collectionName = PER_TENANT
            ? await resolveCollectionForOrg(segment.orgId)
            : legacyEvidence;

          // Store evidence vector. In per-tenant mode the org container holds both
          // memory + evidence — layer=evidence keeps it out of memory recall.
          await this.embeddingService.storeVector({
            collectionName,
            id: segment.id,
            vector: embedding,
            payload: {
              segment_id: segment.id,
              document_id: segment.documentId,
              user_id: segment.userId,
              org_id: segment.orgId,
              segment_type: segment.segmentType,
              layer: 'evidence',
              content_preview: segment.content.slice(0, 200)
            }
          });

          await this.db.knowledgeSegment.update({
            where: { id: segment.id },
            data: { vectorStored: true }
          });
        }
      } catch (error) {
        console.error(`[DocumentFirstIngestion] Failed to embed segment ${segment.id}:`, error);
      }
    }
  }

  /**
   * Promote candidate memories from segments
   * Selective: only segments that represent reusable organizational truths
   * @private
   */
  async _promoteMemories({ documentId, segments, userId, orgId, metadata, promotionStrategy = 'kb_default' }) {
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

    // ── FACTS-ONLY memory creation (default; reversible via KB_FACTS_ONLY=false) ──────────────────────
    // Segments are EVIDENCE (hop-2). Memories = the LLM-distilled atomic FACTS only. We do NOT promote
    // raw segments as "section" memories — those duplicated evidence, carried mid-word chunk text, and
    // spawned a fact→section Derives edge per fact (the bulk of the "Derives noise"). Instead: distill the
    // segments straight into clean fact memories (with filename/doc-id provenance), then run the
    // co-mention linker over the FACTS so they gain real cross-fact relationships (Updates/Extends/
    // Mentions via shared entities) + intra-doc cohesion (batch peers). Result: fewer, richer, fully
    // attributable memories — uniform for central/managed/self-host (the distill + linker both route by
    // org type at their own seams).
    if (String(process.env.KB_FACTS_ONLY ?? 'true').toLowerCase() !== 'false') {
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
        heading: null,
        page: null,
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
        const uConc = Math.max(1, Number(process.env.KB_UNIFIED_CONCURRENCY || 4));
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
        const DOC_CAP = Math.min(400, Math.max(30, Math.ceil(_docChars / 550)));
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
            heading: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.metadata?.heading || null,
            page: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.startPage || null,
            maxFacts: Math.max(1, Math.min(UWMAX, Math.round((content.length / 1000) * UFPK))),
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
        let uBudget = DOC_CAP;
        const uWorkers = Array.from({ length: Math.min(uConc, uWindows.length) }, async () => {
          while (wi < uWindows.length && uBudget > 0) {
            const w = { ...uWindows[wi++] };
            const grant = Math.max(1, Math.min(w.maxFacts || 8, uBudget));
            uBudget -= grant;
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
                source_window_content: w.content,
              })));
            }
            uBudget += Math.max(0, grant - got); // return the unused part of the reservation
          }
        });
        await Promise.all(uWorkers);
        // NEVER exit a document silently. The tail-drop above survived because nothing
        // reported it: a truncated document and a thin document produced identical logs.
        console.log(`[kb-unified] windows_total=${uWindows.length} windows_processed=${wi} `
          + `budget_exhausted=${uBudget <= 0} doc_cap=${DOC_CAP} chars=${_docChars} `
          + `candidates=${extractedCandidates.length}`);
        if (wi < uWindows.length) {
          console.warn(`[kb-unified] TAIL DROPPED: ${uWindows.length - wi} of ${uWindows.length} `
            + `windows never sent to the LLM (budget ${DOC_CAP} exhausted). Facts in those `
            + `windows do not exist in the memory layer.`);
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
        const _dynamicCap = Math.max(8, extractedCandidates.length);
        const curated = await this._curateDocumentClaims(extractedCandidates, {
          docTitle,
          maxMemories: Number(process.env.KB_CURATED_MEMORY_CAP || 0) || _dynamicCap,
        });
        // WHOLE-DOCUMENT SUMMARY — one per document, brief but covering the whole thing.
        // generateDocumentSummary() walks every section (up to 14) and quotes ~220 chars of
        // each, so it reflects the entire document rather than its first page. It existed
        // ONLY on the legacy chunker path (document-chunker.js:516): 35 of 515 memories in
        // org 1380251c carry the `document-summary` tag and ZERO new canonical uploads do.
        // Without it "what is this document about" has nothing to retrieve.
        // It also feeds entityContext below — that P2 change read metadata.documentSummary,
        // which nothing set, so it was inert until this landed.
        let _docSummaryText = null;
        try {
          const { generateDocumentSummary } = await import('./document-chunker.js');
          _docSummaryText = generateDocumentSummary(fullText, {
            title: docTitle, pages: metadata?.pageCount || null, ...(metadata || {}),
          });
          if (_docSummaryText) {
            metadata = { ...(metadata || {}), documentSummary: _docSummaryText };
            const _sum = await this._ingestUnifiedWindow(
              { segmentId: promotableSegments[0]?.id || null, content: _docSummaryText, heading: null, page: null },
              { userId, orgId, documentId, metadata, docTitle,
                preExtractedFacts: [{
                  content: _docSummaryText,
                  title: `Document: ${docTitle}`,
                  // `summary` not `fact`: recall must be able to prefer a distilled overview
                  // for a document-level question and rank it BELOW atoms for a detail one.
                  memory_type: 'summary',
                  importance: 0.9,
                  source_quote: String(fullText || '').slice(0, 120),
                  tags: ['document-summary', 'kb-canonical'],
                }] },
            );
            if (_sum?.[0]) console.log(`[kb-summary] document summary memory created id=${_sum[0].id} chars=${_docSummaryText.length}`);
            else console.warn('[kb-summary] summary memory NOT persisted — a document-level question has nothing to retrieve');
          }
        } catch (error) {
          console.warn(`[kb-summary] failed: ${error.message}`);
        }

        const uFacts = [];
        const extraEvidenceLinks = [];
        for (const claim of curated) {
          const sourceWindow = {
            segmentId: claim.segmentId,
            content: claim.source_window_content || claim.source_quote,
            heading: claim.heading || null,
            page: claim.page || null,
          };
          const persisted = await this._ingestUnifiedWindow(sourceWindow, {
            userId, orgId, documentId, metadata, docTitle, preExtractedFacts: [claim],
          });
          const memory = persisted?.[0];
          if (!memory) continue;
          uFacts.push(memory);
          if (!orgIsRemote(orgId)) {
            for (let index = 1; index < (claim.support_segment_ids || []).length; index++) {
              extraEvidenceLinks.push({
                memoryId: memory.id, documentId,
                segmentId: claim.support_segment_ids[index], linkType: 'supports',
                confidence: claim.importance, excerpt: claim.support_quotes?.[index] || null,
              });
            }
          }
        }
        if (extraEvidenceLinks.length) {
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
        return { candidates: targets.map((t) => ({ segmentId: t.segmentId, content: t.content, reason: 'unified_source' })), memories: uFacts, documentParentId: uDocParent, coverage: curated._coverage || null };
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
        // Route through SmartIngestRouter for deterministic edges
        const payload = {
          userId,
          orgId,
          user_id: userId,
          org_id: orgId,
          // Honor explicit scope (e.g. 'organization' from an org-targeted KB
          // upload) before project/team inference; lift visibility to TOP level
          // so graph-engine infers scope='organization' for org uploads.
          scope: metadata.scope || (Array.isArray(metadata.project_ids) && metadata.project_ids.length > 0
            ? 'project'
            : metadata.primary_team_id ? 'team' : undefined),
          visibility: metadata.visibility || 'private',
          primary_team_id: metadata.primary_team_id || null,
          project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
          content: segment.content,
          // Title: prefer the chunk heading; else first sentence/line of the
          // segment (meaningful + searchable) instead of the opaque
          // "Extracted from <hash>" fallback that produced unusable titles.
          title: (segment.metadata?.heading && !isPageFurnitureHeading(segment.metadata.heading))
            ? String(segment.metadata.heading).slice(0, 200)
            : cleanTitleFrom(segment.content) || `Segment ${documentId.slice(0, 8)}`,
          source_type: 'knowledge_segment',
          source_metadata: {
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
          // Fact-extract enabled by default. Big PDFs (≥30 segs) skip per-segment
          // LLM to keep ingest under a minute — facts can be extracted lazily by
          // promotion-cron later. Override via metadata.force_fact_extraction.
          skip_fact_extraction: metadata.force_fact_extraction === true
            ? false
            : (Array.isArray(segments) && segments.length >= 30),
          // Strict contradiction mode for KB: only fires when BOTH sides
          // carry negation/change language AND token-similarity ≥0.65.
          // Catches real "value updated" cases (e.g. price change in newer
          // catalog), skips noise from unrelated facts.
          strict_contradictions: true,
          documentDate: new Date(),
          metadata: {
            ...(metadata || {}),
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
        console.error(`[DocumentFirstIngestion] Failed to promote segment ${segment.id}:`, error);
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
    const workers = Array.from({ length: Math.min(PROMOTE_CONCURRENCY, promotableSegments.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= promotableSegments.length) return;
        await promoteOne(promotableSegments[i]);
      }
    });
    await Promise.all(workers);

    // #6 — batched provenance inserts (2 round-trips total vs 2×N). Append-only
    // link rows, no advisory-lock semantics — safe + contained to the KB path.
    // RESIDENCY: memoryEvidenceLink + memoryDerivation are CENTRAL-only provenance tables FK'd to the
    // memory. For a remote (self-host) org the memory is on the agent, so these createMany throw + are
    // pointless. Skip for remote — segment↔memory traceability for self-host is the agent's concern.
    if (evidenceLinkRows.length && !orgIsRemote(orgId)) {
      await this.db.memoryEvidenceLink.createMany({ data: evidenceLinkRows, skipDuplicates: true })
        .catch((e) => this.logger.warn?.(`[kb] evidence-link batch failed: ${e.message}`));
    }
    if (derivationRows.length && !orgIsRemote(orgId)) {
      await this.db.memoryDerivation.createMany({ data: derivationRows, skipDuplicates: true })
        .catch((e) => this.logger.warn?.(`[kb] derivation batch failed: ${e.message}`));
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
                console.warn(`[doc-first] PartOf edge ${childId.slice(0, 8)}→${docParentId.slice(0, 8)} failed (native + fallback):`, err2.message);
              }
            }
          };
          const edgeTasks = persistedChildIds.map(childId => createPartOf(childId));
          await Promise.all(edgeTasks);

          memories.push({ id: docParentId, operation: 'document_parent', isParent: true });
        }
      } catch (parentErr) {
        console.warn('[doc-first] Failed to attach Document parent:', parentErr.message);
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
