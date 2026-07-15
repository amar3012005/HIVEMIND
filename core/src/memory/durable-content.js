// Durable memories are reusable claims. Raw markup and code remain source
// evidence and should not compete with those claims in ordinary recall.
export function isStructuredSourceNoise(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 4) return false;
  let braces = 0;
  let semicolons = 0;
  let colons = 0;
  let angles = 0;
  for (const char of text) {
    if (char === '{' || char === '}') braces++;
    else if (char === ';') semicolons++;
    else if (char === ':') colons++;
    else if (char === '<' || char === '>') angles++;
  }
  const styleOrCodeBlock = braces >= 2 && (semicolons > 0 || colons > 0);
  const markupFragment = angles >= 2 && text.startsWith('<') && text.includes('>');
  return styleOrCodeBlock || markupFragment;
}

const ALLOWED_DURABLE_PROMOTION_TYPES = new Set([
  'fact', 'decision', 'preference', 'goal', 'event', 'lesson', 'summary', 'synthesis',
]);
const SCORED_DURABLE_PROMOTION_TYPES = new Set([
  'fact', 'decision', 'preference', 'goal', 'event', 'lesson',
]);

export function isDurableKbPromotionAdmitted(memory, minImportance = 0.65) {
  const tags = Array.isArray(memory?.tags) ? memory.tags : [];
  const type = memory?.memory_type || memory?.memoryType;
  if (!tags.includes('distilled-from-kb')) return true;
  if (!ALLOWED_DURABLE_PROMOTION_TYPES.has(type)) return false;
  if (isStructuredSourceNoise(memory?.content)) return false;
  if (!SCORED_DURABLE_PROMOTION_TYPES.has(type)) return true;
  const importance = Number(memory?.importance_score ?? memory?.importanceScore);
  return Number.isFinite(importance) && importance >= minImportance;
}
