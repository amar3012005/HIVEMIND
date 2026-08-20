import { getStaticPromptArtifact } from './chat-static-prompt-cache.js';
import { ORGANIZATIONAL_BRAIN_PERSONA } from './chat-persona-skill.js';

const LANGUAGE_NAMES = {
  en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', pl: 'Polish', ar: 'Arabic', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
};

function languageName(language) {
  return LANGUAGE_NAMES[String(language || 'en').slice(0, 2).toLowerCase()] || 'English';
}

export function appendGapClarification(response, gaps, language = 'en') {
  const text = String(response || '').trim();
  if (!text || /[?？؟]\s*$/.test(text) || !Array.isArray(gaps)) return text;
  const question = gaps.find((gap) => typeof gap === 'string' && /[?？؟]\s*$/.test(gap.trim()));
  if (question) return `${text}\n${question.trim()}`;
  // `gaps` is also telemetry. Do not turn an arbitrary model-produced note
  // about an unrequested facet into a user-visible question. A clarification
  // is shown only when synthesis deliberately supplied a complete question.
  return text;
}

export function buildSynthesisPromptArtifact({
  language, operation = 'recall', recallMode = 'fact', responseDepth = 'standard', answerObjective = '',
} = {}) {
  const lang = languageName(language).toUpperCase();
  const modules = [];
  if (operation === 'timeline' || recallMode === 'timeline') {
    modules.push('TEMPORAL: rows marked REMOVED/SUPERSEDED are past values. Describe the change; never present them as current.');
  }
  if (operation === 'relation_between') {
    modules.push('RELATIONS: state only literal typed edges supplied in the evidence. Do not infer a graph relation from co-occurrence.');
  }
  if (operation === 'aggregate') {
    modules.push('AGGREGATES: state an exact count only when the evidence marks coverage complete.');
  }
  if (operation === 'source_read') {
    modules.push('SOURCE: answer only from the explicitly requested source and disclose any source-coverage gap.');
  }
  if (operation === 'profile') {
    modules.push('PROFILE: explicit authorized profile facts outrank lower-ranked corpus mentions; do not invent missing identity fields.');
  }
  if (operation === 'connector_read') {
    modules.push('LIVE CONNECTOR: distinguish current provider results from stored memory and cite only the delivered live evidence.');
  }
  if (operation === 'connector_write' || operation === 'mutation') {
    modules.push('MUTATION: synthesis never executes a write. Describe only the server-owned draft or approval state supplied as evidence.');
  }
  const stable = getStaticPromptArtifact({
    family: 'chat-synthesis',
    version: 'v8',
    variant: 'grounded-json',
    build: () => `${ORGANIZATIONAL_BRAIN_PERSONA}

Return strict JSON only: {"response":string,"claims":[{"text":string,"grounded":boolean,"citation_ids":[string]}],"evidence_used":[string],"confidence":number,"gaps":[string],"context_status":"sufficient|relevant_but_incomplete|query_mismatch","coverage":[{"request":string,"status":"supported|unsupported","citation_ids":[string]}]}.
Use only delivered evidence as factual ground truth. Every factual sentence must be a grounded claim with one or more delivered citation IDs. Answer the stated ANSWER OBJECTIVE directly and completely before adding context. Keep every section and detail relevant to that objective. Closely related grounded detail is welcome when it improves understanding, but it must never replace, obscure, or distract from what the user actually asked. Match the requested depth naturally; do not force brevity and do not pad an answer merely because more evidence was delivered.
Calibrate the reply as a well-informed human colleague would: when one bounded fact fully answers the question, say it cleanly in a short natural response; when the user asks for an overview, explanation, comparison, inventory, or all relevant information, give a clear organized account of every meaningful supported facet. Let the request's semantic breadth and the useful evidence determine length—not a fixed sentence count, a generic preference for brevity, or the number of retrieved rows. Never omit a relevant supported fact merely to make the response shorter, and never add filler merely to make it longer.
Rows marked [USER ASSERTION / UNVERIFIED] are real saved user-provided records. Never claim that no record exists while one is delivered. They establish that the user recorded the assertion, not that the assertion is independently verified. When such a row is the only relevant context for a person or subject, say that a user-authored note mentions it but that no reliable profile is established. Do not moralize, refuse, or erase a delivered record solely because of its wording; preserve the source distinction instead.
Before drafting, silently decompose the user's request into every independent semantic detail it asks for, including qualifiers, identifiers, dates, constraints, comparisons, and secondary parts. Inspect the complete delivered evidence for each detail. State every supported detail in the answer; a directly supported detail must never disappear merely because another answerable detail is more prominent. Populate "coverage" with one concise entry per requested detail. Use only delivered citation IDs for supported entries. If the delivered context is relevant but lacks support for a requested detail, set context_status="relevant_but_incomplete"; if the context is off-topic, set query_mismatch; otherwise set sufficient. This status is telemetry, not a request for another retrieval or synthesis pass.
If coverage of the requested objective is partial, lead with everything useful you did find, then state exactly which requested detail remains uncovered. Put something in "gaps" only when the user explicitly requested that missing detail; do not invent gaps about possible products, releases, sources, dates, or follow-up topics the user did not ask for. A clarification question is appropriate only when user input is genuinely needed to answer the stated objective. Never collapse partial knowledge into "I don't know", a blank value, or a blanket absence answer. Preserve exact names, identifiers, relationships, and uncertainty.`,
  });
  const depth = ['standard', 'detailed', 'comprehensive'].includes(responseDepth) ? responseDepth : 'standard';
  const depthGuidance = {
    standard: 'STANDARD DEPTH: give a focused but sufficiently informative answer. Include all directly requested supported facts; use structure when it improves clarity.',
    detailed: 'DETAILED DEPTH: explain the requested subject across its relevant supported aspects, using useful structure and concrete detail. Inspect every delivered evidence item and its source metadata before answering. When the evidence contains multiple distinct findings, make each one visible in a readable organized account rather than substituting a single representative sentence. For inventories, collect and deduplicate every distinct supported item in the delivered window. Do not drift into unrelated background.',
    comprehensive: 'COMPREHENSIVE DEPTH: synthesize the full delivered evidence relevant to the objective, reconcile overlaps or conflicts, and organize the answer for completeness without padding. Give a deduplicated inventory or structured account of every distinct supported finding in the delivered window, including useful dates, qualifiers, and source context when present. Do not claim completeness outside the delivered window.',
  }[depth];
  const dynamic = [
    `OUTPUT LANGUAGE: ${lang}.`,
    `ANSWER OBJECTIVE: ${String(answerObjective || 'Answer the user request exactly as asked.').slice(0, 1000)}`,
    depthGuidance,
    ...modules,
  ].filter(Boolean).join('\n');
  return {
    prompt: `${stable.value}\n${dynamic}`,
    messages: [
      { role: 'system', content: stable.value },
      { role: 'system', content: dynamic },
    ],
    static_prompt: stable.value,
    dynamic_prompt: dynamic,
    cache: { key: stable.key, status: stable.cache, fingerprint: stable.fingerprint },
  };
}

export function buildSynthesisSystemPrompt(options = {}) {
  return buildSynthesisPromptArtifact(options).prompt;
}
