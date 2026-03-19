# HIVE-MIND Hosted MCP Service

## Overview

The **Hosted MCP Service** transforms HIVE-MIND from a local-only MCP server into a **"Context-as-a-Service"** platform. Users simply paste a URL into Claude Desktop, Cursor, or ChatGPT instead of running Node.js scripts locally.

## The "Ultimate API Key" Experience

```
User Journey:
1. Sign up for HIVE-MIND → Get API Key
2. Paste URL into Claude Desktop: https://hivemind.davinciai.eu:8050/api/mcp/servers/{userId}
3. Done! Cross-platform memory sync enabled
```

## API Endpoints

### GET /api/mcp/servers/:userId

Returns a user-specific MCP server configuration.

**Headers:**
- `X-API-Key`: Your HIVE-MIND API key
- `X-Org-Id`: Organization ID (optional)

**Response:**
```json
{
  "mcp": {
    "protocolVersion": "2024-11-05",
    "serverInfo": {
      "name": "hivemind-hosted-mcp",
      "version": "2.0.0"
    }
  },
  "connection": {
    "serverId": "uuid",
    "endpoints": {
      "sse": "https://hivemind.davinciai.eu:8050/api/mcp/servers/{userId}/sse?token=...",
      "message": "https://hivemind.davinciai.eu:8050/api/mcp/servers/{userId}/message?token=...",
      "jsonrpc": "https://hivemind.davinciai.eu:8050/api/mcp/servers/{userId}/rpc?token=..."
    },
    "token": "connection-token",
    "expiresAt": "2026-03-18T..."
  },
  "tools": [...],
  "resources": [...],
  "prompts": [...],
  "clientConfig": {
    "bridge": {...},
    "claudeDesktop": {...},
    "antigravity": {...},
    "cursor": {...},
    "vscode": {...},
    "webappConnectors": {...},
    "simpleUrl": "..."
  }
}
```

## Available MCP Tools

### hivemind_save_memory
Save information to persistent memory with triple-operator relationships (update/extend/derive).

```json
{
  "title": "Docker Best Practices",
  "content": "Multi-stage builds reduce image size...",
  "source_type": "code",
  "tags": ["docker", "devops"],
  "project": "knowledge-base",
  "relationship": "update",
  "related_to": "memory-uuid"
}
```

### hivemind_recall
Search memories using three-tier retrieval (quick/panorama/insight).

```json
{
  "query": "docker deployment patterns",
  "mode": "insight",
  "limit": 5,
  "tags": ["devops"]
}
```

### hivemind_save_conversation
Save entire conversations for future reference.

```json
{
  "title": "React Hooks Discussion",
  "messages": [...],
  "platform": "claude",
  "tags": ["react"]
}
```

### hivemind_traverse_graph
Traverse memory graph relationships.

```json
{
  "memory_id": "uuid",
  "relationship": "extend",
  "depth": 2
}
```

### hivemind_query_with_ai
AI-powered natural language queries with synthesized answers.

```json
{
  "question": "What are my current deployment patterns?",
  "context_limit": 5
}
```

## Client Configuration Examples

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted", "--url", "https://hivemind.davinciai.eu:8050/api/mcp/servers/YOUR_USER_ID", "--user-id", "YOUR_USER_ID"],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_CONNECTION_TOKEN": "YOUR_TOKEN",
        "HIVEMIND_USER_ID": "YOUR_USER_ID",
        "HIVEMIND_ORG_ID": "YOUR_ORG_ID"
      }
    }
  }
}
```

### Antigravity

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcp_servers": {
    "hivemind": {
      "command": "/usr/bin/node",
      "args": [
        "/root/.npm-global/lib/node_modules/@amar_528/mcp-bridge/dist/cli.js",
        "hosted",
        "--url",
        "https://hivemind.davinciai.eu:8050",
        "--user-id",
        "YOUR_USER_ID"
      ],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_CONNECTION_TOKEN": "YOUR_TOKEN",
        "HIVEMIND_USER_ID": "YOUR_USER_ID",
        "HIVEMIND_ORG_ID": "YOUR_ORG_ID",
        "NODE_NO_WARNINGS": "1"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted", "--url", "https://hivemind.davinciai.eu:8050/api/mcp/servers/YOUR_USER_ID", "--user-id", "YOUR_USER_ID"],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_CONNECTION_TOKEN": "YOUR_TOKEN",
        "HIVEMIND_USER_ID": "YOUR_USER_ID",
        "HIVEMIND_ORG_ID": "YOUR_ORG_ID"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted", "--url", "https://hivemind.davinciai.eu:8050/api/mcp/servers/YOUR_USER_ID", "--user-id", "YOUR_USER_ID"],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_CONNECTION_TOKEN": "YOUR_TOKEN",
        "HIVEMIND_USER_ID": "YOUR_USER_ID",
        "HIVEMIND_ORG_ID": "YOUR_ORG_ID"
      }
    }
  }
}
```

### Webapp Connectors / XData Ingestion

Use the generated `clientConfig.webappConnectors` block when wiring hosted web flows:

- `POST /api/ingest` ingests raw xdata payloads
- `POST /api/memories/code/ingest` ingests code and documents
- `POST /api/integrations/webapp/prepare` prepares recall/context for web assistants
- `POST /api/integrations/webapp/store` stores decisions and answers from web UIs
- `POST /api/connectors/mcp/endpoints` registers external MCP sources
- `POST /api/connectors/mcp/inspect` inspects external MCP capabilities
- `POST /api/connectors/mcp/ingest` imports external MCP data into HIVE-MIND

### Direct HTTP (Advanced)

For clients supporting HTTP transport:

```bash
curl https://hivemind.davinciai.eu:8050/api/mcp/servers/YOUR_USER_ID/rpc \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

## Security

- **Connection tokens** expire after 24 hours
- **Token validation** on every request
- **Tokenized descriptor URL** available via `clientConfig.simpleUrl`
- **User ID verification** prevents unauthorized access
- **Rate limiting** built-in (60 req/min, 1000 req/hour)
- **HMAC-SHA256** token generation

## Comparison: Local vs Hosted MCP

| Feature | Local MCP | Hosted MCP |
|---------|-----------|------------|
| Setup | Install Node.js, clone repo, run server | Paste URL |
| Updates | Manual git pull | Automatic |
| Scaling | Single machine | Cloud-native |
| Multi-device | Complex sync | Native support |
| EU Sovereignty | Self-hosted option | Hetzner DE infrastructure |

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│  Hosted MCP API  │────▶│  HIVE-MIND Core │
│  Cursor         │     │  /api/mcp/servers│     │  Triple-Operator│
│  ChatGPT        │     └──────────────────┘     │  Memory Engine  │
└─────────────────┘              │               └─────────────────┘
                                 │                        │
                                 ▼                        ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Connection Token│     │  PostgreSQL     │
                        │  Validation      │     │  Qdrant         │
                        └──────────────────┘     └─────────────────┘
```

## Future Enhancements

- **SSE Streaming**: Real-time memory updates
- **WebSocket Support**: Bidirectional sync
- **Multi-tenant Isolation**: Organization-level endpoints
- **Custom Tool Registration**: User-defined MCP tools
- **Analytics Dashboard**: Usage tracking per user/org

## References

- [Model Context Protocol Spec](https://modelcontextprotocol.io/)
- [Supermemory MCP Implementation](https://github.com/supermemory/supermemory)
- [Client Configuration Guide](./mcp-client-configuration.md)
- [HIVE-MIND Architecture](../hivemind.md)
