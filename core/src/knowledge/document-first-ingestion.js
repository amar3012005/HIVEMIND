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
import { memoryChatFetch } from '../llm/groq-fallback.js';
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
import { validateEnvelope, normalizeProvenance, detectMode } from './canonical-ingest.js';

const DURABLE_EXTRACT_TYPES = ['fact', 'preference', 'decision', 'lesson', 'goal', 'event'];
const INTRA_WINDOW_REL_TYPES = ['Extends', 'Mentions', 'Contradicts'];

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
      // The source remains recallable even when its claim is not durable enough.
      && normalizedImportance(item.importance) >= threshold)
    .slice(0, maxFacts)
    .map((item) => {
      const start = content.indexOf(item.source_quote);
      const rated = Number(item.importance);
      return {
        t: (typeof item.t === 'string' && item.t.trim() && !isGarbageTitle(item.t))
          ? item.t.trim().slice(0, 80)
          : cleanTitleFrom(item.f, 48),
        f: item.f.trim(),
        memory_type: item.memory_type,
        source_quote: item.source_quote,
        source_start: start,
        source_end: start + item.source_quote.length,
        importance: normalizedImportance(rated),
        entities: (Array.isArray(item.entities) ? item.entities : [])
          .filter((entity) => typeof entity === 'string' && entity.trim()).slice(0, 8),
        rels: (Array.isArray(item.rels) ? item.rels : [])
          .filter((rel) => rel && Number.isInteger(rel.to) && INTRA_WINDOW_REL_TYPES.includes(rel.type)).slice(0, 5),
      };
    });
}

export function normalizeCuratedClaims(rawMemories, candidates, maxMemories = 8) {
  const pool = Array.isArray(candidates) ? candidates : [];
  const cap = Math.max(1, Math.min(12, Number(maxMemories) || 8));
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
      t: String(memory.title || primary.t).trim().slice(0, 80),
      f: content,
      memory_type: memory.memory_type,
      importance: Math.max(0.65, Math.min(1, importance)),
      // Canonical entities come only from exact-span extraction. The curator
      // may merge claims but cannot introduce a new graph identity.
      entities: [...new Set(supports.flatMap((item) => item.entities || []))].slice(0, 12),
      rels: [],
      segmentId: primary.segmentId,
      source_quote: primary.source_quote,
      source_start: primary.source_start,
      source_end: primary.source_end,
      support_segment_ids: [...new Set(supports.map((item) => item.segmentId))],
      support_quotes: supports.map((item) => item.source_quote),
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
- Contact/company blocks: postal addresses, phone/fax numbers, email addresses, company registration or legal-form lines (e.g. "SOLVIS GmbH, Grotrian-Steinweg-Straße 12, Telefon 0531 28904-0").
- Raw tabular number dumps with no prose: a run of bare numbers, axis labels, or dimensions with no stated claim is NOT a fact (e.g. "0 0,5 1 1,5 2 2,5 ..."). Only extract a measurement when you can state it as a complete sentence naming WHAT the value is and for WHICH thing (e.g. "The SolvisBruno 10 kW has a fuel heat output of 3.1–10.7 kW") — otherwise skip it.
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
          const entityTags = (ex.entities || []).filter((e) => typeof e === 'string' && e.trim())
            .slice(0, 8)
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
  async _extractUnified(window, { entityContext = '', maxFacts = 8, docTitle = '' } = {}) {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.KB_UNIFIED_MODEL || process.env.MEMORY_PROCESSOR_MODEL || 'openai/gpt-oss-120b';
    const content = (window.content || '').slice(0, 6000);
    if (!apiKey || content.trim().length < 40) {
      // Heuristic fallback: sentence-split facts, no entities/rels — never blocks.
      return content.split(/(?<=[.!?])\s/).map((x) => x.trim()).filter((x) => x.length >= 25).slice(0, maxFacts)
        .map((f) => ({ t: cleanTitleFrom(f, 48), f, entities: [], rels: [] }));
    }
    const REL_TYPES = ['Extends', 'Mentions', 'Contradicts', 'Updates'];
    const sys = `You are a precise knowledge-extraction engine. From the SECTION below, extract in ONE pass: atomic FACTS, the CANONICAL ENTITIES each mentions, the RELATIONSHIPS between facts, and each fact's IMPORTANCE. Return ONLY JSON: {"facts":[{"t":"<3-6 word Title Case topic>","f":"<one complete standalone sentence, explicit subject, never a bare it/they/this>","importance":<0.0-1.0>,"entities":["Canonical Name", ...],"rels":[{"to":<index of another fact in THIS list>,"type":"<Extends|Mentions|Contradicts|Updates>"}, ...]}, ...]}.

FACT rules — FEWEST, HIGHEST-SIGNAL (quality over coverage):
- "f": a complete self-contained sentence; preserve numbers/units/dates/names verbatim; never invent or generalize. Keep it SPECIFIC to THIS document — concrete subjects, real figures, named parties — not a generic restatement.
- Extract only decision-relevant stated information (names, roles, products, specs, numbers, dates, decisions, events, causal claims). NON-REDUNDANT — never restate the same point; keep the single most specific.
- SKIP page furniture, headers/footers, doc/article numbers, addresses, phone/email, legal-disclaimer/copyright lines, raw number dumps with no prose, and OCR garbage/mojibake.
- At MOST ${maxFacts} facts. A thin/decorative section → "facts":[].

IMPORTANCE rules — rate each fact 0.0-1.0 by how decision-critical + specific it is:
- 0.85-1.0: a decision, commitment, deadline, price/budget figure, contract term, or a named strategic fact unique to this org/project.
- 0.6-0.8: a concrete spec/metric/role/event with named parties or numbers.
- 0.3-0.5: supporting context, general description, or background.
- < 0.3: near-boilerplate (you should usually SKIP these instead).

ENTITY rules — ONE canonical name per real-world thing (so it never forks):
- A SHORT noun (1-3 words): a specific person, organization, product/model, place, technology, or standard. NEVER a phrase, clause, description, or generic concept.
- Use the FULL canonical name, not a partial — "Amar Sai Gadde" not "Amar"; "B&B Sinn für Marken" not "B&B" — and reuse that EXACT form for every mention.
- Source language as written (do not translate); singular; drop legal suffixes; prefer full term over acronym unless the acronym is the proper name. 3-7 high-signal entities per fact max.

RELATIONSHIP rules — only between facts in THIS list, only when genuinely related:
- "Extends": one fact adds detail/nuance to another (same subject, complementary). "Mentions": two facts share a key entity but are otherwise distinct. "Contradicts": two facts state conflicting values for the same thing. "Updates": one fact supersedes another (rare within one section).
- Reference the OTHER fact by its 0-based index in "facts". Omit "rels" or use [] when a fact stands alone. Do NOT invent edges to force connectivity.

Output the JSON object and nothing else.`;
    const isGptOss = /gpt-oss/i.test(model);
    const SCHEMA = {
      type: 'object', additionalProperties: false, required: ['facts'],
      properties: { facts: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['t', 'f', 'importance', 'entities', 'rels'],
        properties: {
          t: { type: 'string' }, f: { type: 'string' },
          importance: { type: 'number' },
          entities: { type: 'array', items: { type: 'string' } },
          rels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['to', 'type'],
            properties: { to: { type: 'integer' }, type: { type: 'string', enum: REL_TYPES } } } },
        },
      } } },
    };
    const resp = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 6000,
        messages: [
          { role: 'system', content: sys },
          ...(entityContext ? [{ role: 'system', content: `KNOWN CANONICAL ENTITIES already in this workspace — reuse these EXACT spellings when the same thing appears:\n${entityContext}` }] : []),
          { role: 'user', content: `SECTION${window.heading ? ` [${window.heading}]` : ''}:\n${content}` },
        ],
        ...(isGptOss ? { reasoning_effort: process.env.KB_DISTILL_REASONING_EFFORT || 'low' } : {}),
        response_format: isGptOss
          ? { type: 'json_schema', json_schema: { name: 'unified_extraction', strict: true, schema: SCHEMA } }
          : { type: 'json_object' },
      }),
    });
    if (!resp.ok) throw new Error(`unified-extract ${resp.status}`);
    const j = await resp.json();
    const text = j?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { const a = extractJsonArray(text); parsed = a.length ? { facts: a } : null; }
    const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
    // Evidence capture is unconditional; promotion is deliberately stricter.
    const minImportance = Number(process.env.KB_UNIFIED_MIN_IMPORTANCE || 0.65);
    return normalizeUnifiedClaims(rawFacts, content, maxFacts, minImportance);
  }

  async _extractUnifiedReliable(window, options = {}) {
    const attempts = 1 + Math.max(0, Math.min(2, Number(process.env.KB_UNIFIED_EMPTY_RETRIES ?? 1)));
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const claims = await this._extractUnified(window, options);
        if (claims.length || attempt === attempts) return claims;
        this.logger.warn?.(`[kb-unified] empty extraction; retrying (${attempt}/${attempts})`);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw error;
        this.logger.warn?.(`[kb-unified] extraction failed; retrying (${attempt}/${attempts}): ${error.message}`);
      }
    }
    if (lastError) throw lastError;
    return [];
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
        ...(metadata.tags || []), 'extracted-fact', 'distilled-from-kb', _tsDay, ...entityTags,
        ...(metadata.filename ? [`filename:${metadata.filename}`] : []),
        ...(documentId ? [`doc-id:${documentId}`] : []),
      ]);
      try {
        const res = await this.memoryGraphEngine.ingestMemory({
          user_id: userId, org_id: orgId,
          scope: metadata.scope, visibility: metadata.visibility || 'private',
          primary_team_id: metadata.primary_team_id || null,
          project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
          content: fact.f, title: fact.t, memory_type: 'fact', tags,
          importance_score: fact.importance,           // LLM-rated salience (same-pass) → confidence/recall ranking + FE score
          document_date: metadata.document_date || null,
          source_metadata: { source_platform: metadata.source_platform || 'knowledge_base', source_type: 'knowledge_fact', document_id: documentId, source_id: metadata.source_id || documentId, source_url: metadata.source_url || null },
          metadata: {
            document_id: documentId,
            segment_id: window.segmentId || null,
            source_start: fact.source_start,
            source_end: fact.source_end,
            source_quote: fact.source_quote,
            support_segment_ids: fact.support_segment_ids || [window.segmentId],
            support_quotes: fact.support_quotes || [fact.source_quote],
            distill_agent: 'kb_unified_v2',
          },
          skip_fact_extraction: true, defer_entity_linking: true,
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
            await vs.storeMemory({ id: p.id, user_id: userId, org_id: orgId, content: p.fact, memory_type: 'fact', is_latest: true, tags: p.tags, project_ids: Array.isArray(p.project_ids) ? p.project_ids : [], primary_team_id: p.primary_team_id || null, visibility: p.visibility || 'private', created_at: new Date().toISOString() }, vec ? { vector: vec } : {});
          } catch (ve) { this.logger.warn?.(`[kb-unified] embed failed: ${ve.message}`); }
        }));
      } catch (e) { this.logger.warn?.(`[kb-unified] batch embed failed: ${e.message}`); }
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
            metadata: { created_by: 'kb_unified_v1', document_id: documentId, intra_window: true },
          });
        } catch { /* best-effort; dup/FK tolerated */ }
      }
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
  async _curateDocumentClaims(candidates, { docTitle = '', maxMemories = 8 } = {}) {
    const pool = (Array.isArray(candidates) ? candidates : [])
      .filter((candidate) => candidate?.segmentId && candidate?.f && candidate?.source_quote)
      .slice(0, 48);
    if (!pool.length) return [];

    const cap = Math.max(1, Math.min(12, Number(maxMemories) || 8));
    const fallback = () => [...pool]
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
      .slice(0, cap)
      .map((candidate) => ({
        ...candidate,
        support_segment_ids: [candidate.segmentId],
        support_quotes: [candidate.source_quote],
        rels: [],
      }));

    const route = memoryLLMRoute();
    const apiKey = route?.key || process.env.GROQ_API_KEY;
    if (!apiKey || pool.length === 1) return fallback();
    const model = process.env.KB_CURATOR_MODEL || process.env.KB_UNIFIED_MODEL
      || route?.model || process.env.MEMORY_FAST_MODEL || 'llama-3.1-8b-instant';
    const isGptOss = /gpt-oss/i.test(model);
    const input = pool.map((candidate, index) => ({
      i: index,
      type: candidate.memory_type,
      claim: String(candidate.f).slice(0, 500),
      importance: Number(candidate.importance || 0.5),
      entities: (candidate.entities || []).slice(0, 8),
      source: String(candidate.source_quote).slice(0, 500),
    }));
    const schema = {
      type: 'object', additionalProperties: false, required: ['memories'],
      properties: { memories: { type: 'array', maxItems: cap, items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'content', 'memory_type', 'importance', 'support_indices', 'entities'],
        properties: {
          title: { type: 'string' }, content: { type: 'string' },
          memory_type: { type: 'string', enum: DURABLE_EXTRACT_TYPES },
          importance: { type: 'number' },
          support_indices: { type: 'array', minItems: 1, items: { type: 'integer' } },
          entities: { type: 'array', items: { type: 'string' } },
        },
      } } },
    };
    const system = `You curate durable organizational memory from source-grounded candidates extracted from ONE document.
Return at most ${cap} high-value memories that together cover the document's important decisions, commitments, requirements, metrics, events, validated lessons, stable preferences, and defining facts.
Merge compatible candidates into one complete, information-dense memory. Never merge unrelated subjects. Omit slogans, generic descriptions, contact-directory trivia, repeated examples, and details useful only when reading the raw source.
Every memory MUST be fully supported by its support_indices. Do not invent, infer, or add facts. Preserve names, numbers, dates, conditions, owners, and outcomes. A memory may cite multiple candidates. Use the source language. Fewer strong memories are better than many fragments.`;
    try {
      const response = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, temperature: 0, max_tokens: 2600,
          ...(isGptOss ? { reasoning_effort: 'low' } : {}),
          response_format: isGptOss
            ? { type: 'json_schema', json_schema: { name: 'document_memory_curator', strict: true, schema } }
            : { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Document: ${docTitle}\nCandidates:\n${JSON.stringify(input)}` },
          ],
        }),
      });
      if (!response.ok) throw new Error(`curator ${response.status}`);
      const payload = await response.json();
      const parsed = JSON.parse(payload?.choices?.[0]?.message?.content || '{}');
      const output = normalizeCuratedClaims(parsed.memories, pool, cap);
      return output.length ? output : fallback();
    } catch (error) {
      this.logger.warn?.(`[kb-curator] ${String(docTitle).slice(0, 80)}: ${error.message}; using salience fallback`);
      return fallback();
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
      const keyTopics = (memories || [])
        .filter((memory) => memory?.id && !memory.isParent)
        .map((memory) => String(memory.title || '').trim())
        .filter(Boolean)
        .slice(0, 6);
      const docSummary = [
        `Document: ${docTitle}`,
        `Durable memories: ${childIds.length}`,
        ...(keyTopics.length ? [`Key topics: ${keyTopics.join('; ')}`] : []),
      ].join('\n');
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
        ]),
        source_metadata: { source_platform: metadata.source_platform || 'knowledge_base', source_type: 'document', document_id: documentId, source_id: metadata.source_id || documentId, filename: metadata.filename || null },
        metadata: { semantic_role: 'document', ingest_tree_role: 'parent', document_id: documentId, child_count: childIds.length, total_facts: totalFacts },
        skip_fact_extraction: true, skipPredictCalibrate: true, skip_contradiction_detection: true,
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
    if (opts?.orgId && currentOrg() !== opts.orgId) return runWithOrg(opts.orgId, () => this.ingestKnowledgeDocument(opts)); // residency: org's store
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
          storageLocation: `kb/${userId}/${checksum}/${filename}`,
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
      picture_descriptions: metadata?.picture_descriptions === true,
    });
    const _msParse = Date.now() - _tParse;
    emit('parsed', 35, { parse_ms: _msParse, pages: parseResult.pages, word_count: parseResult.wordCount });

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
    const _docTags = Array.from(new Set([...(metadata.tags || []), _scopeTag]));

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
            if (segs > 0) {
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
        documentType: 'file',
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
        metadata,
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
          documentType: 'file',
          title: filename,
          sourcePlatform: 'knowledge_upload',
          sourceId: _scopedSourceId,
          documentDate: new Date(),
          wordCount: parseResult.wordCount,
          parseStatus: parseResult.success ? 'parsed' : 'failed',
          parseEngine: parseResult.engine,
          parseMetadata: parseResult.metadata || {},
          structureExtracted: parseResult.success,
          tags: _docTags,
        },
        update: {
          // Backfill scope-key tag on pre-existing rows so the dedup gate sees
          // them in subsequent uploads. parseMetadata stays untouched.
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
      },
    });
    this._extractPromotedEntitiesAsync({ memories: promoted.memories, userId, orgId, documentId: knowledgeDoc.id });
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

    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id)
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
        storageLocation: `enterprise/${userId}/${checksum}/${filename}`,
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
      return { ok: true, mode, source: sourceType, memoryIds: evId ? [evId] : [], promotedCount: evId ? 1 : 0, memoryId: evId };
    }

    // ── atomic mode ── one memory through the canonical engine gateway.
    const res = await this.memoryGraphEngine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      content: envelope.content,
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
    });
    if (res?.skipped) return { ok: true, mode, source: sourceType, skipped: true, reason: res.reason };
    const memoryIds = Array.isArray(res?.results)
      ? res.results.map(x => x?.memoryId || x?.id).filter(Boolean)
      : [res?.memoryId || res?.id].filter(Boolean);
    return { ok: true, mode, source: sourceType, memoryIds, promotedCount: memoryIds.length, memoryId: memoryIds[0] || null, operation: res?.operation || null };
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
          const TARGET = Number(process.env.KB_SEGMENT_CHARS || 1500); // ~512 BGE-M3 tokens
          chunks = (chunkText(src, { targetSize: TARGET, maxSize: Math.round(TARGET * 1.5), minSize: 200, overlapSize: 0 }) || [])
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
      // UNIFIED single-call extraction (KB_UNIFIED_EXTRACT=true): one structured LLM call per window
      // emits facts + canonical entities + intra-window relationships TOGETHER (coherent, low-noise,
      // alias-collapsed, ~1 call/window). The recall co-mention pass below then adds CROSS-DOC/TIME edges
      // only (no batch peers → no duplicate intra-doc edges).
      if (String(process.env.KB_UNIFIED_EXTRACT ?? 'false').toLowerCase() === 'true' || String(process.env.KB_UNIFIED_EXTRACT ?? '') === '1') {
        const docTitle = metadata.documentTitle || metadata.filename || '';
        const uConc = Math.max(1, Number(process.env.KB_UNIFIED_CONCURRENCY || 4));
        const DOC_CAP = Number(process.env.KB_UNIFIED_DOC_CAP || 30); // rich-but-bounded total facts/doc
        // Re-window LARGER for unified (fewer, context-rich windows → the model dedups within a window
        // and we don't multiply small-window caps into over-extraction). Falls back to `targets`.
        const UWIN = Number(process.env.KB_UNIFIED_WINDOW_CHARS || 1500);
        const UFPK = Number(process.env.KB_FACTS_PER_1K_CHARS || 11);
        let uWindows = targets;
        try {
          const { chunkText } = await import('./document-chunker.js');
          const uc = (chunkText(fullText, { targetSize: UWIN, maxSize: Math.round(UWIN * 1.6), minSize: 250, overlapSize: 0 }) || [])
            .map((c) => (c && c.text ? c.text.trim() : '')).filter((t) => t.length >= 40);
          if (uc.length) uWindows = uc.map((content, i) => ({
            segmentId: promotableSegments[Math.min(i, promotableSegments.length - 1)]?.id || null,
            content, heading: null, page: null,
            maxFacts: Math.max(3, Math.min(12, Math.round((content.length / 1000) * UFPK))),
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
              claims = await this._extractUnifiedReliable(w, { entityContext: '', maxFacts: w.maxFacts, docTitle });
            } catch (error) {
              this.logger.warn?.(`[kb-unified] candidate extract failed: ${error.message}`);
            }
            const got = Array.isArray(claims) ? claims.length : 0;
            if (got) extractedCandidates.push(...claims.map((claim) => ({ ...claim, segmentId: w.segmentId })));
            uBudget += Math.max(0, grant - got); // return the unused part of the reservation
          }
        });
        await Promise.all(uWorkers);
        const curated = await this._curateDocumentClaims(extractedCandidates, {
          docTitle,
          maxMemories: Number(process.env.KB_CURATED_MEMORY_CAP || 8),
        });
        const windowBySegment = new Map(uWindows.map((window) => [window.segmentId, window]));
        const uFacts = [];
        const extraEvidenceLinks = [];
        for (const claim of curated) {
          const sourceWindow = windowBySegment.get(claim.segmentId);
          if (!sourceWindow) continue;
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
        return { candidates: targets.map((t) => ({ segmentId: t.segmentId, content: t.content, reason: 'unified_source' })), memories: uFacts, documentParentId: uDocParent };
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
