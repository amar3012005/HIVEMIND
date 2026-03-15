# Phase 2 Implementation Plan: Stateful Memory Manager

**Document Version:** 1.0  
**Date:** 2026-03-09  
**Status:** 🚧 IN PROGRESS  
**Priority:** P0 - Critical Path  

---

## Executive Summary

The Stateful Memory Manager addresses the fundamental limitation of static memory systems: **temporal inconsistency**. When information changes (e.g., user's job title, project status), the system must automatically flag previous versions as outdated to prevent AI hallucination from conflicting facts. This plan implements automatic `isLatest` boolean mutation within the database, triggered by "Update" relationships.

**Target:** Match Supermemory.ai's stateful memory with PostgreSQL triggers for automatic state mutation.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    STATEFUL MEMORY MANAGER                                  │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐
│   New Memory │    │  Relationship    │    │  State Mutation  │    │   Database   │
│   (Update)   │───▶│  Detection       │───▶│  Trigger         │───▶│   Persistence│
└──────────────┘    └──────────────────┘    └──────────────────┘    └──────────────┘
                                                         │
                                                         ▼
                                            ┌─────────────────────────────┐
                                            │   Edge-Mutation Logic       │
                                            │   • Mark old node isLatest  │
                                            │   • Set new node isLatest   │
                                            │   • Preserve version history│
                                            └─────────────────────────────┘
                                                         │
                                                         ▼
                                            ┌─────────────────────────────┐
                                            │   Conflict Resolution       │
                                            │   • Latest-first retrieval  │
                                            │   • Version traversal       │
                                            │   • Temporal reasoning      │
                                            └─────────────────────────────┘
```

---

## Current State Gap Analysis

| Component | Current Implementation | Target (Supermemory) | Gap |
|-----------|----------------------|---------------------|-----|
| Automatic isLatest Mutation | ⚠️ Manual in engine.js | ✅ Database trigger | **HIGH** |
| Update Relationship Detection | ⚠️ In-memory only | ✅ Persistent trigger | **HIGH** |
| Edge-Mutation Logic | ⚠️ Basic | ✅ Full state machine | **MEDIUM** |
| Conflict Resolution | ⚠️ Simple | ✅ Temporal-aware | **MEDIUM** |

---

## Implementation Steps

### Step 1: Database Schema Enhancement

**Effort:** 2 days  
**Dependencies:** None  
**Files:** `core/prisma/schema.prisma` (extensions)

```prisma
// Add to schema.prisma - Memory model extensions

model Memory {
  // ... existing fields ...

  // Stateful memory tracking
  isLatest            Boolean        @default(true) @map("is_latest")
  version             Int            @default(1) @map("version")
  versionHistory      MemoryVersion[]

  // ... rest of model ...
}

/// Memory version history for temporal tracking
model MemoryVersion {
  id              String    @id @default(uuid()) @map("id") @db.Uuid
  memoryId        String    @map("memory_id") @db.Uuid
  contentHash     String    @map("content_hash")
  isLatest        Boolean   @default(false) @map("is_latest")
  version         Int       @default(1)
  reason          String?   @map("reason") @db.Text  // "Updates", "Extends", "Derives"
  createdAt       DateTime  @default(now()) @map("created_at")

  memory Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)

  @@index([memoryId, isLatest])
  @@index([createdAt])
  @@map("memory_versions")
}
```

---

### Step 2: PostgreSQL Trigger for Automatic State Mutation

**Effort:** 3 days  
**Dependencies:** Step 1  
**Files:** `core/prisma/migrations/001_stateful_memory.sql`

```sql
-- PostgreSQL trigger for automatic isLatest mutation
-- When a new memory is created with an "Updates" relationship,
-- automatically mark the old memory as not latest

-- Function to handle state mutation
CREATE OR REPLACE FUNCTION handle_memory_update()
RETURNS TRIGGER AS $$
DECLARE
    old_memory_id UUID;
BEGIN
    -- Check if this is an Updates relationship
    IF NEW.type = 'Updates' THEN
        -- Find the old memory that this updates
        SELECT to_id INTO old_memory_id
        FROM relationships
        WHERE id = NEW.id;
        
        -- Mark old memory as not latest
        UPDATE memories
        SET is_latest = FALSE,
            updated_at = NOW()
        WHERE id = old_memory_id;
        
        -- Increment version for old memory
        UPDATE memories
        SET version = COALESCE(version, 0) + 1
        WHERE id = old_memory_id;
        
        -- Create version record for old memory
        INSERT INTO memory_versions (
            memory_id,
            content_hash,
            is_latest,
            version,
            reason,
            created_at
        )
        SELECT 
            old_memory_id,
            md5(content),  -- Simple content hash
            FALSE,
            COALESCE((SELECT MAX(version) FROM memories WHERE id = old_memory_id), 0) + 1,
            'Updates',
            NOW();
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on relationship creation
CREATE TRIGGER trigger_memory_update
AFTER INSERT ON relationships
FOR EACH ROW
EXECUTE FUNCTION handle_memory_update();

-- Function to handle Extends relationship (refinement, not update)
CREATE OR REPLACE FUNCTION handle_memory_extend()
RETURNS TRIGGER AS $$
BEGIN
    -- For Extends, we don't change isLatest
    -- The new memory extends/clarifies the old one
    -- Both remain as isLatest = TRUE
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for Extends relationships
CREATE TRIGGER trigger_memory_extend
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Extends')
EXECUTE FUNCTION handle_memory_extend();

-- Function to handle Derives relationship (inference)
CREATE OR REPLACE FUNCTION handle_memory_derive()
RETURNS TRIGGER AS $$
BEGIN
    -- For Derives, create a new memory node
    -- The derived memory is independent of source
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for Derives relationships
CREATE TRIGGER trigger_memory_derive
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Derives')
EXECUTE FUNCTION handle_memory_derive();
```

---

### Step 3: Prisma Client Extension for Stateful Operations

**Effort:** 3 days  
**Dependencies:** Steps 1 & 2  
**Files:** `core/src/db/stateful.js`

```javascript
/**
 * Stateful Memory Prisma Extension
 * Provides automatic state mutation and conflict resolution
 */

import { PrismaClient } from '@prisma/client';

export class StatefulMemoryManager {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Store memory with automatic state mutation
   * @param {Object} params
   * @param {string} params.content - Memory content
   * @param {string} params.userId - User ID
   * @param {string} params.orgId - Organization ID
   * @param {string} [params.project] - Project name
   * @param {string[]} [params.tags=[]] - Tags
   * @param {Object} [params.relationship] - Relationship to existing memory
   * @returns {Promise<Object>} Created memory
   */
  async storeMemory(params) {
    const { content, userId, orgId, project, tags = [], relationship } = params;

    // Start transaction for atomic operation
    return await this.prisma.$transaction(async (tx) => {
      // Create new memory
      const newMemory = await tx.memory.create({
        data: {
          content,
          userId,
          orgId,
          project,
          tags,
          isLatest: true,
          version: 1,
          metadata: {
            createdAt: new Date().toISOString()
          }
        }
      });

      // Handle relationship if provided
      if (relationship) {
        await this._handleRelationship(tx, newMemory.id, relationship);
      }

      return newMemory;
    });
  }

  /**
   * Handle relationship with automatic state mutation
   */
  async _handleRelationship(tx, newMemoryId, relationship) {
    const { targetId, type, confidence = 1.0, metadata = {} } = relationship;

    // Create relationship
    const rel = await tx.relationship.create({
      data: {
        fromId: newMemoryId,
        toId: targetId,
        type,
        confidence,
        metadata: {
          ...metadata,
          createdAt: new Date().toISOString()
        }
      }
    });

    // For Updates relationship, trigger state mutation
    if (type === 'Updates') {
      // Mark old memory as not latest
      await tx.memory.update({
        where: { id: targetId },
        data: {
          isLatest: false,
          updatedAt: new Date().toISOString()
        }
      });

      // Create version record for old memory
      await tx.memoryVersion.create({
        data: {
          memoryId: targetId,
          contentHash: await this._hashContent(
            (await tx.memory.findUnique({ where: { id: targetId } })).content
          ),
          isLatest: false,
          version: 1,
          reason: 'Updates',
          createdAt: new Date().toISOString()
        }
      });
    }

    return rel;
  }

  /**
   * Search with automatic latest filtering
   */
  async searchMemories(params) {
    const { query, userId, orgId, nResults = 10, filter = {}, includeVersions = false } = params;

    // Default: only return latest versions
    const where = {
      userId,
      orgId,
      isLatest: includeVersions ? undefined : true,
      ...this._buildSearchFilter(query, filter)
    };

    return await this.prisma.memory.findMany({
      where,
      take: nResults,
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get memory with version history
   */
  async getMemoryWithHistory(memoryId) {
    return await this.prisma.memory.findUnique({
      where: { id: memoryId },
      include: {
        versionHistory: {
          orderBy: { createdAt: 'desc' }
        },
        relationships: {
          include: {
            toMemory: true,
            fromMemory: true
          }
        }
      }
    });
  }

  /**
   * Get all versions of a memory
   */
  async getMemoryVersions(memoryId) {
    return await this.prisma.memoryVersion.findMany({
      where: { memoryId },
      orderBy: { createdAt: 'asc' }
    });
  }

  /**
   * Get latest version of memory by content hash
   */
  async getLatestByVersionHash(contentHash) {
    return await this.prisma.memory.findFirst({
      where: {
        contentHash,
        isLatest: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Resolve conflicts between memories
   */
  async resolveConflicts(params) {
    const { userId, orgId, contentHash } = params;

    // Find all memories with same content hash
    const conflicting = await this.prisma.memory.findMany({
      where: {
        userId,
        orgId,
        contentHash,
        isLatest: true
      }
    });

    if (conflicting.length <= 1) {
      return { conflicts: [], resolved: null };
    }

    // Resolve: keep most recent, mark others as not latest
    const sorted = conflicting.sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    const resolved = sorted[0]; // Keep most recent

    // Mark others as not latest
    await this.prisma.$transaction(
      sorted.slice(1).map(memory => 
        this.prisma.memory.update({
          where: { id: memory.id },
          data: { isLatest: false }
        })
      )
    );

    return { conflicts: sorted, resolved };
  }

  /**
   * Build search filter
   */
  _buildSearchFilter(query, filter) {
    const where = {};

    if (filter.project) {
      where.project = filter.project;
    }

    if (filter.memoryType) {
      where.memoryType = filter.memoryType;
    }

    if (filter.tags && filter.tags.length > 0) {
      where.tags = { hasSome: filter.tags };
    }

    if (query) {
      // Full-text search
      where.OR = [
        { content: { contains: query, mode: 'insensitive' } },
        { tags: { hasSome: [query] } }
      ];
    }

    return where;
  }

  /**
   * Simple content hash
   */
  async _hashContent(content) {
    const crypto = await import('crypto');
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Get memory stats with state awareness
   */
  async getStats(userId, orgId) {
    const total = await this.prisma.memory.count({
      where: { userId, orgId }
    });

    const active = await this.prisma.memory.count({
      where: { userId, orgId, isLatest: true }
    });

    const versions = await this.prisma.memoryVersion.count({
      where: {
        memory: {
          userId,
          orgId
        }
      }
    });

    const relationships = await this.prisma.relationship.count({
      where: {
        fromMemory: { userId, orgId }
      }
    });

    return {
      totalMemories: total,
      activeMemories: active,
      versionHistory: versions,
      relationships,
      latestRatio: total > 0 ? active / total : 1
    };
  }

  /**
   * Temporal query: get memories at specific time
   */
  async getMemoriesAtTime(params) {
    const { userId, orgId, timestamp, includeVersions = false } = params;

    const where = {
      userId,
      orgId,
      createdAt: { lte: timestamp },
      OR: [
        { isLatest: true },
        { isLatest: false, updatedAt: { gte: timestamp } }
      ]
    };

    return await this.prisma.memory.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });
  }
}

// Singleton
let statefulManager = null;
export function getStatefulManager(prisma) {
  if (!statefulManager) {
    statefulManager = new StatefulMemoryManager(prisma);
  }
  return statefulManager;
}
```

---

### Step 4: API Endpoints for Stateful Operations

**Effort:** 2 days  
**Dependencies:** Steps 1-3  
**Files:** `core/src/server.js` (extensions)

```javascript
// Add to server.js API routes

case '/api/memories/stateful/store':
  if (req.method === 'POST') {
    const manager = getStatefulManager(prisma);
    const memory = await manager.storeMemory({
      content: body.content,
      userId: body.userId || DEFAULT_USER,
      orgId: body.orgId || DEFAULT_ORG,
      project: body.project,
      tags: body.tags || [],
      relationship: body.relationship
    });
    jsonResponse(res, { success: true, memory });
  }
  break;

case '/api/memories/stateful/conflict':
  if (req.method === 'POST') {
    const manager = getStatefulManager(prisma);
    const result = await manager.resolveConflicts({
      userId: body.userId || DEFAULT_USER,
      orgId: body.orgId || DEFAULT_ORG,
      contentHash: body.contentHash
    });
    jsonResponse(res, result);
  }
  break;

case '/api/memories/stateful/history':
  if (req.method === 'POST') {
    const manager = getStatefulManager(prisma);
    const history = await manager.getMemoryWithHistory(body.memoryId);
    jsonResponse(res, history);
  }
  break;

case '/api/memories/stateful/versions':
  if (req.method === 'POST') {
    const manager = getStatefulManager(prisma);
    const versions = await manager.getMemoryVersions(body.memoryId);
    jsonResponse(res, { versions });
  }
  break;

case '/api/memories/stateful/stats':
  const manager = getStatefulManager(prisma);
  const stats = await manager.getStats(DEFAULT_USER, DEFAULT_ORG);
  jsonResponse(res, stats);
  break;
```

---

### Step 5: Conflict Resolution Strategy

**Effort:** 2 days  
**Dependencies:** Steps 1-4  
**Files:** `core/src/memory/conflict-resolver.js`

```javascript
/**
 * Conflict Resolution Strategy
 * Handles temporal inconsistencies and duplicate memories
 */

export class ConflictResolver {
  constructor() {
    this.resolutions = new Map();
  }

  /**
   * Detect conflicts between memories
   */
  detectConflicts(memories) {
    const conflicts = [];
    
    // Group by content hash
    const byHash = new Map();
    for (const memory of memories) {
      const hash = this._hashContent(memory.content);
      if (!byHash.has(hash)) {
        byHash.set(hash, []);
      }
      byHash.get(hash).push(memory);
    }

    // Find groups with multiple memories
    for (const [hash, group] of byHash) {
      if (group.length > 1) {
        conflicts.push({
          hash,
          memories: group,
          type: 'duplicate'
        });
      }
    }

    return conflicts;
  }

  /**
   * Resolve conflicts using strategy
   */
  resolveConflicts(conflicts, strategy = 'latest') {
    const resolved = [];

    for (const conflict of conflicts) {
      let resolution;

      switch (strategy) {
        case 'latest':
          resolution = this._resolveLatest(conflict);
          break;
        case 'highest-confidence':
          resolution = this._resolveHighestConfidence(conflict);
          break;
        case 'user-preference':
          resolution = this._resolveUserPreference(conflict);
          break;
        case 'merge':
          resolution = this._resolveMerge(conflict);
          break;
        default:
          resolution = this._resolveLatest(conflict);
      }

      resolved.push(resolution);
      this.resolutions.set(conflict.hash, resolution);
    }

    return resolved;
  }

  /**
   * Resolve by keeping most recent
   */
  _resolveLatest(conflict) {
    const sorted = [...conflict.memories].sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    return {
      type: 'latest',
      keep: sorted[0],
      discard: sorted.slice(1),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Resolve by confidence score
   */
  _resolveHighestConfidence(conflict) {
    const sorted = [...conflict.memories].sort((a, b) => 
      (b.confidence || 0) - (a.confidence || 0)
    );

    return {
      type: 'highest-confidence',
      keep: sorted[0],
      discard: sorted.slice(1),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Resolve by user preference (manual)
   */
  _resolveUserPreference(conflict) {
    // User selects which memory to keep
    return {
      type: 'user-preference',
      keep: null, // User selection
      discard: conflict.memories.slice(1),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Merge conflicting memories
   */
  _resolveMerge(conflict) {
    const mergedContent = this._mergeContent(conflict.memories);
    
    return {
      type: 'merge',
      merged: {
        content: mergedContent,
        sources: conflict.memories.map(m => m.id),
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Merge content from multiple memories
   */
  _mergeContent(memories) {
    // Simple concatenation with deduplication
    const contents = memories.map(m => m.content);
    const unique = [...new Set(contents)];
    
    return unique.join('\n\n---\n\n');
  }

  /**
   * Get resolution history
   */
  getResolutionHistory() {
    return Array.from(this.resolutions.entries()).map(([hash, resolution]) => ({
      hash,
      ...resolution
    }));
  }

  /**
   * Clear resolution history
   */
  clearHistory() {
    this.resolutions.clear();
  }

  /**
   * Hash content for conflict detection
   */
  _hashContent(content) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(content).digest('hex');
  }
}

// Singleton
let conflictResolver = null;
export function getConflictResolver() {
  if (!conflictResolver) {
    conflictResolver = new ConflictResolver();
  }
  return conflictResolver;
}
```

---

## Edge-Mutation Logic

### State Machine Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MEMORY STATE MACHINE                                     │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────┐
                    │   isLatest=true │
                    │   version=N     │
                    └────────┬────────┘
                             │
                             │ New "Updates" relationship
                             ▼
                    ┌─────────────────┐
                    │   isLatest=false│  ┌─────────────────┐
                    │   version=N     │  │   isLatest=true │
                    └─────────────────┘  │   version=N+1   │
                                         └────────┬────────┘
                                                  │
                                                  │ New "Extends" relationship
                                                  ▼
                                         ┌─────────────────┐
                                         │   isLatest=true │
                                         │   version=N+1   │
                                         └─────────────────┘
```

### Edge-Mutation Events

| Event | Trigger | Action |
|-------|---------|--------|
| `memory.created` | New memory stored | Set `isLatest = true`, `version = 1` |
| `memory.updated` | Updates relationship created | Set old `isLatest = false`, new `isLatest = true` |
| `memory.extended` | Extends relationship created | Keep both `isLatest = true` |
| `memory.derived` | Derives relationship created | Set `isLatest = true`, independent version |
| `memory.versioned` | Version history created | Track in `memory_versions` table |

---

## Testing Strategy

### Unit Tests

```javascript
// tests/stateful.test.js
import { describe, it, expect, beforeEach } from 'node:test';

describe('StatefulMemoryManager', () => {
  let manager;
  let prisma;

  beforeEach(() => {
    prisma = new PrismaClient();
    manager = getStatefulManager(prisma);
  });

  it('stores memory with automatic state mutation', async () => {
    // Create first memory
    const memory1 = await manager.storeMemory({
      content: 'User is a developer',
      userId: 'test-user',
      orgId: 'test-org'
    });

    // Create update relationship
    const memory2 = await manager.storeMemory({
      content: 'User is a senior developer',
      userId: 'test-user',
      orgId: 'test-org',
      relationship: {
        targetId: memory1.id,
        type: 'Updates'
      }
    });

    // Verify old memory is not latest
    const oldMemory = await prisma.memory.findUnique({ where: { id: memory1.id } });
    expect(oldMemory.isLatest).toBe(false);

    // Verify new memory is latest
    const newMemory = await prisma.memory.findUnique({ where: { id: memory2.id } });
    expect(newMemory.isLatest).toBe(true);
  });

  it('handles Extends relationship correctly', async () => {
    const memory1 = await manager.storeMemory({
      content: 'User is a developer',
      userId: 'test-user',
      orgId: 'test-org'
    });

    const memory2 = await manager.storeMemory({
      content: 'User knows TypeScript',
      userId: 'test-user',
      orgId: 'test-org',
      relationship: {
        targetId: memory1.id,
        type: 'Extends'
      }
    });

    // Both should be latest for Extends
    expect(memory1.isLatest).toBe(true);
    expect(memory2.isLatest).toBe(true);
  });

  it('resolves conflicts using latest strategy', async () => {
    const conflictResolver = getConflictResolver();
    
    const conflicts = conflictResolver.detectConflicts([
      { id: '1', content: 'Same content', createdAt: '2024-01-01' },
      { id: '2', content: 'Same content', createdAt: '2024-01-02' },
      { id: '3', content: 'Same content', createdAt: '2024-01-03' }
    ]);

    const resolution = conflictResolver.resolveConflicts(conflicts, 'latest');
    
    expect(resolution[0].keep.id).toBe('3');
    expect(resolution[0].discard.length).toBe(2);
  });
});
```

### Integration Tests

```javascript
// tests/integration/stateful.test.js
import { describe, it, expect } from 'node:test';

describe('Stateful Memory Integration', () => {
  it('end-to-end state mutation with Updates', async () => {
    // Store initial memory
    const res1 = await fetch('http://localhost:3000/api/memories/stateful/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Project status: Active',
        userId: 'test-user',
        orgId: 'test-org'
      })
    });

    const memory1 = await res1.json();

    // Update with new status
    const res2 = await fetch('http://localhost:3000/api/memories/stateful/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Project status: Completed',
        userId: 'test-user',
        orgId: 'test-org',
        relationship: {
          targetId: memory1.memory.id,
          type: 'Updates'
        }
      })
    });

    const memory2 = await res2.json();

    // Verify state mutation
    const oldMemory = await prisma.memory.findUnique({ where: { id: memory1.memory.id } });
    expect(oldMemory.isLatest).toBe(false);

    const newMemory = await prisma.memory.findUnique({ where: { id: memory2.memory.id } });
    expect(newMemory.isLatest).toBe(true);
  });

  it('retrieval only returns latest versions', async () => {
    // Store memories with Updates relationship
    await manager.storeMemory({ content: 'Old fact', userId, orgId });
    await manager.storeMemory({
      content: 'New fact',
      userId,
      orgId,
      relationship: { targetId: oldId, type: 'Updates' }
    });

    // Search should only return latest
    const results = await manager.searchMemories({ userId, orgId });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('New fact');
  });
});
```

---

## Dependencies

| Component | Dependency | Priority |
|-----------|-----------|----------|
| PostgreSQL | Apache AGE extension | P0 |
| Prisma Client | `@prisma/client` | P0 |
| Stateful Manager | `core/src/db/stateful.js` | P0 |
| Conflict Resolver | `core/src/memory/conflict-resolver.js` | P0 |
| Database Triggers | `core/prisma/migrations/` | P0 |

---

## Estimated Effort

| Task | Hours | Days |
|------|-------|------|
| Schema Enhancement | 8 | 1 |
| PostgreSQL Triggers | 12 | 1.5 |
| Prisma Extension | 12 | 1.5 |
| API Endpoints | 8 | 1 |
| Conflict Resolution | 8 | 1 |
| Testing | 12 | 1.5 |
| Documentation | 4 | 0.5 |
| **Total** | **64** | **8** |

---

## Success Criteria

- [ ] Automatic `isLatest` mutation on Updates relationship
- [ ] Database trigger latency <10ms
- [ ] All retrieval queries filter by `isLatest = true` by default
- [ ] Version history preserved for temporal reasoning
- [ ] Conflict resolution latency <100ms
- [ ] All tests passing (unit + integration)

---

## Rollout Plan

### Phase 1: Schema & Triggers (Week 1)
- Database schema updates
- PostgreSQL trigger creation
- Migration testing

### Phase 2: Prisma Extension (Week 2)
- Stateful manager implementation
- API endpoint creation
- Basic testing

### Phase 3: Conflict Resolution (Week 3)
- Conflict detection algorithms
- Resolution strategies
- Integration testing

### Phase 4: Production Deployment (Week 4)
- Performance optimization
- Monitoring setup
- Gradual rollout

---

## Monitoring & Observability

### Key Metrics

| Metric | Alert Threshold | Target |
|--------|----------------|--------|
| State Mutation Latency | >20ms | <10ms |
| Conflict Detection Rate | >5% of memories | <1% |
| Latest Ratio | <90% | >95% |
| Version History Size | >1000 per memory | <100 |

### Logging

```javascript
logger.info('stateful.mutation', {
  memoryId: newMemory.id,
  oldMemoryId: oldMemory.id,
  relationshipType: type,
  latencyMs: performance.now() - start
});

logger.warn('stateful.conflict', {
  conflictCount: conflicts.length,
  resolutionType: strategy,
  timestamp: new Date().toISOString()
});
```

---

## Future Enhancements

1. **Conflict Visualization**: UI for viewing and resolving conflicts
2. **Auto-Merge**: Intelligent merging of similar memories
3. **Temporal Queries**: Query memories at specific timestamps
4. **Version Diffing**: Show changes between versions
5. **Audit Trail**: Track all state mutations

---

## References

- Supermemory Stateful Memory: https://supermemory.ai/docs/concepts/stateful-memory/
- PostgreSQL Triggers: https://www.postgresql.org/docs/current/triggers.html
- Temporal Databases: https://en.wikipedia.org/wiki/Temporal_database
