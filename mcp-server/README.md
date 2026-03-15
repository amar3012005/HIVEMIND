# HIVE-MIND MCP Server

Model Context Protocol (MCP) server for HIVE-MIND cross-platform memory system. This server enables AI assistants like Claude Desktop and Cursor IDE to access, store, and retrieve memories across all your AI conversations.

## Features

- **8 Memory Tools**: Save, recall, search, and manage memories
- **5 Resource URIs**: Access memory collections via URI schemes
- **2 Prompt Templates**: Pre-built prompts for memory operations
- **Meta-MCP Bridge Integration**: Cross-app context synchronization
- **Real-time Sync**: WebSocket/SSE for Cursor ↔ Claude ↔ ChatGPT synchronization
- **Cross-Platform Visibility**: Memories sync automatically across platforms
- **Semantic Search**: Vector-based similarity search with recency and importance weighting
- **Graph Traversal**: Navigate memory relationships (Updates, Extends, Derives)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    META-MCP BRIDGE ARCHITECTURE                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         META-MCP BRIDGE                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  User-Specific Endpoint Generation                                    │  │
│  │  • UUID-based endpoint per user                                       │  │
│  │  • Persistent connection across sessions                              │  │
│  │  • Cross-app visibility (Cursor ↔ Claude ↔ ChatGPT)                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│   Cursor     │    │  Claude Desktop  │    │  ChatGPT     │
│   MCP Client │    │  MCP Client      │    │  MCP Client  │
└───────┬──────┘    └────────┬─────────┘    └───────┬──────┘
        │                    │                     │
        └────────────────────┼─────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  HIVE-MIND Core │
                    │  • Memory Store │
                    │  • Search       │
                    │  • Recall       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  MCP Protocol   │
                    │  • Tools        │
                    │  • Resources    │
                    │  • Prompts      │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  State Sync     │
                    │  • Session      │
                    │  • Context      │
                    │  • Preferences  │
                    └─────────────────┘
```

## Installation

### Prerequisites

- Node.js 20+
- HIVE-MIND API server running
- MCP-compatible client (Claude Desktop, Cursor IDE, etc.)

### Setup

1. **Install dependencies**:
   ```bash
   cd /Users/amar/HIVE-MIND/mcp-server
   npm install
   ```

2. **Configure environment**:
   ```bash
   export HIVEMIND_API_URL=http://localhost:3000
   export HIVEMIND_API_KEY=your-api-key
   export CURRENT_USER_ID=your-user-id
   export MCP_SECRET_KEY=your-secret-key
   ```

3. **Add to MCP client configuration**:

   **Claude Desktop** (`claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "hivemind": {
         "command": "node",
         "args": ["/path/to/HIVE-MIND/mcp-server/server.js"],
         "env": {
           "HIVEMIND_API_URL": "http://localhost:3000",
           "HIVEMIND_API_KEY": "your-api-key",
           "CURRENT_USER_ID": "your-user-id",
           "MCP_SECRET_KEY": "your-secret-key"
         }
       }
     }
   }
   ```

   **Cursor IDE** (Settings → MCP → Add Server):
   ```json
   {
     "hivemind": {
       "command": "node",
       "args": ["/path/to/HIVE-MIND/mcp-server/server.js"],
       "env": {
         "HIVEMIND_API_URL": "http://localhost:3000",
         "HIVEMIND_API_KEY": "your-api-key",
         "MCP_SECRET_KEY": "your-secret-key"
       }
     }
   }
   ```

## Cross-App Context Synchronization

The Meta-MCP Bridge enables automatic context synchronization between all your AI platforms:

### How It Works

1. **Endpoint Generation**: Each user gets a unique UUID-based endpoint
2. **Real-time Sync**: Context updates are queued and synced across platforms
3. **Bidirectional**: Changes in any platform propagate to all others
4. **Conflict Resolution**: Vector clocks ensure consistent ordering

### Supported Platforms

| Platform | MCP Client | Sync Status |
|----------|------------|-------------|
| Cursor IDE | ✅ | Real-time |
| Claude Desktop | ✅ | Real-time |
| ChatGPT | ✅ | Real-time |
| Perplexity | ✅ | Real-time |
| Gemini | ✅ | Real-time |

### Configuration

```json
{
  "metaMcpBridge": {
    "enabled": true,
    "endpointPrefix": "hivemind",
    "endpointBaseUrl": "http://localhost:3000",
    "maxEndpointsPerUser": 5,
    "rateLimit": {
      "requestsPerMinute": 60,
      "requestsPerHour": 1000
    },
    "sync": {
      "interval": 1000,
      "maxBatchSize": 10,
      "timeout": 30000,
      "maxRetries": 3,
      "retryDelay": 1000
    }
  }
}
```

## Available Tools

### save_memory
Save information to persistent cross-platform memory.

**Parameters:**
- `content` (required): The content to remember (1-10000 characters)
- `memoryType`: Type of memory (fact, preference, decision, lesson, goal, event, relationship)
- `title`: Short descriptive title
- `tags`: Array of tags for categorization
- `importanceScore`: Importance 0-1 (default: 0.5)

**Example:**
```
Save this memory:
- Content: "User prefers TypeScript for backend development"
- Type: preference
- Tags: ["typescript", "backend", "programming"]
- Importance: 0.8
```

**Auto-Sync**: ✅ Context automatically syncs to all connected platforms

### recall
Search and retrieve relevant memories using natural language.

**Parameters:**
- `query` (required): Natural language search query
- `limit`: Maximum results (1-50, default: 10)
- `memoryTypes`: Filter by memory types
- `recencyBias`: Weight for recency (0-1, default: 0.5)

**Example:**
```
What do I know about TypeScript?
```

**Auto-Sync**: ✅ Context view updates synced to other platforms

### list_memories
List all memories with optional filtering.

**Parameters:**
- `limit`: Number to return (1-100, default: 20)
- `offset`: Pagination offset (default: 0)
- `memoryType`: Filter by type
- `tags`: Filter by tags
- `sourcePlatform`: Filter by source (chatgpt, claude, etc.)

**Example:**
```
List my last 10 decision memories
```

### get_memory
Get a specific memory by ID with relationships.

**Parameters:**
- `memoryId` (required): UUID of the memory
- `includeRelationships`: Include related memories (default: true)

**Example:**
```
Get memory 550e8400-e29b-41d4-a716-446655440000
```

### delete_memory
Delete a memory by ID (soft delete for GDPR).

**Parameters:**
- `memoryId` (required): UUID of the memory to delete

**Example:**
```
Delete memory 550e8400-e29b-41d4-a716-446655440000
```

### get_context
Get all relevant context for the current conversation.

**Parameters:**
- `topic`: Optional topic to filter context
- `format`: Output format (xml, json, markdown)

**Example:**
```
Get context for my healthcare project discussion
```

### search_memories
Advanced hybrid search with vector, keyword, and graph matching.

**Parameters:**
- `query` (required): Search query
- `filters`: Advanced filters (types, platform, tags, dates)
- `weights`: Scoring weights (similarity, recency, importance)
- `nResults`: Number of results (1-50)

**Example:**
```
Search for database decisions with high importance
```

### traverse_graph
Traverse the memory graph from a starting memory.

**Parameters:**
- `startId` (required): Starting memory ID
- `depth`: Traversal depth (1-5, default: 3)
- `relationshipTypes`: Types to follow (Updates, Extends, Derives)

**Example:**
```
Traverse graph from memory 550e8400-e29b-41d4-a716-446655440000 with depth 2
```

## Resource URIs

Access memory collections directly via URI:

| URI | Description | Format | Auto-Sync |
|-----|-------------|--------|-----------|
| `memories://recent` | Most recently accessed memories | JSON | ✅ |
| `memories://favorites` | High-importance memories (≥0.8) | JSON | ✅ |
| `memories://all` | Complete memory collection | JSON | ❌ |
| `context://current` | Active conversation context | XML | ✅ |
| `context://summary` | User context summary | Markdown | ✅ |

## Prompt Templates

### memory-summary
Generate a comprehensive summary of memories for a topic.

**Arguments:**
- `topic` (required): Topic to summarize

### context-injection
Inject relevant context into a conversation.

**Arguments:**
- `conversationId` (optional): Conversation identifier

## Cross-App Sync Protocol

### Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `context_update` | Server → Client | Context update from another platform |
| `context_request` | Client → Server | Request context from server |
| `context_response` | Server → Client | Response with context data |
| `context_ack` | Bidirectional | Acknowledgment of context sync |
| `ping` | Bidirectional | Keep-alive heartbeat |
| `pong` | Bidirectional | Response to ping |

### Protocol Flow

```
┌─────────────┐                    ┌─────────────┐
│   Cursor    │                    │  Claude     │
│   Platform  │                    │  Platform   │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │ 1. save_memory("TypeScript")     │
       │─────────────────────────────────>│
       │                                  │
       │ 2. Context queued for sync       │
       │                                  │
       │ 3. context_update message        │
       │─────────────────────────────────>│
       │                                  │
       │ 4. context_ack (success)         │
       │<─────────────────────────────────│
       │                                  │
       │ 5. Memory automatically available│
       │                                  │
```

## CLI Commands

### Generate Endpoint

```bash
node src/mcp/bridge.js generate <userId> <orgId> [platform]
```

Example:
```bash
node src/mcp/bridge.js generate user123 org456 cursor
```

### List Endpoints

```bash
node src/mcp/bridge.js list <userId>
```

### Show Statistics

```bash
node src/mcp/bridge.js stats
```

### Start Sync Server

```bash
node src/mcp/sync.js start
```

### Show Sync Statistics

```bash
node src/mcp/sync.js stats
```

## Development

### Running Locally

```bash
# Start the server
node mcp-server/server.js

# Or with the MCP inspector
npx @modelcontextprotocol/inspector node mcp-server/server.js
```

### Testing

```bash
# Run tests
npm test

# Test specific tool
node tests/test-tool.js save_memory
```

### Debugging

Enable debug logging:
```bash
export MCP_DEBUG=true
node mcp-server/server.js
```

## API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp/endpoints` | GET | List all endpoints for current user |
| `/api/mcp/endpoints` | POST | Create new endpoint |
| `/api/mcp/endpoints/:endpointId` | DELETE | Revoke endpoint |
| `/api/mcp/endpoints/:endpointId/rotate` | POST | Regenerate secret |

### Sync Protocol

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp/{endpointId}` | POST | Receive context updates |
| `/mcp/{endpointId}` | GET | Get context (SSE) |

## Troubleshooting

### Server Won't Start

1. Check Node.js version: `node --version` (must be 20+)
2. Verify dependencies: `npm install`
3. Check API URL: Ensure HIVE-MIND API is running

### Tools Not Appearing

1. Verify MCP client configuration
2. Check server logs for errors
3. Restart MCP client

### Cross-App Sync Not Working

1. Verify endpoint is active: `node src/mcp/bridge.js list <userId>`
2. Check sync queue: `node src/mcp/sync.js stats`
3. Verify API key has sync permissions

### Authentication Errors

1. Verify API key is correct
2. Check API key hasn't expired
3. Ensure user ID is valid

## Security

### Endpoint Security

- All endpoints use HMAC-SHA256 signature validation
- Secrets are rotated periodically
- Rate limiting prevents abuse
- Maximum 5 endpoints per user

### Sync Security

- All sync messages are authenticated
- Context size is limited (100KB max)
- TTL ensures stale data is purged
- Retry logic prevents data loss

## Performance

| Metric | Target | Typical |
|--------|--------|---------|
| Tool response time | <1s P99 | 200-500ms |
| Context injection | <200ms P99 | 50-150ms |
| Memory search | <300ms P99 | 100-200ms |
| Sync latency | <500ms P99 | 100-300ms |
| Endpoint generation | <5s | 1-2s |

## API Reference

For detailed API documentation, see:
- [HIVE-MIND API Docs](../README.md)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Cross-Platform Sync Spec](../CROSS_PLATFORM_SYNC_SPEC.md)

## License

Proprietary - HIVE-MIND Project

## Support

- Email: api@hivemind.io
- Documentation: https://hivemind.io/docs
- Issues: https://github.com/hivemind/hivemind/issues

---

**Version:** 2.0.0
**Last Updated:** March 9, 2026
**Meta-MCP Bridge:** Enabled
