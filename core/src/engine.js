/**
 * HIVE-MIND Core Memory Engine (JavaScript)
 * Graph-based memory with Updates, Extends, Derives triple-operator logic
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

/**
 * MemoryEngine - Core memory operations
 */
export class MemoryEngine {
  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.init();
  }

  init() {
    // Create memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        user_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        project TEXT,
        tags TEXT, -- JSON array
        is_latest INTEGER DEFAULT 1,
        strength REAL DEFAULT 1.0,
        recall_count INTEGER DEFAULT 0,
        last_confirmed DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        document_date DATETIME,
        event_dates TEXT, -- JSON array
        source TEXT,
        metadata TEXT -- JSON
      )
    `);

    // Create relationships table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('Updates', 'Extends', 'Derives')),
        confidence REAL DEFAULT 1.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT,
        FOREIGN KEY (from_id) REFERENCES memories(id),
        FOREIGN KEY (to_id) REFERENCES memories(id),
        UNIQUE(from_id, to_id, type)
      )
    `);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_org ON memories(org_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_latest ON memories(is_latest)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type)`);
  }

  /**
   * Store a new memory with triple-operator relationship support
   */
  storeMemory({ content, user_id, org_id, project, tags = [], source, metadata = {}, relationship, document_date, event_dates }) {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, content, user_id, org_id, project, tags, source, metadata, created_at, updated_at, document_date, event_dates)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      content,
      user_id,
      org_id,
      project || null,
      JSON.stringify(tags),
      source || null,
      JSON.stringify(metadata),
      now,
      now,
      document_date || null,
      event_dates ? JSON.stringify(event_dates) : null
    );

    // Handle relationship
    if (relationship) {
      this.createRelationship({
        from_id: id,
        to_id: relationship.target_id,
        type: relationship.type,
        confidence: 1.0
      });

      // For Updates, mark old memory as not latest
      if (relationship.type === 'Updates') {
        this.db.prepare(`UPDATE memories SET is_latest = 0, updated_at = ? WHERE id = ?`).run(now, relationship.target_id);
      }
    }

    return this.getMemory(id);
  }

  /**
   * Create relationship between memories
   */
  createRelationship({ from_id, to_id, type, confidence = 1.0, metadata = {} }) {
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO relationships (id, from_id, to_id, type, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, from_id, to_id, type, confidence, JSON.stringify(metadata));
    return { id, from_id, to_id, type, confidence };
  }

  /**
   * Search memories with keyword search
   */
  searchMemories({ query, user_id, org_id, n_results = 10, filter = {} }) {
    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params = [];

    if (user_id) {
      sql += ' AND user_id = ?';
      params.push(user_id);
    }
    if (org_id) {
      sql += ' AND org_id = ?';
      params.push(org_id);
    }
    if (filter.project) {
      sql += ' AND project = ?';
      params.push(filter.project);
    }
    if (filter.is_latest !== undefined) {
      sql += ' AND is_latest = ?';
      params.push(filter.is_latest ? 1 : 0);
    }
    if (query) {
      sql += ' AND (content LIKE ? OR tags LIKE ?)';
      params.push(`%${query}%`, `%${query}%`);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(n_results);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map(row => this.rowToMemory(row));
  }

  /**
   * Get memory by ID with relationships
   */
  getMemory(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row) return null;

    const memory = this.rowToMemory(row);
    const relationships = this.db.prepare('SELECT * FROM relationships WHERE from_id = ? OR to_id = ?').all(id, id);

    return { memory, relationships: relationships.map(r => this.rowToRelationship(r)) };
  }

  /**
   * Traverse graph from starting memory
   */
  traverse({ start_id, depth = 3, relationship_types = ['Updates', 'Extends', 'Derives'] }) {
    const visited = new Set();
    const queue = [{ id: start_id, depth: 0 }];
    const nodes = [];
    const edges = [];

    const typePlaceholders = relationship_types.map(() => '?').join(',');

    while (queue.length > 0) {
      const { id, depth: currentDepth } = queue.shift();
      if (visited.has(id) || currentDepth > depth) continue;
      visited.add(id);

      const node = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (node) nodes.push(this.rowToMemory(node));

      const rels = this.db.prepare(`
        SELECT * FROM relationships
        WHERE (from_id = ? OR to_id = ?) AND type IN (${typePlaceholders})
      `).all(id, id, ...relationship_types);

      for (const rel of rels) {
        edges.push(this.rowToRelationship(rel));
        const otherId = rel.from_id === id ? rel.to_id : rel.from_id;
        if (!visited.has(otherId)) {
          queue.push({ id: otherId, depth: currentDepth + 1 });
        }
      }
    }

    return { nodes, edges, paths: this.buildPaths(nodes, edges) };
  }

  /**
   * Calculate memory decay using Ebbinghaus curve
   * Formula: P = e^(-t/s)
   */
  calculateDecay(memoryId) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
    if (!row) return null;

    const memory = this.rowToMemory(row);
    const now = new Date();
    const lastConfirmed = new Date(memory.last_confirmed);
    const t = (now - lastConfirmed) / (1000 * 60 * 60 * 24); // days
    const s = memory.strength * (1 + Math.log(memory.recall_count + 1));
    const probability = Math.exp(-t / s);
    const halfLife = s * Math.log(2);

    let status;
    if (probability > 0.3) status = 'active';
    else if (probability > 0.1) status = 'decaying';
    else status = 'forgotten';

    return { memory_id: memoryId, recall_probability: probability, status, half_life_days: halfLife };
  }

  /**
   * Reinforce memory on recall
   */
  reinforceMemory(memoryId) {
    const stmt = this.db.prepare(`
      UPDATE memories
      SET strength = strength * 1.1, recall_count = recall_count + 1, last_confirmed = ?
      WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), memoryId);
    return this.getMemory(memoryId);
  }

  /**
   * Auto-recall: Get relevant memories for context
   */
  autoRecall({ query_context, user_id, max_memories = 5, weights = { similarity: 0.5, recency: 0.3, importance: 0.2 } }) {
    // Simple keyword-based search for local version
    const keywords = query_context.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    const allMemories = this.db.prepare('SELECT * FROM memories WHERE user_id = ?').all(user_id);

    const scored = allMemories.map(row => {
      const memory = this.rowToMemory(row);
      const content = memory.content.toLowerCase();

      // Simple keyword matching score
      const keywordMatches = keywords.filter(k => content.includes(k)).length;
      const similarityScore = keywordMatches / Math.max(keywords.length, 1);

      const now = new Date().getTime();
      const created = new Date(memory.created_at).getTime();
      const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
      const recencyScore = Math.exp(-daysAgo / 30);

      const importanceScore = memory.strength;

      const weightedScore = weights.similarity * similarityScore + weights.recency * recencyScore + weights.importance * importanceScore;

      return { memory, score: weightedScore };
    });

    const topMemories = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, max_memories)
      .map(s => s.memory);

    const injectionText = `<relevant-memories>\n${topMemories.map(m => `- ${m.content}`).join('\n')}\n</relevant-memories>`;

    return { memories: topMemories, injectionText };
  }

  /**
   * Session end: Auto-capture decisions and lessons
   */
  sessionEndHook({ session_content, user_id, org_id }) {
    const decisionKeywords = ['decided', 'decision', 'chose', 'will use', 'going with', 'settled on', 'agreed to'];
    const lessonKeywords = ['lesson', 'learned', 'takeaway', 'important', 'remember', 'note that'];

    const sentences = session_content.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
    const captured = [];

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();

      for (const keyword of decisionKeywords) {
        if (lower.includes(keyword)) {
          const memory = this.storeMemory({
            content: `Decision: ${sentence}`,
            user_id,
            org_id,
            tags: ['decision', 'auto-captured'],
            metadata: { source: 'session_end_hook', keyword }
          });
          captured.push({ type: 'decision', memory });
          break;
        }
      }

      for (const keyword of lessonKeywords) {
        if (lower.includes(keyword)) {
          const memory = this.storeMemory({
            content: `Lesson: ${sentence}`,
            user_id,
            org_id,
            tags: ['lesson', 'auto-captured'],
            metadata: { source: 'session_end_hook', keyword }
          });
          captured.push({ type: 'lesson', memory });
          break;
        }
      }
    }

    return { captured, count: captured.length };
  }

  /**
   * Get all memories
   */
  getAllMemories(user_id, org_id) {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE user_id = ? AND org_id = ? ORDER BY created_at DESC');
    return stmt.all(user_id, org_id).map(row => this.rowToMemory(row));
  }

  /**
   * Get stats
   */
  getStats(user_id, org_id) {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND org_id = ?').get(user_id, org_id);
    const active = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND org_id = ? AND is_latest = 1').get(user_id, org_id);
    const rels = this.db.prepare(`
      SELECT COUNT(*) as count FROM relationships
      WHERE from_id IN (SELECT id FROM memories WHERE user_id = ? AND org_id = ?)
    `).get(user_id, org_id);

    return {
      total_memories: total.count,
      active_memories: active.count,
      relationships: rels.count
    };
  }

  // Helpers
  rowToMemory(row) {
    return {
      id: row.id,
      content: row.content,
      user_id: row.user_id,
      org_id: row.org_id,
      project: row.project,
      tags: JSON.parse(row.tags || '[]'),
      is_latest: row.is_latest === 1,
      strength: row.strength,
      recall_count: row.recall_count,
      last_confirmed: row.last_confirmed,
      created_at: row.created_at,
      updated_at: row.updated_at,
      document_date: row.document_date,
      event_dates: row.event_dates ? JSON.parse(row.event_dates) : [],
      source: row.source,
      metadata: JSON.parse(row.metadata || '{}')
    };
  }

  rowToRelationship(row) {
    return {
      id: row.id,
      from_id: row.from_id,
      to_id: row.to_id,
      type: row.type,
      confidence: row.confidence,
      created_at: row.created_at,
      metadata: JSON.parse(row.metadata || '{}')
    };
  }

  buildPaths(nodes, edges) {
    // Simple path building
    return edges.map(edge => ({
      from: nodes.find(n => n.id === edge.from_id),
      to: nodes.find(n => n.id === edge.to_id),
      relationship: edge.type
    }));
  }

  close() {
    this.db.close();
  }
}

// Export for ES modules
export default MemoryEngine;
