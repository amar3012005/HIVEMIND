# Connector Runtime V1 — Phase 0: Characterization (executable inventory)

Read-only recon of every connector surface BEFORE any behavior change. This is
the frozen baseline the migration is measured against. Repo: `core/src/**`,
`employees-service/**`. All anchors are `file:line`.

## 0. The shape of the problem (why the runtime is needed)

Gmail alone is implemented **3 times with 3 different tool-name schemes across 2
execution implementations**:

| Surface | Gmail tool names | Executes via |
|---|---|---|
| Core native (`google-native.js`) | `gmail_search/get/send/create_draft/send_draft/list_drafts/get_thread/list_labels/modify/trash` | direct Google REST (`runGoogleTool`, google-native.js:638) |
| Chat toolkit (`connector-toolkits/gmail-tools.js`) | `gmail_search_threads/read_thread/send_email/label_thread` | Nango REST (`nangoProxyFetch`) |
| HyperAgents (`agentscope_tools.py`) | `gmail_search/get/get_thread/list_drafts/list_labels/create_draft/modify/send/reply/trash` | Core `/api/connectors/google/exec` → `runGoogleTool` |
| **Plan canonical (target)** | `gmail__search/get_message/get_thread/create_draft/send_draft` | one plugin |

So `gmail_send_email` (Chat) ≠ `gmail_send` (HyperAgents/native); Chat executes Gmail through **Nango REST** while HyperAgents executes the SAME provider through **Core google-native** — two implementations, two schemas, two read/write classifications to keep in sync. This pattern repeats for docs/sheets/slack/notion.

## 1. Execution surfaces (the "one execution implementation" target)

| Execution path | file:line | Consumers | Guards today |
|---|---|---|---|
| `runGoogleTool` (direct Google REST) | google-native.js:638 | `/api/connectors/google/exec` (server.js:11058); HyperAgents | no approval/timeout/audit at the route |
| `nangoProxyFetch` (Nango REST) | connector-toolkits/nango-fetch.js:43 | Chat gmail/gdocs/gemini tools | draft-approval (chat only), no timeout at route |
| `MCPConnectorRunner.execute` | mcp/runner.js:197 | `/api/connectors/mcp/exec` (server.js:11029); Chat MCP (notion/github/linear); HyperAgents generic MCP | **NO timeout** (hung upstream = unbounded); no approval/audit |
| `WorkspaceMcpBridge.callTool` | providers/google/workspace-mcp-bridge.js:96 | google live-query (calendar/drive/contacts/tasks/chat) | read-only |
| `SlackBridge._call` | providers/slack/bridge.js:80 | native Slack (Chat + HyperAgents via `execSlackReadTool`) | write blocked in exec bridge |
| `WhatsAppBridge` | providers/whatsapp/bridge.js:22 | sync + send | event-driven |

`AuditLogger` exists (server.js:934) but is **not** called on `google/exec`, `mcp/exec`, `mcp/ingest`, or the pending-write approve path. Only `slack-action` + meeting-delete audit.

## 2. Read/write classification signals that already exist (reuse these)

- Chat toolkit `readOnly: true|false` per `registerToolFunction` — the cleanest existing R/W flag.
- `google-native.js` R/W is implicit by operation (send/create/modify/trash = W).
- HyperAgents: `_is_read_tool` hints (engine.py:390) + `_looks_like_read`; write funcs go through `_gate_write`.
- MCP catalog: `supports_ingestion`/`supports_live_tools` (catalog-seed.js:41-42); `mode:['ingestion'|'live']` in catalog.js/shared.
- Gen-1 ingestion adapters: `requiredScopes` ending `.readonly` = read-only signal.
- No unified R/W enum exists — the runtime's `CanonicalConnectorTool.access` must be the single source.

## 3. Ingestion adapters — TWO generations

- **Gen-2** (`adapters/*`, `BaseConnectorAdapter`, `fetchBulk`/`fetchResource`, self-register in `adapterRegistry`, Nango `tokenResolver`, webhooks): slack, notion, github, linear, jira, confluence.
- **Gen-1** (`providers/*`, `BaseProviderAdapter`, `fetchInitial`/`fetchIncremental`, token from `ConnectorStore.getAccessToken`): gmail, github, linear, notion, salesforce, microsoft, atlassian, personio-v2, google_calendar/contacts/drive_docs, gdrive, gdocs, gemini(stub), slack, whatsapp.
- Which runs on the scheduler is decided by `ADAPTER_DISPATCH` (sync-scheduler.js:108); unlisted providers fall to a legacy dynamic path. Some Gen-1 providers are **dead code** for scheduled sync (superseded by Gen-2).
- **Canonical ingestion front door (GOOD):** `SyncEngine._ingestWithRetry` (sync-engine.js:341) and `webhook-processor.js:140` both call `documentFirstIngestion.ingestSource(...)` (the V5 canonical path, `globalThis.__hivemindDocumentFirstIngestion`). The runtime's `plugin.sync()` must keep this front door.

## 4. Two job systems (the sync-consolidation target)

| System | Storage | Durable? | Ingestion call |
|---|---|---|---|
| `SyncEngine` + `SyncScheduler` + `webhook-processor` | Postgres `platform_integrations` (cursor/status) + Redis dedup | YES | `ingestSource` (canonical) |
| `MCPIngestionService` + `MCPConnectorJobStore` | single **JSON file** `core/data/mcp-connector-jobs.json` | **NO** (racy across replicas, no locking) | `ingestionPipeline.ingest` (divergent) |

Plan Phase 7/10: add a Postgres `ConnectorSyncJob` model (lease/SKIP LOCKED), fold the file-backed MCP path onto it + `SyncEngine`, delete `MCPConnectorJobStore`.

## 5. Two approval systems (the approval-consolidation target)

- **Core `PendingWrite`** (schema.prisma:371, table `pending_writes`): `{userId,orgId,provider,toolGroup,toolName,toolArgs,argsHash,projectId,connectionId,traceId,idempotencyKey(unique),expiresAt,preview,status,result,errorMsg,approvedAt,sentAt}`. Status: draft|approved|cancelled|sent|failed(+executing,expired). Drives Chat draft-approval. **This is the one to keep (plan Phase 3 extends it additively).**
- **HyperAgents `_PENDING_WRITES`** (agentscope_tools.py:98, ContextVar) + `_gate_write`/consensus gate — a separate in-process approval. **To be converged onto `PendingWrite`.**

## 6. Capability tokens — none per-call (the gateway gap)

Existing: consumer tokens (long-lived `ApiKey` scopes:['mcp']), signed HMAC connection tokens (24h, `hosted-service.js:245`), bridge `?secret=`, Nango `NANGO_SECRET_KEY`. All hand-rolled HMAC; **no JWT lib, no short-lived per-tool-call capability token.** Plan §6 fills this (5-min asymmetric-signed capability token, Redis JTI revocation).

## 7. FROZEN FE / cross-service contracts (must not change during migration)

1. **Toolkit `execute()` ToolResponse:** `{content:[{type:'text',text}], status, meta:{raw,readOnly,...}}` (toolkit.js:266).
2. **Draft card:** `status:'draft_created'` + `meta:{draft_id,tool_name,provider,preview}` (draft-approval.js:184). Gate = `readOnly:false && external:true` — `markGroupExternal` (toolkit.js:163) is load-bearing; MCP tools get `external:true` in `registerMcpClient`.
3. **SSE tool-progress events:** `tool_selected, tool_started, tool_call, tool_result, tool_completed, finish, turn_completed` (react-agent-v2.js) + terminal `{type:'done', ...result}` with top-level `draft_ids`/`project_choice`/`action_result`.
4. **Approval endpoints:** `GET /api/pending-writes`; `POST /api/pending-writes/:id/(approve|cancel)` (server.js:8389) — 404/409/410 guards, argsHash-bound `_approval_token` replay guard.
5. **Connector mgmt endpoints:** `/api/connectors/connect-session`, `/api/connectors/connect`, `/api/connectors/:id/{connect,disconnect,status}`, `/api/connectors/:provider/scope` (role-gated), `/api/connectors/nango/webhook`.
6. **AgentScope 1.0.19 API in use (compat surface):** `Toolkit()`, `register_tool_function(fn, group_name)`, `create_tool_group(active=False, notes)`, `update_tool_groups(group_names, active=True)`, `reset_equipped_tools` as meta-tool via `enable_meta_tool`, `ReActAgent(...)`, `register_instance_hook`. NOT the 2.x dev API.

## 8. Owner assignment (every current route → future runtime owner)

| Current route/impl | Future owner |
|---|---|
| `/api/connectors/google/exec` → runGoogleTool | `gmail` / `google_docs` / `google_sheets` / `google_calendar` plugins → ConnectorRuntime.executeTool |
| Chat gmail/gdocs/gemini tools (Nango REST) | same plugins via `runtime-toolkit-adapter` (in-process) |
| `/api/connectors/mcp/exec` → MCPConnectorRunner | `notion`/`github`/`linear`/external-MCP plugins (runtime wraps runner, adds timeout/audit) |
| HyperAgents `agentscope_tools.py` provider fns | generic MCP projection → capability token → `/mcp/connectors/:id` → same plugins |
| HyperAgents `engine.py` `_connector_routes` | runtime group summaries + selected canonical schemas |
| `MCPIngestionService` file jobs | `ConnectorSyncJob` (Postgres) + `plugin.sync()` + `SyncEngine` |
| Slack native (`SlackBridge`) | `slack` plugin (keep native bridge underneath) |
| WhatsApp / workspace-mcp / Gen-1+Gen-2 adapters | `plugin.sync()` wrapping existing fetchers |

## 9. Phase 0 acceptance

- [x] **Every current route has an owner** — §8.
- [x] **Every duplicate schema identified** — §0/§1 (Gmail 3-way, docs/sheets/slack analogous; Chat=Nango vs HyperAgents=google/exec).
- [x] **Existing FE contracts frozen** — §7 (documented; migration adapters must reproduce byte-for-byte).
- [x] **The invalid MCP operation name cannot reappear** — enforced by canonical `<connector>__<operation>` naming + one schema registry + `validateAndSanitize`-style strict validation in the runtime; alias map translates legacy names inbound only.

## 10. Non-obvious risks captured for later phases

- `mcp/exec` and `MCPConnectorRunner` have **no timeout** — the runtime pipeline's deadline (plan §4) is a real safety upgrade, not cosmetic.
- Dropping `markGroupExternal` in the new adapter silently disables draft-approval — contract test required.
- Gmail has two live execution impls (Nango REST vs google-native) with different auth; the plugin must pick one and prove result-parity against BOTH before deleting either.
- `ingestSource` (canonical) vs `ingestionPipeline.ingest` (MCP) divergence must be resolved in favor of `ingestSource`.
- AgentScope must stay `^1.0.19`; the MCP projection targets the 1.x API only.
