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

export function appendSuggestedFollowUps(response, followUps, language = 'en') {
  const text = String(response || '').trim();
  const suggestions = normalizeSuggestedFollowUps(followUps);
  if (!text || suggestions.length < 2) return text;
  const headings = {
    de: 'Mögliche nächste Fragen', es: 'Siguientes preguntas', fr: 'Questions suivantes',
    it: 'Domande successive', pt: 'Próximas perguntas', nl: 'Mogelijke vervolgvragen',
    pl: 'Możliwe kolejne pytania', hi: 'अगले संभावित प्रश्न', ja: '次に聞けること',
    ko: '다음 질문', zh: '后续问题', ar: 'أسئلة متابعة مقترحة',
  };
  const heading = headings[String(language || 'en').slice(0, 2).toLowerCase()] || 'Suggested follow-ups';
  return `${text}\n\n${heading}:\n${suggestions.map((item) => `- ${item}`).join('\n')}`;
}

export function normalizeSuggestedFollowUps(followUps) {
  return [...new Set((Array.isArray(followUps) ? followUps : [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))].slice(0, 3);
}

export function normalizeSearchableFollowUps(followUps, { context = '', sourceTitles = [], language = 'en' } = {}) {
  const corpus = String(context || '').toLocaleLowerCase();
  const conversational = /\b(would you like|do you need|do you want|want me to|could you provide|can you provide|which competitors would|search the web|search online)\b/i;
  const anchored = normalizeSuggestedFollowUps(followUps).filter((question) => {
    if (conversational.test(question)) return false;
    const tokens = question.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) || [];
    return tokens.some((token) => corpus.includes(token));
  });
  const templates = {
    de: (title) => `Was sagt ${title} außerdem zu diesem Thema?`,
    es: (title) => `¿Qué más dice ${title} sobre este tema?`,
    fr: (title) => `Que dit encore ${title} à ce sujet ?`,
    en: (title) => `What else does ${title} say about this topic?`,
  };
  const template = templates[String(language || 'en').slice(0, 2).toLowerCase()] || templates.en;
  for (const rawTitle of sourceTitles) {
    if (anchored.length >= 3) break;
    const title = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) continue;
    const question = template(title);
    if (!anchored.includes(question)) anchored.push(question);
  }
  return anchored.slice(0, 3);
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
    modules.push('RELATIONS: typed edges are verified graph relationships. Explicit relation claims may also be reported exactly as sourced claims, preserving whether they are user assertions or stored records; never promote them to graph edges or independently verified facts. A legacy_unresolved_author claim must be quoted/paraphrased with its first-person pronoun unresolved—never assume "me" is the authenticated user. Shared sources and co-occurrence alone are not relationships.');
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
    version: 'v10',
    variant: 'grounded-json',
    build: () => `${ORGANIZATIONAL_BRAIN_PERSONA}

Return strict JSON only: {"response":string,"claims":[{"text":string,"grounded":boolean,"citation_ids":[string]}],"evidence_used":[string],"confidence":number,"gaps":[string],"follow_ups":[string],"context_status":"sufficient|relevant_but_incomplete|query_mismatch","coverage":[{"request":string,"status":"supported|unsupported","citation_ids":[string]}]}.
Use only delivered evidence as factual ground truth. Every factual sentence must be a grounded claim with one or more delivered citation IDs. Answer the stated ANSWER OBJECTIVE directly and completely before adding context. Keep every section and detail relevant to that objective. Closely related grounded detail is welcome when it improves understanding, but it must never replace, obscure, or distract from what the user actually asked. Match the requested depth naturally; do not force brevity and do not pad an answer merely because more evidence was delivered.
Calibrate the reply as a well-informed human colleague would: when one bounded fact fully answers the question, say it cleanly in a short natural response; when the user asks for an overview, explanation, comparison, inventory, or all relevant information, give a clear organized account of every meaningful supported facet. Let the request's semantic breadth and the useful evidence determine length—not a fixed sentence count, a generic preference for brevity, or the number of retrieved rows. Never omit a relevant supported fact merely to make the response shorter, and never add filler merely to make it longer.
Organize the visible answer in the user's requested order. When no order is stated, lead with the direct conclusion or concise summary, follow with the most important supported details in relevance order, then qualifications, conflicts, or missing requested information. Use short headings or bullets only when they make a multi-facet answer easier to scan.
For a substantive, successfully grounded recall answer, return two or three concise suggested next questions in follow_ups. Each must be directly searchable inside HIVEMIND using the delivered memories or evidence: reuse an explicit entity, source title, document name, topic, date, decision type, or exact term present in the delivered context. Write them in the output language. A follow-up is a question the user could ask next, not a new factual assertion. Never suggest web research, generic competitor research, future projections, or asking the user to provide information that HIVEMIND should search. Return an empty array for greetings, acknowledgements, mutations, or when clarification is required to answer the current request. Never use follow-ups to introduce an unsupported entity, source, date, capability, or claim.
Rows marked [USER ASSERTION / UNVERIFIED] are real saved user-provided records. Never claim that no record exists while one is delivered. They establish that the user recorded the assertion, not that the assertion is independently verified. When such a row is the only relevant context for a person or subject, say that a user-authored note mentions it but that no reliable profile is established. Do not moralize, refuse, or erase a delivered record solely because of its wording; preserve the source distinction instead.
Before drafting, silently decompose the user's request into every independent semantic detail it asks for, including qualifiers, identifiers, dates, constraints, comparisons, and secondary parts. Inspect the complete delivered evidence for each detail. State every supported detail in the answer; a directly supported detail must never disappear merely because another answerable detail is more prominent. Populate "coverage" with one concise entry per requested detail. Use only delivered citation IDs for supported entries. Evidence about the same person or entity is NOT automatically evidence for the requested attribute: identity, birthplace, employment, appearance, decisions, dates, and relationships are distinct answer objectives. If no delivered passage supports the requested semantic detail, mark that detail unsupported and set query_mismatch; never substitute a different fact merely because it shares the entity name. If the delivered context supports part of the objective but lacks another requested detail, set context_status="relevant_but_incomplete"; otherwise set sufficient. This status is telemetry, not a request for another retrieval or synthesis pass.
If coverage of the requested objective is partial, lead with everything useful you did find, then state exactly which requested detail remains uncovered. Put something in "gaps" only when the user explicitly requested that missing detail; do not invent gaps about possible products, releases, sources, dates, or follow-up topics the user did not ask for. A clarification question is appropriate only when user input is genuinely needed to answer the stated objective. Never collapse partial knowledge into "I don't know", a blank value, or a blanket absence answer. Preserve exact names, identifiers, relationships, and uncertainty.`,
  });
  const depth = ['standard', 'detailed', 'comprehensive'].includes(responseDepth) ? responseDepth : 'standard';
  const depthGuidance = {
    standard: 'STANDARD DEPTH: synthesize the unified top-five window into a focused but sufficiently informative answer. Include all directly requested supported facts; use structure only when it improves clarity.',
    detailed: 'DETAILED DEPTH: Inspect every delivered evidence item in the complete delivered top-fifteen window and explain the requested subject across every relevant supported aspect, using useful structure and concrete detail. When the evidence contains multiple distinct findings, make each one visible in a readable organized account rather than substituting a single representative sentence. For inventories, collect and deduplicate every distinct supported item in the delivered window. Do not drift into unrelated background.',
    comprehensive: 'COMPREHENSIVE DEPTH: inspect and synthesize the complete delivered top-fifteen window relevant to the objective, reconcile overlaps or conflicts, and organize the answer for completeness without padding. Give a deduplicated inventory or structured account of every distinct supported finding in the delivered window, including useful dates, qualifiers, and source context when present. Do not claim completeness outside the delivered window.',
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
