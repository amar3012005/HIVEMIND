# HIVEMIND — The Company Brain

**A production-grade, self-hosted memory engine that turns scattered organizational data into a connected, queryable knowledge graph.**

---

## Table of Contents

1. [What HIVEMIND Is](#what-hivemind-is)
2. [The Core Idea: Graph Memory, Not RAG](#the-core-idea-graph-memory-not-rag)
3. [The Relationship Model](#the-relationship-model)
4. [Current Feature Set](#current-feature-set)
5. [Architecture](#architecture)
6. [Ingestion Pipeline](#ingestion-pipeline)
7. [Retrieval & Recall](#retrieval--recall)
8. [Graph Robustness (Priority 1)](#graph-robustness-priority-1)
9. [Deployment](#deployment)
10. [API Reference](#api-reference)
11. [Where We Are Going](#where-we-are-going)
12. [Development](#development)

---

## What HIVEMIND Is

HIVE-MIND is not a chatbot. It is not a vector database. It is not a note-taking app.

HIVE-MIND is a **company brain**: a persistent, self-updating knowledge graph that ingests everything your organization produces — emails, Slack messages, documents, code, conversations, decisions — and connects it into a single, queryable model of what your company knows.

When it works correctly, you should be able to ask:

- "What did we decide about the Qdrant migration?"
- "Who was in that email thread about the Hetzner contract?"
- "Show me everything related to the Priority 1 graph fix."
- "What has changed since last month on the frontend deployment?"

And get answers that reflect the actual state of your organization's knowledge, not just keyword matches against isolated documents.

### What Makes It Different

| Approach | What It Does | Limitation |
|----------|-------------|------------|
| **RAG (Retrieval-Augmented Generation)** | Finds relevant text chunks and feeds them to an LLM | No understanding of how facts relate to each other; no temporal awareness |
| **Vector Search** | Finds semantically similar content | Returns isolated results; cannot answer "what changed" or "how are these connected" |
| **HIVE-MIND Graph Memory** | Builds a living graph of facts with typed relationships (Updates, Extends, Derives) | Requires careful ingestion pipeline design (this is what Priority 1 addressed) |

The key insight: **a company brain needs edges, not just nodes.** A collection of 250 isolated facts is nearly useless. The same 250 facts connected by 200+ typed relationships becomes a reasoning substrate.

---

## The Core Idea: Graph Memory, Not RAG

### Why RAG Alone Fails for Organizational Memory

Traditional RAG works like this:

1. Chunk documents into pieces
2. Embed each chunk into a vector
3. At query time, find the most similar vectors
4. Feed those chunks to an LLM

This breaks down for organizational memory because:

- **No temporal awareness.** RAG cannot tell you that a fact was superseded. It will return both the old and new version with equal weight.
- **No relationship awareness.** RAG does not know that an email thread, a Slack conversation, and a decision document are about the same topic.
- **No synthesis.** RAG cannot combine three separate facts to infer a fourth.

### How HIVEMIND Graph Memory Works

Instead of treating memories as independent documents, HIVEMIND builds a **typed property graph**:

```
┌──────────────────┐     Updates     ┌──────────────────┐
│ "Using Qdrant    │ ───────────────→│ "Using Qdrant    │
│  v1.8"           │                 │  v1.12"          │
│ (isLatest=false) │                 │ (isLatest=true)  │
└──────────────────┘                 └──────────────────┘
         │                                    │
         │ Extends                            │ Extends
         ▼                                    ▼
┌──────────────────┐                 ┌──────────────────┐
│ "Qdrant setup    │                 │ "Qdrant upgrade  │
│  guide"          │                 │  notes"          │
└──────────────────┘                 └──────────────────┘
         │                                    │
         └──────────── Derives ───────────────┘
                           │
                           ▼
                ┌──────────────────┐
                │ "Qdrant is the   │
                │  team's primary  │
                │  vector store"   │
                └──────────────────┘
```

Every node is a memory. Every edge is a typed relationship. The graph is always queryable, always up-to-date, and always aware of what superseded what.

---

## The Relationship Model

HIVE-MIND uses three canonical relationship types. These are not arbitrary tags — they are the core semantic operators that make the graph a reasoning substrate.

### Updates (State Mutation)

**When:** New information directly supersedes an existing fact.

**Example:**
- Memory A: "Amar is a software engineer"
- Memory B: "Amar is now a staff engineer"
- Edge: B → Updates → A

**Behavior:**
- Memory A is marked `isLatest = false`
- Default retrieval returns Memory B
- Temporal queries can still access Memory A for historical reasoning
- Prevents the LLM from seeing two conflicting facts simultaneously

### Extends (Refinement)

**When:** New information enriches an existing memory without replacing it.

**Example:**
- Memory A: "Amar is a staff engineer"
- Memory B: "Amar specializes in distributed systems and TypeScript"
- Edge: B → Extends → A

**Behavior:**
- Both memories remain `isLatest = true`
- Retrieval returns both together for richer context
- The graph can traverse Extends chains to build comprehensive profiles

### Derives (Inference / Synthesis)

**When:** The engine synthesizes multiple distinct memories to infer a new connection.

**Example:**
- Memory A: "The team decided to use Qdrant for vector search"
- Memory B: "The team migrated embeddings from Mistral to a local model"
- Memory C (derived): "The team prioritizes self-hosted infrastructure for AI workloads"
- Edges: C → Derives → A, C → Derives → B

**Behavior:**
- The derived memory is a new node with its own identity
- Derives edges point from the synthesis to each source
- Enables multi-hop reasoning: "Why did the team choose self-hosted?"

### Deterministic Structural Edges (Priority 1 Addition)

Beyond semantic relationships, HIVEMIND now enforces **deterministic structural edges** that are always correct regardless of content similarity:

| Rule | Edge Type | Confidence | Trigger |
|------|-----------|------------|---------|
| Same Gmail `thread_id` | Extends | 0.95 | Thread match in SmartIngestRouter |
| Same session / `source_session_id` | Updates | 0.90 | Session match in SmartIngestRouter |
| Document chunk → parent | Extends | 0.99 | `parent_schema_id` in metadata |
| Chunk N → Chunk N-1 | Extends | 0.98 | `chunk_index` + `parent_title` match |
| Enterprise fallback | Extends | 0.99 | Server-side safety net after ingest |

These rules run **before** semantic similarity heuristics. They guarantee that documents, threads, and sessions form visible clusters in the graph regardless of content overlap.

---

## Current Feature Set

### Core Memory Engine

| Feature | File | Description |
|---------|------|-------------|
| **Graph Engine** | `core/src/memory/graph-engine.js` | Orchestrates ingest, classification, relationship creation, and contradiction reconciliation |
| **Smart Ingest Router** | `core/src/memory/smart-ingest-router.js` | Type-aware pre-processing with deterministic structural edge rules |
| **Relationship Classifier** | `core/src/memory/relationship-classifier.js` | Content-based fallback classification using token similarity |
| **Relationship Semantics** | `core/src/memory/relationship-semantics.js` | Canonical alias normalization (e.g., "update" → "Updates") |
| **Prisma Graph Store** | `core/src/memory/prisma-graph-store.js` | PostgreSQL-backed persistence with idempotent relationship upserts |
| **Conflict Detector** | `core/src/memory/` | Predict-calibrate dedup before ingest |
| **Memory Processor** | `core/src/memory/memory-processor.js` | Fact extraction and enrichment |

### Vector & Search

| Feature | File | Description |
|---------|------|-------------|
| **Qdrant Client** | `core/src/vector/qdrant-client.js` | Vector storage with Mistral embeddings (1024-dim) |
| **Hybrid Search** | `core/src/search/hybrid.js` | Vector + keyword + graph + policy ranking |
| **Three-Tier Retrieval** | `core/src/search/three-tier-retrieval.js` | QuickSearch (<100ms), PanoramaSearch (<500ms), InsightForge (<3s) |
| **Insight Forge** | `core/src/search/insight-forge.js` | LLM-powered sub-query generation and entity extraction |
| **Panorama Search** | `core/src/search/panorama-search.js` | Temporal categorization and timeline building |
| **Graph Cache** | `core/src/memory/graph-cache.js` | In-process cache for graph visualization queries |

### Ingestion Sources

| Source | Path | Status |
|--------|------|--------|
| **Gmail** | `core/src/connectors/providers/gmail/` | Thread-aware sync + selected-thread ingest |
| **Slack** | `core/src/connectors/providers/slack/` | Employee actions, webhook events, Talk-to-HIVE |
| **Google Calendar** | `core/src/connectors/providers/google/calendar-adapter.js` | Event ingestion |
| **Knowledge Upload** | `core/src/server.js` (knowledge route) | PDF/Document chunking with pre-embedding |
| **Enterprise Upload** | `core/src/server.js` (enterprise route) | Schema extraction + parent/chunk structure |
| **Webapp Store** | `core/src/server.js` (`/api/integrations/webapp/store`) | Direct memory creation from frontend |
| **Web Intelligence** | `core/src/server.js` (web job routes) | Search/crawl results saved as memories |
| **Talk-to-HIVE Chat** | `core/src/server.js` (chat route) | Fact extraction from conversations |
| **MCP Protocol** | `core/src/mcp/` | Universal AI client connectivity |
| **Live Query** | `core/src/connectors/providers/google/live-query-router.js` | On-demand Google Workspace search with memory promotion |

### Frontend

| Feature | Location | Description |
|---------|----------|-------------|
| **Memory Graph 3D** | `frontend/Da-vinci/src/components/hivemind/app/pages/MemoryGraph3D.jsx` | WebGL graph visualization with selective rendering |
| **Memory Graph Page** | `frontend/Da-vinci/src/components/hivemind/app/pages/MemoryGraph.jsx` | Graph fetch/cache/filter/sidebar/search |
| **Knowledge Base** | `frontend/Da-vinci/src/components/hivemind/app/pages/KnowledgeBase.jsx` | Document upload/list/delete UI |
| **Talk-to-HIVE** | `frontend/Da-vinci/src/components/hivemind/cartesia/` | Chat interface with assistant identity |
| **PageIndex** | `frontend/Da-vinci/src/components/hivemind/app/pages/` | Project/halls/tags navigation |

### Platform & Infrastructure

| Feature | Description |
|---------|-------------|
| **Multi-Tenancy** | `user_id` + `org_id` isolation on all queries |
| **Plan Enforcement** | Usage tracking with token/memory/search limits |
| **Audit Logging** | All mutations recorded with actor, event type, and metadata |
| **Tenant Gate** | Per-tenant concurrency control for expensive graph queries |
| **Graph Hygiene** | Duplicate detection, orphan scanning, stale memory identification |
| **Graph Backfill** | `POST /api/graph/backfill` — repair sparse tenant graphs |
| **Graph Quality Probe** | `GET /api/graph/quality` — nodes, edges, isolation %, duplicate rate |
| **EU Sovereignty** | Hetzner/Scaleway/OVHcloud, LUKS2 encryption, GDPR compliance |
| **Coolify Deploy** | Single-click deployment with `coolify.yaml` |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        INGESTION LAYER                           │
│  Gmail · Slack · Calendar · Docs · Chat · Web · MCP · Live      │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                   CANONICAL INGEST CONTRACT                      │
│                                                                  │
│  normalize source → SmartIngestRouter → GraphEngine.ingestMemory │
│                                                                  │
│  Every source follows this path. Nothing bypasses the router.    │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                     SMART INGEST ROUTER                          │
│                                                                  │
│  1. Type detection (gmail/slack/chat/doc/code)                   │
│  2. Content normalization + chunking                             │
│  3. Deterministic structural edges (thread/session/document)     │
│  4. Semantic similarity search                                   │
│  5. Triple-operator annotation (Updates/Extends/Derives)         │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                       GRAPH ENGINE                               │
│                                                                  │
│  1. Predict-calibrate dedup                                      │
│  2. Fact extraction (optional, controlled by skip_fact_extraction)│
│  3. Relationship classification (never skipped for clean ingest) │
│  4. Apply Updates (mark prior isLatest=false)                    │
│  5. Apply Extends (link to target)                               │
│  6. Apply Derives (link to sources)                              │
│  7. Contradiction reconciliation                                 │
│  8. Persist memory + edges                                       │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                      PERSISTENCE LAYER                           │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ PostgreSQL       │  │ Qdrant           │  │ Redis          │  │
│  │ • Memories       │  │ • Vector store   │  │ • Cache        │  │
│  │ • Relationships  │  │ • 1024-dim       │  │ • Rate limits  │  │
│  │ • Versions       │  │ • Hybrid search  │  │ • Sessions     │  │
│  │ • Source metadata│  │ • Multi-tenant   │  │                │  │
│  └─────────────────┘  └──────────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                      RETRIEVAL LAYER                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ QuickSearch   │  │ Panorama     │  │ InsightForge         │   │
│  │ <100ms        │  │ <500ms       │  │ <3s                  │   │
│  │ Vector only   │  │ + Temporal   │  │ + LLM sub-queries    │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                  │
│  All tiers include graph expansion: traverse Updates/Extends/    │
│  Derives edges one hop to surface structurally connected facts.  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Ingestion Pipeline

### The Canonical Contract

Every memory entering HIVEMIND follows this path:

```
raw source → normalize → SmartIngestRouter.route() → GraphEngine.ingestMemory() → persist
```

This is enforced by `buildRoutedIngestPayloads()` in `core/src/server.js`. No ingestion path calls `persistentMemoryEngine.ingestMemory()` directly without going through the router first.

### Processing Flags

To give callers precise control without accidentally disabling graph creation:

| Flag | Effect |
|------|--------|
| `skip_fact_extraction: true` | Skip LLM fact extraction (content is already clean). Does NOT skip relationship classification. |
| `skip_relationship_classification: true` | Skip content-based relationship classification. Use when caller provides explicit relationship. |
| `skipProcessing: true` | Legacy flag. Still supported for backward compatibility. Skips fact extraction but no longer skips relationships. |
| `smartIngest: false` | Bypass SmartIngestRouter entirely. Use only for identity/config data, not knowledge. |

### Source-Specific Routing

| Source Type | Router Method | Key Behavior |
|-------------|--------------|--------------|
| Gmail | `_routeGmail()` | Extracts Subject/From/Date, stamps `thread_id` |
| Slack | `_routeSlack()` | Normalizes channel/team metadata |
| Knowledge Base | `_routeKnowledgeBase()` | Chunks by heading hierarchy, stamps `chunk_index`/`chunk_total`/`parent_title` |
| Claude | `_routeClaude()` | Distills meaningful lines from conversation |
| Chat | `_routeChat()` | Marks as fact type for triple-operator matching |
| GitHub | `_routeGithub()` | Marks as decision type |

---

## Retrieval & Recall

### Three-Tier Search

| Tier | Endpoint | Latency | Use Case |
|------|----------|---------|----------|
| **QuickSearch** | `POST /api/search/quick` | <100ms | Autocomplete, fast lookup |
| **PanoramaSearch** | `POST /api/search/panorama` | <500ms | Historical timeline, temporal queries |
| **InsightForge** | `POST /api/search/insight` | <3s | Complex multi-hop reasoning, synthesis |

### Graph Expansion

All retrieval tiers include one-hop graph expansion. When a memory is retrieved, the engine also fetches memories connected via Updates, Extends, and Derives edges. This means:

- A query about "Qdrant" returns not just the matching memory, but also the upgrade notes, the setup guide, and the derived synthesis about infrastructure preferences.
- A query about a person returns their current role (via Updates chain) plus related decisions and projects (via Extends/Derives).

### Recall for Chat

The Talk-to-HIVE chat path uses a dedicated recall pipeline:

1. Hybrid search (vector + keyword + graph)
2. Filter out config tags (assistant-name, voice-profile)
3. Decision-first sort for choice-related queries
4. Variable content limits (top 3 get full context, rest get tighter slices)
5. Graph-expand the top match one hop
6. Append live Slack/Google results when local recall is thin
7. Inject user profile context and voice profile

---

## Graph Robustness (Priority 1)

This section documents the work completed on May 17, 2026 to fix the "250 nodes · 22 edges" problem.

### The Problem

Before Priority 1, HIVEMIND had all the right machinery for building a rich graph, but it was not applied consistently:

1. **`skipProcessing: true` accidentally suppressed relationships.** Many ingestion paths used this flag to mean "content is already clean," but it also disabled relationship classification. Result: clean ingests produced isolated nodes.

2. **Most ingestion paths bypassed SmartIngestRouter.** Only `POST /api/memories` used the router. Slack, Gmail, chat, documents, and web all called `persistentMemoryEngine.ingestMemory()` directly. Result: no deterministic thread/session/document edges for the highest-volume paths.

3. **Duplicate Derives edges.** The router and engine could both create Derives edges from the same sources through different fields. Result: duplicate edges and wasted storage.

4. **No idempotent edge creation.** `createRelationship()` used plain `create()`, so retries or concurrent jobs could throw unique-constraint errors.

5. **No repair path for existing sparse graphs.** Even after fixing live ingest, old tenants would remain sparse.

### What Was Fixed

#### 1. Engine Semantics (`core/src/memory/graph-engine.js`)

- Split `skipProcessing` into `skip_fact_extraction` and `skip_relationship_classification`
- `skipProcessing: true` no longer suppresses relationship creation
- Added `shouldSkipFactExtraction` computed separately from relationship skip logic
- Added guard: `effectiveRelationshipType !== 'Derives'` before the `_derives_from` auto-derive block

#### 2. Canonical Routing (`core/src/server.js`)

- Added `buildRoutedIngestPayloads(payload, { smartIngestRouter })` helper
- Migrated 12 ingestion paths to use the helper:
  - Slack employee auto-ingest
  - Slack webhook event ingest
  - Gmail selected-thread ingest
  - Gmail sync thread ingest
  - Enterprise parent + chunk ingest
  - Knowledge upload summary + chunk ingest
  - Web job save-to-memory
  - Webapp store
  - Live query promotion
  - Talk-to-HIVE Slack post auto-ingest
  - Talk-to-HIVE Slack fallback auto-ingest
  - Talk-to-HIVE fact ingest
- Replaced `skipProcessing: true` with `skip_fact_extraction: true` in all migrated paths
- Added enterprise parent→chunk fallback edge creation after ingest

#### 3. Deterministic Structural Edges (`core/src/memory/smart-ingest-router.js`)

- Added `parent_schema_id → Extends` rule (confidence 0.99)
- Added chunk→previous-chunk `Extends` rule via `chunk_index` + `parent_title` matching (confidence 0.98)
- These rules run before semantic similarity heuristics

#### 4. Idempotent Persistence (`core/src/memory/prisma-graph-store.js`)

- Changed `createRelationship()` from `create()` to `upsert()` on `@@unique([fromId, toId, type])`
- Re-ingest or concurrent jobs no longer produce duplicate edges

#### 5. Repair & Measurement (`core/src/server.js`)

- Added `POST /api/graph/backfill` — replays orphan memories through SmartIngestRouter, reports or writes missing edges
- Added `GET /api/graph/quality` — reports nodes, edges, isolated %, duplicate edge groups, relationship type distribution

### Verification

After deploying Priority 1:

1. Run `GET /api/graph/quality` for baseline
2. Run `POST /api/graph/backfill` with `dry_run: true`
3. Inspect `edges_proposed`
4. Run with `dry_run: false` to apply
5. Run `GET /api/graph/quality` again
6. Confirm: nodes stable, edges up, isolated % down, duplicate edge groups at 0
7. Spot-check Gmail thread clusters and document chains in the graph UI

---

## Deployment

### Quick Local Start

```bash
cd /Users/amar/HIVE-MIND/core
npm install
npm start
# → http://localhost:3000
```

### Production (Coolify)

```bash
cp .env.coolify.example .env
# Edit .env with your keys and secrets
./scripts/deploy-coolify.sh production
```

### Production (Manual Docker)

```bash
cd infra
cp .env.example .env
# Edit .env
./deploy.sh
```

### Required Environment Variables

```bash
# API & Auth
API_MASTER_KEY=<hex-64>
SESSION_SECRET=<hex-64>
HIVEMIND_MASTER_API_KEY=<hex-64>

# AI Services
GROQ_API_KEY=<groq-key>
MISTRAL_API_KEY=<mistral-key>

# Database
DATABASE_URL=postgresql://...
QDRANT_URL=https://...
QDRANT_COLLECTION="BUNDB AGENT"

# Infrastructure
REDIS_PASSWORD=<hex-64>
BACKUP_ENCRYPTION_KEY=<base64-64>

# EU Compliance
GDPR_MODE=true
DATA_RESIDENCY=EU
EU_REGION=eu-central-1
```

---

## API Reference

### Memory Ingestion

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/memories` | POST | Create memory (goes through full SmartIngestRouter pipeline) |
| `/api/memories` | GET | List memories |
| `/api/memories/search` | POST | Search memories |
| `/api/memories/delete-all` | DELETE | Delete all memories for tenant |

### Graph

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graph` | GET | Full graph data (nodes + edges) for visualization |
| `/api/graph/backfill` | POST | Repair sparse graphs (dry_run default true) |
| `/api/graph/quality` | GET | Graph health metrics |
| `/api/graph/hygiene/scan` | GET | Scan for duplicates, orphans, noise |
| `/api/graph/hygiene/execute` | POST | Execute hygiene actions |
| `/api/graph/hygiene/stats` | GET | Hygiene statistics |

### Search & Recall

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search/quick` | POST | Fast vector search |
| `/api/search/panorama` | POST | Temporal search with timeline |
| `/api/search/insight` | POST | Deep LLM-powered analysis |
| `/api/search/pageindex` | POST | PageIndex-powered hybrid search |
| `/api/recall` | POST | Auto-recall for context injection |

### Connectors

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/connectors/gmail/ingest-selected` | POST | Ingest specific Gmail threads |
| `/api/connectors/gmail/flush` | POST | Remove Gmail-sourced memories |
| `/api/connectors/slack/event-ingest` | POST | Webhook ingest for Slack events |
| `/api/connectors/sync` | POST | Provider-agnostic connector sync |
| `/api/employees/slack-action` | POST | Digital Employee Slack actions |

### Knowledge & Enterprise

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/knowledge/document` | POST | Upload document for chunking + ingest |
| `/api/knowledge/document` | DELETE | Delete uploaded document |
| `/api/enterprise/upload/ingest` | POST | Enterprise document with schema extraction |

### Chat

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Talk-to-HIVE conversation |

### Web Intelligence

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/web/jobs/:id/save-to-memory` | POST | Save web search/crawl results as memories |

---

## Where We Are Going

Priority 1 made the graph robust. The next phases make it intelligent.

### Phase 2: Entity-Centric Graphing

**Goal:** Move from content-similarity edges to entity-aware edges.

Today, two memories connect if their text is similar or they share a thread/session ID. Tomorrow, they should connect if they mention the same person, project, company, or decision — even if the wording is completely different.

**Key work:**
- Named entity recognition on ingest
- Entity resolution across sources ("Amar" = "amar@company.com" = "the staff engineer")
- Entity-centric graph views: "Show me everything about Project X"

### Phase 3: Temporal Reasoning

**Goal:** Make the graph fully time-aware.

Today, `isLatest` handles simple supersession. Tomorrow, the graph should understand:
- "What did we know about this topic in March 2026 vs May 2026?"
- "Show me the decision timeline for the Qdrant migration."
- "What changed after the Hetzner contract was signed?"

**Key work:**
- Bi-temporal versioning (transaction time + valid time)
- Timeline queries with diff support
- Automatic change detection and summarization

### Phase 4: Cross-Tenant Intelligence

**Goal:** Learn patterns across organizations without leaking data.

Today, each tenant is fully isolated. Tomorrow, the platform should:
- Detect common failure patterns across deployments
- Recommend best practices based on similar organizations
- Provide industry benchmarks without exposing individual tenant data

**Key work:**
- Federated pattern extraction
- Differential privacy for cross-tenant analytics
- Anonymized benchmark datasets

### Phase 5: Autonomous Graph Maintenance

**Goal:** The graph should heal itself.

Today, backfill and hygiene are manual API calls. Tomorrow:
- Automatic orphan detection and reconnection
- Stale memory archival with configurable policies
- Confidence scoring for inferred edges with automatic reinforcement or decay
- Graph health alerts when isolation % exceeds threshold

### Phase 6: Multi-Modal Memory

**Goal:** Images, audio, and video become first-class graph citizens.

Today, non-text content is extracted to text and then treated as documents. Tomorrow:
- Native multi-modal embeddings
- Cross-modal relationships ("this diagram explains that decision")
- Visual graph exploration with spatial memory layouts

---

## Development

### Project Structure

```
HIVE-MIND/
├── core/                        # Backend server
│   ├── src/
│   │   ├── server.js            # Main HTTP server (all routes)
│   │   ├── memory/              # Memory engine
│   │   │   ├── graph-engine.js          # Core ingest orchestrator
│   │   │   ├── smart-ingest-router.js   # Type-aware pre-processing
│   │   │   ├── relationship-classifier.js
│   │   │   ├── relationship-semantics.js
│   │   │   ├── prisma-graph-store.js    # PostgreSQL persistence
│   │   │   ├── graph-cache.js
│   │   │   └── tenant-gate.js
│   │   ├── search/              # Retrieval
│   │   │   ├── hybrid.js
│   │   │   ├── three-tier-retrieval.js
│   │   │   ├── insight-forge.js
│   │   │   └── panorama-search.js
│   │   ├── vector/              # Qdrant integration
│   │   ├── connectors/          # Source adapters
│   │   │   ├── providers/
│   │   │   │   ├── gmail/
│   │   │   │   ├── slack/
│   │   │   │   └── google/
│   │   │   └── framework/
│   │   ├── mcp/                 # MCP protocol server
│   │   ├── services/            # Business logic
│   │   └── embeddings/          # Mistral embedding service
│   └── prisma/
│       └── schema.prisma        # Database schema
├── frontend/                    # React frontend
│   └── Da-vinci/
│       └── src/
│           └── components/
│               └── hivemind/
│                   └── app/
│                       └── pages/
│                           ├── MemoryGraph.jsx
│                           ├── MemoryGraph3D.jsx
│                           └── KnowledgeBase.jsx
├── infra/                       # Docker & deployment
├── scripts/                     # Utility scripts
├── docs/                        # Documentation
└── tests/                       # Test suites
```

### Key Files for Contributors

| File | Why It Matters |
|------|---------------|
| `core/src/server.js` | All API routes. The largest file. Start here to understand the system. |
| `core/src/memory/graph-engine.js` | Core ingest logic. Where memories become graph nodes. |
| `core/src/memory/smart-ingest-router.js` | Pre-processing and deterministic edge rules. |
| `core/prisma/schema.prisma` | Database schema. The source of truth for data models. |
| `core/src/memory/prisma-graph-store.js` | Persistence layer. All DB reads/writes go through here. |

### Running Tests

```bash
cd core
npm test
```

### Code Quality Rules

- All functions must have explicit return types or clear JSDoc
- No `console.log` in production paths — use structured logging
- All async operations must have error handling
- No hardcoded secrets — use environment variables
- Relationship creation must be idempotent (use `upsert`, not `create`)
- New ingestion paths must use `buildRoutedIngestPayloads()`
- `skipProcessing: true` is deprecated for new code — use `skip_fact_extraction: true` instead

---

## Agent Army Protocol

HIVEMIND is built by a structured team of specialist Claude agents, not a single agent. This protocol is mandatory for every non-trivial command.

### The army (lives in `.claude/agents/`)

| Tier | Agent | Role |
|---|---|---|
| 0 | orchestrator | Decompose, dispatch, integrate. Never codes. |
| 1 recon | cartographer | Blast radius via code-review-graph |
| 1 recon | historian | Prior decisions/bugs via HIVEMIND memory + git |
| 1 design | architect | Interfaces, contracts, schema |
| 1 design | planner | Atomic task DAG |
| 1 impl | tdd-writer | Failing tests first |
| 1 impl | implementer-backend | Node/Prisma/Express |
| 1 impl | implementer-frontend | React/Vercel |
| 1 impl | implementer-infra | Docker/Caddy/Coolify |
| 1 domain | nango-specialist | Self-hosted Nango OAuth |
| 1 domain | mcp-specialist | MCP transports, catalog |
| 1 review | code-reviewer | Style, dead code, types |
| 1 review | db-reviewer | Prisma, indexes, migrations |
| 1 review | security-reviewer | OWASP, auth, tenant isolation |
| 1 ship | e2e-runner | Curl + browser smoke |
| 1 ship | deploy-operator | SSH/Docker/Coolify |
| 2 red team | bug-hunter | Edge cases, races, partial failures |
| 2 red team | threat-modeler | Attack paths |
| 2 red team | performance-critic | Hot path costs |
| 3 knowledge | memory-curator | HIVEMIND memory discipline |
| 3 knowledge | contract-keeper | Three-catalog drift, env matrix |
| 3 knowledge | doc-updater | README/runbook sync |
| 3 knowledge | journal-keeper | Physical journal — survives compaction |

### Dispatch flow (orchestrator enforces)

```
USER COMMAND
  ↓
parallel: cartographer + historian
  ↓
[high-risk?] parallel: threat-modeler + bug-hunter
  ↓
architect → planner
  ↓
tdd-writer (RED)
  ↓
parallel: implementer-{backend,frontend,infra} per task
  ↓
parallel: code-reviewer + db-reviewer + security-reviewer
  ↓ (loop until green)
e2e-runner (prod endpoint)
  ↓
deploy-operator
  ↓
parallel: memory-curator + journal-keeper + contract-keeper + doc-updater
  ↓
REPORT
```

### Hard rules (non-negotiable)

1. No code touched without cartographer + historian first.
2. No "done" without E2E against production endpoint.
3. Every task ends with journal-keeper entry + memory-curator writes.
4. Schema change blocks on db-reviewer with up/down migration.
5. External SDKs: explicit baseURL/host required, never trust defaults.
6. Three-catalog rule: `core/data/mcp-connectors.json` + `core/src/connectors/catalog.js` + `frontend/.../connectors-catalog.js` stay in sync.

### Physical Journal

`/Users/amar/HIVE-MIND/JOURNAL/` — git-tracked, survives Claude Code compaction.

```
JOURNAL/
  INDEX.md                — master TOC
  daily/YYYY-MM-DD/       — per-task entries
  decisions/              — architectural decisions
  incidents/              — bugs, outages, backlog.md
  playbooks/              — env-matrix, deploy, nango-providers, per-connector
  handoffs/               — session-end handoffs
```

Templates in `.claude/agents/journal-keeper.md`. Every task = one file. Always linked from INDEX.

### On every new Claude Code session

Bootstrap reads (in order):
1. `COMPANY_BRAIN.md` (this file)
2. `JOURNAL/INDEX.md` → latest 5 daily/ entries
3. `JOURNAL/incidents/backlog.md`
4. HIVEMIND recall: `tags=["session-trail-*","master-index"]`

Then orchestrator dispatches per protocol.

---

## License

See `LICENSE.research.md` for details.

---

*HIVE-MIND is built on the principle that a company's knowledge is its most valuable asset — and that asset should be connected, queryable, and sovereign.*
