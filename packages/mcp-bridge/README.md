# @amar_528/mcp-bridge

**Sovereign EU MCP Bridge for Claude Desktop and Cursor**

Connect your AI IDE to GDPR-compliant, sovereign European memory storage.

## Quick Start

### Option 1: Claude Desktop (Recommended)

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": [
        "-y",
        "@amar_528/mcp-bridge",
        "hosted",
        "--url",
        "https://hivemind.davinciai.eu:8050/api/mcp/servers/00000000-0000-4000-8000-000000000001",
        "--user-id",
        "00000000-0000-4000-8000-000000000001"
      ],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_CONNECTION_TOKEN": "YOUR_TOKEN",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001",
        "HIVEMIND_ORG_ID": "00000000-0000-4000-8000-000000000002"
      }
    }
  }
}
```

### Option 2: Global Installation

```bash
npm install -g @amar_528/mcp-bridge
```

Then use the full path in your config:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": [
        "/usr/local/lib/node_modules/@amar_528/mcp-bridge/dist/cli.js",
        "hosted",
        "--url",
        "https://hivemind.davinciai.eu:8050/api/mcp/servers/00000000-0000-4000-8000-000000000001",
        "--user-id",
        "00000000-0000-4000-8000-000000000001"
      ],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY",
        "HIVEMIND_CONNECTION_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

## Available Tools

Once connected, you have access to these MCP tools:

| Tool | Description |
|------|-------------|
| `save_memory` | Save text, code, or data to sovereign storage |
| `recall` | Search memories with semantic ranking |
| `list_memories` | List all memories with filters |
| `get_memory` | Retrieve a specific memory by ID |
| `delete_memory` | Delete a memory |
| `get_context` | Get contextual information |
| `search_memories` | Hybrid search across memories |
| `traverse_graph` | Navigate memory relationships |

## Usage Examples

### Save a Memory

```
Save this code snippet:

const greet = (name) => `Hello, ${name}!`;

Tags: javascript, utility, greeting
Project: my-app
```

### Search Memories

```
Find memories about authentication patterns
```

### Recall Context

```
What do I know about the user preferences API?
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HIVEMIND_API_URL` | No | Optional base API URL when `--url` is not passed |
| `HIVEMIND_HOSTED_URL` | No | Optional hosted descriptor URL when `--url` is not passed |
| `HIVEMIND_API_KEY` | Yes | Authentication API key |
| `HIVEMIND_CONNECTION_TOKEN` | No | Hosted MCP connection token |
| `HIVEMIND_USER_ID` | No | User identifier (auto-generated if not set) |

## Local Development Mode

For testing against a local HIVE-MIND server:

```bash
npx @amar_528/mcp-bridge local --url http://localhost:3000
```

## Command Line Options

```
USAGE:
  npx @amar_528/mcp-bridge [mode] [options]

MODES:
  hosted    Connect to hosted HIVE-MIND API (default)
  local     Connect to local development server

OPTIONS:
  --url <url>         API URL (overrides env var)
  --api-key <key>     API key (overrides env var)
  --user-id <id>      User ID (overrides env var)
  --verbose, -v       Enable verbose logging
  --version           Show version number
  --help, -h          Show help message
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│  MCP Bridge      │────▶│  HIVE-MIND API  │
│  (MCP Client)   │     │  (npx @amar_528) │     │  (Hetzner EU)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                    │
                     ┌──────────────────────────────┼──────────────┐
                     │                              │              │
                     ▼                              ▼              ▼
            ┌─────────────────┐           ┌─────────────────┐     │
            │  PostgreSQL     │           │  Qdrant Cloud   │     │
            │  (Metadata)     │           │  (Vectors)      │     │
            └─────────────────┘           └─────────────────┘     │
                                                                  │
                                                    ┌─────────────────┐
                                                    │  Hetzner        │
                                                    │  Embeddings     │
                                                    │  (all-MiniLM)   │
                                                    └─────────────────┘
```

## Data Residency

All data is stored in the European Union:

- **PostgreSQL**: Hetzner Cloud (Falkenstein, Germany)
- **Qdrant Cloud**: AWS Frankfurt (EU region)
- **Embeddings**: Hetzner Cloud (Falkenstein, Germany)

This ensures GDPR compliance for European enterprises with strict data residency requirements.

## Comparison with Supermemory

| Feature | HIVE-MIND | Supermemory |
|---------|-----------|-------------|
| Data Residency | EU (Hetzner) | US (Cloudflare) |
| GDPR Compliance | Yes | Limited |
| Infrastructure | Sovereign EU | US-centric |
| Target Market | European enterprises | Global |

## License

MIT License - See [LICENSE](LICENSE) file.

## Repository

https://github.com/hivemind/mcp-bridge

## Support

For issues or questions, please open an issue on GitHub.
