# Connector Runtime V1 — decision record & current state

_Last updated: 2026-07-22. Live on `core-api:prod-20260722-rmye01367541` (singulance-main @ `e01367541`)._

## Why this exists
Before the runtime, every provider was implemented 2–3× with different tool-name
schemes across different execution paths (Gmail alone: Core `runGoogleTool`,
Chat Nango REST, HyperAgents `/exec`). No single layer guaranteed
auth/approval/timeout/normalize/audit. The Connector Runtime is the **one
canonical authority**: one plugin per provider, one schema per tool, one
approval system, one execution + audit path, projected to each surface.

## Architecture (hybrid execution model)
```
                 Connector Runtime in Core
        schemas · policy · auth · execution · audit · sync
                          │
   ┌──────────────────────┼────────────────────────┐
Core Chat Toolkit    Stateless MCP Gateway     Durable Sync
(in-process adapter) (HyperAgents/TARA/ext)    (background → canonical ingest)
```
- **Canonical naming:** `<connector>__<operation>` (e.g. `gmail__search`). Legacy names are inbound aliases only.
- **Never a monolith:** each provider is its own small script under `core/src/connectors/runtime/plugins/<id>/`.

## Files (`core/src/connectors/runtime/`)
| File | Role |
|---|---|
| `contracts.js` | shapes + validators (`validateManifest/ToolContract/Context`, `makeResult`), `TOOL_NAME_RE`, `SURFACES`, `RESULT_STATUSES` |
| `errors.js` | typed `ConnectorError` tree → one result-status each; `classifyError` (HTTP-status, language-neutral); `redactSecrets` |
| `connector-plugin.js` | `ConnectorPlugin` base (manifest + listTools + getConnection/executeTool) |
| `connector-registry.js` | one catalog; canonical resolve + inbound legacy aliases |
| `connector-runtime.js` | the execution authority: 18-step pipeline; `executeTool`, `executeApproved`, `drainSyncOnce` |
| `config.js` | `CONNECTOR_RUNTIME_*` flags (default off; explicit env authoritative) |
| `input-validator.js` | ajv validate/coerce/strip (reuses existing ajv) |
| `policy-engine.js` | authorize hook (role floor, read-only-surface write block) |
| `approval-hash.js` + `approval-store.js` | approval + idempotency over the EXISTING `pending_writes` table (same formulas as `draft-approval.js`) |
| `capability-token.js` | Ed25519 5-min capability tokens (asymmetric, JTI-revocable) |
| `mcp-gateway.js` + `mcp-routes.js` | stateless MCP transport (`initialize`/`tools/list`/`tools/call`) |
| `runtime-audit.js` | audit hook (fail-closed on completed writes) + metrics |
| `plugins/<id>/index.js` | one connector-wise script per provider |

## Plugins (7 connectors / 35 tools)
| Connector | Kind | Reads | Writes (approval:required) |
|---|---|---|---|
| gmail | direct (`runGoogleTool`) | search, get_message, get_thread, list_labels, list_drafts | create_draft, send_draft, send |
| google_docs | direct | search, get | create, append |
| google_sheets | direct | get_range | append_rows, create |
| slack | MCP-backed | search, list_channels, get_history, read_thread | post_message |
| notion | MCP-backed | search, get_page | create_page, update_page, create_comment |
| github | MCP-backed | search_issues, get_issue, search_code | create_issue, comment_issue |
| linear | MCP-backed | search_issues, get_issue, list_projects | create_issue, update_issue |

Provider tool-names for notion/github/linear are best-known and **refine at the
first live MCP `tools/list` inspect** (a wrong name returns a structured result,
never a crash; unknown connectors fall through to legacy).

## Deployment state (flags, in `/root/hivemind/.env`)
| Flag | State | Meaning |
|---|---|---|
| `CONNECTOR_RUNTIME_ENABLED` | **on** | master switch |
| `CONNECTOR_RUNTIME_MCP` | **on** | stateless gateway (`/api/connectors/runtime/capabilities`, `/mcp/connectors/:id`) — LIVE, verified (capability 200, token issued, 7 connectors offered) |
| `CONNECTOR_RUNTIME_CHAT` | **on** | Chat via `runtime-toolkit-adapter` (toolkit-factory.js) — fall-through-safe, verified |
| `CONNECTOR_RUNTIME_HYPER` | **on** | HyperAgents via `employees-service/.../connectors/mcp_projection.py` (native AgentScope `HttpStatelessClient`+`register_mcp_client`, protocol 2025-11-25) — employees image has the code |
| `CONNECTOR_RUNTIME_TARA` | env-gated | `services/tara-deepgram/tara_deepgram/connectors.py` (voice-safe, read-only, `CONNECTOR_RUNTIME_TARA_CONNECTORS=google_calendar,google_docs`) — code BAKED in the tara image (2026-07-22); activate via tara's `/opt/tara-deepgram/.env` |
| `CONNECTOR_RUNTIME_SYNC` | off | durable-sync worker loop mounted in `server.js` (`drainSyncOnce` on a guarded interval) — inert until flipped |

Gateway mount: `server.js:~3462` (lazy-imports runtime + mcp-routes + capability-token).

## Approval / audit
- Writes → `pending_writes` (the existing table), same `argsHash`/`idempotencyKey`/TTL formulas as chat `draft-approval.js`. `approval_required` result carries `{id, summary, expiresAt}`; approved execution replays STORED args once (atomic claim = replay guard).
- Frozen FE contracts preserved: `draft_created` card, `readOnly:false && external:true` gate, 7 SSE events, `/api/pending-writes` endpoints.

## Still open (external-state / cleanliness — non-blocking)
1. Refine notion/github/linear provider tool-names at the first live MCP inspect (needs a *connected* connector).
2. Approval convergence: HyperAgents `_PENDING_WRITES` ContextVar → the shared `PendingWrite` (both work today; convergence is cleanliness).
3. `AuditLogger` not yet called on the legacy `google/exec` + `mcp/exec` routes (the runtime path DOES audit).
4. P11 legacy-path removal — only after all surfaces proven at scale.

## Verify quickly
- Gateway offers all connectors: `POST /api/connectors/runtime/capabilities` `{surface:"mcp",requested_connectors:[...],requested_access:"read"}` → 200 + connectors list.
- Unit suite (34/34): `node --test core/tests/unit/connector-runtime-phase2.test.js core/tests/unit/connector-runtime-phase3.test.js`.
- Phase docs: `docs/connector-runtime/00..06-*.md` (in the v5-canonical build tree).
