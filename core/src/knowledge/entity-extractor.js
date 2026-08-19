/**
 * Entity Extractor — extracts entities (people, orgs, projects, topics,
 * locations, products) from knowledge segments and writes them to the
 * canonical Entity + EntityMention tables.
 *
 * Strategy:
 *   1. Cheap regex pre-pass (emails, @mentions, URLs, hashtags)
 *   2. LLM extraction via existing litellm-client (JSON mode)
 *   3. Entity resolution: upsert by canonical name within tenant
 *
 * Designed to run async (fire-and-forget) after segment ingestion so it
 * never blocks the document-first pipeline.
 */

import { chatCompletion, getDefaultModel } from './enterprise/litellm-client.js';
import { memoryLLMRoute } from '../llm/groq-fallback.js';
import { orgIsRemote } from '../vector/mneme/driver.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s)]+/g;
const MENTION_RE = /(?:^|[^A-Z0-9_])@([A-Z0-9_.-]{2,40})/gi;
const HASHTAG_RE = /(?:^|\s)#([A-Z0-9_-]{2,40})/gi;

const ENTITY_TYPES = ['person', 'organization', 'project', 'topic', 'location', 'product', 'event'];

const SYSTEM_PROMPT = `You extract EVERY distinct named entity from the text. Be THOROUGH, not minimal — this feeds a knowledge graph, and a missed entity is lost forever. Never stop at the obvious organization; capture every specific named thing.

Return ONLY a JSON object: { "entities": [...] }
Each entity: { "name": string, "type": one_of(${ENTITY_TYPES.map(t => `"${t}"`).join(',')}), "aliases": string[]?, "confidence": number_0_to_1 }

Extract ALL of these whenever named or specifically identified:
- person — named individuals.
- organization — companies, institutions, teams, brands, vendors, clients, partners.
- product — products, product LINES, MODELS, devices, COMPONENTS, apps, services, features, and article/model/SKU numbers. List EACH distinct product/component as its OWN entity, not just the parent brand (e.g. "Solvis Indoor Unit", "Solvis Storage Tank", "Solvis Outdoor Unit", "SolvisBen HB", "article 33989" — all separate products).
- project — named projects, initiatives, campaigns.
- location — places, cities, countries, regions, sites, addresses, facilities.
- topic — significant technologies, standards, materials, methods, or concepts central to the text (e.g. "R290 refrigerant", "heat pump", "GWP").
- event — meetings, launches, milestones, or notable dated occurrences.

Rules:
- COMPREHENSIVE over conservative: when in doubt about a clearly-named specific thing, include it.
- Canonical name = most common written form. Strip titles ("Mr.", "Dr.") for people.
- Combine same-entity spelling/casing variants under ONE canonical with aliases (don't drop them).
- Skip ONLY truly generic words with no specific name ("user", "the team", "the company", "the system", "lorem ipsum" placeholder text).
- Up to 40 entities per call.
- Empty list only if there are genuinely no named entities.`;

export class EntityExtractor {
  constructor({ prisma, logger = console, model = null }) {
    this.prisma = prisma;
    this.logger = logger;
    // Entity extraction prefers a fast non-reasoning model (llama 3.3 70B is
    // ~5x faster than gpt-oss-20b and emits JSON cleanly).
    // Use the LiteLLM client's own default model (getDefaultModel — the same
    // client chatCompletion() calls). The old `cerebras/gpt-oss-120b` fallback
    // was NOT a valid model id at the gateway (api.blaiq.ai) → every LLM
    // extraction 400'd → 0 entities (only the heuristic's lone org survived).
    this.model = model
      || process.env.ENTITY_EXTRACTION_MODEL
      || memoryLLMRoute()?.model
      || getDefaultModel();
  }

  /**
   * Extract entities from a single segment and persist mentions.
   * Returns { entities: [], mentions: [], skipped: false }
   */
  async extractFromSegment({ segment, userId, orgId, documentId, shouldContinue = () => true }) {
    if (!segment?.content || segment.content.trim().length < 20) {
      return { entities: [], mentions: [], skipped: true, reason: 'too_short' };
    }
    // RESIDENCY: the central entity / entityMention tables are FK'd to central segment/memory rows the
    // agent doesn't have — for a remote (self-host) org these upserts throw ("Invalid prisma.entityMention
    // .create invocation"). The memory entity graph for self-host is built on the AGENT by the co-mention
    // linker (entity:* tags via amrUpdateTags + edges via amrAddEdge). Skip the central segment-entity
    // persistence for remote.
    if (orgIsRemote(orgId)) {
      return { entities: [], mentions: [], skipped: true, reason: 'remote-agent' };
    }

    // 1. Regex pre-pass — cheap candidates
    const regexCandidates = this._regexCandidates(segment.content);

    // 2. LLM extraction
    let llmCandidates = [];
    try {
      llmCandidates = await this._llmExtract(segment.content);
    } catch (err) {
      this.logger.warn(`[entity-extractor] LLM failed: ${err.message}`);
    }

    // 3. Merge + dedup by (type, lowercased canonical)
    let merged = this._mergeCandidates(regexCandidates, llmCandidates);

    // 3b. Entity resolution: collapse aliases pointing at same canonical (P1 #10)
    merged = await this._resolveCandidates(merged, orgId);

    if (!shouldContinue()) return { entities: [], mentions: [], skipped: true, reason: 'document_deleted' };

    // 4. Upsert entities + write mentions
    const entities = [];
    const mentions = [];
    for (const cand of merged) {
      if (!shouldContinue()) break;
      try {
        const entity = await this.prisma.entity.upsert({
          where: {
            orgId_entityType_canonicalName: {
              orgId,
              entityType: cand.type,
              canonicalName: cand.name,
            },
          },
          create: {
            orgId,
            entityType: cand.type,
            canonicalName: cand.name,
            aliases: cand.aliases || [],
            confidence: cand.confidence ?? 0.7,
            mentionCount: 1,
            lastSeenAt: new Date(),
          },
          update: {
            mentionCount: { increment: 1 },
            lastSeenAt: new Date(),
            aliases: { set: Array.from(new Set([...(cand.aliases || [])])) },
          },
        });
        entities.push(entity);

        if (!shouldContinue()) break;
        const mention = await this.prisma.entityMention.create({
          data: {
            entityId: entity.id,
            documentId,
            segmentId: segment.id,
            mentionText: cand.surfaceForm || cand.name,
            confidence: cand.confidence ?? 0.7,
            context: segment.content.slice(0, 200),
          },
        });
        mentions.push(mention);
      } catch (err) {
        this.logger.warn(`[entity-extractor] upsert failed for "${cand.name}": ${err.message}`);
      }
    }
    return { entities, mentions, skipped: false };
  }

  _regexCandidates(text) {
    const cands = [];
    for (const m of text.matchAll(EMAIL_RE)) {
      const email = m[0];
      cands.push({
        name: email.toLowerCase(),
        type: 'person',
        surfaceForm: email,
        confidence: 0.95,
        source: 'regex_email',
      });
    }
    for (const m of text.matchAll(MENTION_RE)) {
      cands.push({
        name: m[1],
        type: 'person',
        surfaceForm: `@${m[1]}`,
        confidence: 0.85,
        source: 'regex_mention',
      });
    }
    for (const m of text.matchAll(HASHTAG_RE)) {
      cands.push({
        name: m[1].toLowerCase(),
        type: 'topic',
        surfaceForm: `#${m[1]}`,
        confidence: 0.75,
        source: 'regex_hashtag',
      });
    }
    return cands;
  }

  async _llmExtract(text) {
    // 8000 chars (~2k tokens): long atomic memories (e.g. a full image visual-
    // evidence description) exceed 4000 and would lose entities named later in
    // the text. Wider window → richer, complete extraction.
    const input = String(text).slice(0, 8000);
    let raw = null;
    // Retry once on transient failure
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        raw = await chatCompletion({
          model: this.model,
          json_mode: true,
          temperature: 0.1,
          // 800 was self-defeating. The system prompt demands "extract EVERY
          // distinct named entity, be THOROUGH not minimal" — and the cap then
          // truncated the JSON mid-array, so JSON.parse failed and the whole
          // extraction returned []. The MORE entities the model found, the more
          // certain it produced NOTHING.
          // Measured on a real 7.2 KB image description naming E3/DC, SOLVIS,
          // clever-PV, SPINE, HEIDELBERG plus photovoltaics/HEMS/battery storage:
          //   completion=836 finish=error  (attempt 1)
          //   completion=800 finish=error  (attempt 2)  -> 0 candidates
          // ~25 entities of ~40 JSON tokens each needs well over 1k.
          max_tokens: Number(process.env.ENTITY_EXTRACT_MAX_TOKENS || 4000),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
        });
        break;
      } catch (err) {
        if (attempt === 1) {
          this.logger?.warn?.(`[entity-extractor] LLM exhausted retries: ${err.message}`);
          return [];
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      // Salvage: try to extract first {...} block
      const m = typeof raw === 'string' ? raw.match(/\{[\s\S]*\}/) : null;
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
      }
      // SECOND salvage — recover a TRUNCATED array. The block match above needs a
      // closing brace, so a response cut off mid-array matched nothing and every
      // entity the model DID emit was thrown away. All-or-nothing on a truncated
      // response is the worst possible failure here: entity extraction feeds the
      // graph, and a dropped entity is a relationship that can never form.
      // Rebuild by taking whole `{...}` objects up to the truncation point.
      if (!parsed && typeof raw === 'string') {
        const objs = raw.match(/\{\s*"name"[\s\S]*?\}/g) || [];
        if (objs.length) {
          const salvaged = [];
          for (const o of objs) {
            try { salvaged.push(JSON.parse(o)); } catch { /* skip the partial tail */ }
          }
          if (salvaged.length) {
            this.logger?.warn?.(`[entity-extractor] response truncated — salvaged ${salvaged.length} entities`);
            parsed = { entities: salvaged };
          }
        }
      }
      if (!parsed) return [];
    }
    const list = Array.isArray(parsed?.entities) ? parsed.entities : [];
    return list
      .filter(e => e?.name && ENTITY_TYPES.includes(e.type))
      .map(e => ({
        name: String(e.name).trim().slice(0, 500),
        type: e.type,
        aliases: Array.isArray(e.aliases) ? e.aliases.map(a => String(a).slice(0, 200)).slice(0, 10) : [],
        confidence: Number.isFinite(e.confidence) ? Math.min(Math.max(e.confidence, 0), 1) : 0.7,
        source: 'llm',
      }));
  }

  /**
   * Entity resolution — collapse candidate variants that refer to the same
   * canonical entity. Applies three strategies:
   *   1. Email/handle/hashtag → look up by alias in existing entities for tenant
   *   2. Re-type regex hits when an LLM-identified entity claims them
   *      (e.g. regex tagged "acme-corp" as person; LLM tagged "Acme Corp" as
   *      organization with alias "acme-corp" → merge into the organization)
   *   3. Drop candidates whose name is just an email/handle of an LLM entity
   */
  async _resolveCandidates(candidates, orgId) {
    if (!candidates.length) return candidates;

    // Build alias index from LLM candidates so we can absorb regex variants
    const aliasIndex = new Map(); // lowered alias/name -> winning canonical
    for (const c of candidates) {
      if (c.source !== 'llm') continue;
      const winningKey = `${c.type}|${c.name.toLowerCase()}`;
      aliasIndex.set(c.name.toLowerCase(), winningKey);
      for (const a of c.aliases || []) {
        aliasIndex.set(String(a).toLowerCase(), winningKey);
      }
    }

    // Pull existing entities for cross-document resolution
    const lookupNames = Array.from(new Set(candidates.flatMap(c => [c.name.toLowerCase(), ...(c.aliases || []).map(a => a.toLowerCase())])));
    let existing = [];
    if (lookupNames.length) {
      try {
        existing = await this.prisma.entity.findMany({
          where: {
            orgId,
            OR: [
              { canonicalName: { in: lookupNames, mode: 'insensitive' } },
              { aliases: { hasSome: lookupNames } },
            ],
          },
          select: { id: true, entityType: true, canonicalName: true, aliases: true },
        });
      } catch {
        existing = [];
      }
    }
    const existingByAlias = new Map();
    for (const e of existing) {
      existingByAlias.set(e.canonicalName.toLowerCase(), e);
      for (const a of e.aliases || []) {
        existingByAlias.set(String(a).toLowerCase(), e);
      }
    }

    const out = new Map(); // dedup
    // Process LLM canonicals first so winners exist in `out` before regex
    // variants are folded in.
    const sorted = [...candidates].sort((a, b) => {
      const score = c => (c.source === 'llm' ? 0 : c.source === 'resolved_existing' ? 1 : 2);
      return score(a) - score(b);
    });
    for (const c of sorted) {
      const lower = c.name.toLowerCase();
      // 1. Already known entity in DB — pin to it
      const known = existingByAlias.get(lower);
      if (known) {
        const key = `${known.entityType}|${known.canonicalName.toLowerCase()}`;
        const prev = out.get(key);
        if (prev) {
          prev.aliases = Array.from(new Set([...(prev.aliases || []), c.name, ...(c.aliases || [])]));
        } else {
          out.set(key, {
            name: known.canonicalName,
            type: known.entityType,
            aliases: Array.from(new Set([...(known.aliases || []), c.name, ...(c.aliases || [])])).filter(a => a.toLowerCase() !== known.canonicalName.toLowerCase()),
            confidence: c.confidence,
            surfaceForm: c.surfaceForm,
            source: 'resolved_existing',
          });
        }
        continue;
      }
      // 2. Match against another LLM candidate's alias set in this batch
      const winnerKey = aliasIndex.get(lower);
      if (winnerKey && winnerKey !== `${c.type}|${lower}`) {
        const prev = out.get(winnerKey);
        if (prev) {
          prev.aliases = Array.from(new Set([...(prev.aliases || []), c.name, ...(c.aliases || [])]));
          continue;
        }
      }
      // 3. Email heuristic — match email domain/local-part to existing entity alias
      if (c.source === 'regex_email' && c.type === 'person') {
        const emailParts = lower.split('@');
        if (emailParts.length === 2) {
          const local = emailParts[0];
          const domain = emailParts[1].split('.')[0]; // strip TLD
          // Try matching against other entries in `out` by alias OR canonical
          let absorbed = false;
          for (const [k, v] of out.entries()) {
            const candidates = [v.name.toLowerCase(), ...(v.aliases || []).map(a => a.toLowerCase())];
            if (candidates.some(s => s === domain || s.includes(domain) || domain.includes(s)) ||
                candidates.some(s => s === local || s.includes(local))) {
              v.aliases = Array.from(new Set([...(v.aliases || []), c.name]));
              absorbed = true;
              break;
            }
          }
          if (absorbed) continue;
        }
      }
      // 4. New unique entity
      const key = `${c.type}|${lower}`;
      const prev = out.get(key);
      if (prev) {
        prev.confidence = Math.max(prev.confidence, c.confidence);
        prev.aliases = Array.from(new Set([...(prev.aliases || []), ...(c.aliases || [])]));
      } else {
        out.set(key, c);
      }
    }
    return Array.from(out.values());
  }

  _mergeCandidates(regexC, llmC) {
    const byKey = new Map();
    for (const c of [...regexC, ...llmC]) {
      const key = `${c.type}|${c.name.toLowerCase()}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, c);
      } else {
        // Keep highest confidence, merge aliases
        prev.confidence = Math.max(prev.confidence, c.confidence);
        prev.aliases = Array.from(new Set([...(prev.aliases || []), ...(c.aliases || [])]));
        if (c.surfaceForm && !prev.surfaceForm) prev.surfaceForm = c.surfaceForm;
      }
    }
    return Array.from(byKey.values());
  }
}
