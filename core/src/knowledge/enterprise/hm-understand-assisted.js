const SUPPORTED_SMOKE_LANGUAGES = new Set(['en', 'de', 'es']);
const GROUNDED_ENTITY_LABELS = new Set(['person', 'organization', 'location', 'product', 'project']);
const STRONG_SIGNALS = new Set(['decision_verb', 'commitment_or_assignment', 'preference_verb']);

function splitSentences(text) {
  return String(text || '').match(/[^.!?。！？\n]+(?:[.!?。！？]+|$)/gu) || [];
}

function isFactBearing(sentence) {
  return /\d/u.test(sentence)
    || /\b(?:kW|kWh|EUR|€|%|Mio|Nr\.)\b/iu.test(sentence)
    || /\s\p{Lu}\p{Ll}{2,}/u.test(sentence);
}

function normalizedWhitespace(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

/**
 * Build a conservative prompt projection from exact local evidence spans.
 * Returns null unless the full analysis is complete, language is smoke-tested,
 * every heuristic fact-bearing sentence is covered, and the input is reduced
 * by at least 15%. Core still validates every model quote against sourceContent.
 */
export function projectHmUnderstandWindow(window, analysis, { minSavingsRatio = 0.15 } = {}) {
  const sourceContent = String(window?.content || '');
  if (sourceContent.length < 100 || analysis?.complete !== true || !Array.isArray(analysis.blocks)) return null;

  const sourceSentences = splitSentences(sourceContent)
    .map(normalizedWhitespace)
    .filter((sentence) => sentence.length >= 16);
  if (!sourceSentences.length) return null;
  const requiredSentences = sourceSentences.filter(isFactBearing);
  const selected = new Map();

  for (const block of analysis.blocks) {
    if (!SUPPORTED_SMOKE_LANGUAGES.has(String(block?.language?.primary || ''))) continue;
    if (block?.quality?.refinement_required === true) continue;
    const grounded = (block.mentions || []).filter((mention) =>
      mention?.extractor === 'gliner'
      && GROUNDED_ENTITY_LABELS.has(String(mention.label || '').toLowerCase())
      && typeof mention.text === 'string' && mention.text.trim());
    for (const candidate of block.candidates || []) {
      if (candidate?.kind === 'uncertain') continue;
      const quote = String(candidate?.evidence?.quote || '');
      const normalizedQuote = normalizedWhitespace(quote);
      if (quote.length < 16 || !normalizedQuote || !sourceContent.includes(quote)) continue;
      const anchored = grounded.some((mention) => quote.includes(mention.text));
      const hasStrongSignal = (candidate.signals || []).some((signal) => STRONG_SIGNALS.has(signal));
      const hasLiteral = (block.mentions || []).some((mention) =>
        ['date', 'money', 'percentage', 'ticket_id', 'url'].includes(String(mention?.label || '').toLowerCase())
        && typeof mention.text === 'string' && quote.includes(mention.text));
      if (anchored || hasStrongSignal || hasLiteral) selected.set(normalizedQuote, quote);
    }
  }

  if (!selected.size) return null;
  const selectedSentences = new Set([...selected.keys()]);
  if (requiredSentences.some((sentence) => !selectedSentences.has(sentence))) return null;

  const extractionContent = [...selected.values()].join('\n');
  const savingsRatio = 1 - (extractionContent.length / sourceContent.length);
  if (savingsRatio < minSavingsRatio) return null;
  return {
    extractionContent,
    sourceContent,
    sourceChars: sourceContent.length,
    extractionChars: extractionContent.length,
    savingsRatio: Number(savingsRatio.toFixed(4)),
    selectedSentences: selected.size,
  };
}
