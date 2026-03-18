# HIVE-MIND MCP Bridge - Antigravity Setup

## Quick Setup

### Step 1: Install the Package

```bash
npm install -g @amar_528/mcp-bridge
```

### Step 2: Verify Installation

```bash
node /root/.npm-global/lib/node_modules/@amar_528/mcp-bridge/dist/cli.js --version
# Should output: @hivemind/mcp-bridge v2.0.5
```

### Step 3: Configure Claude Desktop

Add this to your `claude_desktop_config.json`:

**Linux:**
```bash
nano ~/.config/claude/claude_desktop_config.json
```

**macOS:**
```bash
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Config:**
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["/root/.npm-global/lib/node_modules/@amar_528/mcp-bridge/dist/cli.js"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu:8050",
        "HIVEMIND_API_KEY": "hm_master_key_99228811",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

### Step 4: Restart Claude Desktop

Close and reopen Claude Desktop. The HIVEMIND tools should now appear.

### Step 5: Test

Ask Claude: "What MCP tools are available?" or try "Save this to my memory: [some text]"

---

## Troubleshooting

### "Connection failed"
1. Check API URL includes port 8050: `https://hivemind.davinciai.eu:8050`
2. Verify server is running: `curl -k https://hivemind.davinciai.eu:8050/health`
3. Check API key is correct: `hm_master_key_99228811`

### Tools not appearing
1. Verify the CLI path is correct in config
2. Check Claude Desktop config JSON is valid
3. Restart Claude Desktop completely

### Find Your npm Global Path
```bash
npm root -g
```
Use this path in your claude_desktop_config.json args.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│  MCP Bridge      │────▶│  HIVEMIND API   │
│  (MCP Client)   │     │  (node CLI)      │     │  (Hetzner EU)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                    │       │
                                           ┌────────┘       └────────┐
                                           ▼                         ▼
                                    ┌─────────────┐           ┌─────────────┐
                                    │  PostgreSQL │           │   Qdrant    │
                                    │  (Memory)   │           │  (Vectors)  │
                                    └─────────────┘           └─────────────┘
```

All data resides in Hetzner Cloud, Falkenstein, Germany - GDPR compliant.

## Available Tools

| Tool | Description |
|------|-------------|
| `save_memory` | Save text, code, or data with optional tags |
| `recall` | Semantic search across memories |
| `list_memories` | List all memories |
| `get_memory` | Get specific memory by ID |
| `delete_memory` | Delete a memory |
| `get_context` | Get contextual information |
| `search_memories` | Hybrid search |
| `traverse_graph` | Navigate memory relationships |
