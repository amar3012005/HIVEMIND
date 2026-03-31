# HIVEMIND — Self-Improving Memory Intelligence Platform

## What Is HIVEMIND?

HIVEMIND is a **persistent memory intelligence system** that ingests knowledge from any source, organizes it into a self-improving knowledge graph, and retrieves it with human-level contextual understanding. Three resident AI agents (Faraday, Feynman, Turing) continuously scan, analyze, and repair the graph — making it smarter over time without retraining.

**Core thesis**: Intelligence lives in the environment (knowledge graph, trails, blueprints), not in individual agents. Agents are interchangeable operators that read from and write to shared cognitive state.

---

## Proven Results

| Metric | Value |
|--------|-------|
| LongMemEval temporal-reasoning | **86.7%** (Supermemory: 76.69%) |
| Single-Session-Assistant | **100%** (Supermemory: 96.43%) |
| Decision detection precision | **100%** (0 false positives) |
| Decision detection recall | **95%** (19/20) |
| Intelligence transfer | Fresh agent inherits blueprints, 0 knowledge loss |
| Graph self-repair | Duplicates merged, stale truths linked, risks promoted — automatically |
| Learning across runs | Second scan: 0 new anomalies (vs 4 on first) |

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        HIVEMIND PLATFORM                             │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  LAYER 3: INTEGRATIONS                                          │ │
│  │  Gmail · Slack · GitHub · Linear · Notion · MCP · Web Crawl     │ │
│  └────────────────────────────┬──────────────────────────────────── │ │
│                               │                                      │
│  ┌────────────────────────────▼──────────────────────────────────┐  │
│  │  LAYER 2: CSI (Cognitive Swarm Intelligence)                   │  │
│  │                                                                 │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │  │
│  │  │ Faraday  │→ │ Feynman  │→ │  Turing  │→ Graph Actions      │  │
│  │  │ Scanner  │  │ Analyst  │  │ Verifier │  (merge/link/promote)│  │
│  │  └──────────┘  └──────────┘  └──────────┘                     │  │
│  │                                                                 │  │
│  │  Trail Executor · ForceRouter · ChainMiner · ReputationEngine  │  │
│  │  WeightUpdater · PromotionMux · MetaEvaluator · Dashboard      │  │
│  └────────────────────────────┬──────────────────────────────────┘  │
│                               │                                      │
│  ┌────────────────────────────▼──────────────────────────────────┐  │
│  │  LAYER 1: MEMORY ENGINE                                        │  │
│  │                                                                 │  │
│  │  Predict-Calibrate · Operator Layer · Context Autopilot         │  │
│  │  Bi-Temporal · Stigmergic CoT · Byzantine Consensus             │  │
│  │                                                                 │  │
│  │  MemoryProcessor (LLM) · Fact Extraction · Contextual Embedding │  │
│  │  Smart Ingestion · Conflict Detection · Relationship Classifier │  │
│  └────────────────────────────┬──────────────────────────────────┘  │
│                               │                                      │
│  ┌────────────────────────────▼──────────────────────────────────┐  │
│  │  LAYER 0: STORAGE                                              │  │
│  │  PostgreSQL (Prisma) · Qdrant (Vector) · Redis (Sessions)      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  FRONTEND: Da-vinci (React + Vercel)                          │   │
│  │  Memory Graph · Agent Swarm · Chat · Evaluation · Connectors  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [**features.md**](features.md) | Complete feature catalog — every capability with technical details |
| [**architecture.md**](architecture.md) | CSI architecture deep-dive — components, force routing, blueprints, schemas |
| [**api-reference.md**](api-reference.md) | Full API reference with request/response examples |
| [**integrations.md**](integrations.md) | All platform integrations, connectors, and external services |
| [**paradigm.md**](paradigm.md) | Environment-Centric Intelligence — the theoretical foundation |
| [**experiments.md**](experiments.md) | Benchmark results, experiments, and empirical evidence |
| [**LONGMEMEVAL-README.md**](LONGMEMEVAL-README.md) | LongMemEval benchmark runner guide |
| [**roadmap.md**](roadmap.md) | Development roadmap and next steps |
| [**brain_s/**](brain_s/) | AGI research notes (101-104) |

---

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 15+
- Qdrant (cloud or self-hosted)
- Redis (optional, for sessions)
- Groq API key (LLM inference)
- Embedding service (LiteLLM with bge-m3 or Mistral API)

### Deploy
```bash
# Core server
bash /opt/HIVEMIND/scripts/deploy.sh core

# Environment variables
DATABASE_URL=postgresql://...
QDRANT_URL=https://...
QDRANT_API_KEY=...
QDRANT_COLLECTION="BUNDB AGENT"    # Production (384d, all-MiniLM-L6-v2)
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
EMBEDDING_PROVIDER=mistral          # or litellm
```

### Run Resident Agents
```bash
# Full CSI chain: Faraday → Feynman → Turing
curl -X POST -H "X-API-Key: $KEY" "$API/api/swarm/resident/agents/faraday/run" \
  -d '{"scope":"workspace","goal":"scan for anomalies"}'

# Wait 15s, then:
curl -X POST -H "X-API-Key: $KEY" "$API/api/swarm/resident/agents/feynman/run"

# Wait 12s, then:
curl -X POST -H "X-API-Key: $KEY" "$API/api/swarm/resident/agents/turing/run"
```

### Run LongMemEval Benchmark
```bash
# Direct mode (fastest, 86.7% temporal)
GROQ_API_KEY=... LITELLM_API_KEY=... EMBED_MODEL=bge-m3 \
  node benchmarks/LongMemEval/run-benchmark.js 500

# SOTA engine mode (all features)
HIVEMIND_API_KEY=... GROQ_API_KEY=... \
  node benchmarks/LongMemEval/run-benchmark-sota.js 500
```

---

## HIVEMIND vs Supermemory

| Feature | Supermemory | HIVEMIND |
|---------|-------------|----------|
| Atomic memory extraction | Contextual Retrieval (Anthropic) | MemoryProcessor + heuristic facts |
| Relational versioning | Updates / Extends / Derives | Same (Triple Operator) |
| Dual timestamps | documentDate + eventDate | Same (Bi-Temporal) |
| Search strategy | Search memories → inject chunks | Same (fact-memory → parent injection) |
| Embedding model | Not disclosed | bge-m3 (1024d) / all-MiniLM (384d) |
| LLM for generation | GPT-4o / GPT-5 / Gemini-3-Pro | llama-3.3-70b (Groq) |
| **Self-improving agents** | **No** | **Yes (Faraday/Feynman/Turing)** |
| **Graph self-repair** | **No** | **Yes (GraphActionExecutor)** |
| **Learning across runs** | **No** | **Yes (observation history + reputation)** |
| **Cross-project connections** | **No** | **Yes (Faraday LLM detection)** |
| **Decision Intelligence** | **No** | **Yes (detect/classify/link/store)** |
| **Blueprint formation** | **No** | **Yes (ChainMiner → auto-promotion)** |
| **Byzantine consensus** | **No** | **Yes (Weiszfeld geometric median)** |

---

## Key Files

### Memory Engine (`core/src/memory/`)
| File | Purpose |
|------|---------|
| `graph-engine.js` | Ingestion pipeline: predict-calibrate → LLM processor → fact-memories |
| `memory-processor.js` | LLM fact extraction (exact quotes, dates, entities) |
| `predict-calibrate.js` | SHA-256 dedup + TOP-K similarity + delta extraction |
| `operator-layer.js` | Intent detection + dynamic retrieval weights |
| `context-autopilot.js` | Token-count-based context lifecycle management |
| `bi-temporal.js` | Time-travel queries (valid_time vs transaction_time) |
| `stigmergic-cot.js` | Pheromone-trail agent coordination |
| `byzantine-consensus.js` | Geometric median multi-voter validation |
| `persisted-retrieval.js` | Recall with is_latest, sort, graph expansion |
| `conflict-detector.js` | Token-similarity conflict detection (0.45 threshold) |
| `conflict-resolver.js` | LLM-based conflict resolution |
| `relationship-classifier.js` | Updates/Extends/Derives classification |
| `fact-extractor.js` | Structured fact extraction (people, orgs, dates) |
| `code-ingestion.js` | AST-based code chunking |

### CSI Layer (`core/src/resident/`)
| File | Purpose |
|------|---------|
| `faraday.js` | Scanner: semantic probing + LLM cluster analysis + cross-project detection |
| `feynman.js` | Analyst: hypothesis formation with verification plans |
| `turing.js` | Verifier: evaluation + graph action recommendations |
| `graph-action-executor.js` | Executes merge/link/suppress/promote/relate actions |
| `run-manager.js` | Orchestration + CSI feedback loop + direct graph actions |
| `contract.js` | Agent type contracts and observation schemas |

### Trail Executor (`core/src/executor/`)
| File | Purpose |
|------|---------|
| `execution-loop.js` | Select-bind-execute-write cycle (the "motor cortex") |
| `force-router.js` | 8-dimension Social Force Model with softmax sampling |
| `trail-selector.js` | Trail selection with blueprint matching |
| `chain-miner.js` | Pattern mining → blueprint promotion |
| `weight-updater.js` | 6-factor composite trail scoring |
| `reputation-engine.js` | EMA-based agent reputation (per-tool, per-blueprint) |
| `promotion-mux.js` | Dedup promotion candidate emission |
| `meta-evaluator.js` | 5-rule batch analysis with parameter recommendations |
| `parameter-registry.js` | 20 tunable parameters with atomic apply + rollback |
| `dashboard.js` | Read-only analytics (overview, executions, blueprints, agents) |

### Vector / Search (`core/src/vector/`, `core/src/embeddings/`)
| File | Purpose |
|------|---------|
| `qdrant-client.js` | Contextual embedding + Qdrant storage + hybrid search |
| `mistral.js` | Mistral AI embeddings (1024d, BGE-M3 based) |
| `litellm.js` | LiteLLM proxy embeddings (bge-m3, batch processing) |

### Frontend (`frontend/Da-vinci/src/components/hivemind/`)
| File | Purpose |
|------|---------|
| `MemoryGraph.jsx` | Interactive graph with smart loading + resident overlay |
| `AgentSwarm.jsx` | Agent console (run agents, goal presets, findings viewer) |
| `Chat.jsx` | "Talk to HIVE" — recall-augmented conversational UI |
| `Memories.jsx` | Memory search and management (hybrid search) |
| `Connectors.jsx` | Platform connector configuration |
| `Evaluation.jsx` | Benchmark runner and results viewer |

### Benchmarks (`benchmarks/LongMemEval/`)
| File | Purpose |
|------|---------|
| `run-benchmark.js` | Direct bge-m3 + Qdrant runner (fastest, 86.7%) |
| `run-benchmark-sota.js` | Full SOTA engine through HIVEMIND server |
| `run-benchmark-csi.js` | SOTA + CSI trail executor |

---

*Built by Amar + Claude Code. March 2026.*
*HIVEMIND: where memory becomes intelligence.*
