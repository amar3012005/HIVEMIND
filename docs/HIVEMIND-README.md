# HIVEMIND - Your Second Brain, Engineered

> **The AI-native memory engine that thinks with you.**
> HIVEMIND automatically captures, connects, and recalls everything you know — across every tool you use — so nothing falls through the cracks.

---

## What is HIVEMIND?

HIVEMIND is a **cognitive memory engine** — not another note-taking app, not another knowledge base. It's the infrastructure layer that sits behind your AI tools, connectors, and workflows, building a persistent, evolving graph of everything you learn, decide, and discuss.

Think of it as the difference between a filing cabinet and a brain. A filing cabinet stores documents. A brain **connects** them, surfaces the right one at the right time, and synthesizes new insights from old knowledge. HIVEMIND is the brain.

### The Problem

Knowledge workers use 10+ tools daily. Decisions get buried in Slack threads. Insights from meetings vanish. That email from six months ago with the critical vendor terms? Gone. Your AI assistant forgets everything the moment you close the tab.

**You remember that you knew something. You just can't find it.**

### The Solution

HIVEMIND captures knowledge from every source — Gmail, Slack, Claude conversations, Notion, GitHub, documents — and builds a living knowledge graph that grows smarter over time. Every memory is connected to related memories through **triple operators** (Updates, Extends, Derives, Contradicts). Every search uses multi-signal reranking to find exactly what matters.

The result: a second brain that is automatic, cross-platform, AI-powered, and always available.

---

## Why HIVEMIND?

### For Individual Users

**Obsidian proved that 1M+ people crave seeing their knowledge as a connected graph.** But Obsidian's graph is static, local-only, and manual. You have to do all the linking yourself.

HIVEMIND does it **automatically**:
- Connect your Gmail, and yesterday's meeting notes are already linked to the project decision from last month
- Your Claude conversation about database architecture? Connected to the GitHub PR that implemented it
- That preference you mentioned once ("I always prefer PostgreSQL over MongoDB")? Extracted, stored as a profile fact, and injected into every future AI interaction

**The emotional hook of watching your second brain grow creates retention.** People come back just to see the graph evolve — new nodes appearing, connections forming, clusters emerging around topics they care about.

### For German Enterprises

German buyers are pragmatic. They respect *Ingenieurskunst* — engineering craft. HIVEMIND's neural-network-like knowledge graph signals "this is serious AI infrastructure," not a toy. It justifies the investment visually and functionally.

**What makes HIVEMIND enterprise-ready:**

- **Collective knowledge, visualized.** Enterprise teams need to see their shared knowledge working. A living graph where connections form across team members' memories — Sarah's market research linked to Thomas's engineering decision linked to Maria's customer feedback — is a powerful differentiator. No competitor offers this.
- **Tools like Confluence and Notion look like spreadsheets.** HIVEMIND's graph should make a CTO say "show me more" within 3 seconds of opening it.
- **EU-first infrastructure.** Data residency in EU (fr-par-1), GDPR-compliant by design, audit logs with 7-year retention, DPA included from Scale tier.
- **NIS2/DORA compliance.** Full sync audit trail, encryption audit logging, HYOK (Hold Your Own Keys) for Enterprise.

---

## Architecture

### The Memory Engine

```
Content → ContentNormalizer → SmartIngestRouter → MemoryGraphEngine → ProfileStore
              (clean)         (type-aware)         (store + link)      (auto-extract)
                                   ↓
                          Triple Operator Check
                     (retrieve → compare → annotate)
                                   ↓
                    Updates | Extends | Derives | Contradicts
```

Every piece of content flows through a multi-stage pipeline:

1. **Content Normalization** — Source-type-specific cleanup. Email signatures stripped. Code comments removed. PDF page numbers cleaned. Claude conversation noise filtered to keep only decisions and insights.

2. **Smart Ingest Routing** — Detects source type (Gmail, Claude, Notion, GitHub, Slack) and applies type-specific extraction logic. Knowledge base documents are chunked by heading. Emails are grouped by thread.

3. **Triple Operator Pre-flight** — Before storing, searches existing memories for semantic similarity:
   - **> 0.88 similarity** → `Updates` (supersedes the existing memory)
   - **0.65–0.88 similarity** → `Extends` (augments with new information)
   - **0.40–0.65 with 2+ matches** → `Derives` (synthesizes from multiple sources)
   - **Contradiction detected** → `Contradicts` edge created

4. **Graph Storage** — Memory stored in PostgreSQL with vector embeddings in Qdrant. Relationships (edges) created between connected memories.

5. **Profile Auto-Extraction** — User facts (name, company, role, preferences, goals) automatically extracted from content via pattern matching and stored as durable profile facts.

### The CSI Pipeline (Autonomous Intelligence)

Three AI agents continuously scan and improve the knowledge graph:

| Agent | Role | What It Does |
|-------|------|-------------|
| **Faraday** | Observer | Scans for patterns, duplicates, gaps, and anomalies in the graph |
| **Feynman** | Hypothesizer | Generates hypotheses from Faraday's observations ("these 3 memories might be duplicates") |
| **Turing** | Verifier | Validates hypotheses with evidence, executes graph actions (merge, promote, create relationships) |

This means HIVEMIND gets smarter over time — even when you're not using it. Duplicate memories get merged. Important observations get promoted. New connections get discovered.

### Three-Tier Retrieval

| Tier | Speed | Depth | Use Case |
|------|-------|-------|----------|
| **Quick Search** | <250ms | Vector similarity + BM25 | "Find that email about Project Alpha" |
| **Panorama Search** | 1-3s | Multi-hop graph traversal | "Everything related to our Q2 strategy" |
| **Insight Search** | 5-15s | LLM-powered analysis | "What patterns exist across our hiring decisions?" |

All tiers include:
- **Query rewriting** — Filler word removal, synonym expansion, entity extraction
- **Semantic deduplication** — Jaccard similarity clustering to remove near-duplicates
- **Multi-signal reranking** — Vector score (40%) + term overlap (25%) + recency (15%) + authority (10%) + relationship density (10%)

### The Knowledge Graph Visualization

The Memory Graph is not a feature — it's the **identity** of HIVEMIND. A living, breathing visualization of your second brain:

- **Layer-based node shapes** — Facts are diamonds, observations are rounded squares, TARA insights are stars, promoted risks have red halos, verified memories glow green
- **Triple operator edges** — Blue solid lines for Updates, green for Extends, purple dashed for Derives
- **Temporal weighting** — Recent memories glow brighter; older ones fade but remain connected
- **Team coloring** — In enterprise team scope, nodes are color-coded per team member, showing collective knowledge at a glance
- **Three scope modes** — Personal (your brain), Team (your team's brain), All (the organization's brain)

---

## Connectors

| Connector | Status | Sync Mode |
|-----------|--------|-----------|
| Gmail | Live | Incremental (thread-grouped) |
| Google Drive | Live | Full + delta |
| Slack | Live | Channel-based |
| Notion | Live | Page-based |
| GitHub | Live | PR/issue/commit |
| Obsidian | Live | Vault sync |
| Claude (MCP) | Live | Conversation capture |
| Linear | Planned | Issue tracking |
| Figma | Planned | Design decisions |
| Confluence | Planned | Enterprise wiki |

Each connector supports **scope selection**:
- **My Space** (personal) — Synced content is private to you
- **Team Workspace** (organization) — Synced content is shared with your team (Enterprise only)

---

## User Profiles

HIVEMIND maintains a persistent user profile that travels with every interaction:

```
User Profile:
  name: Amar (confirmed 3x)
  company: DaVinci AI (confirmed 2x)
  role: founder
  location: Bangalore (confirmed 4x)
  timezone: IST (confirmed 2x)
Preferences:
  - dark mode (confirmed 3x)
Current Goals:
  - Ship Enterprise Teams feature
```

Profile facts are:
- **Auto-extracted** from conversations and ingested content (regex pattern matching)
- **Explicitly writable** via `POST /api/profiles`
- **Version-tracked** — value changes are logged, contradictions detected
- **Injected into every recall** — your AI tools know who you are without being told

---

## Plans & Pricing

|  | **Free** | **Pro** | **Scale** | **Enterprise** |
|---|---------|---------|-----------|----------------|
| **Price** | Free | 19/mo | 199/mo | Custom |
| **Tokens/mo** | 1M | 5M | 80M | Unlimited |
| **Searches/mo** | 10K | 100K | 2M | Unlimited |
| **Users** | 1 | 5 | 25 | Unlimited |
| **Connectors** | 1 | 10 | Unlimited | Unlimited |
| **Memory Graph** | Yes | Yes | Yes | Yes |
| **MCP Protocol** | Yes | Yes | Yes | Yes |
| **Agent Swarm (CSI)** | Yes | Yes | Yes | Yes |
| **Web Intelligence** | - | Yes | Yes | Yes |
| **LLM Observer** | - | Yes | Yes | Yes |
| **TARA Voice Agent** | - | Yes | Yes | Yes |
| **Webhooks** | - | - | Yes | Yes |
| **Audit Logs** | - | - | Yes | Yes |
| **SSO / SAML** | - | - | Yes | Yes |
| **DPA Compliance** | - | - | Yes | Yes |
| **Team Workspaces** | - | - | - | Yes |
| **HYOK Encryption** | - | - | - | Yes |
| **Dedicated Infra** | - | - | - | Yes |
| **SLA** | None | 99.5% | 99.9% | Custom |
| **Support** | Community | Email | Priority | Dedicated CSM |

---

## Enterprise Teams

Shared memory workspaces where org admins invite employees, each employee connects their own integrations and chooses per-connector whether to sync to "My Space" or "Team Workspace."

**Features:**
- **Invite system** — Generate shareable `/join/{slug}/{token}` links, email-restricted invites, role assignment (admin/member/viewer)
- **Member management** — List members, change roles, remove members
- **Project channels** — Organize team memories by project with dedicated slugs
- **Per-user graph coloring** — Memory Graph shows color-coded nodes per employee in team scope
- **Connector scope choice** — Each connector can sync to personal or organization-wide storage
- **Org-wide CSI** — Faraday/Feynman/Turing scan across all team members' memories for cross-employee knowledge linking

---

## API

### Core Endpoints

```
POST   /api/memories              — Ingest memory (async with job_id, or ?sync=true)
GET    /api/memories/ingest/status — Check async ingest job status
GET    /api/recall                — Recall with graph traversal + profile context
POST   /api/search/quick          — Fast semantic search (<250ms)
POST   /api/search/panorama       — Deep multi-hop search
POST   /api/search/insight        — LLM-powered analytical search
GET    /api/graph                 — Knowledge graph nodes + edges + resident activity
```

### Profile Endpoints

```
GET    /api/profiles              — List all profile facts (?category=&key=)
POST   /api/profiles              — Upsert fact(s) (supports batch array)
DELETE /api/profiles              — Soft-delete a fact
GET    /api/profiles/context      — Get formatted LLM context string
POST   /api/profiles/extract      — Auto-extract facts from text content
GET    /api/profiles/history      — Version history for a profile fact key
```

### Team Endpoints

```
POST   /api/team/invites          — Create invite link
GET    /api/team/invites          — List pending invites
DELETE /api/team/invites/:id      — Revoke invite
POST   /api/team/invites/:token/accept — Accept invite
GET    /api/team/members          — List org members with roles
PATCH  /api/team/members/:userId  — Change member role
DELETE /api/team/members/:userId  — Remove member
GET    /api/team/projects         — List projects
POST   /api/team/projects         — Create project
PATCH  /api/team/projects/:id     — Update project
DELETE /api/team/projects/:id     — Delete project
```

### Webhook Endpoints (Scale/Enterprise)

```
GET    /api/webhooks              — List webhook subscriptions
POST   /api/webhooks              — Create webhook (HMAC-SHA256 signed)
DELETE /api/webhooks/:id          — Delete webhook
```

Events: `memory.created`, `memory.updated`, `memory.deleted`, `ingest.job_complete`

### Connector Endpoints

```
GET    /api/connectors/gmail/connect     — Start Gmail OAuth
GET    /api/connectors/gmail/callback    — OAuth callback
GET    /api/connectors/gmail/status      — Connection status + target_scope
POST   /api/connectors/gmail/sync        — Configure and trigger sync
POST   /api/connectors/gmail/disconnect  — Disconnect
PATCH  /api/connectors/:provider/scope   — Change sync scope (personal/organization)
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Core Server** | Node.js (ESM), custom HTTP server |
| **Database** | PostgreSQL 16 (Prisma ORM) |
| **Vector Store** | Qdrant (bge-m3 embeddings) |
| **Frontend** | React 18, TailwindCSS, Framer Motion |
| **Graph Viz** | react-force-graph-2d (D3 force simulation) |
| **Auth** | ZITADEL IAM + API keys (HMAC-SHA256) |
| **Encryption** | AES-256-GCM (connector tokens), HYOK support |
| **Deployment** | Docker, Coolify, EU infrastructure (fr-par-1) |
| **LLM** | Claude (Anthropic), Groq (Llama 3.3), OpenAI (fallback) |
| **MCP** | Model Context Protocol server (13+ tools) |

---

## What Makes HIVEMIND Different

| Feature | Obsidian | Notion | Mem.ai | SuperMemory | **HIVEMIND** |
|---------|----------|--------|--------|-------------|-------------|
| Auto-capture from tools | No | No | Partial | Yes | **Yes** |
| Knowledge graph | Manual links | No | No | No | **Automatic** |
| Triple operators | No | No | No | Yes | **Yes + auto-Derives** |
| Contradiction detection | No | No | No | No | **Yes** |
| User profile persistence | No | No | Partial | Yes | **Yes + auto-extract** |
| Team shared memory | No | Yes | No | Yes | **Yes + per-user coloring** |
| Autonomous CSI agents | No | No | No | No | **Yes (Faraday/Feynman/Turing)** |
| Content normalization | No | No | No | Partial | **Yes (6 source types)** |
| Multi-signal reranking | No | No | No | No | **Yes (5 signals)** |
| EU data residency | No | Partial | No | No | **Yes** |
| Voice agent (TARA) | No | No | No | No | **Yes** |
| MCP integration | Plugin | No | No | No | **Native (13+ tools)** |

---

## Getting Started

```bash
# Clone
git clone https://github.com/amar3012005/HIVEMIND.git
cd HIVEMIND

# Start infrastructure
docker compose up -d

# Environment
cp core/.env.example core/.env
# Edit core/.env with your database, Qdrant, and LLM API keys

# Run migrations
cd core && npx prisma migrate deploy

# Start the server
npm start
# Server runs on http://localhost:3001

# Frontend (separate repo)
cd frontend/Da-vinci
npm install && npm start
# Frontend runs on http://localhost:3000
```

---

## Repository Structure

```
HIVEMIND/
  core/
    src/
      server.js                          # Main HTTP server (5800+ lines)
      memory/
        graph-engine.js                  # Core ingest pipeline + triple operators
        prisma-graph-store.js            # PostgreSQL storage layer
        smart-ingest-router.js           # Type-aware ingestion preprocessing
        content-normalizer.js            # Source-specific content cleanup
        profile-store.js                 # Persistent user profile facts
        conflict-detector.js             # Contradiction detection
        ingest-tracker.js                # Async job tracking
      search/
        query-rewriter.js               # Deterministic query expansion
        result-dedup.js                  # Semantic deduplication
        result-reranker.js               # Multi-signal reranking
      external/search/
        three-tier-retrieval.js          # Quick/Panorama/Insight search
      resident/
        faraday.js                       # CSI Observer agent
        feynman.js                       # CSI Hypothesizer agent
        turing.js                        # CSI Verifier agent
        graph-action-executor.js         # Graph mutation executor
      connectors/framework/
        sync-engine.js                   # Connector sync orchestrator
        connector-store.js               # Encrypted token storage
        provider-adapter.js              # Provider abstraction
      webhooks/
        webhook-manager.js               # Event webhook dispatch
      audit/
        audit-logger.js                  # Compliance audit logging
      billing/
        plan-enforcer.js                 # Plan limit enforcement
    prisma/
      schema.prisma                      # 32 models, full schema
  frontend/Da-vinci/                     # React frontend (Vercel)
  docs/                                  # Documentation
  benchmarks/                            # MemoryBench evaluation
```

---

*Built by DaVinci AI. Engineered in Bangalore, deployed in Europe.*
