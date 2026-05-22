# HIVEMIND — ChatGPT One-Click Integration Layer

Adapter that exposes 5 narrow REST endpoints over HIVEMIND's MCP tool registry, so ChatGPT custom-GPTs and the plugin/connector framework can mount HIVEMIND as a tool surface in one click.

## Files

| File | Purpose |
|---|---|
| `openapi.yaml` | Machine-readable contract ChatGPT reads to discover the 5 tools |
| `../src/services/chatgpt-adapter.js` | Pure functions — auth-resolved tool dispatch + sync web-search polling |
| `../src/server.js` | Mounts `/v1/chatgpt/*` routes + serves `/v1/chatgpt/openapi.yaml` |

## Architecture

```
ChatGPT                     core (port 8050)              HIVEMIND graph
─────────                   ────────────────              ──────────────
1. User clicks
   "Connect to              /oauth/authorize  ──────>     (existing OAuth
   HIVEMIND"                                              flow — same one
                            <─ redirect w/ code           MCP / Claude use)

2. POST /oauth/token        exchange code → access_token (stored in apiKey
                            table, kind=oauth_access_token, scopes attached)

3. Tool call:               POST /v1/chatgpt/memory/search
   searchMemory({           Bearer auth → principal { userId, orgId, scopes }
     query: "..."           → dispatchTool('hivemind_recall', ...)
   })                  <─── normalized JSON

4. Tool call:               POST /v1/chatgpt/web/search
   webSearch({              dispatchTool('hivemind_web_search', ...)
     query: "..."           poll hivemind_web_job_status until done
   })                  <─── synchronous results (hides async)
```

OAuth is already implemented in `core/src/server.js` for MCP / Claude Desktop. ChatGPT reuses the exact same `/oauth/authorize` + `/oauth/token` endpoints — no new auth stack.

## Five exposed operations

| `operationId` | Method | Path | Maps to | Scope |
|---|---|---|---|---|
| `searchMemory`        | POST | `/v1/chatgpt/memory/search` | `hivemind_recall`         | `memory:read` |
| `saveMemory`          | POST | `/v1/chatgpt/memory/save`   | `hivemind_save_memory`    | `memory:write` |
| `listMemories`        | GET  | `/v1/chatgpt/memory/list`   | `hivemind_list_memories`  | `memory:read` |
| `queryMemoryWithAI`   | POST | `/v1/chatgpt/memory/query`  | `hivemind_query_with_ai`  | `memory:read` |
| `webSearch`           | POST | `/v1/chatgpt/web/search`    | `hivemind_web_search` + poll | `web:search` |

Deliberately narrow + consumer-safe. Coding tools, bi-temporal, graph traversal NOT exposed — add later once consumer flow is stable.

## Setup (OpenAI dev dashboard)

1. Create a GPT → **Configure** → **Actions** → **Import from URL**.
2. Paste: `https://core.hivemind.davinciai.eu:8050/v1/chatgpt/openapi.yaml`
3. **Authentication** → **OAuth** →
   - Authorization URL: `https://core.hivemind.davinciai.eu:8050/oauth/authorize`
   - Token URL: `https://core.hivemind.davinciai.eu:8050/oauth/token`
   - Scope: `memory:read memory:write web:search`
4. OpenAI returns a callback URL (e.g. `https://chat.openai.com/aip/...`). Register it as an allowed redirect in HIVEMIND's OAuth client list.
5. Publish the GPT. Users click **Connect to HIVEMIND** on first tool call.

## Security

- Every endpoint resolves `userId` / `orgId` from the validated Bearer token via `authenticateApiKey(req)` — tenancy is server-side. Clients **never** pass `user_id` / `org_id` in request bodies.
- Scope check (`hasScope` in `chatgpt-adapter.js`) per endpoint. `'*'` / `admin` keys bypass; OAuth-minted tokens carry the scopes from the consent screen.
- OAuth code expiry, refresh, revocation: handled by the existing flow in `server.js`.
- Web-search polling bounded by `POLL_TIMEOUT_MS` (30s) to prevent hung connections.

## Frontend surfaces

- **Connectors page** — `ChatGPTConnectorCard` shows copy-buttons for the spec URL + OAuth endpoints + scopes + a 4-step setup checklist.
- **MCP Server page** — `ChatGPT` tab with full operation table + setup guide.

## Future hardening

- PKCE on the OAuth flow (already supported by core's OAuth, just enable client requirement).
- Per-OAuth-client rate limits.
- Replace `in-memory Maps` in any earlier draft — current implementation already uses the persisted `apiKey` table for tokens.
- Audit log emission per tool call (already happens via `dispatchTool` if the underlying handler emits).
