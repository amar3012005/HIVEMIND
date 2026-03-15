# HIVE-MIND Skills Installation Guide for Claude Code

This guide explains how to install and use the HIVE-MIND skills and subagents in Claude Code.

## Quick Start

```bash
# Clone or navigate to HIVE-MIND directory
cd /Users/amar/HIVE-MIND

# Install skills (copy to Claude Code skills directory)
cp skills/*.json ~/.claude/skills/

# Install subagents (copy to Claude Code agents directory)
cp subagents/*.json ~/.claude/agents/

# Verify installation
claude /skills list
```

## Skills Overview

| Skill | Purpose | Key Commands |
|-------|---------|--------------|
| `hivemind-memory` | Core memory engine with graph relationships | `memory_store`, `memory_search`, `memory_relate` |
| `hivemind-chunker` | AST-aware content processing | `chunk_code`, `chunk_contextualize` |
| `hivemind-sovereign` | EU infrastructure deployment | `sovereign_deploy`, `sovereign_encrypt` |
| `hivemind-mcp` | MCP protocol server | `mcp_serve`, `mcp_auto_recall` |
| `hivemind-cognitive` | Smart forgetting & lifecycle | `cognitive_compact`, `cognitive_decay_calculate` |
| `hivemind-iam` | ZITADEL identity management | `iam_init`, `iam_org_create` |

## Subagent Usage

Invoke subagents with the `/` command:

```bash
# Design the database schema
/agent-hive-architect "design the memory graph schema with Updates, Extends, Derives relationships"

# Deploy to Hetzner
/agent-hive-sre "generate terraform for Hetzner deployment with LUKS encryption"

# Test memory flows
/agent-hive-qa "create test suite for graph relationship integrity"

# Document the API
/agent-hive-docs "generate OpenAPI spec for the MCP server"
```

## Daily Workflow

```bash
# Store a memory
/hivemind-memory store "We decided to use Qdrant for vector search" \
  --tags=architecture,decision \
  --project=hivemind-core

# Search memories
/hivemind-memory search "vector database decision"

# Chunk a codebase
/hivemind-chunker chunk_code ./src --strategy=ast

# Deploy infrastructure
/hivemind-sovereign deploy component=database provider=hetzner

# Start MCP server
/hivemind-mcp serve --port=3000

# Check compliance
/hivemind-iam audit_export --start-date=2024-01-01 --format=json
```

## Environment Setup

1. Copy environment template:
   ```bash
   cp infra/.env.example infra/.env
   ```

2. Fill in your values:
   - Database credentials
   - API keys (Mistral, etc.)
   - Provider tokens (Hetzner, Scaleway, OVHcloud)

3. Deploy the stack:
   ```bash
   cd infra
   ./deploy.sh
   ```

## Architecture

```
User Request → MCP Protocol (hivemind-mcp)
                    ↓
    ┌───────────────┼───────────────┐
    ↓               ↓               ↓
Memory Graph    Compliance      AI Models
(hivemind-    (hivemind-iam)  (Mistral/
 memory)                       Aleph Alpha)
    ↓
Sovereign Infra
(hivemind-sovereign)
    ↓
EU-native: Hetzner/Scaleway/OVHcloud
```

## Compliance

All skills enforce:
- **GDPR**: Data residency, right to erasure, portability
- **NIS2**: Security measures, incident reporting
- **DORA**: Digital operational resilience
- **Data Sovereignty**: EU-only providers, no US CLOUD Act exposure

## Troubleshooting

**Skill not found?**
```bash
# Check Claude Code skills directory
ls ~/.claude/skills/

# Reload skills
claude /skills reload
```

**Permission denied on deploy.sh?**
```bash
chmod +x infra/deploy.sh
```

**Database connection failed?**
- Verify `.env` file exists and is populated
- Check PostgreSQL is running: `docker-compose ps postgres`
- Review logs: `docker-compose logs postgres`

## Next Steps

1. **Phase 1**: Deploy core services (`./deploy.sh core`)
2. **Phase 2**: Configure ZITADEL (`./deploy.sh iam`)
3. **Phase 3**: Start MCP server (`./deploy.sh mcp`)
4. **Phase 4**: Connect clients (Claude Desktop, Cursor)

## Support

For issues or questions:
- Review the full blueprint: `hivemind.md`
- Check skill documentation in `skills/*.json`
- Consult subagent prompts in `subagents/*.json`
