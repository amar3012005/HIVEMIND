# Priority 2 - Memory Engine Correctness Implementation Plan

**Target:** Enterprise memory engine that goes beyond generic RAG
**Focus:** Memory behavior with state tracking, not just chunk search
**Created:** 2026-03-12

---

## Executive Summary

This plan transforms HIVE-MIND from a "passive search" model to an "active memory" model capable of handling enterprise complexity. The key differentiator is **reasoning over state and structure** rather than simple similarity matching.

### Current State Analysis

**What Exists:**
- ✅ Prisma schema with `Updates`, `Extends`, `Derives` relationship types
- ✅ `is_latest` and `supersedes_id` fields for versioning
- ✅ `StateMutator` class implementing triple-operator logic
- ✅ `ConflictResolver` with multiple strategies (latest, highest-confidence, merge, temporal-weighted)
- ✅ Basic version history tracking in memory
- ✅ AST chunker with scope chain, NWS density, signature extraction
- ✅ Temporal fields (`document_date`, `event_dates`) in schema
- ✅ Source tracking fields (`source_platform`, `source_session_id`, `source_message_id`)

**What's Missing (The Gap):**
- ❌ **Version history not persisted** - only tracked in-memory via `Map`
- ❌ **No record_time vs event_time distinction** - schema has fields but no enforcement
- ❌ **Source metadata not enforced at ingestion** - optional fields, no validation
- ❌ **AST metadata not stored with memories** - chunker exists but no integration
- ❌ **No golden-set tests** for relationship behavior validation
- ❌ **No schema validation layer** - Prisma types exist but no runtime enforcement
- ❌ **No evolutionary/temporal query patterns** - relationships exist but no specialized queries

---

## 1. Normalized Memory Schema (P0)

### 1.1 Current Schema Gaps

| Field | Current State | Required State |
|-------|---------------|----------------|
| `record_time` | ❌ Missing | ✅ System timestamp when memory was ingested |
| `event_time` | ⚠️ `document_date` exists | ✅ Explicit dual-timestamp design |
| `source_metadata` | ⚠️ Optional fields | ✅ Required structured JSONB |
| `version` | ⚠️ In-memory only | ✅ Persisted with history table |
| `ast_metadata` | ❌ Missing | ✅ For code memories |

### 1.2 Proposed Schema Extensions

```prisma
// Add to schema.prisma

/// Normalized source metadata (required for all memories)
model SourceMetadata {
  id              String   @id @default(uuid())
  memoryId        String   @unique @map("memory_id") @db.Uuid
  sourceType      String   @map("source_type")  // gmail, slack, github, claude_session, etc.
  sourceId        String   @map("source_id")    // Platform-specific ID
  ingestedAt      DateTime @default(now()) @map("ingested_at")  // record_time
  ingestedBy      String   @map("ingested_by")  // user_id or system
  
  // Context capture
  originalUrl     String?  @map("original_url") @db.Text
  threadId        String?  @map("thread_id")
  parentMessageId String?  @map("parent_message_id")
  
  // Permissions at source
  originalVisibility String? @map("original_visibility")
  
  // Raw payload snapshot (for audit/replay)
  rawPayloadHash  String?  @map("raw_payload_hash")
  rawPayloadSize  Int?     @map("raw_payload_size")
  
  memory Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)
  
  createdAt DateTime @default(now()) @map("created_at")
  
  @@index([memoryId])
  @@index([sourceType, sourceId])
  @@map("source_metadata")
}

/// Version history (persisted, not just in-memory)
model MemoryVersion {
  id          String   @id @default(uuid()) @db.Uuid
  memoryId    String   @map("memory_id") @db.Uuid
  version     Int      @map("version")
  content     String
  isLatest    Boolean  @default(false) @map("is_latest")
  
  // Change tracking
  changedFields String[] @default([]) @map("changed_fields")
  changeReason  String?  @map("change_reason")  // Updates, Extends, Derives, manual
  changedBy     String   @default("system") @map("changed_by")
  
  // Relationship that triggered this version
  relationshipType String? @map("relationship_type")
  relatedMemoryId  String? @map("related_memory_id") @db.Uuid
  
  // Snapshot metadata
  snapshotHash  String?  @map("snapshot_hash")
  snapshotSize  Int?     @map("snapshot_size")
  
  createdAt   DateTime @default(now()) @map("created_at")
  
  memory Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)
  
  @@unique([memoryId, version])
  @@index([memoryId, version])
  @@index([memoryId, isLatest])
  @@map("memory_versions")
}

/// AST/Scope metadata for code memories
model CodeMemoryMetadata {
  id            String   @id @default(uuid()) @db.Uuid
  memoryId      String   @unique @map("memory_id") @db.Uuid
  
  // File context
  filepath      String   @map("filepath")
  language      String   @map("language")  // javascript, typescript, python, etc.
  startLine     Int      @map("start_line")
  endLine       Int      @map("end_line")
  
  // AST structure
  entityType    String   @map("entity_type")  // Class, Method, Function, Interface, Module
  entityName    String?  @map("entity_name")
  scopeChain    String[] @default([]) @map("scope_chain")  // Full scope path
  signatures    String[] @default([]) @map("signatures")   // Function/class signatures
  
  // Dependencies
  imports       String[] @default([]) @map("imports")
  dependencies  String[] @default([]) @map("dependencies")  // Other entities this depends on
  dependents    String[] @default([]) @map("dependents")    // Entities that depend on this
  
  // Complexity metrics
  nwsCount      Int      @default(0) @map("nws_count")  // Non-whitespace characters
  cyclomaticComplexity Int? @map("cyclomatic_complexity")
  parameterCount Int?    @map("parameter_count")
  
  // Documentation
  hasDocstring  Boolean  @default(false) @map("has_docstring")
  docstringPreview String? @map("docstring_preview")
  
  memory Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)
  
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  
  @@index([memoryId])
  @@index([filepath])
  @@index([language])
  @@index([entityType])
  @@map("code_memory_metadata")
}
```

### 1.3 Validation Layer

**New file:** `core/src/memory/schema.validator.js`

```javascript
/**
 * Runtime schema validation for memory ingestion
 * Enforces required fields and data types beyond Prisma
 */

import { z } from 'zod';

export const MemoryIngestionSchema = z.object({
  // Core fields
  content: z.string().min(1).max(50000),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']),
  userId: z.string().uuid(),
  orgId: z.string().uuid().nullable(),
  project: z.string().max(255).optional(),
  
  // REQUIRED: Source metadata
  source: z.object({
    type: z.string().min(1),  // gmail, slack, github, claude_session, etc.
    id: z.string().min(1),    // Platform-specific ID
    ingestedBy: z.string().uuid(),
    originalUrl: z.string().url().optional(),
    threadId: z.string().optional(),
    parentMessageId: z.string().optional(),
    originalVisibility: z.enum(['private', 'channel', 'public']).optional(),
  }),
  
  // Temporal fields (dual-timestamp enforcement)
  temporal: z.object({
    recordTime: z.coerce.date(),  // When ingested (auto-set)
    eventTime: z.coerce.date().optional(),  // When event occurred
    documentDate: z.coerce.date().optional(),
  }),
  
  // Optional: Code metadata (required if source.type is codebase)
  codeMetadata: z.object({
    filepath: z.string(),
    language: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    entityType: z.enum(['Class', 'Method', 'Function', 'Interface', 'Module']),
    scopeChain: z.array(z.string()).default([]),
    imports: z.array(z.string()).default([]),
  }).optional(),
  
  // Optional: Relationship
  relationship: z.object({
    type: z.enum(['Updates', 'Extends', 'Derives']),
    targetId: z.string().uuid(),
  }).optional(),
  
  tags: z.array(z.string()).default([]),
  visibility: z.enum(['private', 'organization', 'public']).default('private'),
});

export function validateMemoryIngestion(input) {
  const result = MemoryIngestionSchema.safeParse(input);
  
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code,
      })),
    };
  }
  
  // Additional business logic validation
  const data = result.data;
  
  // If source is codebase, codeMetadata is required
  if (data.source.type === 'codebase' && !data.codeMetadata) {
    return {
      valid: false,
      errors: [{
        field: 'codeMetadata',
        message: 'Code metadata is required for codebase source type',
        code: 'required',
      }],
    };
  }
  
  return { valid: true, data };
}
```

---

## 2. Triple-Operator Behavior (P0)

### 2.1 Current Implementation Status

| Operator | Implementation | Tests | Production Ready |
|----------|----------------|-------|------------------|
| `Updates` | ✅ `StateMutator._applyUpdate()` | ✅ Basic tests | ⚠️ Needs DB persistence |
| `Extends` | ✅ `StateMutator._applyExtend()` | ✅ Basic tests | ⚠️ Needs DB persistence |
| `Derives` | ✅ `StateMutator._applyDerive()` | ✅ Basic tests | ⚠️ Needs DB persistence |

### 2.2 Golden-Set Test Suite

**New file:** `core/tests/memory/relationship-behavior.golden.test.js`

```javascript
/**
 * Golden-set tests for Updates/Extends/Derives behavior
 * These tests define the EXPECTED behavior and must never change
 */

import { describe, it, beforeEach } from 'node:test';
import { MemoryEngine } from '../../src/engine.local.js';
import assert from 'node:assert';

describe('Golden Set: Relationship Behavior', () => {
  let engine;
  
  beforeEach(() => {
    engine = new MemoryEngine();
  });
  
  describe('Updates Operator', () => {
    it('GOLDEN: Old memory becomes is_latest=false', () => {
      // Setup
      const mem1 = engine.storeMemory({
        content: 'Server runs on port 3000',
        user_id: 'user-1',
        org_id: 'org-1',
      });
      
      // Execute Update
      const mem2 = engine.storeMemory({
        content: 'Server runs on port 3001',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          type: 'Updates',
          target_id: mem1.memory.id,
        },
      });
      
      // Golden expectation: mem1 is no longer latest
      const updatedMem1 = engine.memories.get(mem1.memory.id);
      assert.strictEqual(updatedMem1.is_latest, false, 
        'Updated memory must have is_latest=false');
      
      // Golden expectation: mem2 is latest
      assert.strictEqual(mem2.memory.is_latest, true,
        'Updating memory must have is_latest=true');
    });
    
    it('GOLDEN: Version increments for both memories', () => {
      // ... version tracking test
    });
    
    it('GOLDEN: Version history is queryable', () => {
      // ... history query test
    });
  });
  
  describe('Extends Operator', () => {
    it('GOLDEN: Both memories remain is_latest=true', () => {
      // Setup
      const mem1 = engine.storeMemory({
        content: 'Use PostgreSQL for storage',
        user_id: 'user-1',
        org_id: 'org-1',
      });
      
      // Execute Extend
      const mem2 = engine.storeMemory({
        content: 'Use PostgreSQL with Apache AGE extension for graph queries',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          type: 'Extends',
          target_id: mem1.memory.id,
        },
      });
      
      // Golden expectation: BOTH remain latest
      const extendedMem1 = engine.memories.get(mem1.memory.id);
      assert.strictEqual(extendedMem1.is_latest, true,
        'Extended memory must remain is_latest=true');
      assert.strictEqual(mem2.memory.is_latest, true,
        'Extending memory must have is_latest=true');
    });
    
    it('GOLDEN: Extends creates clarification chain', () => {
      // ... test that Extends allows retrieval of refinements
    });
  });
  
  describe('Derives Operator', () => {
    it('GOLDEN: Derived memory is independent but linked', () => {
      // Setup
      const mem1 = engine.storeMemory({
        content: 'Team has 5 developers',
        user_id: 'user-1',
        org_id: 'org-1',
      });
      
      // Execute Derive
      const mem2 = engine.storeMemory({
        content: 'Team can complete 20 story points per sprint',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          type: 'Derives',
          target_id: mem1.memory.id,
        },
      });
      
      // Golden expectation: mem1 unchanged
      const derivedMem1 = engine.memories.get(mem1.memory.id);
      assert.strictEqual(derivedMem1.is_latest, true,
        'Source memory unchanged by Derives');
      
      // Golden expectation: mem2 is latest (independent fact)
      assert.strictEqual(mem2.memory.is_latest, true,
        'Derived memory is independent latest fact');
    });
    
    it('GOLDEN: Derives enables inference traversal', () => {
      // ... test graph traversal through Derives relationships
    });
  });
  
  describe('Cross-Operator Behavior', () => {
    it('GOLDEN: Updates after Extends maintains correct state', () => {
      // Complex scenario: A extends B, then C updates A
      // Verify state consistency
    });
    
    it('GOLDEN: Derives chain preserves source independence', () => {
      // A derives from B, C derives from A
      // Verify B unchanged, A unchanged, C is latest
    });
  });
});
```

### 2.3 Enhanced State Mutator (DB Persistence)

**New file:** `core/src/stateful/persister.js`

```javascript
/**
 * Persists version history to database (not just in-memory)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class VersionPersister {
  /**
   * Persist version snapshot when mutation occurs
   */
  async persistVersion(mutation, memory) {
    const versionData = {
      memoryId: memory.id,
      version: memory.version || 1,
      content: memory.content,
      isLatest: memory.is_latest,
      changedFields: this._extractChangedFields(mutation),
      changeReason: this._getChangeReason(mutation),
      changedBy: 'system',  // Or from context
      relationshipType: mutation.type,
      relatedMemoryId: mutation.type === 'Updates' ? mutation.oldMemoryId : null,
      snapshotHash: await this._hashContent(memory.content),
      snapshotSize: memory.content.length,
    };
    
    return prisma.memoryVersion.create({
      data: versionData,
    });
  }
  
  /**
   * Get full version history for a memory
   */
  async getVersionHistory(memoryId) {
    return prisma.memoryVersion.findMany({
      where: { memoryId },
      orderBy: { version: 'asc' },
    });
  }
  
  /**
   * Get version diff between two versions
   */
  async getVersionDiff(memoryId, fromVersion, toVersion) {
    const [from, to] = await Promise.all([
      prisma.memoryVersion.findUnique({
        where: { memoryId_version: { memoryId, version: fromVersion } },
      }),
      prisma.memoryVersion.findUnique({
        where: { memoryId_version: { memoryId, version: toVersion } },
      }),
    ]);
    
    return {
      from: from.content,
      to: to.content,
      changedFields: to.changedFields,
    };
  }
  
  _extractChangedFields(mutation) {
    return mutation.changes.map(c => c.field);
  }
  
  _getChangeReason(mutation) {
    return `${mutation.type} relationship applied`;
  }
  
  async _hashContent(content) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
```

---

## 3. Version History Preservation (P0)

### 3.1 Implementation Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    Version History Flow                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Memory Update Request                                    │
│         ↓                                                    │
│  2. StateMutator.applyMutation()                             │
│         ↓                                                    │
│  3. [NEW] VersionPersister.persistVersion()                  │
│         ↓                                                    │
│  4. Create MemoryVersion record                              │
│         ↓                                                    │
│  5. Update Memory.is_latest, Memory.version                  │
│         ↓                                                    │
│  6. Return mutation result                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 State Mutation Tests

**New file:** `core/tests/memory/state-mutation.test.js`

```javascript
describe('State Mutation Tests', () => {
  it('preserves version history in database', async () => {
    // Create memory
    const mem1 = await memoryService.create({...});
    
    // Update it
    const mem2 = await memoryService.create({
      ...
      relationship: { type: 'Updates', target_id: mem1.id }
    });
    
    // Query version history
    const history = await memoryService.getVersionHistory(mem1.id);
    
    assert.strictEqual(history.length, 2);  // Original + Update
    assert.strictEqual(history[0].version, 1);
    assert.strictEqual(history[1].version, 2);
  });
});
```

---

## 4. Temporal Fields: Record Time vs Event Time (P1)

### 4.1 Dual-Timestamp Design

| Field | Purpose | Example |
|-------|---------|---------|
| `record_time` | When memory was ingested | `2026-03-12T10:30:00Z` (now) |
| `event_time` | When the event occurred | `2026-03-05T14:00:00Z` (client meeting) |

### 4.2 Implementation

**Update:** `core/src/memory/ingest.service.js` (new file)

```javascript
export class MemoryIngestService {
  /**
   * Ingest memory with proper temporal handling
   */
  async ingest(memoryData, context) {
    // Validate schema
    const validation = validateMemoryIngestion(memoryData);
    if (!validation.valid) {
      throw new IngestionError(validation.errors);
    }
    
    const { source, temporal, ...memoryCore } = validation.data;
    
    // Separate record_time (auto) from event_time (from data)
    const recordTime = new Date();  // Always now
    const eventTime = temporal.eventTime || temporal.documentDate || recordTime;
    
    // Create memory with dual timestamps
    const memory = await prisma.memory.create({
      data: {
        ...memoryCore,
        document_date: eventTime,  // When event occurred
        created_at: recordTime,    // When ingested
        // ... other fields
      },
    });
    
    // Create source metadata
    await prisma.sourceMetadata.create({
      data: {
        memoryId: memory.id,
        sourceType: source.type,
        sourceId: source.id,
        ingestedAt: recordTime,
        ingestedBy: source.ingestedBy,
        originalUrl: source.originalUrl,
        threadId: source.threadId,
        // ...
      },
    });
    
    return memory;
  }
  
  /**
   * Query by event time (not record time)
   */
  async findByEventTimeRange(orgId, startTime, endTime) {
    return prisma.memory.findMany({
      where: {
        orgId,
        document_date: {
          gte: startTime,
          lte: endTime,
        },
      },
      include: {
        sourceMetadata: true,
      },
      orderBy: {
        document_date: 'asc',
      },
    });
  }
}
```

### 4.3 Test: Event vs Record Time

```javascript
it('distinguishes event time from record time', async () => {
  // Back-date an event (meeting was last week, ingested now)
  const eventTime = new Date('2026-03-05T14:00:00Z');
  
  const memory = await ingestService.ingest({
    content: 'Client approved budget',
    temporal: {
      eventTime: eventTime,
    },
    source: { ... },
  });
  
  // Record time is now
  assert.ok(memory.created_at > new Date('2026-03-11'));
  
  // Event time is preserved
  assert.strictEqual(memory.document_date.toISOString(), '2026-03-05T14:00:00Z');
  
  // Query by event time finds it
  const found = await ingestService.findByEventTimeRange(
    'org-1',
    new Date('2026-03-05'),
    new Date('2026-03-06')
  );
  assert.strictEqual(found.length, 1);
});
```

---

## 5. Source Metadata Enforcement (P0)

### 5.1 Required Source Metadata

Every memory MUST have:
- `source.type` - Platform identifier (gmail, slack, github, claude_session, etc.)
- `source.id` - Platform-specific unique ID
- `source.ingestedBy` - User or system that ingested
- `source.ingestedAt` - Timestamp (auto-set)

### 5.2 Ingestion Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                  Source Metadata Capture                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Gmail Connector                                             │
│    → Extract: thread_id, message_id, labels, sender         │
│    → Store: SourceMetadata record                           │
│                                                              │
│  Codebase Connector                                          │
│    → Extract: filepath, commit_hash, author, language       │
│    → Store: SourceMetadata + CodeMemoryMetadata             │
│                                                              │
│  Claude Session Connector                                    │
│    → Extract: session_id, message_id, platform              │
│    → Store: SourceMetadata record                           │
│                                                              │
│  Manual API Ingestion                                        │
│    → Require: source.type, source.id in payload             │
│    → Validate: Schema enforcement                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. AST/Scope Metadata for Code (P1)

### 6.1 Integration: Chunker → Memory Service

**Update:** `core/src/chunking/code.ingest.service.js` (new file)

```javascript
import { SyntaxChunker } from '../chunker.ast.js';

export class CodeIngestService {
  constructor() {
    this.chunker = new SyntaxChunker();
  }
  
  /**
   * Ingest code file with AST metadata preservation
   */
  async ingestCodeFile(filepath, content, context) {
    // Parse and chunk with AST awareness
    const chunks = this.chunker.chunk(content, this._detectLanguage(filepath));
    
    const memories = [];
    
    for (const chunk of chunks) {
      // Create memory with code metadata
      const memory = await prisma.memory.create({
        data: {
          content: chunk.text,
          memoryType: 'fact',
          userId: context.userId,
          orgId: context.orgId,
          sourcePlatform: 'codebase',
          // ... other fields
        },
      });
      
      // Attach AST metadata
      await prisma.codeMemoryMetadata.create({
        data: {
          memoryId: memory.id,
          filepath: filepath,
          language: chunk.language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          entityType: chunk.entityType || 'Module',
          entityName: chunk.entityName,
          scopeChain: chunk.scopeChain || [],
          signatures: chunk.signatures || [],
          imports: chunk.imports || [],
          nwsCount: chunk.nwsDensity || 0,
          hasDocstring: chunk.docstrings?.length > 0,
          docstringPreview: chunk.docstrings?.[0]?.slice(0, 200),
        },
      });
      
      memories.push(memory);
    }
    
    return memories;
  }
  
  /**
   * Structural query: Find implementation of X
   */
  async findStructuralImplementation(orgId, entityType, entityName) {
    return prisma.codeMemoryMetadata.findMany({
      where: {
        memory: {
          orgId,
          deletedAt: null,
        },
        entityType,
        entityName,
      },
      include: {
        memory: true,
      },
    });
  }
  
  /**
   * Impact analysis: What depends on X?
   */
  async findDependents(filepath, entityName) {
    // Find all code memories that import this entity
    return prisma.codeMemoryMetadata.findMany({
      where: {
        memory: {
          orgId,
          deletedAt: null,
        },
        imports: {
          has: entityName,
        },
      },
      include: {
        memory: true,
      },
    });
  }
  
  _detectLanguage(filepath) {
    const ext = filepath.split('.').pop();
    const langMap = {
      js: 'javascript',
      ts: 'typescript',
      py: 'python',
      // ...
    };
    return langMap[ext] || 'plaintext';
  }
}
```

### 6.2 Test: AST Metadata Preservation

```javascript
describe('Code Ingestion with AST Metadata', () => {
  it('preserves scope chain for functions', async () => {
    const code = `
      class AuthService {
        async validateToken(token) {
          // ... implementation
        }
      }
    `;
    
    const memories = await codeIngestService.ingestCodeFile(
      'src/auth.service.js',
      code,
      { userId: 'user-1', orgId: 'org-1' }
    );
    
    const funcMemory = memories.find(m => 
      m.codeMetadata?.entityType === 'Method'
    );
    
    assert.ok(funcMemory);
    assert.ok(funcMemory.codeMetadata.scopeChain.includes('AuthService'));
    assert.strictEqual(funcMemory.codeMetadata.entityName, 'validateToken');
  });
  
  it('supports impact analysis queries', async () => {
    // Ingest file A that exports X
    // Ingest file B that imports X
    // Query: What depends on X?
    const dependents = await codeIngestService.findDependents(
      'src/auth.service.js',
      'validateToken'
    );
    
    assert.ok(dependents.length > 0);
    assert.ok(dependents[0].codeMetadata.imports.includes('validateToken'));
  });
});
```

---

## 7. Implementation Timeline

### Week 1: Schema & Validation (P0)

| Day | Task | Owner | Deliverable |
|-----|------|-------|-------------|
| 1-2 | Add Prisma models (SourceMetadata, MemoryVersion, CodeMemoryMetadata) | Backend Lead | Schema migration |
| 3 | Implement schema validation layer | Backend Lead | `schema.validator.js` |
| 4-5 | Update ingestion endpoints to enforce source metadata | Backend Lead | All memories have source |

### Week 2: Version History Persistence (P0)

| Day | Task | Owner | Deliverable |
|-----|------|-------|-------------|
| 1-2 | Implement `VersionPersister` class | Backend Lead | DB persistence |
| 3-4 | Integrate with `StateMutator` | Backend Lead | Auto-versioning on mutation |
| 5 | Write golden-set tests for relationships | ML Engineer | Test suite passing |

### Week 3: Temporal Fields & AST Metadata (P1)

| Day | Task | Owner | Deliverable |
|-----|------|-------|-------------|
| 1-2 | Implement dual-timestamp ingestion | Backend Lead | `record_time` vs `event_time` |
| 3-4 | Integrate AST chunker with memory service | ML Engineer | Code metadata stored |
| 5 | Write impact analysis queries | ML Engineer | Structural queries working |

### Week 4: Query Patterns & Testing (P0/P1)

| Day | Task | Owner | Deliverable |
|-----|------|-------|-------------|
| 1-2 | Implement evolutionary queries (State-of-the-Union) | Backend Lead | Version traversal API |
| 3 | Implement structural queries (Where-Used) | ML Engineer | AST-based retrieval |
| 4-5 | Full integration testing | QA Lead | All tests passing |

---

## 8. Test Evidence Requirements

### 8.1 Schema Validation Tests

```javascript
// File: core/tests/memory/schema-validation.test.js

describe('Schema Validation', () => {
  it('rejects memory without source metadata', () => {
    const invalid = {
      content: 'Test',
      user_id: 'user-1',
      org_id: 'org-1',
      // Missing: source
    };
    
    const result = validateMemoryIngestion(invalid);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.field === 'source'));
  });
  
  it('requires code metadata for codebase source', () => {
    const invalid = {
      content: 'function test() {}',
      source: { type: 'codebase', id: 'file-1', ingestedBy: 'user-1' },
      // Missing: codeMetadata
    };
    
    const result = validateMemoryIngestion(invalid);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.field === 'codeMetadata'));
  });
});
```

### 8.2 State Mutation Tests

```javascript
// File: core/tests/memory/state-mutation.test.js

describe('State Mutation', () => {
  it('preserves version history across Updates', async () => {
    // Create → Update → Query history
    // Verify: history.length === 2
  });
  
  it('maintains is_latest consistency', async () => {
    // Create → Update → Extend → Derive
    // Verify: correct is_latest states
  });
});
```

### 8.3 Golden-Set Tests

```javascript
// File: core/tests/memory/relationship-behavior.golden.test.js
// (See section 2.2 for full examples)
```

---

## 9. Success Criteria

| Item | Pass/Fail | Evidence Required |
|------|-----------|-------------------|
| Normalized memory schema is defined and enforced | ⬜ | Prisma schema + validation tests |
| `Updates`, `Extends`, `Derives` behavior works as designed | ⬜ | Golden-set tests passing |
| Version history is preserved for changed facts | ⬜ | State mutation tests + DB records |
| Temporal fields distinguish record time vs event time | ⬜ | API examples + query tests |
| Source metadata is attached to every ingested memory | ⬜ | Sample memories with full metadata |
| Code ingestion preserves AST/scope metadata | ⬜ | Code ingestion test set |

---

## Appendix A: Search Pattern Implementation

### A.1 Chronological Audit (Version History + Event Time)

```javascript
async function getStateOfUnion(orgId, projectId) {
  // Get latest memories
  const latest = await prisma.memory.findMany({
    where: { orgId, project: projectId, is_latest: true },
  });
  
  // For each, traverse Updates chain
  const histories = await Promise.all(
    latest.map(mem => prisma.memoryVersion.findMany({
      where: { memoryId: mem.id },
      orderBy: { version: 'asc' },
    }))
  );
  
  return {
    current: latest,
    evolution: histories,
  };
}
```

### A.2 Logical Scoping (AST Metadata)

```javascript
async function findImplementation(entityType, entityName) {
  return prisma.codeMemoryMetadata.findMany({
    where: { entityType, entityName },
    include: { memory: true },
  });
}
```

### A.3 Relational Synthesis (Updates/Extends/Derives)

```javascript
async function findRefinements(memoryId) {
  // Find all Extends relationships
  return prisma.relationship.findMany({
    where: { toId: memoryId, type: 'Extends' },
    include: { fromMemory: true },
  });
}
```

### A.4 Source Provenance

```javascript
async function getSourceEvidence(memoryId) {
  const memory = await prisma.memory.findUnique({
    where: { id: memoryId },
    include: { sourceMetadata: true },
  });
  
  return {
    sourceType: memory.sourceMetadata.sourceType,
    sourceId: memory.sourceMetadata.sourceId,
    ingestedAt: memory.sourceMetadata.ingestedAt,
    originalUrl: memory.sourceMetadata.originalUrl,
  };
}
```

---

**Next Steps:**
1. Review and approve this plan
2. Create implementation tasks in project tracker
3. Begin Week 1: Schema & Validation
