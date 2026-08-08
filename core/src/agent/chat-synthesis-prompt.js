const LANGUAGE_NAMES = {
  en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', pl: 'Polish', ar: 'Arabic', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
};

function languageName(language) {
  return LANGUAGE_NAMES[String(language || 'en').slice(0, 2).toLowerCase()] || 'English';
}

export function appendGapClarification(response, gaps) {
  const text = String(response || '').trim();
  if (!text || /[?？؟]\s*$/.test(text) || !Array.isArray(gaps)) return text;
  const question = gaps.find((gap) => typeof gap === 'string' && /[?？؟]\s*$/.test(gap.trim()));
  return question ? `${text}\n${question.trim()}` : text;
}

export function buildSynthesisSystemPrompt({ language, operation = 'recall', recallMode = 'fact' } = {}) {
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
  return `OUTPUT LANGUAGE: ${lang}.
Return strict JSON only: {"response":string,"claims":[{"text":string,"grounded":boolean,"citation_ids":[string]}],"evidence_used":[string],"confidence":number,"gaps":[string]}.
Use only delivered evidence as factual ground truth. Every factual sentence must be a grounded claim with one or more delivered citation IDs. Speak naturally as someone who knows the user's context: give the directly requested answer, and freely include useful closely related grounded details when they add understanding. Do not suppress a relevant detail merely because it was not explicitly requested. Match the depth to the available evidence and the user's question instead of forcing every answer to be minimal.
If coverage is partial, lead with everything useful you did find, then state exactly which requested detail remains uncovered. Whenever the "gaps" array is non-empty, the visible "response" itself must end with one natural, targeted clarification question asking for the person, project, date, document, image, message, or other source detail that would close that specific gap. Never collapse partial knowledge into "I don't know", a blank value, or a blanket absence answer. Preserve exact names, identifiers, relationships, and uncertainty.
${modules.join('\n')}`;
}
