/** Language codes the onboarding form and LangSwitcher share. Default English. */
export const PREFERRED_LANGUAGE_CODES = Object.freeze([
  'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'sk', 'cs', 'ro', 'uk', 'hu',
  'sv', 'da', 'fi', 'no', 'el', 'tr', 'ru', 'ar', 'he', 'fa', 'hi', 'bn', 'id',
  'vi', 'th', 'zh', 'ja', 'ko',
]);

export function normalizePreferredLanguage(raw) {
  const code = String(raw || 'en').trim().toLowerCase().split('-')[0];
  return PREFERRED_LANGUAGE_CODES.includes(code) ? code : 'en';
}

/** Appended to every onboarding LLM system prompt. JSON keys stay English. */
export function narrativeLanguageInstruction(raw) {
  const code = normalizePreferredLanguage(raw);
  if (code === 'en') {
    return 'Write all narrative in English only. JSON object keys stay English.';
  }
  return `Write all narrative in the user's preferred language (${code}) only. JSON object keys stay English.`;
}
