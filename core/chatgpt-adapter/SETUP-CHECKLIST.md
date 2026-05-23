# HIVEMIND × ChatGPT — One-Time GPT Publisher Setup

Pick this up later. Everything you need to publish the HIVEMIND custom GPT once. End users just click the green "Add HIVEMIND to ChatGPT" button after this is done.

## Status as of 2026-05-23

- ✅ OpenAPI spec ready (`core/chatgpt-adapter/openapi.yaml`)
- ✅ Adapter (`core/src/services/chatgpt-adapter.js`) — 5 ops, OAuth bearer auth
- ✅ Routes mounted in `core/src/server.js` (`/v1/chatgpt/*` + `/v1/chatgpt/openapi.yaml`)
- ✅ Vercel rewrites in `frontend/Da-vinci/vercel.json` (proxy `/v1/chatgpt/*`, `/oauth/*`, `/.well-known/oauth-*` → core:8050)
- ✅ FE Connectors card + McpServer ChatGPT tab + Admin expander w/ register form
- ✅ OAuth client-secret + confidential-client flow in `/oauth/token`
- ⏳ **Coolify deploy of latest core commits** — currently `https://hivemind.davinciai.eu/v1/chatgpt/openapi.yaml` returns 404 (route not live). Once `dd0a2ee` (BE) deploys, returns YAML.
- ⏳ **Env var on Coolify core service** — `HIVEMIND_OAUTH_CLIENTS_JSON` not yet set on prod.
- ⏳ **ChatGPT GPT published in OpenAI editor** — not done yet.

## Pre-minted credentials (use these)

```
CLIENT_ID:     hmc_b8a3740e48be648d82633115
CLIENT_SECRET: hms_b744010e394976f2c69b8f4762f2b5e59749ec74e8bb3fbc
SECRET_HASH:   3b4ac703196d97fb0c2d20382f788d2f63887f3d1eb11bd51d3b2780710776b1
```

The secret is shown here because we minted it ourselves. Once the registry endpoint mints via the dashboard UI, the modal shows it only once.

## Step 1 — Set Coolify env var on `core` service

```
HIVEMIND_OAUTH_CLIENTS_JSON=[{"client_id":"hmc_b8a3740e48be648d82633115","client_name":"ChatGPT — HIVEMIND Production","redirect_uris":["https://chatgpt.com/aip/g-placeholder/oauth/callback","https://chat.openai.com/aip/g-placeholder/oauth/callback"],"allowed_scopes":["memory.read","memory.write","web.search"],"is_public":true,"status":"active"}]
```

Public client (`is_public: true`) → PKCE flow, server ignores secret submitted by OpenAI. Works with the currently-deployed core. Switch to confidential after the latest core deploys (just replace `is_public: true` with `client_secret_hash: "<hash>"` + `is_public: false`).

Restart core. Verify:

```bash
curl -s "https://hivemind.davinciai.eu/.well-known/oauth-protected-resource" | python3 -m json.tool
# scopes_supported must include "memory.read", "memory.write", "web.search"
```

## Step 2 — OpenAI GPT editor (one-time)

ChatGPT → My GPTs → Create a GPT → Configure.

Fill in:

- **Name**: HIVEMIND
- **Description**: Your persistent memory engine. Search, save, recall — across every conversation.
- **Instructions**: see "GPT instructions" section below
- **Conversation starters**: 4 starter prompts (see below)
- **Knowledge**: leave empty
- **Capabilities**: enable Web Browsing, DALL·E, Code Interpreter as you wish
- **Actions** → Create new action:

### Schema — paste inline

(do NOT use Import from URL until core route deploys; this works either way)

Paste the full YAML from `core/chatgpt-adapter/openapi.yaml`. Self-contained, no external refs.

### Authentication — OAuth

| Field | Value |
|---|---|
| Authentication Type | OAuth |
| Client ID | `hmc_b8a3740e48be648d82633115` |
| Client Secret | `hms_b744010e394976f2c69b8f4762f2b5e59749ec74e8bb3fbc` |
| Authorization URL | `https://hivemind.davinciai.eu/oauth/authorize` |
| Token URL | `https://hivemind.davinciai.eu/oauth/token` |
| Scope | `memory:read memory:write web:search` |
| Token Exchange Method | Default (POST request) |

### Privacy policy

```
https://hivemind.davinciai.eu/privacy
```

### Save → grab the real callback URL

After Save, OpenAI shows the action's real Callback URL at the bottom of the Actions section:

```
https://chatgpt.com/aip/g-<actual-gpt-id>/oauth/callback
```

Copy that. Update Coolify env var — replace `g-placeholder` with the real id in BOTH redirect URIs:

```
HIVEMIND_OAUTH_CLIENTS_JSON=[{"client_id":"hmc_b8a3740e48be648d82633115","client_name":"ChatGPT — HIVEMIND Production","redirect_uris":["https://chatgpt.com/aip/g-<real-id>/oauth/callback","https://chat.openai.com/aip/g-<real-id>/oauth/callback"],"allowed_scopes":["memory.read","memory.write","web.search"],"is_public":true,"status":"active"}]
```

Restart core.

## Step 3 — Preview + publish

In GPT editor → Preview pane (right side):
- "Search my memories for X" → triggers `searchMemory` → OAuth consent screen → Allow → results
- "Save this fact: <text>" → triggers `saveMemory`
- "What was decided about Y?" → triggers `queryMemoryWithAI`

If consent screen 404s → check `redirect_uri` matches exactly.
If token call 400s → check scope mismatch (server normalizes `memory:read` ↔ `memory.read` since `1e79591`).

Once preview works → top right → **Update / Create** → choose visibility (Only me / Anyone with link / Public).

Public URL format:
```
https://chatgpt.com/g/g-<your-gpt-id>-hivemind
```

## Step 4 — Wire the FE button

Vercel project (Da-vinci) → Environment Variables → add:

```
REACT_APP_CHATGPT_GPT_URL=https://chatgpt.com/g/g-<your-gpt-id>-hivemind
```

Redeploy FE. Connectors page → ChatGPT card now shows the real green "Add HIVEMIND to ChatGPT →" button.

## GPT instructions (paste into Configure → Instructions)

```
You are HIVEMIND — the user's persistent memory engine.

Behavior contract:

1. RECALL FIRST: Before answering any question about the user's own life,
   work, decisions, projects, contacts, or history, call searchMemory.
   Quote memory titles inline. If nothing relevant, say so plainly.

2. SAVE DURABLE FACTS: When the user reveals something durable (a
   preference, decision, goal, person, event), call saveMemory with at
   least 2 tags. Never save chitchat, transient state, or secrets.

3. MULTI-HOP: For complex "who/what/why" questions spanning multiple
   memories, use queryMemoryWithAI — it returns a grounded answer with
   citations to memory IDs.

4. WEB SEARCH SPARINGLY: Only when the user explicitly asks for current
   external info NOT in memory. Cite source URLs.

5. NEVER invent. If memory + web both miss it, say "I don't have notes
   on that yet — want me to save what you tell me?"

6. INTERNAL VOICE: Speak as "we / our" — you are the company's collective
   brain, not a generic assistant.

Output: concise, conversational, no boilerplate "How would you like to
proceed?" closers.
```

## Conversation starters

1. What did I decide about the pricing model last week?
2. Save this: <paste a fact>
3. Who attended the Solvis kickoff and what were the action items?
4. Show me recent decisions tagged #product

## Five exposed operations

| operationId | Method | Path | Maps to internal tool |
|---|---|---|---|
| `searchMemory` | POST | `/v1/chatgpt/memory/search` | `hivemind_recall` |
| `saveMemory` | POST | `/v1/chatgpt/memory/save` | `hivemind_save_memory` |
| `listMemories` | GET | `/v1/chatgpt/memory/list` | `hivemind_list_memories` |
| `queryMemoryWithAI` | POST | `/v1/chatgpt/memory/query` | `hivemind_query_with_ai` |
| `webSearch` | POST | `/v1/chatgpt/web/search` | `hivemind_web_search` + poll |

Deliberately narrow + consumer-safe. Coding tools, bi-temporal, graph traversal NOT exposed in v1.

## Smoke tests (curl) after Step 1

```bash
# Spec served
curl -s "https://hivemind.davinciai.eu/v1/chatgpt/openapi.yaml" | head -5
#  expect: openapi: 3.1.0

# OAuth metadata
curl -s "https://hivemind.davinciai.eu/.well-known/oauth-protected-resource" | python3 -m json.tool | grep authorization
#  expect: "authorization_endpoint": "https://core.hivemind.davinciai.eu:8050/oauth/authorize"

# Unauthenticated tool call → 401
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://hivemind.davinciai.eu/v1/chatgpt/memory/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
#  expect: HTTP 401 with WWW-Authenticate header
```

## Open issues blocking publish

1. **Core deploy lag** — `/v1/chatgpt/*` routes not live yet (returns 404 via Vercel rewrite). Last 5 backend commits not deployed.
2. **Env var not set on Coolify** — see Step 1.
3. **Caddy SSL on `core.hivemind.davinciai.eu:443`** returns Traefik default cert instead of Caddy. Vercel rewrite path works (Vercel → Caddy → core via `via: 1.1 Caddy` header), so this is non-blocking but should be fixed for direct access.

## Files touched

- `core/chatgpt-adapter/openapi.yaml`
- `core/chatgpt-adapter/README.md`
- `core/chatgpt-adapter/SETUP-CHECKLIST.md` (this file)
- `core/src/services/chatgpt-adapter.js`
- `core/src/server.js` — route mount + OAuth confidential client check
- `core/src/control-plane-server.js` — `/v1/oauth/clients` CRUD (org-admin UI)
- `frontend/Da-vinci/vercel.json` — rewrites
- `frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx` — ChatGPT card + admin OAuth registry
- `frontend/Da-vinci/src/components/hivemind/app/pages/McpServer.jsx` — ChatGPT tab
- `frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js` — `listOAuthClients` / `createOAuthClient` / `deleteOAuthClient`
