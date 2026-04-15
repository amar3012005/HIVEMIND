# HIVEMIND "Connect" Integration Strategy

## Overview
How HIVE-MIND enables 3rd party applications to access our tools and data using an OAuth-like "Connect" flow or direct API Keys.

## Integration Patterns

### 1. The "Connect to HIVEMIND" Flow (OAuth-like)
Designed for web apps (e.g., MiroFish) or VS Code extensions that want to access a user's tools without requiring the user to manually copy API keys.

1. **Initiation**: 3rd party app redirects user to `https://hivemind.davinciai.eu/login?redirect_uri=CALLBACK_URL`.
2. **Authentication**: User signs in via HIVE-MIND (Zitadel).
3. **Handshake**: HIVE-MIND redirects back to `CALLBACK_URL?token=HM_SESSION_TOKEN`.
4. **Validation**: 3rd party backend calls `GET /v1/bootstrap` with `Authorization: Bearer <HM_SESSION_TOKEN>` to verify identity and get user/org profile.
5. **Tool Access**: Use the token to call the MCP RPC endpoint.

### 2. Direct API Key Access (S2S)
Designed for servers or CLI tools.
1. **Generation**: Admins or Users generate an API Key in the HIVE-MIND dashboard.
2. **Usage**: App sends `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>` header.
3. **Verification**: `core/src/server.js` validates against PRISMA or the internal key store.

## Core API Endpoints for 3rd Parties

### A. Discovery (`MCP RPC: tools/list`)
Allows the 3rd party to see which tools are available to the authenticated user.
- **Endpoint**: `POST /api/mcp/rpc`
- **Method**: `tools/list`

### B. Execution (`MCP RPC: tools/call`)
Triggers a HIVEMIND tool (e.g., `SEARCH_WEB`, `INGEST_FILE`).
- **Endpoint**: `POST /api/mcp/rpc`
- **Method**: `tools/call`
- **Params**: `{ "name": "tool_name", "arguments": { ... } }`

### C. Knowledge Sync
- **Fetch Memories**: `GET /api/memories`
- **Save Memory**: `POST /api/memories`

## Security Requirements
- All 3rd party requests MUST be over HTTPS.
- Tokens should be treated as secrets and stored securely by the 3rd party.
- Rate limits are applied per Org/User via `PlanEnforcer`.
