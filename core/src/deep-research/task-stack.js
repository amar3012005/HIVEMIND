/**
 * TaskStack — Stack-based recursive task decomposition for deep research.
 *
 * Inspired by AgentScope's depth-first expansion with 8-dimension analysis.
 * Each task can spawn subtasks. When a subtask completes, if gaps remain,
 * new subtasks are pushed. The stack is exhausted when all paths reach
 * sufficient confidence or max depth.
 */

import { randomUUID } from 'node:crypto';

let DEFAULT_MAX_DEPTH = 2; // was 4 — deep recursion creates too many subtasks
const MAX_TASKS = 7;    // was 20 — wave-1(3) + gaps(2) + buffer(2) = 7 max
const CONFIDENCE_THRESHOLD = 0.80;

// 8 research dimensions (from AgentScope)
const DIMENSIONS = [
  'definition',      // What is X?
  'mechanism',       // How does X work?
  'evidence',        // What data supports X?
  'stakeholders',    // Who is affected by X?
  'timeline',        // When did/will X happen?
  'comparison',      // How does X compare to Y?
  'implications',    // What are the consequences of X?
  'gaps',            // What is unknown about X?
];

const WAVE_GROUPS = {
  1: ['definition', 'mechanism', 'evidence', 'timeline'],
  2: ['stakeholders', 'comparison', 'implications'],
  3: ['gaps'],
};

export class TaskStack {
  constructor({ maxDepth } = {}) {
    this.tasks = new Map();    // id → task
    this.stack = [];           // ids in execution order (LIFO)
    this.completed = [];       // completed task ids
    this.rootId = null;
    this.maxDepth = maxDepth || DEFAULT_MAX_DEPTH;
  }

  /**
   * Initialize with a root research query.
   * @param {string} query - the user's research question
   * @returns {Task} the root task
   */
  createRoot(query) {
    const task = {
      id: randomUUID(),
      query,
      depth: 0,
      parentId: null,
      status: 'pending',    // pending | active | completed | failed
      subtaskIds: [],
      findings: [],          // evidence collected for this task
      confidence: 0,
      gaps: [],              // identified gaps to fill
      dimension: null,       // which dimension this explores
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.tasks.set(task.id, task);
    this.stack.push(task.id);
    this.rootId = task.id;
    return task;
  }

  /**
   * Pop the next task to work on.
   * @returns {Task|null}
   */
  next() {
    while (this.stack.length > 0) {
      const id = this.stack.pop();
      const task = this.tasks.get(id);
      if (task && task.status === 'pending') {
        task.status = 'active';
        return task;
      }
    }
    return null;
  }

  /**
   * Complete a task with findings and identified gaps.
   * @param {string} taskId
   * @param {{ findings: Array, confidence: number, gaps: string[] }} result
   */
  complete(taskId, { findings = [], confidence = 0, gaps = [] }) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.findings = findings;
    task.confidence = confidence;
    task.gaps = gaps;
    task.completedAt = new Date().toISOString();
    this.completed.push(taskId);

    // If gaps remain and we haven't hit limits, decompose further
    if (gaps.length > 0 && task.depth < this.maxDepth && this.tasks.size < MAX_TASKS) {
      for (const gap of gaps.slice(0, 3)) {
        this.addSubtask(taskId, gap);
      }
    }
  }

  /**
   * Mark a task as failed.
   */
  fail(taskId, reason) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'failed';
    task.gaps = [reason];
    task.completedAt = new Date().toISOString();
    this.completed.push(taskId);
  }

  /**
   * Add a subtask under a parent.
   */
  addSubtask(parentId, query, dimension = null) {
    if (this.tasks.size >= MAX_TASKS) return null;

    const parent = this.tasks.get(parentId);
    if (!parent) return null;

    const task = {
      id: randomUUID(),
      query,
      depth: parent.depth + 1,
      parentId,
      status: 'pending',
      subtaskIds: [],
      findings: [],
      confidence: 0,
      gaps: [],
      dimension,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    this.tasks.set(task.id, task);
    parent.subtaskIds.push(task.id);
    this.stack.push(task.id);
    return task;
  }

  /**
   * Decompose a task into dimension-based subtasks.
   * Uses the 8 research dimensions to expand a broad query.
   * @param {string} taskId
   * @param {string[]} relevantDimensions - subset of DIMENSIONS to explore
   */
  decompose(taskId, relevantDimensions) {
    const task = this.tasks.get(taskId);
    if (!task) return [];

    const subtasks = [];
    for (const dim of relevantDimensions) {
      const subQuery = this._dimensionQuery(task.query, dim);
      const sub = this.addSubtask(taskId, subQuery, dim);
      if (sub) subtasks.push(sub);
    }
    return subtasks;
  }

  /**
   * Group pending dimension tasks into execution waves.
   * Wave 1: Independent foundation dimensions (parallel)
   * Wave 2: Contextual dimensions (need wave 1 results, parallel)
   * Wave 3: Gap analysis (needs everything, sequential)
   */
  getTasksByWave() {
    const waves = { 1: [], 2: [], 3: [] };
    for (const [, task] of this.tasks) {
      if (task.status !== 'pending' || !task.dimension) continue;
      for (const [wave, dims] of Object.entries(WAVE_GROUPS)) {
        if (dims.includes(task.dimension)) {
          waves[wave].push(task);
          break;
        }
      }
    }
    return waves;
  }

  /**
   * Generate a dimension-specific sub-query.
   */
  _dimensionQuery(query, dimension) {
    const templates = {
      definition: `What exactly is ${query}? Define the key concepts.`,
      mechanism: `How does ${query} work? What are the technical mechanisms?`,
      evidence: `What evidence or data supports claims about ${query}?`,
      stakeholders: `Who are the key stakeholders or affected parties in ${query}?`,
      timeline: `What is the timeline or chronology of ${query}?`,
      comparison: `How does ${query} compare to alternatives or competitors?`,
      implications: `What are the implications and consequences of ${query}?`,
      gaps: `What is still unknown or debated about ${query}?`,
    };
    return templates[dimension] || `Explore ${dimension} aspects of: ${query}`;
  }

  /**
   * Check if the research is complete.
   */
  isComplete() {
    if (this.stack.length > 0) return false;
    const root = this.tasks.get(this.rootId);
    return root && this.getAggregateConfidence() >= CONFIDENCE_THRESHOLD;
  }

  /**
   * Get aggregate confidence across all completed tasks.
   */
  getAggregateConfidence() {
    const completedTasks = this.completed
      .map(id => this.tasks.get(id))
      .filter(t => t && t.status === 'completed');

    if (completedTasks.length === 0) return 0;

    const totalConf = completedTasks.reduce((sum, t) => sum + t.confidence, 0);
    return totalConf / completedTasks.length;
  }

  /**
   * Get all findings across all completed tasks (flattened).
   */
  getAllFindings() {
    const findings = [];
    for (const id of this.completed) {
      const task = this.tasks.get(id);
      if (task?.findings) {
        findings.push(...task.findings.map(f => ({
          ...f,
          _taskId: task.id,
          _taskQuery: task.query,
          _taskDepth: task.depth,
          _taskDimension: task.dimension,
        })));
      }
    }
    return findings;
  }

  /**
   * Get remaining gaps across all tasks.
   */
  getRemainingGaps() {
    const gaps = [];
    for (const [, task] of this.tasks) {
      if (task.status === 'completed' && task.gaps.length > 0 && task.depth >= this.maxDepth) {
        gaps.push(...task.gaps.map(g => ({ gap: g, taskId: task.id, query: task.query })));
      }
    }
    return gaps;
  }

  /**
   * Get a progress summary.
   */
  getProgress() {
    const total = this.tasks.size;
    const completed = this.completed.length;
    const pending = this.stack.length;
    const active = [...this.tasks.values()].filter(t => t.status === 'active').length;

    return {
      total,
      completed,
      pending,
      active,
      confidence: this.getAggregateConfidence(),
      depth: Math.max(0, ...[...this.tasks.values()].map(t => t.depth)),
      findingCount: this.getAllFindings().length,
      isComplete: this.isComplete(),
    };
  }

  /**
   * Serialize for persistence (save to CSI graph).
   */
  toJSON() {
    return {
      rootId: this.rootId,
      tasks: Object.fromEntries(this.tasks),
      stack: this.stack,
      completed: this.completed,
      progress: this.getProgress(),
    };
  }
}

export { DIMENSIONS, WAVE_GROUPS, DEFAULT_MAX_DEPTH as MAX_DEPTH, MAX_TASKS, CONFIDENCE_THRESHOLD };
