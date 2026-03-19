# HIVE-MIND Cross-Platform MCP Configuration

This document is the production reference for HIVE-MIND MCP clients on the live server:

- API base URL: `https://hivemind.davinciai.eu:8050`
- Hosted descriptor: `https://hivemind.davinciai.eu:8050/api/mcp/servers/<USER_ID>`
- Legacy-compatible RPC endpoint: `https://hivemind.davinciai.eu:8050/api/mcp/rpc`
- Published bridge package: `@amar_528/mcp-bridge`

The currently published bridge works best with the base API URL via env vars, not the hosted descriptor URL passed as `--url`.

## Recommended Defaults

- `USER_ID`: `00000000-0000-4000-8000-000000000001`
- `HIVEMIND_API_URL`: `https://hivemind.davinciai.eu:8050`
- `HIVEMIND_API_KEY`: your API key

## Claude Desktop

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu:8050",
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

## Antigravity

Stdio bridge config:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu:8050",
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001",
        "NODE_NO_WARNINGS": "1"
      }
    }
  }
}
```

Remote MCP config:

```json
{
  "mcpServers": {
    "hivemind-remote": {
      "serverUrl": "https://hivemind.davinciai.eu:8050/api/mcp/rpc",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY",
        "X-User-Id": "00000000-0000-4000-8000-000000000001",
        "Content-Type": "application/json"
      }
    }
  }
}
```

## VS Code / Cursor

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu:8050",
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

## Hosted Descriptor

Use the hosted descriptor when you want the live server to generate the latest client config:

- `GET /api/mcp/servers/<USER_ID>`

This endpoint returns:

- connection details
- tool/resource/prompt manifests
- a `clientConfig` block with copy-paste client examples

## Direct Ingestion And Web Connectors

Use these endpoints when the client is not speaking MCP directly or when you want direct xdata ingestion.

### Raw memory ingestion

`POST /api/ingest`

```json
{
  "source_type": "text",
  "title": "Imported XData",
  "content": "Raw external data to ingest",
  "project": "antigravity",
  "tags": ["xdata", "import"]
}
```

### Memory write

`POST /api/memories`

```json
{
  "title": "Security Cleanup & Git History Scrubbing (March 2026)",
  "content": "Imported memory content",
  "memory_type": "event",
  "project": "HIVE-MIND",
  "tags": ["mcp", "xdata"]
}
```

### Webapp prepare

`POST /api/integrations/webapp/prepare`

```json
{
  "platform": "chatgpt",
  "query": "What do we already know about xdata ingestion?",
  "project": "antigravity",
  "preferred_source_platforms": ["claude", "antigravity"],
  "preferred_tags": ["xdata"],
  "max_memories": 5
}
```

### Webapp store

`POST /api/integrations/webapp/store`

```json
{
  "platform": "chatgpt",
  "content": "Imported xdata summary from web workflow",
  "memory_type": "fact",
  "title": "XData import summary",
  "project": "antigravity",
  "tags": ["xdata", "webapp"]
}
```

### Code ingestion

`POST /api/memories/code/ingest`

```json
{
  "filepath": "src/example.ts",
  "content": "export const answer = 42;",
  "language": "typescript",
  "project": "antigravity",
  "tags": ["code", "xdata"],
  "source_platform": "vscode"
}
```

### MCP endpoint ingestion

1. Register with `POST /api/connectors/mcp/endpoints`
2. Inspect with `POST /api/connectors/mcp/inspect`
3. Ingest with `POST /api/connectors/mcp/ingest`

Example:

```json
{
  "endpoint_name": "linear-prod",
  "adapter": "linear",
  "project": "antigravity",
  "tags": ["xdata", "linear"],
  "operation": {
    "type": "tool",
    "name": "list_issues",
    "arguments": {
      "team": "HM"
    }
  }
}
```

## Production Notes

- Qdrant collection: `BUNDB AGENT`
- Embedding provider: Hetzner remote embedding service
- Embedding model: `all-MiniLM-L6-v2`
- Embedding dimension: `384`
- Cross-platform recall is verified for memory `2da3f8eb-5ce3-4b7c-bed5-95fa28d01594`
- `POST /api/search/quick` returns the Antigravity/Claude-saved memory for `Groq API`

## Do Not Use

Do not use this pattern with the currently published bridge:

```bash
npx -y @amar_528/mcp-bridge hosted --url https://hivemind.davinciai.eu:8050/api/mcp/servers/<USER_ID>
```

The published package expects `HIVEMIND_API_URL` as a base URL and can mis-handle the full descriptor URL.
