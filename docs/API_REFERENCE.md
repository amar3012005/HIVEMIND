# HIVE-MIND API Reference (Local)

**Base URL:** `http://localhost:3000`  
**Version:** Local dev reference  
**Updated:** 2026-03-11

## Authentication Model

All memory endpoints require an **Ultimate API Key**.

- Header option A: `Authorization: Bearer <YOUR_ULTIMATE_API_KEY>`
- Header option B: `X-API-Key: <YOUR_ULTIMATE_API_KEY>`

Key management endpoints require:

- `X-Admin-Secret: <HIVEMIND_ADMIN_SECRET>`

Default local admin secret if unset:

- `local-admin-secret-change-me`

Set your own before shared/staging use:

```bash
export HIVEMIND_ADMIN_SECRET="replace-with-strong-secret"
```

---

## 1) Ultimate API Key Endpoints

### POST `/api/keys/generate`
Generate a user-scoped API key. Full key is returned once.

Headers:
- `Content-Type: application/json`
- `X-Admin-Secret: <admin-secret>`

Body:
```json
{
  "label": "ultimate-user-key",
  "user_id": "local-user",
  "org_id": "local-org",
  "scopes": ["memory:read", "memory:write"]
}
```

Response:
```json
{
  "success": true,
  "key": "hmk_live_...",
  "key_id": "uuid",
  "key_preview": "hmk_live_xxx...yyy",
  "user_id": "local-user",
  "org_id": "local-org",
  "scopes": ["memory:read", "memory:write"],
  "created_at": "2026-03-11T18:00:00.000Z",
  "warning": "Store this key now. It will not be shown again in full."
}
```

### GET `/api/keys`
List key metadata (no raw secrets).

Headers:
- `X-Admin-Secret: <admin-secret>`

### POST `/api/keys/revoke`
Revoke a key by `key_id`.

Headers:
- `Content-Type: application/json`
- `X-Admin-Secret: <admin-secret>`

Body:
```json
{
  "key_id": "uuid"
}
```

---

## 2) Memory Endpoints (Auth Required)

### POST `/api/memories`
Store a memory.

Body:
```json
{
  "content": "We selected Qdrant for enterprise vector retrieval.",
  "project": "hivemind-enterprise",
  "tags": ["decision", "architecture"]
}
```

### GET `/api/memories`
List memories for the authenticated user/org context.

### POST `/api/memories/search`
Search memories.

Body:
```json
{
  "query": "Qdrant decision",
  "n_results": 10,
  "filter": {
    "project": "hivemind-enterprise",
    "is_latest": true
  }
}
```

### POST `/api/memories/traverse`
Graph traversal.

Body:
```json
{
  "start_id": "memory-id",
  "depth": 3,
  "relationship_types": ["Updates", "Extends", "Derives"]
}
```

### POST `/api/memories/decay`
Calculate decay score for memory.

Body:
```json
{
  "memory_id": "memory-id"
}
```

### POST `/api/memories/reinforce`
Reinforce a memory.

Body:
```json
{
  "memory_id": "memory-id"
}
```

### POST `/api/relationships`
Create a relationship between memories.

### POST `/api/recall`
Auto-recall top relevant memories.

Body:
```json
{
  "query_context": "What did we decide for vector storage?",
  "max_memories": 5
}
```

### POST `/api/session/end`
Session end hook for auto-capture.

### GET `/api/stats`
Returns user/org scoped memory statistics.

---

## 3) Webapp Middleware Endpoints

These endpoints are for ChatGPT/Gemini-style wrappers or browser apps that do not speak MCP directly but still need HIVE-MIND memory.

### POST `/api/integrations/webapp/prepare`
Prepare scoped memory context and return a prompt envelope ready to send to a webapp model.

Body:
```json
{
  "platform": "chatgpt",
  "query": "Where does Project Atlas deploy?",
  "user_prompt": "Where does Project Atlas deploy?",
  "project": "atlas",
  "preferred_source_platforms": ["chatgpt"],
  "preferred_tags": ["deploy"],
  "max_memories": 5
}
```

Response shape:
```json
{
  "ok": true,
  "platform": "chatgpt",
  "search_method": "persisted-hybrid",
  "context": {
    "system_prompt": "You have access to tenant-scoped HIVE-MIND memory...",
    "injection_text": "<relevant-memories>...</relevant-memories>",
    "memories": []
  },
  "prompt_envelope": {
    "platform": "chatgpt",
    "messages": [
      { "role": "system", "content": "..." },
      { "role": "user", "content": "Where does Project Atlas deploy?" }
    ]
  }
}
```

### POST `/api/integrations/webapp/store`
Persist an answer, decision, or useful output from a webapp back into HIVE-MIND.

Body:
```json
{
  "platform": "gemini",
  "content": "Atlas deploys on Hetzner with blue-green rollout.",
  "memory_type": "fact",
  "title": "Atlas deployment answer",
  "tags": ["atlas", "deploy"],
  "importance_score": 0.7,
  "conversation_id": "conv-123",
  "session_id": "sess-456"
}
```

---

## 4) Example Integration Flow

1. Generate key (admin only):
```bash
curl -X POST http://localhost:3000/api/keys/generate \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: local-admin-secret-change-me" \
  -d '{"label":"team-a","user_id":"user-a","org_id":"org-a"}'
```

2. Use key for memory write:
```bash
curl -X POST http://localhost:3000/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hmk_live_xxx" \
  -d '{"content":"Decision: use MCP bridge","project":"alpha","tags":["decision"]}'
```

3. Search:
```bash
curl -X POST http://localhost:3000/api/memories/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hmk_live_xxx" \
  -d '{"query":"MCP bridge","n_results":5}'
```

---

## 5) Local UX/Integration Test Page

Open:

- `http://localhost:3000/ux-test`

This page allows:
- Ultimate key generation
- Copy/use key
- Store/list/search/recall/stat operations
- Fast UX validation against local stack

---

## 6) Browser/Wrapper SDK

A lightweight browser SDK is available at:

- `/Users/amar/HIVE-MIND/web/hivemind-web-sdk.js`

Example:
```js
import { HivemindWebClient } from '/Users/amar/HIVE-MIND/web/hivemind-web-sdk.js';

const client = new HivemindWebClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'hmk_live_xxx'
});

const prepared = await client.prepareContext({
  platform: 'chatgpt',
  query: 'What do we know about Atlas deployment?',
  project: 'atlas'
});

const result = await client.storeMemory({
  platform: 'chatgpt',
  content: 'Atlas deploys on Hetzner.',
  memoryType: 'fact',
  title: 'Atlas deployment answer'
});
```

---

## 7) Local Wrapper Page

Open:

- `http://localhost:3000/webapp-wrapper`

This page:

- uses `/web/hivemind-web-sdk.js`
- prepares scoped context for ChatGPT/Gemini-style flows
- shows the exact `prompt_envelope`
- stores useful outputs back into HIVE-MIND

---

## 8) Tampermonkey Bridge

Userscript:

- `/Users/amar/HIVE-MIND/scripts/tampermonkey-hivemind-web.user.js`

Targets:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://gemini.google.com/*`

Behavior:

- injects a floating HIVE-MIND panel
- `Recall To Prompt` calls `POST /api/integrations/webapp/prepare`
- inserts HIVE-MIND `injection_text` into the current prompt composer
- `Save Last Answer` calls `POST /api/integrations/webapp/store`

This is a localhost bridge, not a production browser extension.
