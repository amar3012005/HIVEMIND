# Trail Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stateless, concurrent-safe execution runtime that turns stored reasoning trails into actionable behavior, with clean separation between canonical memory (kg/*), operational cognition (op/*), and learning signals (meta/*).

**Architecture:** Three-phase rollout starting with foundation components (TrailSelector, ActionBinder, ToolRunner, OutcomeWriter), then learning infrastructure (LeaseManager, WeightUpdater, PromotionMux), then production hardening (observability, error recovery, safety). Each phase produces working, independently testable software.

**Tech Stack:** Node.js/TypeScript, Prisma ORM (Postgres), Qdrant (vector search), Jest (tests), basic observability (pino logging + Prometheus metrics).

---

## File Structure

### Core Executor Services
```
core/src/executor/
├── trail-selector.ts       # Select best trail from op/* by weight + agent rep
├── action-binder.ts        # Resolve params from working memory + kg/*
├── tool-runner.ts          # Execute tool with safety guards (budget, timeout)
├── outcome-writer.ts       # Write execution events to op/execution_events
├── weight-updater.ts       # Multi-signal weight calculation
├── lease-manager.ts        # Prevent concurrent execution of same trail
├── promotion-mux.ts        # Emit promotion candidates asynchronously
├── execution-loop.ts       # Main executor loop orchestrating all components
└── tool-registry.ts        # Strict tool definitions + validation

tests/executor/
├── trail-selector.test.ts
├── action-binder.test.ts
├── tool-runner.test.ts
├── outcome-writer.test.ts
├── weight-updater.test.ts
├── lease-manager.test.ts
├── promotion-mux.test.ts
├── execution-loop.integration.test.ts
└── fixtures/               # Mock data, test trails, sample events
```

### Schema & Types
```
core/src/types/
├── executor.types.ts       # All TypeScript interfaces
├── graph.types.ts          # Extend existing for kg/op/meta namespaces
└── metrics.types.ts        # Observability types

core/src/db/
├── prisma/schema.prisma    # Schema migrations for op/*, meta/*
└── migrations/
    └── 20260327_add_trail_executor_schema.sql
```

### API Endpoints
```
core/src/api/
└── routes/
    └── executor.routes.ts   # POST /api/swarm/execute, GET /api/executor/status
```

### Observability
```
core/src/observability/
├── metrics.ts              # Prometheus metrics (trail success, duplication, latency)
└── logging.ts              # Structured logging (pino)
```

---

## Phase 1A: Foundation (TrailSelector, ActionBinder, ToolRunner, OutcomeWriter)

### Task 1A.1: Define TypeScript Interfaces

**Files:**
- Create: `core/src/types/executor.types.ts`

**Steps:**

- [ ] **Step 1: Write failing test for Trail interface**

```typescript
// tests/executor/trail-selector.test.ts
import { Trail, ExecutionEvent } from '../../../src/types/executor.types'

describe('Trail interface', () => {
  it('should enforce Trail type', () => {
    const trail: Trail = {
      id: 'trail_123',
      goal_id: 'goal_456',
      agent_id: 'agent_789',
      steps: [{ action_name: 'api_call', status: 'success', result_summary: 'OK' }],
      execution_event_ids: [],
      success_score: 0.85,
      confidence: 0.82,
      weight: 0.78,
      decay_rate: 0.05,
      created_at: new Date(),
      last_executed_at: undefined
    }
    expect(trail.id).toBe('trail_123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && npm test -- tests/executor/trail-selector.test.ts
# Expected: FAIL - "Cannot find module '../../../src/types/executor.types'"
```

- [ ] **Step 3: Create executor.types.ts with all interfaces**

```typescript
// core/src/types/executor.types.ts

export interface TrailStep {
  action_name: string
  status: 'success' | 'failed' | 'pending'
  result_summary: string
}

export interface Trail {
  id: string
  goal_id: string
  agent_id: string
  steps: TrailStep[]
  execution_event_ids: string[]
  success_score: number
  confidence: number
  weight: number
  decay_rate: number
  created_at: Date
  last_executed_at?: Date
}

export interface ExecutionEvent {
  id: string
  trail_id: string
  agent_id: string
  step_index: number
  action_name: string
  bound_params: Record<string, unknown>
  tool_used: string
  result?: unknown
  error?: string
  latency_ms: number
  success: boolean
  confidence_delta: number
  timestamp: Date
}

export interface BoundAction {
  tool: string
  params: Record<string, unknown>
  schema_version: string
}

export interface ToolResult {
  result?: unknown
  error?: string
  latency_ms: number
  timestamp: Date
}

export interface ExecutionConfig {
  maxSteps: number
  lease_ttl_seconds: number
  promotionThreshold: number
  promotionRule: string
  budget: ExecutionBudget
}

export interface ExecutionBudget {
  max_tokens: number
  timeout_ms: number
  max_retries: number
}

export interface ExecutionResult {
  goal: string
  agentId: string
  steps_executed: number
  events_logged: number
  final_state: WorkingMemorySnapshot
  trails_updated: string[]
  observations_to_promote: string[]
  next_recommended_goal?: string
}

export interface WorkingMemorySnapshot {
  context: Record<string, unknown>
  observations: unknown[]
  failures_count: number
}

export interface Lease {
  id: string
  trail_id: string
  agent_id: string
  lease_expiry_at: Date
  created_at: Date
  heartbeat_at: Date
}

export interface PromotionCandidate {
  id: string
  source_event_id: string
  promotion_rule_id: string
  consensus_score: number
  status: 'pending' | 'approved' | 'rejected' | 'deferred'
  created_at: Date
  decided_at?: Date
  idempotency_key: string // (source_event_id, promotion_rule_id, target_fact_kind)
}

export interface TrailWeight {
  trail_id: string
  weight: number
  components: {
    base_confidence: number
    failure_penalty: number
    agent_reputation_boost: number
    novelty_discount: number
    downstream_success_factor: number
  }
  updated_at: Date
  next_decay_at: Date
}

export interface AgentReputation {
  agent_id: string
  success_rate: number
  avg_confidence: number
  skill_scores: Record<string, number>
  recent_attempts: number
  updated_at: Date
}

export interface ToolDefinition {
  name: string
  description: string
  params: Record<string, { type: string; required: boolean; description: string }>
  requires_permission?: string[]
  max_tokens?: number
  timeout_ms?: number
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd core && npm test -- tests/executor/trail-selector.test.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add core/src/types/executor.types.ts tests/executor/trail-selector.test.ts
git commit -m "feat: add Trail Executor TypeScript interfaces"
```

---

### Task 1A.2: Create Prisma Schema Extensions (op/*, meta/*)

**Files:**
- Modify: `core/prisma/schema.prisma`
- Create: `core/prisma/migrations/20260327_add_trail_executor_schema.sql`

**Steps:**

- [ ] **Step 1: Write test expecting new schema tables**

```typescript
// tests/executor/outcome-writer.test.ts
import { prisma } from '../../../src/db/client'

describe('ExecutionEvent storage', () => {
  it('should create and retrieve execution event', async () => {
    const event = await prisma.executionEvent.create({
      data: {
        id: 'event_123',
        trail_id: 'trail_456',
        agent_id: 'agent_789',
        step_index: 0,
        action_name: 'call_api',
        bound_params: { url: 'https://example.com' },
        tool_used: 'http_client',
        result: { status: 200 },
        error: null,
        latency_ms: 145,
        success: true,
        confidence_delta: 0.05,
        timestamp: new Date()
      }
    })
    expect(event.id).toBe('event_123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && npm test -- tests/executor/outcome-writer.test.ts
# Expected: FAIL - "ExecutionEvent is not defined on PrismaClient"
```

- [ ] **Step 3: Add schema models to schema.prisma**

```prisma
// core/prisma/schema.prisma - append to existing file

// ========== OPERATIONAL COGNITION (op/*) ==========

model OpAgent {
  id                String   @id @default(uuid())
  agent_id          String   @unique
  role              String
  model_version     String
  skills            String[] // JSON array of skill names
  status            String   @default("active") // active, idle, error
  created_at        DateTime @default(now())
  updated_at        DateTime @updatedAt

  @@map("op_agents")
}

model OpGoal {
  id                String   @id @default(uuid())
  goal_text         String
  context           Json     @default("{}")
  priority          Int      @default(0)
  agent_id          String
  parent_goal_id    String?
  status            String   @default("open") // open, in_progress, resolved
  created_at        DateTime @default(now())
  updated_at        DateTime @updatedAt

  @@map("op_goals")
}

model OpTrail {
  id                String   @id @default(uuid())
  goal_id           String
  agent_id          String
  steps             Json     @default("[]") // Array of { action_name, status, result_summary }
  execution_event_ids String[] @default([]) // Links to canonical events
  success_score     Float    @default(0)
  confidence        Float    @default(0)
  weight            Float    @default(0.5)
  decay_rate        Float    @default(0.05)
  created_at        DateTime @default(now())
  last_executed_at  DateTime?
  updated_at        DateTime @updatedAt

  @@index([goal_id])
  @@index([agent_id])
  @@index([weight])
  @@map("op_trails")
}

model ExecutionEvent {
  id                String   @id @default(uuid())
  trail_id          String
  agent_id          String
  step_index        Int
  action_name       String
  bound_params      Json     @default("{}")
  tool_used         String
  result            Json?
  error             String?
  latency_ms        Int
  success           Boolean
  confidence_delta  Float    @default(0)
  timestamp         DateTime @default(now())
  created_at        DateTime @default(now())

  @@index([trail_id])
  @@index([agent_id])
  @@index([created_at])
  @@map("op_execution_events")
}

model OpTrailLease {
  id                String   @id @default(uuid())
  trail_id          String   @unique
  agent_id          String
  lease_expiry_at   DateTime
  created_at        DateTime @default(now())
  heartbeat_at      DateTime @default(now())

  @@index([trail_id])
  @@index([lease_expiry_at])
  @@map("op_trail_leases")
}

model OpObservation {
  id                String   @id @default(uuid())
  agent_id          String
  what_observed     String
  context           Json     @default("{}")
  certainty         Float    @default(0.5)
  related_to_trial  String?
  timestamp         DateTime @default(now())

  @@index([agent_id])
  @@map("op_observations")
}

// ========== CONTROL & LEARNING (meta/*) ==========

model MetaEvaluation {
  id                String   @id @default(uuid())
  trail_id          String
  evaluator_id      String
  correctness_score Float
  efficiency_score  Float
  reasoning         String
  confidence        Float
  timestamp         DateTime @default(now())

  @@index([trail_id])
  @@index([evaluator_id])
  @@map("meta_evaluations")
}

model MetaTrailWeight {
  trail_id          String   @id @unique
  weight            Float
  components        Json     // { base_confidence, failure_penalty, agent_reputation_boost, novelty_discount, downstream_success_factor }
  updated_at        DateTime @updatedAt
  next_decay_at     DateTime

  @@map("meta_trail_weights")
}

model MetaReputation {
  agent_id          String   @id @unique
  success_rate      Float
  avg_confidence    Float
  skill_scores      Json     @default("{}")
  recent_attempts   Int      @default(0)
  updated_at        DateTime @updatedAt

  @@map("meta_reputation")
}

model MetaPromotionCandidate {
  id                String   @id @default(uuid())
  source_event_id   String
  promotion_rule_id String
  consensus_score   Float
  status            String   @default("pending") // pending, approved, rejected, deferred
  created_at        DateTime @default(now())
  decided_at        DateTime?
  idempotency_key   String   @unique // (source_event_id, promotion_rule_id, target_fact_kind)

  @@index([status])
  @@index([created_at])
  @@map("meta_promotion_candidates")
}

model MetaDecaySchedule {
  id                String   @id @default(uuid())
  target_type       String   // trail, observation
  half_life_days    Int
  min_weight        Float
  applies_to        Json     // { namespace, kind }
  created_at        DateTime @default(now())

  @@map("meta_decay_schedules")
}
```

- [ ] **Step 4: Create migration file**

```sql
-- core/prisma/migrations/20260327_add_trail_executor_schema/migration.sql

-- Operational Cognition Layer (op/*)
CREATE TABLE "op_agents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agent_id" TEXT NOT NULL UNIQUE,
  "role" TEXT NOT NULL,
  "model_version" TEXT NOT NULL,
  "skills" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "op_goals" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "goal_text" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '{}',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "agent_id" TEXT NOT NULL,
  "parent_goal_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "op_trails" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "goal_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "steps" TEXT NOT NULL DEFAULT '[]',
  "execution_event_ids" TEXT NOT NULL DEFAULT '[]',
  "success_score" REAL NOT NULL DEFAULT 0,
  "confidence" REAL NOT NULL DEFAULT 0,
  "weight" REAL NOT NULL DEFAULT 0.5,
  "decay_rate" REAL NOT NULL DEFAULT 0.05,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_executed_at" DATETIME,
  "updated_at" DATETIME NOT NULL
);

CREATE INDEX "op_trails_goal_id_idx" ON "op_trails"("goal_id");
CREATE INDEX "op_trails_agent_id_idx" ON "op_trails"("agent_id");
CREATE INDEX "op_trails_weight_idx" ON "op_trails"("weight");

CREATE TABLE "op_execution_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "trail_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "step_index" INTEGER NOT NULL,
  "action_name" TEXT NOT NULL,
  "bound_params" TEXT NOT NULL DEFAULT '{}',
  "tool_used" TEXT NOT NULL,
  "result" TEXT,
  "error" TEXT,
  "latency_ms" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "confidence_delta" REAL NOT NULL DEFAULT 0,
  "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "op_execution_events_trail_id_idx" ON "op_execution_events"("trail_id");
CREATE INDEX "op_execution_events_agent_id_idx" ON "op_execution_events"("agent_id");
CREATE INDEX "op_execution_events_created_at_idx" ON "op_execution_events"("created_at");

CREATE TABLE "op_trail_leases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "trail_id" TEXT NOT NULL UNIQUE,
  "agent_id" TEXT NOT NULL,
  "lease_expiry_at" DATETIME NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeat_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "op_trail_leases_trail_id_idx" ON "op_trail_leases"("trail_id");
CREATE INDEX "op_trail_leases_lease_expiry_at_idx" ON "op_trail_leases"("lease_expiry_at");

CREATE TABLE "op_observations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agent_id" TEXT NOT NULL,
  "what_observed" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '{}',
  "certainty" REAL NOT NULL DEFAULT 0.5,
  "related_to_trial" TEXT,
  "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "op_observations_agent_id_idx" ON "op_observations"("agent_id");

-- Control & Learning Layer (meta/*)
CREATE TABLE "meta_evaluations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "trail_id" TEXT NOT NULL,
  "evaluator_id" TEXT NOT NULL,
  "correctness_score" REAL NOT NULL,
  "efficiency_score" REAL NOT NULL,
  "reasoning" TEXT NOT NULL,
  "confidence" REAL NOT NULL,
  "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "meta_evaluations_trail_id_idx" ON "meta_evaluations"("trail_id");
CREATE INDEX "meta_evaluations_evaluator_id_idx" ON "meta_evaluations"("evaluator_id");

CREATE TABLE "meta_trail_weights" (
  "trail_id" TEXT NOT NULL PRIMARY KEY UNIQUE,
  "weight" REAL NOT NULL,
  "components" TEXT NOT NULL,
  "updated_at" DATETIME NOT NULL,
  "next_decay_at" DATETIME NOT NULL
);

CREATE TABLE "meta_reputation" (
  "agent_id" TEXT NOT NULL PRIMARY KEY UNIQUE,
  "success_rate" REAL NOT NULL,
  "avg_confidence" REAL NOT NULL,
  "skill_scores" TEXT NOT NULL DEFAULT '{}',
  "recent_attempts" INTEGER NOT NULL DEFAULT 0,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "meta_promotion_candidates" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source_event_id" TEXT NOT NULL,
  "promotion_rule_id" TEXT NOT NULL,
  "consensus_score" REAL NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" DATETIME,
  "idempotency_key" TEXT NOT NULL UNIQUE
);

CREATE INDEX "meta_promotion_candidates_status_idx" ON "meta_promotion_candidates"("status");
CREATE INDEX "meta_promotion_candidates_created_at_idx" ON "meta_promotion_candidates"("created_at");

CREATE TABLE "meta_decay_schedules" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "target_type" TEXT NOT NULL,
  "half_life_days" INTEGER NOT NULL,
  "min_weight" REAL NOT NULL,
  "applies_to" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 5: Run migration**

```bash
cd core && npx prisma migrate dev --name add_trail_executor_schema
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd core && npm test -- tests/executor/outcome-writer.test.ts
# Expected: PASS
```

- [ ] **Step 7: Commit**

```bash
git add core/prisma/schema.prisma core/prisma/migrations/
git commit -m "feat: add Trail Executor database schema (op/*, meta/*)"
```

---

### Task 1A.3: Implement ToolRegistry (Strict Type Validation)

**Files:**
- Create: `core/src/executor/tool-registry.ts`
- Create: `tests/executor/tool-registry.test.ts`

**Steps:**

- [ ] **Step 1: Write failing test for tool validation**

```typescript
// tests/executor/tool-registry.test.ts
import { ToolRegistry } from '../../../src/executor/tool-registry'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('should reject action with undefined tool', () => {
    const action = { tool: 'undefined_tool', params: {} }
    const validation = registry.validate(action)
    expect(validation.ok).toBe(false)
    expect(validation.error).toContain('Tool not found')
  })

  it('should reject action with missing required param', () => {
    registry.register({
      name: 'call_api',
      description: 'Call an API endpoint',
      params: {
        url: { type: 'string', required: true, description: 'URL to call' },
        method: { type: 'string', required: false, description: 'HTTP method' }
      }
    })
    const action = { tool: 'call_api', params: { method: 'GET' } }
    const validation = registry.validate(action)
    expect(validation.ok).toBe(false)
    expect(validation.error).toContain('url')
  })

  it('should accept valid action', () => {
    registry.register({
      name: 'call_api',
      description: 'Call an API endpoint',
      params: {
        url: { type: 'string', required: true, description: 'URL to call' }
      }
    })
    const action = { tool: 'call_api', params: { url: 'https://example.com' } }
    const validation = registry.validate(action)
    expect(validation.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && npm test -- tests/executor/tool-registry.test.ts
# Expected: FAIL - "ToolRegistry is not defined"
```

- [ ] **Step 3: Implement ToolRegistry**

```typescript
// core/src/executor/tool-registry.ts
import { ToolDefinition } from '../types/executor.types'

interface ValidationResult {
  ok: boolean
  error?: string
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  validate(action: { tool: string; params: Record<string, unknown> }): ValidationResult {
    const tool = this.tools.get(action.tool)

    if (!tool) {
      return { ok: false, error: `Tool not found: ${action.tool}` }
    }

    for (const [paramName, paramSchema] of Object.entries(tool.params)) {
      if (paramSchema.required && !(paramName in action.params)) {
        return { ok: false, error: `Missing required param: ${paramName}` }
      }

      if (paramName in action.params) {
        const value = action.params[paramName]
        if (typeof value !== paramSchema.type) {
          return {
            ok: false,
            error: `Param ${paramName} has wrong type: expected ${paramSchema.type}, got ${typeof value}`
          }
        }
      }
    }

    return { ok: true }
  }

  getDefinition(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName)
  }

  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd core && npm test -- tests/executor/tool-registry.test.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add core/src/executor/tool-registry.ts tests/executor/tool-registry.test.ts
git commit -m "feat: implement ToolRegistry with strict validation"
```

---

### Task 1A.4: Implement TrailSelector

**Files:**
- Create: `core/src/executor/trail-selector.ts`
- Create: `tests/executor/trail-selector.test.ts`
- Create: `tests/executor/fixtures/trails.ts`

**Steps:**

- [ ] **Step 1: Create test fixtures**

```typescript
// tests/executor/fixtures/trails.ts
import { Trail } from '../../../src/types/executor.types'

export const mockTrail1: Trail = {
  id: 'trail_1',
  goal_id: 'goal_1',
  agent_id: 'agent_1',
  steps: [{ action_name: 'api_call', status: 'success', result_summary: 'OK' }],
  execution_event_ids: [],
  success_score: 0.85,
  confidence: 0.82,
  weight: 0.78,
  decay_rate: 0.05,
  created_at: new Date(),
  last_executed_at: undefined
}

export const mockTrail2: Trail = {
  id: 'trail_2',
  goal_id: 'goal_1',
  agent_id: 'agent_2',
  steps: [],
  execution_event_ids: [],
  success_score: 0.60,
  confidence: 0.50,
  weight: 0.45,
  decay_rate: 0.05,
  created_at: new Date(),
  last_executed_at: undefined
}
```

- [ ] **Step 2: Write failing test for TrailSelector**

```typescript
// tests/executor/trail-selector.test.ts
import { TrailSelector } from '../../../src/executor/trail-selector'
import { mockTrail1, mockTrail2 } from './fixtures/trails'

describe('TrailSelector', () => {
  let selector: TrailSelector

  beforeEach(() => {
    selector = new TrailSelector(mockGraphStore, mockLeaseManager)
  })

  it('should select highest weight trail for goal', async () => {
    const selected = await selector.selectBest('goal_1', mockContext, 'agent_1')
    expect(selected?.id).toBe('trail_1')
    expect(selected?.weight).toBe(0.78)
  })

  it('should skip leased trails', async () => {
    jest.spyOn(mockLeaseManager, 'isLeased').mockResolvedValue(true)
    const selected = await selector.selectBest('goal_1', mockContext, 'agent_1')
    expect(selected?.id).not.toBe('trail_1')
  })

  it('should return null if no trails available', async () => {
    const selected = await selector.selectBest('goal_nonexistent', mockContext, 'agent_1')
    expect(selected).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd core && npm test -- tests/executor/trail-selector.test.ts
# Expected: FAIL - "TrailSelector is not defined"
```

- [ ] **Step 4: Implement TrailSelector**

```typescript
// core/src/executor/trail-selector.ts
import { Trail } from '../types/executor.types'

interface GraphStore {
  queryTrails(goalId: string): Promise<Trail[]>
  getTrailWeight(trailId: string): Promise<number>
}

interface LeaseManager {
  isLeased(trailId: string): Promise<boolean>
}

interface WorkingMemory {
  context: Record<string, unknown>
}

interface AgentContext {
  agent_id: string
  reputation_score: number
}

export class TrailSelector {
  constructor(private graphStore: GraphStore, private leaseManager: LeaseManager) {}

  async selectBest(
    goal: string,
    workingMemory: WorkingMemory,
    agentId: string
  ): Promise<Trail | null> {
    // Query all trails for this goal
    const trails = await this.graphStore.queryTrails(goal)

    if (trails.length === 0) {
      return null
    }

    // Score each trail by weight, filtering out leased ones
    const scoredTrails: Array<{ trail: Trail; score: number }> = []

    for (const trail of trails) {
      const isLeased = await this.leaseManager.isLeased(trail.id)
      if (isLeased) continue

      // Score = trail weight + slight boost for same agent (to avoid context switching)
      const sameAgentBoost = trail.agent_id === agentId ? 0.05 : 0
      const score = trail.weight + sameAgentBoost

      scoredTrails.push({ trail, score })
    }

    if (scoredTrails.length === 0) {
      return null
    }

    // Return highest-scored trail
    return scoredTrails.reduce((best, current) => {
      return current.score > best.score ? current : best
    }).trail
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd core && npm test -- tests/executor/trail-selector.test.ts
# Expected: PASS
```

- [ ] **Step 6: Commit**

```bash
git add core/src/executor/trail-selector.ts tests/executor/trail-selector.test.ts tests/executor/fixtures/trails.ts
git commit -m "feat: implement TrailSelector with weight-based ranking"
```

---

*[Plan continues with remaining components: ActionBinder, ToolRunner, OutcomeWriter, then Phase 1B (LeaseManager, WeightUpdater, PromotionMux), then Phase 1C (observability, error recovery), then integration testing and rollout]*

---

## Phase 1B: Learning Infrastructure

### Task 1B.1: Implement LeaseManager (Concurrency Control)

**Files:**
- Create: `core/src/executor/lease-manager.ts`
- Create: `tests/executor/lease-manager.test.ts`

*[Complete implementation with compare-and-swap semantics, heartbeat renewal, TTL expiry, jitter/backoff]*

---

## Phase 1C: Production Hardening

### Task 1C.1: Add Observability (Metrics + Logging)

**Files:**
- Create: `core/src/observability/metrics.ts`
- Create: `core/src/observability/logging.ts`
- Modify: `core/src/executor/execution-loop.ts` (wire in metrics)

*[Baseline metrics: trail success rate, duplicate-attempt rate, promotion precision, latency per step]*

---

## Integration & Deployment

### Task INT.1: Wire Executor into API

**Files:**
- Create: `core/src/api/routes/executor.routes.ts`
- Modify: `core/src/server.ts`

**Endpoint Contract:**
```
POST /api/swarm/execute
Body: { goal: string, agentId: string, maxSteps: number }
Response: ExecutionResult
Status: 200 (success), 400 (validation), 503 (service unavailable)
```

---

## Rollout & Testing Strategy

### Pre-Deployment Checklist
- [ ] All unit tests pass (95%+ coverage)
- [ ] Integration test passes (end-to-end execution)
- [ ] Idempotency keys verified (no duplicate promotion)
- [ ] Lease semantics verified (concurrent execution safe)
- [ ] Metrics baseline established

### Deployment Steps
1. **Stage 1:** Deploy to dev environment, run smoke tests
2. **Stage 2:** Deploy to staging, run load tests (10 concurrent agents)
3. **Stage 3:** Canary to 10% production agents, monitor metrics for 24h
4. **Stage 4:** Full production rollout

---

## Success Criteria (Testable)

- [ ] Single agent executes trail → updates weight → next execution uses updated weight
- [ ] 10 concurrent agents execute without race conditions (no duplicate work)
- [ ] Trail weights improve over time (success_rate ↑ as weight ↑)
- [ ] Execution events are logged and auditable
- [ ] Promotion candidates with same idempotency_key deduplicated
- [ ] LeaseManager prevents dogpiling (only 1 agent per trail at a time)
- [ ] System handles agent failure gracefully (lease auto-expires)
- [ ] Observability shows: trail success rate, latency, duplicates, promotion precision

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Foundation Plan (Phase 1A) Complete |

