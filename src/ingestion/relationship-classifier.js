const RELATION_TYPES = ['Updates', 'Extends', 'Derives'];

async function classifyRelationships({ chunk, candidates, classifier }) {
  // Hook for $hivemind-memory-engine-architect classification workflow.
  if (classifier && typeof classifier.classify === 'function') {
    return classifier.classify({ chunk, candidates });
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  return candidates.slice(0, 3).map((candidate, index) => ({
    target_id: candidate.id,
    type: RELATION_TYPES[index % RELATION_TYPES.length],
    score: Number((0.9 - index * 0.1).toFixed(2)),
  }));
}

module.exports = {
  classifyRelationships,
};
