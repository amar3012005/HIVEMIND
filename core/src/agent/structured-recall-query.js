export function buildStructuredRecallQuery(queries = [], answerObjective = '') {
  const parts = [...new Set(
    [...queries, answerObjective]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()),
  )];
  if (parts.length === 0) return '';
  const [primary, ...focus] = parts;
  return [primary, ...focus.map((value) => `Retrieval objective: ${value}`)].join('\n');
}
