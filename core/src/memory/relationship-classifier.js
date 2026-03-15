import { ConflictDetector } from './conflict-detector.js';

const REPLACEMENT_SIGNALS = [
  'now',
  'current',
  'updated',
  'changed',
  'replaced',
  'moved',
  'deprecated',
  'no longer'
];

export class RelationshipClassifier {
  constructor({ conflictDetector = new ConflictDetector() } = {}) {
    this.conflictDetector = conflictDetector;
  }

  classifyRelationship(newMemory, existingMemories = []) {
    const latestMemories = existingMemories.filter(memory => memory.is_latest !== false);
    const candidates = this.conflictDetector.detectCandidates(newMemory, latestMemories);

    if (candidates.length === 0) {
      return {
        operation: 'created',
        relationship: null,
        similarity: 0
      };
    }

    const best = candidates[0];
    const relationshipType = this._isReplacement(newMemory.content, best.memory.content) ? 'Updates' : 'Extends';

    return {
      operation: relationshipType === 'Updates' ? 'updated' : 'extended',
      relationship: {
        type: relationshipType,
        targetId: best.memory.id,
        confidence: best.similarity
      },
      similarity: best.similarity
    };
  }

  _isReplacement(nextContent = '', previousContent = '') {
    const next = nextContent.toLowerCase();
    const previous = previousContent.toLowerCase();
    if (next === previous) {
      return false;
    }

    if (REPLACEMENT_SIGNALS.some(signal => next.includes(signal))) {
      return true;
    }

    const numberMatch = [...next.matchAll(/\b\d+\b/g)].map(match => match[0]).join(',');
    const previousNumberMatch = [...previous.matchAll(/\b\d+\b/g)].map(match => match[0]).join(',');

    return numberMatch !== previousNumberMatch && previousNumberMatch.length > 0;
  }
}
