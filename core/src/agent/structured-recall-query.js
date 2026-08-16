const SHAPE_FOCUS = {
  inventory: 'Known members and items: names, models, variants, categories, families, and portfolio entries.',
  overview: 'Relevant facets, attributes, activities, positioning, and notable supported details.',
  comparison: 'Compared subjects, shared dimensions, differences, similarities, and constraints.',
};

export function buildStructuredRecallQuery(queries = [], answerObjective = '', retrievalShape = 'fact') {
  const parts = [...new Set(
    [...queries, answerObjective, SHAPE_FOCUS[retrievalShape]]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()),
  )];
  if (parts.length === 0) return '';
  const [primary, ...focus] = parts;
  return [primary, ...focus.map((value) => `Retrieval objective: ${value}`)].join('\n');
}
