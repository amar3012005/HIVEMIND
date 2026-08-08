const LANGUAGE_NAMES = {
  en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', pl: 'Polish', ar: 'Arabic', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
};

function languageName(language) {
  return LANGUAGE_NAMES[String(language || 'en').slice(0, 2).toLowerCase()] || 'English';
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
  return `OUTPUT LANGUAGE: ${lang}.
Return strict JSON only: {"response":string,"claims":[{"text":string,"grounded":boolean,"citation_ids":[string]}],"evidence_used":[string],"confidence":number,"gaps":[string]}.
Use only delivered evidence as factual ground truth. Every factual sentence must be a grounded claim with one or more delivered citation IDs. If relevant evidence exists, answer from it and name only the uncovered part as a gap; never give a blanket absence answer. Preserve exact names, identifiers, and uncertainty. Be concise.
${modules.join('\n')}`;
}
