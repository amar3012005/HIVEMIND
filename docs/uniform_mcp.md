# HIVEMIND MCP v1 — Canonical Contract

> Single source of truth for all MCP clients (Claude, VS Code, Antigravity, Cursor, Codex).
> Only transport/config differs by platform. Tool names, schemas, and behavior are identical.

## Tool Set (9 tools)

### hivemind_save_memory
Save a new memory to persistent storage.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| content | string | yes | Memory content text |
| title | string | no | Short title |
| tags | string[] | no | Categorization tags |
| memory_type | string | no | `fact`, `preference`, `decision`, `lesson`, `goal`, `event`, `relationship` |
| project | string | no | Project scope |
| source_platform | string | no | Origin platform identifier |
| relationship | object | no | `{type: "update"\|"extend"\|"derive", related_to: "<memory_id>"}` |

**Output:** `{id, title, memory_type, tags, created_at}`

### hivemind_recall
Search and retrieve relevant memories.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | yes | Natural language query |
| mode | string | no | `quick` (default), `panorama`, `insight` |
| max_memories | number | no | Max results (default: 5) |
| project | string | no | Project filter |
| tags | string[] | no | Tag filter |
| source_platforms | string[] | no | Platform filter |

**Output:** `{memories: [{id, title, content, tags, score, source, ...}], search_method, expansion_stats}`

### hivemind_get_memory
Retrieve a single memory by ID.

| Field | Type | Required |
|-------|------|----------|
| memory_id | string | yes |

**Output:** Full memory object with metadata.

### hivemind_list_memories
List memories with filters.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| limit | number | no | Max results (default: 20) |
| offset | number | no | Pagination offset |
| project | string | no | Project filter |
| memory_type | string | no | Type filter |
| tags | string[] | no | Tag filter |

**Output:** `{memories: [...], total, limit, offset}`

### hivemind_update_memory
Update an existing memory.

| Field | Type | Required |
|-------|------|----------|
| memory_id | string | yes |
| content | string | no |
| title | string | no |
| tags | string[] | no |
| project | string | no |

**Output:** Updated memory object.

### hivemind_delete_memory
Soft-delete a memory.

| Field | Type | Required |
|-------|------|----------|
| memory_id | string | yes |

**Output:** `{success: true, deleted_id}`

### hivemind_save_conversation
Save a conversation thread as memories.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| messages | object[] | yes | `[{role, content, timestamp?}]` |
| title | string | no | Conversation title |
| tags | string[] | no | Tags |
| project | string | no | Project scope |
| source_platform | string | no | Origin platform |

**Output:** `{saved_count, memory_ids: [...]}`

### hivemind_traverse_graph
Follow memory relationships.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| memory_id | string | yes | Starting memory UUID |
| relationship_types | string[] | no | `["update", "extend", "derive"]` |
| depth | number | no | Max traversal depth (default: 2, max: 5) |

**Output:** `{nodes: [...], edges: [{from, to, type, confidence}]}`

### hivemind_query_with_ai
LLM-powered analysis over memories.

| Field | Type | Required |
|-------|------|----------|
| query | string | yes |
| include_analysis | boolean | no |

**Output:** `{answer, evidence: [...], sub_queries: [...], entity_insights: [...]}`

## Relationship Enum

At the MCP layer, relationships use lowercase values:
- `update` — replaces a prior memory (old becomes `is_latest=false`)
- `extend` — adds to a prior memory (both remain `is_latest=true`)
- `derive` — inferred connection (async, confidence-scored)

Internally mapped to Prisma enum: `Updates`, `Extends`, `Derives`.

## Result Format

All tools return MCP-compliant content blocks:
```json
[{"type": "text", "text": "{\"id\":\"...\",\"title\":\"...\"}"}]
```

The `text` field contains a JSON string. Clients parse via `JSON.parse(content[0].text)`.

## Error Format

```json
[{"type": "text", "text": "{\"error\":\"message\",\"code\":\"ERROR_CODE\"}"}]
```

Codes: `NOT_FOUND`, `VALIDATION_ERROR`, `AUTH_ERROR`, `RATE_LIMITED`, `INTERNAL_ERROR`.

## Validation Rules

The bridge/hosted service normalizes inputs before forwarding:
- Undefined/null optional fields are stripped
- `memory_type` validated against enum; invalid defaults to `fact`
- `relationship.type` normalized to lowercase
- `tags` coerced to string array
- `memory_id` validated as UUID
- Content capped at 100KB

## Platform Configuration

### Claude Desktop / Cursor
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge", "hosted"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu:8050",
        "HIVEMIND_API_KEY": "<your-api-key>",
        "HIVEMIND_USER_ID": "<your-user-id>"
      }
    }
  }
}
```

### VS Code
Same as Claude Desktop. Add to `.vscode/mcp.json` or user MCP settings.

### Antigravity / Remote HTTP
```
POST https://core.hivemind.davinciai.eu:8050/api/mcp/servers/<userId>/rpc
Headers: Authorization: Bearer <mcp-token>
Body: JSON-RPC 2.0
```

## Contract Version

- Schema: `2024-11-05`
- Protocol: `2024-11-05`
- Server: `hivemind-hosted-mcp` v2.0.0
- Bridge: `@amar_528/mcp-bridge`
