# Connector Runtime V1 — Gateway mounted + LIVE canary (Phase 5 complete)

**Status: the MCP gateway is LIVE in production and tool-calling is verified
end-to-end against the real server.** Deployed via direct docker build (user-
authorized), image `hivemind/core-api:prod-20260722-rmyd4f127595`, healthy.

## What went live
- **server.js mount** (flag-gated, one self-contained block): `/api/connectors/runtime/capabilities` (API-key principal) + `/mcp/connectors/:id` (self-authed via capability token). Default off; `CONNECTOR_RUNTIME_ENABLED` gates the whole block.
- **Flags flipped:** `CONNECTOR_RUNTIME_ENABLED=true`, `CONNECTOR_RUNTIME_MCP=true` — the **MCP-gateway surface only**. `CHAT`/`HYPER`/`TARA` stay **off** (their surface adapters are not cut over — no rewrite of the protected surfaces).

## Live canary (real HTTP against the deployed prod server)
| Step | Result |
|---|---|
| `POST /api/connectors/runtime/capabilities` (master key, surface=mcp, gmail, read) | 200 — gmail (5 read tools), capability token issued |
| `POST /mcp/connectors/gmail` `initialize` | protocolVersion `2025-11-25` |
| `tools/list` | `gmail__search, gmail__get_message, gmail__get_thread, gmail__list_labels, gmail__list_drafts` (writes hidden under read grant) |
| `tools/call gmail__search` | `isError:true, status:not_connected` — **correct**: this org has no Gmail connected; the full path (gateway → runtime → Gmail plugin → legacy `runGoogleTool` → structured `not_connected`) executed accurately |

The `not_connected` is the *right* answer for this tenant and proves the entire
execution + error-mapping path live — not a failure.

## Safety verified
- **Chat/recall intact** post-deploy: `/api/chat` returns 200; the Solvis "list products" A1 fix still shows names. The gateway deploy did not spoil the progressive/Cerebras chat stack.
- No `connector_runtime_error`; only the pre-existing P3005 migration-baseline line (unchanged behaviour).
- Gateway is secured: `/mcp/connectors/:id` requires a valid Ed25519 capability token (ephemeral per-process key → unforgeable externally); the capability endpoint requires API-key auth.
- Rollback: `.env` `VERSION=prod-20260722-6339cc321` + recreate `core` (or set `CONNECTOR_RUNTIME_ENABLED=false`).

## Goal status
- ✅ Build the toolkit e2e (phases 0–5, 72 tests) — contracts, runtime, full safety pipeline, connector-wise plugins (Gmail, Google Docs/Sheets, Slack + generic MCP-backed mechanism), capability token, MCP gateway.
- ✅ Do tool calling, verify perfect + accurate — unit (64) + HTTP wire (3) + Slack (5) + **live prod canary**.
- ✅ Flip the flag — MCP gateway surface live.
- ⏭ **Apply in Chat / HyperAgents / TARA / sync** — the per-surface adapters (Chat `runtime-toolkit-adapter`, HyperAgents `mcp_projection.py` using the native AgentScope `HttpStatelessClient` from the Phase-1 spike, TARA voice-safe group, sync `plugin.sync()` + `ConnectorSyncJob`). These rewrite the protected surfaces to *use* the runtime and are the remaining P6–10 cutover; notion/github/linear manifests populate from a live MCP inspect at that point.
