# HIVE-MIND

**Sovereign European AI Memory Platform**

A self-hosted, EU-compliant memory engine for AI applications. Replicates Supermemory.ai with full data sovereignty—no US CLOUD Act exposure.

## What is HIVE-MIND?

HIVE-MIND provides AI applications with persistent, evolving memory using a graph-based relational ontology. It enables:

- **Triple-Operator Memory**: Updates, Extends, Derives relationships
- **AST-Aware Code Chunking**: Tree-sitter powered technical ingestion
- **Auto-Recall**: Pre-inference memory injection
- **Smart Forgetting**: Ebbinghaus curve-based decay
- **MCP Protocol**: Universal connectivity across AI clients

## Key Features

| Feature | Implementation | Benefit |
|---------|---------------|---------|
| **Graph Memory** | PostgreSQL + Apache AGE | Multi-hop relationship queries |
| **Vector Search** | Qdrant | Sub-300ms semantic search |
| **Code Understanding** | Tree-sitter | AST-aware chunking |
| **EU Sovereignty** | Hetzner/Scaleway/OVHcloud | Zero US jurisdiction |
| **Encryption** | LUKS2 + Managed HSM | Hardware-level security |
| **Identity** | ZITADEL | NIS2/DORA compliant IAM |
| **Protocol** | MCP | Universal AI client support |

## Quick Start

```bash
# 1. Clone and enter directory
cd /Users/amar/HIVE-MIND

# 2. Configure environment
cp infra/.env.example infra/.env
# Edit .env with your settings

# 3. Deploy
cd infra && ./deploy.sh

# 4. Access services
# PostgreSQL: localhost:5432
# Qdrant:     localhost:6333
# MCP Server: localhost:3000
# ZITADEL:    localhost:8080
```

### Local UX + Ultimate API Key Test

```bash
# Start Docker local stack, including the API container on :3000
./scripts/run-local-ux.sh

# Open UX testing page
# http://localhost:3000/ux-test
```

Reference docs:
- `docs/API_REFERENCE.md`
- `project_status/GO_LIVE_CHECKLIST.md`

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Clients                          │
│   (Claude Desktop, Cursor, OpenCode, Continue)         │
└────────────────────┬────────────────────────────────────┘
                     │ MCP Protocol (SSE/stdio)
┌────────────────────▼────────────────────────────────────┐
│                   MCP Server                             │
│   • Tools: memory_store, memory_search                   │
│   • Resources: memory://{id}, profile://{user}          │
│   • Prompts: summarize_session, contextualize_chunk     │
└────────────────────┬────────────────────────────────────┘
                     │
    ┌────────────────┼────────────────┐
    ↓                ↓                ↓
┌─────────┐    ┌─────────┐     ┌──────────┐
│ Memory  │    │ Vector  │     │ Identity │
│ Graph   │    │ Store   │     │ (ZITADEL)│
│(PostgreSQL+│   │(Qdrant) │     │          │
│ Apache   │    │         │     └──────────┘
│ AGE)     │    └─────────┘
└─────────┘
    │
    ↓
┌─────────────────────────────────────────────────────────┐
│              Sovereign EU Infrastructure                │
│   Hetzner (DE) → Scaleway (FR) → OVHcloud (FR)         │
│   • LUKS2 Encryption  • Managed HSM  • SecNumCloud     │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
HIVE-MIND/
├── hivemind.md              # Full architectural blueprint
├── INSTALL.md               # Claude Code installation guide
├── skills/                  # Claude Code skills (6 skills)
│   ├── hivemind-memory.json
│   ├── hivemind-chunker.json
│   ├── hivemind-sovereign.json
│   ├── hivemind-mcp.json
│   ├── hivemind-cognitive.json
│   └── hivemind-iam.json
├── subagents/               # Claude Code subagents (4 agents)
│   ├── agent-hive-architect.json
│   ├── agent-hive-sre.json
│   ├── agent-hive-qa.json
│   └── agent-hive-docs.json
└── infra/                   # Infrastructure as Code
    ├── docker-compose.sovereign.yml
    ├── .env.example
    └── deploy.sh
```

## Phased Deployment

### Phase 1: Core Memory Engine
- PostgreSQL with Apache AGE
- Qdrant vector store
- Triple-operator graph (Updates/Extends/Derives)

### Phase 2: Sovereign Stack
- Hetzner/Scaleway/OVHcloud deployment
- LUKS2 encryption at rest
- Managed HSM integration

### Phase 3: Technical Ingestion
- Tree-sitter AST chunking
- Scope tree enrichment
- Contextual retrieval

### Phase 4: MCP Protocol
- Universal client connectivity
- Auto-Recall pattern
- Weighted memory scoring

### Phase 5: Cognitive Lifecycle
- Ebbinghaus decay curves
- Preemptive compaction
- Session end hooks

### Phase 6: Local/Hybrid Bridge
- Local Qdrant deployment
- HYOK encryption
- Cloud sync option

## Compliance

| Framework | Status | Implementation |
|-----------|--------|----------------|
| **GDPR** | ✅ Compliant | Data residency, erasure, portability |
| **NIS2** | ✅ Compliant | Security measures, incident reporting |
| **DORA** | ✅ Compliant | Digital operational resilience |
| **SecNumCloud** | ✅ Supported | OVHcloud qualified instances |

## API Example

```javascript
// Store memory with relationship
const memory = await hivemind.memory_store({
  content: "We decided to use Qdrant over pgvector",
  tags: ["architecture", "decision"],
  project: "hivemind-core",
  relationship: {
    type: "Extends",
    target_id: "prev-decision-123"
  }
});

// Search with hybrid scoring
const results = await hivemind.memory_search({
  query: "vector database choice",
  weights: { similarity: 0.5, recency: 0.3, importance: 0.2 }
});

// Traverse graph relationships
const related = await hivemind.memory_traverse({
  start_id: memory.id,
  depth: 2,
  relationship_types: ["Derives", "Extends"]
});
```

## MCP Client Configuration

### Claude Desktop
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "docker",
      "args": ["exec", "-i", "hivemind-mcp", "node", "/app/mcp-server"],
      "env": {
        "MCP_AUTH_SECRET": "your-secret"
      }
    }
  }
}
```

### Cursor
Add to Cursor Settings > MCP:
- URL: `http://localhost:3000`
- Transport: `sse`

## Skills & Subagents

### Available Skills

| Skill | Purpose |
|-------|---------|
| `hivemind-memory` | Graph-based memory operations |
| `hivemind-chunker` | AST-aware content processing |
| `hivemind-sovereign` | EU infrastructure deployment |
| `hivemind-mcp` | MCP protocol server |
| `hivemind-cognitive` | Smart forgetting & decay |
| `hivemind-iam` | ZITADEL identity management |

### Available Subagents

| Subagent | Purpose |
|----------|---------|
| `agent-hive-architect` | System design and schema |
| `agent-hive-sre` | Infrastructure and deployment |
| `agent-hive-qa` | Testing and compliance |
| `agent-hive-docs` | Documentation and guides |

## Providers

### Primary (EU-Native)

| Provider | Country | Best For |
|----------|---------|----------|
| **Hetzner** | Germany (DE) | Compute, price-performance |
| **Scaleway** | France (FR) | Managed DB, GPU instances |
| **OVHcloud** | France (FR) | HSM, high-security tiers |

### Models (EU-Based)

| Provider | Models | Strength |
|----------|--------|----------|
| **Mistral AI** | Mistral Large 2 | Performance, cost |
| **Aleph Alpha** | Luminous | Explainability, BSI-certified |

## Security

- **Encryption at Rest**: LUKS2 (AES-256-XTS)
- **Encryption in Transit**: TLS 1.3
- **Key Management**: Managed HSM (OVHcloud)
- **HYOK**: Hold Your Own Key for enterprises
- **Tenant Isolation**: Organization-level separation (ZITADEL)

## License

EUPL-1.2 (European Union Public License)

## Acknowledgments

Inspired by Supermemory.ai architecture, rebuilt for European sovereignty.

---

**Data Never Leaves Europe** | **GDPR Native** | **NIS2 Ready**
