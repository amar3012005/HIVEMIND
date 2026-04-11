import { ConflictDetector } from './conflict-detector.js';
import { normalizeRelationshipDescriptor } from './relationship-semantics.js';

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

const SYNTHESIS_SIGNALS = [
  'based on',
  'combining',
  'combined',
  'from multiple sources',
  'overall',
  'in summary',
  'therefore',
  'thus',
  'together',
  'synthes',
  'cross-reference',
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
    const shouldDerive = candidates.length >= 2 && this._looksLikeSynthesis(newMemory.content);
    const relationshipType = shouldDerive
      ? 'Derives'
      : this._isReplacement(newMemory.content, best.memory.content)
        ? 'Updates'
        : 'Extends';

    const relationship = relationshipType === 'Derives'
      ? normalizeRelationshipDescriptor({
        type: 'Derives',
        sourceIds: candidates.slice(0, 3).map(candidate => candidate.memory.id),
        confidence: best.similarity,
        reason: 'synthesis_signals',
      })
      : normalizeRelationshipDescriptor({
        type: relationshipType,
        targetId: best.memory.id,
        confidence: best.similarity,
        reason: relationshipType === 'Updates' ? 'replacement_signals' : 'augmentation',
      });

    return {
      operation: relationshipType === 'Updates'
        ? 'updated'
        : relationshipType === 'Derives'
          ? 'derived'
          : 'extended',
      relationship: {
        type: relationship.type,
        targetId: relationship.targetId,
        sourceIds: relationship.sourceIds,
        confidence: relationship.confidence,
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

  _looksLikeSynthesis(content = '') {
    const next = content.toLowerCase();
    return SYNTHESIS_SIGNALS.some(signal => next.includes(signal));
  }
}
