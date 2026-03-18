---
name: mcp-integration
description: MCP (Model Context Protocol) server development - tools, resources, prompts, and Claude Desktop integration
type: reference
---

# MCP Integration Skill

## Overview
Develop and maintain the HIVEMIND MCP server for Claude Desktop, Cursor IDE, and other MCP clients.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│  MCP Bridge      │────▶│  HIVEMIND API   │
│  (MCP Client)   │     │  (npx @hivemind) │     │  (Hetzner EU)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Configuration

**MCP Bridge**: `@hivemind/mcp-bridge` v2.0.0
**MCP Server**: `hivemind-hosted-mcp`
**Protocol**: `2024-11-05`

**Connection**:
- **URL**: `https://hivemind.davinciai.eu/api/mcp/servers/{userId}`
- **Token**: From `/api/mcp/servers/{userId}` response
- **User ID**: `00000000-0000-4000-8000-000000000001`

## Commands

### `/mcp add-tool`
Add a new MCP tool using Zod validation (Supermemory pattern).

**Workflow**:
1. Define tool schema with Zod in `mcp-bridge/src/server.ts`
2. Implement tool handler function
3. Export tool definition
4. Register in MCP server
5. Update mcp-config.json
6. Test with Claude Desktop
7. Update README.md

**Template (Zod/Supermemory Pattern)**:
```typescript
import { z } from 'zod';

// Define schema
const MyToolInputSchema = z.object({
  param1: z.string().describe("Description"),
  param2: z.number().default(10).optional()
});

type MyToolInput = z.infer<typeof MyToolInputSchema>;

// Export tool definition
export const MY_TOOL_DEFINITION = {
  name: 'my_tool',
  description: 'What the tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Description' },
      param2: { type: 'number', default: 10 }
    },
    required: ['param1']
  }
} as const;

// Handler
async function handleMyTool(input: MyToolInput) {
  // Implementation
  return { success: true, result: '...' };
}
```

### `/mcp test`
Run MCP test suite.

**Tests**:
1. List tools - verify all tools registered
2. Call each tool - verify response format
3. Test error handling
4. Test with Claude Desktop

**Command**:
```bash
cd /opt/HIVEMIND/mcp-server
node tests/test-tools.js
```

### `/mcp deploy`
Deploy MCP server to production.

**Workflow**:
1. Update version in `mcp-server/server.js`
2. Commit and push
3. Coolify auto-deploys
4. Verify health check
5. Test Claude Desktop connection

**Health Check**:
```bash
curl -X GET "https://hivemind.davinciai.eu/api/mcp/servers/00000000-0000-4000-8000-000000000001"
```

### `/mcp debug`
Debug MCP connection issues.

**Common Issues**:

**Issue**: Claude Desktop shows "Connection failed"
**Fix**:
1. Check server is running: `curl https://hivemind.davinciai.eu/health`
2. Check token is valid (24h expiry)
3. Check userId matches
4. Check Claude Desktop config:
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@hivemind/mcp-bridge"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu",
        "HIVEMIND_API_KEY": "hm_master_key_99228811",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

**Issue**: Tools not appearing
**Fix**:
1. Check TOOLS object in server.js
2. Restart MCP server
3. Reconnect Claude Desktop

**Issue**: Tool calls fail
**Fix**:
1. Check HIVEMIND_API_KEY in MCP server env
2. Check API endpoint is reachable
3. Check logs: `docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 | grep MCP`

## MCP Tools Reference

| Tool | Purpose | Input | Output |
|------|---------|-------|--------|
| `save_memory` | Save to memory | content, tags, type | memory ID |
| `recall` | Search memories | query, limit | ranked results |
| `list_memories` | List all | filters | memory list |
| `get_memory` | Get by ID | id | memory object |
| `delete_memory` | Delete | id | success boolean |
| `get_context` | Get context | query | context summary |
| `search_memories` | Hybrid search | query, filters | search results |
| `traverse_graph` | Graph traversal | startId, depth | path |

## MCP Resources Reference

| Resource | URI | Purpose |
|----------|-----|---------|
| Recent Memories | `memories://recent` | Last 10 memories |
| Favorites | `memories://favorites` | Starred memories |
| All Memories | `memories://all` | Complete list |

## MCP Prompts Reference

| Prompt | Purpose |
|--------|---------|
| `memory-summary` | Summarize memories for context |
| `context-injection` | Inject relevant context |

## Key Files

| File | Purpose |
|------|---------|
| `/opt/HIVEMIND/packages/mcp-bridge/src/server.ts` | MCP server with Zod validation |
| `/opt/HIVEMIND/packages/mcp-bridge/src/cli.ts` | CLI entrypoint for npx execution |
| `/opt/HIVEMIND/packages/mcp-bridge/README.md` | Bridge documentation |
| `/opt/HIVEMIND/mcp-server/server.js` | Hosted MCP server |
| `/opt/HIVEMIND/mcp-server/mcp-config.json` | Tool configurations |

## NPM Publication

**Package**: `@hivemind/mcp-bridge`

**Publish Commands**:
```bash
cd /opt/HIVEMIND/packages/mcp-bridge
npm version patch  # or minor/major
npm run build
npm publish --access public
```

**Post-Publish**:
1. Test with `npx @hivemind/mcp-bridge --version`
2. Update Claude Desktop config
3. Verify connection works

## Testing Checklist

- [ ] All tools list correctly
- [ ] save_memory creates memory in PostgreSQL + Qdrant
- [ ] recall returns ranked results
- [ ] get_memory retrieves by ID
- [ ] delete_memory removes from both stores
- [ ] Error messages are clear
- [ ] Claude Desktop shows all tools
- [ ] `npx @hivemind/mcp-bridge --version` works
