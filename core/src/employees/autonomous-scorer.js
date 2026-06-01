// Autonomous response scorer for Digital Employees (maya/jonah/lina/eli).
// Pure, dependency-free. Ports score_response_autonomously() from
// tuning/autonomous_improvement_loop.py with weights:
//   0.3 consistency + 0.3 completeness + 0.2 clarity + 0.2 depth.
//
// NOTE: hyper-state.js does NOT export employeeLearningKey (it is a
// module-local function), so the identical logic is replicated here.

const CORE_PERSONAS = ['maya', 'jonah', 'lina', 'eli'];

// Replicated verbatim from core/src/employees/hyper-state.js (not exported there).
export function employeeLearningKey(employee = {}) {
  const slug = String(employee.slug || '').toLowerCase();
  const name = String(employee.name || '').toLowerCase();
  const firstToken = name.split(/\s+/).filter(Boolean)[0] || '';

  for (const key of CORE_PERSONAS) {
    if (slug.startsWith(key) || firstToken === key || slug.includes(`${key}-`)) {
      return key;
    }
  }

  return slug || firstToken || 'employee';
}

// Role-specific consistency checks, ported from the Python consistency_checks map.
function consistencyChecks(key, lower, response) {
  switch (key) {
    case 'maya':
      return [
        lower.includes('option') || lower.includes('choice') || lower.includes('decision') || lower.includes('trade-off'),
        lower.includes('however') || lower.includes('but'),
        response.includes('\n'),
        response.length > 150,
      ];
    case 'jonah':
      return [
        lower.includes('risk') || lower.includes('concern') || lower.includes('assumption') || lower.includes('what if') || response.includes('?'),
        lower.includes('why') || lower.includes('but'),
        lower.includes('assumption') || lower.includes('however'),
        response.length > 150,
      ];
    case 'lina':
      return [
        lower.includes('pattern') || lower.includes('data') || lower.includes('based on') || lower.includes('similar') || lower.includes('evidence'),
        lower.includes('data') || lower.includes('based on'),
        lower.includes('trend') || lower.includes('history'),
        response.length > 150,
      ];
    case 'eli':
      return [
        lower.includes('implement') || lower.includes('timeline') || lower.includes('resources') || lower.includes('steps') || lower.includes('dependency'),
        lower.includes('timeline') || lower.includes('resource') || lower.includes('plan'),
        lower.includes('dependency') || lower.includes('required'),
        response.length > 150,
      ];
    default:
      return [];
  }
}

// completeness = length/structure heuristic (the SCORER API has no task
// evaluation_criteria, so completeness is derived structurally).
function completenessScore(response) {
  const length = response.length;
  const paragraphs = response.split(/\n{2,}/).filter((p) => p.trim()).length;

  let score = 0.0;
  if (length > 100) score += 0.25;
  if (length > 300) score += 0.25;
  if (paragraphs >= 2) score += 0.25;
  if (paragraphs >= 3) score += 0.25;
  return Math.min(1, score);
}

// clarity = paragraph/structure heuristic, ported from the Python clarity block.
function clarityScore(lower, response) {
  const numParagraphs = (response.match(/\n/g) || []).length;
  const numSentences = (response.match(/[.!?]/g) || []).length;
  const hasReasoning = lower.includes('because') || lower.includes('therefore');

  let bonus = 0.0;
  if (numParagraphs > 2) bonus += 0.15;
  if (numSentences > 3) bonus += 0.15;
  if (hasReasoning) bonus += 0.2;
  return Math.min(0.5, bonus);
}

// depth = multi-point/reasoning indicators, ported from the Python depth block.
function depthScore(lower) {
  const indicators = [
    lower.includes('tradeoff') || lower.includes('trade-off'),
    lower.includes('consider'),
    lower.includes('however') || lower.includes('on the other hand'),
    lower.includes('evidence') || lower.includes('data'),
  ];
  return indicators.filter(Boolean).length / indicators.length;
}

export function scoreResponse({ key, query, response } = {}) {
  void query;
  const text = String(response || '');
  const lower = text.toLowerCase();
  const roleKey = String(key || '').toLowerCase();

  const roleChecks = consistencyChecks(roleKey, lower, text);
  const consistency = roleChecks.length
    ? roleChecks.filter(Boolean).length / roleChecks.length
    : 0.5;

  const completeness = completenessScore(text);
  const clarity = clarityScore(lower, text);
  const depth = depthScore(lower);

  const score = consistency * 0.3 + completeness * 0.3 + clarity * 0.2 + depth * 0.2;

  return {
    score,
    breakdown: { consistency, completeness, clarity, depth },
  };
}
