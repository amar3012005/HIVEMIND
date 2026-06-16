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
import { resolveCollectionForOrg, PER_TENANT } from '../vector/container-router.js';
import { normalizeEntity, normalizeTagsArray } from '../memory/entity-normalize.js';

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
function cleanTitleFrom(text, max = 80) {
  const first = ((text || '').trim().split(/(?<=[.!?])\s|\n/)[0] || '').trim();
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
  _extractEntitiesAsync({ segments, userId, orgId, documentId }) {
    if (!this.entityExtractor || process.env.ENABLE_ENTITY_EXTRACTION !== 'true') return;
    // Skip entity extraction on tiny docs (single short segment) — no real value.
    const totalChars = segments.reduce((acc, s) => acc + (s.content?.length || 0), 0);
    if (segments.length <= 2 && totalChars < 1500) {
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
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
          return { t: (typeof x.t === 'string' && x.t.trim()) ? x.t.trim() : cleanTitleFrom(x.f, 48), f: x.f };
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
          title: (factTitle && factTitle.trim()) ? factTitle.trim().slice(0, 80) : cleanTitleFrom(fact),
          memory_type: 'fact',
          source_type: 'knowledge_fact',
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
          source_metadata: { source_platform: 'knowledge_base', source_type: 'knowledge_fact', document_id: documentId },
          metadata: { document_id: documentId, segment_memory_id: t.memoryId, distill_agent: 'kb_distill_v2' },
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
        // Provenance: fact Derives-from its section.
        try {
          await this.memoryGraphEngine.store.createRelationship({
            id: crypto.randomUUID(), from_id: factId, to_id: t.memoryId,
            type: 'Derives', confidence: 0.9,
            metadata: { created_by: 'kb_distill_v2', document_id: documentId },
          });
        } catch { /* best-effort */ }
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
          perSection = await this._batchExtractFacts(batch, { maxFacts: MAX_FACTS_PER_SEGMENT, entityContext });
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
          const facts = (ex.facts || []).filter((f) => f && typeof f.f === 'string' && f.f.trim().length >= 20).slice(0, MAX_FACTS_PER_SEGMENT);
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
              if (p && created < MAX_FACTS_PER_DOC) { pending.push(p); created++; }
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
      return { created, failed };
    })().catch((err) => {
      this.logger.warn?.(`[kb-distill] batch failed: ${err.message}`);
      return null;
    });

    this._distillPromise = run; // reprocess scripts can await this
    return run;
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
    let suppressed = 0, related = 0;
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
      } else if (top.score >= RELATE_MIN && this.memoryGraphEngine.store?.createRelationship) {
        await this.memoryGraphEngine.store.createRelationship({
          id: crypto.randomUUID(), from_id: rec.factId, to_id: top.id,
          type: 'Mentions', confidence: Number(top.score.toFixed(2)),
          metadata: { created_by: 'kb_enrich', kind: 'semantic_related', document_id: documentId },
        }).catch(() => {});
        related++;
      }
    }
    this.logger.info?.(`[kb-enrich] doc ${String(documentId).slice(0, 8)}: suppressed=${suppressed} related=${related} of ${enrichRecs.length}`);
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
  async ingestKnowledgeDocument({ userId, orgId, filename, fileBuffer, contentType, metadata = {}, onProgress = null }) {
    const emit = (stage, progress, extra = {}) => { try { onProgress?.({ stage, progress, ...extra }); } catch { /* never let telemetry break ingest */ } };
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Step 1: Store raw source artifact
    const sourceArtifact = await this.db.sourceArtifact.upsert({
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
    const knowledgeDoc = await this.db.knowledgeDocument.upsert({
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

    // Step 4: Create segments from parsed structure (idempotent — re-uploads
    // of identical content reuse existing segments)
    const _tSeg = Date.now();
    let segments = await this.db.knowledgeSegment.findMany({
      where: { documentId: knowledgeDoc.id },
      orderBy: { segmentIndex: 'asc' },
    });
    let _msEmbed = 0;
    if (!segments.length) {
      segments = await this._createSegments({
        documentId: knowledgeDoc.id,
        userId,
        orgId,
        parseResult
      });
      // Step 5: Embed segments (only on first-time creation)
      const _tEmbed = Date.now();
      await this._embedSegments(segments);
      _msEmbed = Date.now() - _tEmbed;
    }
    const _msSeg = Date.now() - _tSeg;
    emit('embedded', 70, { segments: segments.length, embed_ms: _msEmbed });

    this._extractEntitiesAsync({ segments, userId, orgId, documentId: knowledgeDoc.id });
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
  async ingestEnterpriseDocument({ userId, orgId, filename, fileBuffer, contentType, schema, metadata = {} }) {
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

    this._extractEntitiesAsync({ segments, userId, orgId, documentId: parentDoc.id });
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
  async ingestConnectorRecord({ userId, orgId, providerKey, sourceId, title, content, sourceUrl = null, documentDate = null, metadata = {} }) {
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return { skipped: true, reason: 'empty_content' };
    }
    const checksum = crypto.createHash('sha256').update(`${providerKey}:${sourceId}:${content}`).digest('hex');

    // Step 1: source artifact (immutable evidence)
    const sourceArtifact = await this.db.sourceArtifact.upsert({
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
    const knowledgeDoc = await this.db.knowledgeDocument.create({
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

    // Step 3: single segment (whole record body) — adapter could split later
    const segment = await this.db.knowledgeSegment.create({
      data: {
        userId, orgId,
        documentId: knowledgeDoc.id,
        segmentType: 'chunk',
        segmentIndex: 0,
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        startPage: null, endPage: null,
        metadata: { providerKey, sourceId },
      },
    });
    const segments = [segment];

    // Step 4: embed segment
    await this._embedSegments(segments);

    this._extractEntitiesAsync({ segments, userId, orgId, documentId: knowledgeDoc.id });
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

    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id).filter(Boolean),
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
    const hybridChunks = parseResult?.metadata?.hybridChunks;
    const hasChunks = Array.isArray(hybridChunks) && hybridChunks.length > 0;
    // If parse failed AND no chunks, nothing to segment.
    if ((!parseResult.success || !parseResult.text) && !hasChunks) {
      return [];
    }
    console.log(`[segments] hybridChunks=${hasChunks ? hybridChunks.length : 'none'} parseText=${(parseResult?.text || '').length}ch for doc ${documentId}`);
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
   * Embed segments into evidence vector collection
   * @private
   */
  async _embedSegments(segments) {
    if (!this.embeddingService) return;

    // Legacy: a dedicated hivemind_evidence collection. Per-tenant: evidence
    // lives in the org container alongside memory, separated by layer=evidence.
    const legacyEvidence = process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence';

    for (const segment of segments) {
      try {
        const embedding = await this.embeddingService.embed(segment.content);

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
          // Defense-in-depth: verify row actually exists before FK insert
          const exists = await this.db.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
          if (!exists) {
            memories.push(result);
            continue;
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
    if (evidenceLinkRows.length) {
      await this.db.memoryEvidenceLink.createMany({ data: evidenceLinkRows, skipDuplicates: true })
        .catch((e) => this.logger.warn?.(`[kb] evidence-link batch failed: ${e.message}`));
    }
    if (derivationRows.length) {
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
