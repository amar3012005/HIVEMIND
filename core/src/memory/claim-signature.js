// ── Claim signatures: structured fact comparison for relationship semantics ──
// Production gate for destructive graph edges over multilingual, multi-source
// corpora. Instead of lexical token-overlap heuristics (language-dependent,
// brittle at scale), every fact is reduced to a structured CLAIM SIGNATURE:
//
//   subjects  — canonical entity slugs (registry identity, not string fuzz)
//   values    — typed value slots extracted deterministically:
//               numbers+units, years, dates, percentages, model identifiers,
//               ranges. Numbers, units and dates are language-neutral — a
//               German and an English datasheet yield the same slots.
//   frame     — the residual attribute wording (used only as a weak signal)
//
// Relation assessment is then STRUCTURAL:
//   update        same specific subject + comparable value types + values
//                 DIFFER (genuine replacement evidence)
//   corroboration same specific subject + values EQUAL (paraphrase/duplicate
//                 across documents — Extends, never supersedes)
//   contradiction same specific subject + comparable slots + incompatible
//                 values
//   different-subject / no-shared-subject / no-comparable-values → the edge
//                 type is not provable; downgrade to Mentions.
//
// An LLM (or any heuristic) may PROPOSE an edge; this module decides whether
// the structure supports it. No LLM calls, O(content length), deterministic.

const UNIT_ALIASES = new Map([
  // volume
  ['l', 'l'], ['liter', 'l'], ['liters', 'l'], ['litre', 'l'], ['litres', 'l'],
  // energy/power (abbrev + spelled-out — prose claims use words, e.g. "12 megawatts")
  ['kw', 'kw'], ['kwh', 'kwh'], ['w', 'w'], ['mw', 'mw'], ['gw', 'gw'],
  ['watt', 'w'], ['watts', 'w'], ['kilowatt', 'kw'], ['kilowatts', 'kw'],
  ['megawatt', 'mw'], ['megawatts', 'mw'], ['gigawatt', 'gw'], ['gigawatts', 'gw'],
  ['kilowatthour', 'kwh'], ['kilowatthours', 'kwh'],
  // temperature
  ['°c', 'c'], ['c', 'c'], ['celsius', 'c'], ['k', 'k'],
  // dimensions/weight (abbrev + spelled-out)
  ['mm', 'mm'], ['cm', 'cm'], ['m', 'm'], ['km', 'km'], ['kg', 'kg'], ['g', 'g'], ['t', 't'],
  ['millimeter', 'mm'], ['millimeters', 'mm'], ['millimetre', 'mm'], ['millimetres', 'mm'],
  ['centimeter', 'cm'], ['centimeters', 'cm'], ['centimetre', 'cm'], ['centimetres', 'cm'],
  ['meter', 'm'], ['meters', 'm'], ['metre', 'm'], ['metres', 'm'],
  ['kilometer', 'km'], ['kilometers', 'km'], ['kilometre', 'km'], ['kilometres', 'km'],
  ['kilogram', 'kg'], ['kilograms', 'kg'], ['gram', 'g'], ['grams', 'g'],
  ['tonne', 't'], ['tonnes', 't'], ['ton', 't'], ['tons', 't'],
  // area
  ['m2', 'm2'], ['m²', 'm2'], ['qm', 'm2'],
  // pressure / flow
  ['bar', 'bar'], ['pa', 'pa'], ['mbar', 'mbar'],
  // time
  ['h', 'h'], ['hour', 'h'], ['hours', 'h'], ['min', 'min'], ['minute', 'min'], ['minutes', 'min'],
  ['s', 's'], ['second', 's'], ['seconds', 's'],
  ['day', 'd'], ['days', 'd'], ['week', 'wk'], ['weeks', 'wk'], ['month', 'mo'], ['months', 'mo'],
  ['jahr', 'y'], ['jahre', 'y'], ['year', 'y'], ['years', 'y'],
  // percentage handled separately
]);

const MODEL_TOKEN_RE = /[\p{L}\d][\p{L}\d.\-\/]{1,19}/gu; // candidate tokens; letter+digit filter applied below (SolvisLea-8.3, DIN51603, GEG2024)
const NUMBER_RE = /(\d+(?:[.,]\d+)?)\s*([\p{L}°%²\/]{0,12})/gu;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4})\b/g;

function _num(value) {
  return Number(String(value).replace(',', '.'));
}

/** Extract typed value slots from fact content. Deterministic, language-neutral. */
export function extractValueSlots(content = '') {
  // The ingest layer appends `(YYYY-MM-DDTHH:MMZ)` for temporal recall. It is
  // provenance, not a claim value; comparing it made two different claims
  // appear equal merely because they were saved in the same minute.
  const text = String(content || '').replace(/\s*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\s*$/, '');
  const slots = { quantities: new Map(), years: new Set(), dates: new Set(), percents: new Set(), modelIds: new Set() };

  for (const m of text.matchAll(DATE_RE)) slots.dates.add(m[1]);
  for (const m of text.matchAll(YEAR_RE)) slots.years.add(m[1]);

  for (const m of text.matchAll(NUMBER_RE)) {
    const value = _num(m[1]);
    if (!Number.isFinite(value)) continue;
    const rawUnit = (m[2] || '').toLowerCase().replace(/\.$/, '');
    if (rawUnit === '%') { slots.percents.add(value); continue; }
    const unit = UNIT_ALIASES.get(rawUnit);
    if (!unit) continue; // bare numbers without a known unit are too noisy at corpus scale
    if (!slots.quantities.has(unit)) slots.quantities.set(unit, new Set());
    slots.quantities.get(unit).add(value);
  }

  for (const m of text.matchAll(MODEL_TOKEN_RE)) {
    const token = m[0].toLowerCase();
    // A model identifier must contain BOTH a letter and a digit (SolvisLea-8.3,
    // DIN51603, GEG2024) — this is the language-neutral signal that separates a
    // product/standard code from ordinary words and bare numbers.
    if (!/[a-z]/i.test(token) || !/\d/.test(token)) continue;
    if (/^\d+([.,]\d+)?$/.test(token)) continue;       // bare number
    if (/^(19|20)\d{2}$/.test(token)) continue;         // pure year
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) continue;    // ISO date
    slots.modelIds.add(token);
  }
  return slots;
}

function _setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function _setsOverlap(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function _claimField(memory, snake, camel) {
  const short = snake.replace(/^claim_/, '');
  return memory?.[snake]
    ?? memory?.[camel]
    ?? memory?.metadata?.claim?.[snake]
    ?? memory?.metadata?.claim?.[camel]
    ?? memory?.metadata?.claim?.[short]
    ?? null;
}

function _canonicalClaimToken(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function _stableQualifierObject(memory) {
  const qualifiers = _claimField(memory, 'claim_qualifiers', 'claimQualifiers');
  if (!qualifiers || typeof qualifiers !== 'object' || Array.isArray(qualifiers)) return null;
  const value = qualifiers.object ?? qualifiers.value ?? qualifiers.target ?? null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    return JSON.stringify(value, Object.keys(value).sort()).normalize('NFKC').toLowerCase();
  }
  return String(value).normalize('NFKC').trim().toLowerCase();
}

function _structuredClaim(memory) {
  const subject = _canonicalClaimToken(_claimField(memory, 'claim_subject', 'claimSubject'));
  const predicate = _canonicalClaimToken(_claimField(memory, 'claim_predicate', 'claimPredicate'));
  return { subject, predicate, object: _stableQualifierObject(memory) };
}

/**
 * Compare the value slots of two claims.
 * @returns {'equal'|'different'|'incomparable'}
 *   equal        — every comparable typed slot agrees (corroboration)
 *   different    — at least one comparable typed slot disagrees (change/conflict evidence)
 *   incomparable — the claims measure different things (no shared slot types)
 */
export function compareValueSlots(a, b) {
  let comparable = 0;
  let differing = 0;

  const unitTypes = new Set([...a.quantities.keys()].filter((u) => b.quantities.has(u)));
  for (const unit of unitTypes) {
    comparable += 1;
    if (!_setEq(a.quantities.get(unit), b.quantities.get(unit))) differing += 1;
  }
  if (a.percents.size && b.percents.size) {
    comparable += 1;
    if (!_setEq(a.percents, b.percents)) differing += 1;
  }
  if (a.years.size && b.years.size) {
    comparable += 1;
    if (!_setsOverlap(a.years, b.years)) differing += 1;
  }
  if (a.dates.size && b.dates.size) {
    comparable += 1;
    if (!_setsOverlap(a.dates, b.dates)) differing += 1;
  }

  if (comparable === 0) return 'incomparable';
  return differing > 0 ? 'different' : 'equal';
}

/**
 * Structural relation assessment between two facts.
 *
 * @param {{tags?: string[], content?: string}} from  the NEW claim
 * @param {{tags?: string[], content?: string}} to    the OLD claim
 * @param {{hubSlugs?: string[]}} [opts]
 * @returns {{
 *   relation: 'update'|'contradiction-capable'|'corroboration'|'different-subject'|'no-shared-subject'|'topical',
 *   reason: string,
 *   sharedSpecific: string[],
 * }}
 */
export function assessClaimRelation(from = {}, to = {}, { hubSlugs = [] } = {}) {
  const hubs = new Set((hubSlugs || []).map((s) => String(s).toLowerCase()));
  const ents = (tags = []) => {
    const out = new Set();
    for (const t of Array.isArray(tags) ? tags : []) {
      if (typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('person:'))) {
        const slug = t.replace(/^(entity|person):/, '').trim().toLowerCase();
        if (slug) out.add(slug);
      }
    }
    return out;
  };

  const fromEnts = ents(from.tags);
  const toEnts = ents(to.tags);
  const fromClaim = _structuredClaim(from);
  const toClaim = _structuredClaim(to);
  if (fromClaim.subject) fromEnts.add(fromClaim.subject);
  if (toClaim.subject) toEnts.add(toClaim.subject);
  const fromSlots = extractValueSlots(from.content);
  const toSlots = extractValueSlots(to.content);

  // Model identifiers inside the CONTENT count as subject evidence too — the
  // most reliable multilingual subject signal in technical corpora (SolvisLea-8.3
  // vs SolvisLea-7: different products even when tags are sparse).
  const fromSubjects = new Set([...fromEnts, ...fromSlots.modelIds]);
  const toSubjects = new Set([...toEnts, ...toSlots.modelIds]);

  let sharedSpecific = [];
  if (fromSubjects.size && toSubjects.size) {
    const shared = [...fromSubjects].filter((e) => toSubjects.has(e));
    if (shared.length === 0) {
      return { relation: 'no-shared-subject', reason: 'no shared canonical subject', sharedSpecific: [] };
    }
    sharedSpecific = shared.filter((e) => !hubs.has(e));
    if (hubs.size && sharedSpecific.length === 0) {
      return { relation: 'topical', reason: 'only corpus-hub subject shared', sharedSpecific: [] };
    }
    const exclusiveFrom = [...fromSubjects].filter((e) => !toSubjects.has(e) && !hubs.has(e));
    const exclusiveTo = [...toSubjects].filter((e) => !fromSubjects.has(e) && !hubs.has(e));
    if (sharedSpecific.length === 0 && exclusiveFrom.length && exclusiveTo.length) {
      return { relation: 'different-subject', reason: 'each claim about its own specific subject', sharedSpecific: [] };
    }
  } else if (!fromSubjects.size && !toSubjects.size) {
    // No subject evidence on either side (untagged conversational memories):
    // fall through to value comparison only — callers decide strictness.
    sharedSpecific = [];
  } else {
    return { relation: 'topical', reason: 'subject evidence on one side only', sharedSpecific: [] };
  }

  if (fromClaim.predicate && toClaim.predicate && fromClaim.predicate !== toClaim.predicate) {
    return { relation: 'topical', reason: 'different structured predicates', sharedSpecific };
  }

  if (fromClaim.predicate && toClaim.predicate && fromClaim.object !== null && toClaim.object !== null) {
    if (fromClaim.object === toClaim.object) {
      return { relation: 'corroboration', reason: 'same structured claim object', sharedSpecific };
    }
    return { relation: 'update', reason: 'same structured claim, object differs', sharedSpecific };
  }

  const valueCmp = compareValueSlots(fromSlots, toSlots);
  if (valueCmp === 'different') {
    return { relation: 'update', reason: 'same subject, comparable values differ (change evidence)', sharedSpecific };
  }
  if (valueCmp === 'equal') {
    return { relation: 'corroboration', reason: 'same subject, values agree — corroborates, does not supersede', sharedSpecific };
  }
  return { relation: 'topical', reason: 'no comparable value slots — change not provable', sharedSpecific };
}
