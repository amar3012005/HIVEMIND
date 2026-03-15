/**
 * HIVE-MIND Stateful Memory Mutator
 * Handles automatic isLatest mutation and version history tracking
 * Supports triple-operator logic: Updates, Extends, Derives
 */

/**
 * State Mutator - Manages memory state transitions
 * Detects relationship types and applies appropriate state mutations
 */
export class StateMutator {
  constructor() {
    this.mutationLog = [];
    this.versionHistory = new Map();
  }

  /**
   * Apply state mutation based on relationship type
   * @param {Object} params
   * @param {Object} params.relationship - Relationship object
   * @param {Object} params.oldMemory - Memory being updated
   * @param {Object} params.newMemory - New memory being created
   * @param {Object} params.memories - Map of all memories
   * @returns {Object} Mutation result
   */
  applyMutation({ relationship, oldMemory, newMemory, memories }) {
    const { type, confidence = 1.0, metadata = {} } = relationship;
    const now = new Date().toISOString();
    const mutation = {
      type,
      timestamp: now,
      oldMemoryId: oldMemory?.id,
      newMemoryId: newMemory?.id,
      changes: []
    };

    switch (type) {
      case 'Updates':
        // Updates: Old memory becomes not latest, new memory becomes latest
        mutation.changes = this._applyUpdate(
          oldMemory,
          newMemory,
          memories,
          confidence,
          metadata
        );
        break;

      case 'Extends':
        // Extends: Both memories remain latest (clarification/refinement)
        mutation.changes = this._applyExtend(
          oldMemory,
          newMemory,
          memories,
          confidence,
          metadata
        );
        break;

      case 'Derives':
        // Derives: New memory is independent (inference)
        mutation.changes = this._applyDerive(
          oldMemory,
          newMemory,
          memories,
          confidence,
          metadata
        );
        break;

      default:
        throw new Error(`Unknown relationship type: ${type}`);
    }

    // Log mutation
    this.mutationLog.push(mutation);
    this._trackVersionHistory(mutation);

    return mutation;
  }

  /**
   * Apply Update relationship mutation
   * Marks old memory as not latest, new memory as latest
   */
  _applyUpdate(oldMemory, newMemory, memories, confidence, metadata) {
    const changes = [];
    const now = new Date().toISOString();

    // Mark old memory as not latest
    if (oldMemory) {
      if (oldMemory.is_latest !== false) {
        oldMemory.is_latest = false;
        oldMemory.updated_at = now;
        changes.push({
          memoryId: oldMemory.id,
          field: 'is_latest',
          from: true,
          to: false,
          reason: 'Update relationship'
        });
      }

      // Increment version for old memory
      oldMemory.version = (oldMemory.version || 1) + 1;
      changes.push({
        memoryId: oldMemory.id,
        field: 'version',
        from: oldMemory.version - 1,
        to: oldMemory.version,
        reason: 'Update relationship'
      });
    }

    // Mark new memory as latest
    if (newMemory) {
      newMemory.is_latest = true;
      newMemory.version = (newMemory.version || 1) + 1;
      newMemory.updated_at = now;
      newMemory.last_confirmed = now;
      changes.push({
        memoryId: newMemory.id,
        field: 'is_latest',
        from: undefined,
        to: true,
        reason: 'Update relationship'
      });
      changes.push({
        memoryId: newMemory.id,
        field: 'version',
        from: newMemory.version - 1,
        to: newMemory.version,
        reason: 'Update relationship'
      });
    }

    return changes;
  }

  /**
   * Apply Extend relationship mutation
   * Both memories remain latest (clarification/refinement)
   */
  _applyExtend(oldMemory, newMemory, memories, confidence, metadata) {
    const changes = [];
    const now = new Date().toISOString();

    // For Extends, both memories remain latest
    // The new memory extends/clarifies the old one
    if (newMemory) {
      newMemory.is_latest = true;
      newMemory.version = (newMemory.version || 1) + 1;
      newMemory.updated_at = now;
      newMemory.last_confirmed = now;
      changes.push({
        memoryId: newMemory.id,
        field: 'is_latest',
        from: undefined,
        to: true,
        reason: 'Extends relationship'
      });
      changes.push({
        memoryId: newMemory.id,
        field: 'version',
        from: newMemory.version - 1,
        to: newMemory.version,
        reason: 'Extends relationship'
      });
    }

    // If old memory exists, ensure it remains latest
    if (oldMemory && oldMemory.is_latest !== true) {
      oldMemory.is_latest = true;
      oldMemory.updated_at = now;
      changes.push({
        memoryId: oldMemory.id,
        field: 'is_latest',
        from: false,
        to: true,
        reason: 'Extends relationship (restore latest)'
      });
    }

    return changes;
  }

  /**
   * Apply Derive relationship mutation
   * New memory is independent (inference)
   */
  _applyDerive(oldMemory, newMemory, memories, confidence, metadata) {
    const changes = [];
    const now = new Date().toISOString();

    // For Derives, the new memory is independent
    // It can be a derived fact from the source
    if (newMemory) {
      newMemory.is_latest = true;
      newMemory.version = (newMemory.version || 1) + 1;
      newMemory.updated_at = now;
      newMemory.last_confirmed = now;
      changes.push({
        memoryId: newMemory.id,
        field: 'is_latest',
        from: undefined,
        to: true,
        reason: 'Derives relationship'
      });
      changes.push({
        memoryId: newMemory.id,
        field: 'version',
        from: newMemory.version - 1,
        to: newMemory.version,
        reason: 'Derives relationship'
      });
    }

    // Source memory remains unchanged
    // The derived memory is independent but linked

    return changes;
  }

  /**
   * Track version history for a memory
   */
  _trackVersionHistory(mutation) {
    const { oldMemoryId, newMemoryId, changes } = mutation;

    // Track old memory version
    if (oldMemoryId) {
      const history = this.versionHistory.get(oldMemoryId) || [];
      history.push({
        timestamp: mutation.timestamp,
        changes: changes.filter(c => c.memoryId === oldMemoryId),
        reason: mutation.type
      });
      this.versionHistory.set(oldMemoryId, history);
    }

    // Track new memory version
    if (newMemoryId) {
      const history = this.versionHistory.get(newMemoryId) || [];
      history.push({
        timestamp: mutation.timestamp,
        changes: changes.filter(c => c.memoryId === newMemoryId),
        reason: mutation.type
      });
      this.versionHistory.set(newMemoryId, history);
    }
  }

  /**
   * Get version history for a memory
   */
  getVersionHistory(memoryId) {
    return this.versionHistory.get(memoryId) || [];
  }

  /**
   * Get all mutation logs
   */
  getMutationLog() {
    return [...this.mutationLog];
  }

  /**
   * Clear mutation log and version history
   */
  clear() {
    this.mutationLog = [];
    this.versionHistory.clear();
  }

  /**
   * Get current state of a memory
   */
  getMemoryState(memoryId, memories) {
    const memory = memories.get(memoryId);
    if (!memory) return null;

    return {
      id: memory.id,
      content: memory.content,
      is_latest: memory.is_latest,
      version: memory.version || 1,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
      versionHistory: this.getVersionHistory(memoryId)
    };
  }

  /**
   * Validate state transition
   */
  validateTransition({ type, oldMemory, newMemory }) {
    const errors = [];

    if (!newMemory) {
      errors.push('New memory is required');
    }

    if (type === 'Updates' && !oldMemory) {
      errors.push('Old memory is required for Updates relationship');
    }

    if (type === 'Updates' && oldMemory && oldMemory.is_latest !== true) {
      errors.push('Cannot update a memory that is not latest');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get statistics about mutations
   */
  getStats() {
    const updates = this.mutationLog.filter(m => m.type === 'Updates').length;
    const extendsCount = this.mutationLog.filter(m => m.type === 'Extends').length;
    const derives = this.mutationLog.filter(m => m.type === 'Derives').length;

    return {
      totalMutations: this.mutationLog.length,
      updates,
      extends: extendsCount,
      derives,
      memoriesWithHistory: this.versionHistory.size,
      avgChangesPerMutation: this.mutationLog.length > 0
        ? this.mutationLog.reduce((sum, m) => sum + m.changes.length, 0) / this.mutationLog.length
        : 0
    };
  }
}

/**
 * Factory function to create state mutator
 */
export function getStateMutator() {
  return new StateMutator();
}

/**
 * Apply state mutation to in-memory memories map
 * @param {Object} params
 * @param {Object} params.relationship - Relationship object
 * @param {Map} params.memories - Map of all memories
 * @returns {Object} Mutation result
 */
export function applyStateMutation({ relationship, memories }) {
  const mutator = getStateMutator();
  const { type, from_id, to_id } = relationship;
  const newMemory = memories.get(from_id);
  const oldMemory = memories.get(to_id);

  return mutator.applyMutation({
    relationship,
    oldMemory,
    newMemory,
    memories
  });
}
