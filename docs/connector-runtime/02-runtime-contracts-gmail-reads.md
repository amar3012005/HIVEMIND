# Connector Runtime V1 — Phase 2: Runtime contracts + Gmail reads

**Status: PASS (21/21 unit tests, executed in the live `hm-core` Node v20).**
Purely additive — nothing existing imports the runtime (grep-verified), so
ingestion / recall / chat are untouched. Every flag defaults OFF.

## What shipped (all under `core/src/connectors/runtime/`, one small file each)

| File | Role |
|---|---|
| `contracts.js` | canonical shapes + validators: `validateManifest`, `validateToolContract`, `validateContext`, `makeResult`; `TOOL_NAME_RE` (`<connector>__<operation>`), `SURFACES`, `RESULT_STATUSES` |
| `errors.js` | typed `ConnectorError` tree → one result status each; `classifyError` (language-neutral, HTTP-status based); `redactSecrets` (OAuth-token leak guard) |
| `connector-plugin.js` | `ConnectorPlugin` base (manifest storage + default listTools + getConnection/executeTool contract) |
| `connector-registry.js` | one catalog; canonical resolve + inbound legacy-name aliases |
| `connector-runtime.js` | the single execution authority — Phase-2 pipeline subset + marked Phase-3 hook points |
| `config.js` | `CONNECTOR_RUNTIME_*` flag loader, all default off, surface + connector scoped |
| `plugins/gmail/index.js` | Gmail plugin — wraps legacy `runGoogleTool` reads; 5 canonical tools |
| `index.js` | bootstrap `buildConnectorRuntime` + `getConnectorRuntime` singleton |

## Canonical Gmail read tools (match Phase-0 fixtures)

| Canonical | Legacy (inbound alias) | Access | Result shape (verbatim from legacy) |
|---|---|---|---|
| `gmail__search` | `gmail_search` | read | `{count, messages:[{id,threadId,subject,from,to,date,snippet}]}` |
| `gmail__get_message` | `gmail_get` | read | `{id,subject,from,to,date,body}` |
| `gmail__get_thread` | `gmail_get_thread` | read | `{threadId,count,messages}` |
| `gmail__list_labels` | `gmail_list_labels` | read | `{labels:[{id,name,type}]}` |
| `gmail__list_drafts` | `gmail_list_drafts` | read | `{count,drafts}` |

Writes (`gmail__create_draft`, `gmail__send_draft`, `gmail__send`) are declared in
Phase 3 with the `PendingWrite` approval gate — deliberately not in Phase 2.

## Phase-2 pipeline (spine; Phase 3 fills the hooks, never reorders)

`validateContext → resolveTool(+legacy alias) → flag-gate → surface-check →
[authorize hook] → getConnection → [validateInput hook] → [gateWrite hook] →
[acquireSlot hook] → execute-with-deadline → classifyError → coerce →
normalize+truncate → [audit hook] → [metrics hook]`

Hooks default to permissive no-ops so the spine is identical with or without the
safety stages installed. This is what lets Phase 3 add validation/approval/
idempotency/audit **without touching the spine or re-testing parity**.

## Acceptance (plan §8 Phase 2) — all met, real execution

- **Canonical schemas match characterization fixtures** — 5 read tools, shapes as above; `validateManifest(GMAIL_MANIFEST)` green.
- **Runtime direct execution equals the legacy result** — `res.content[0].data` deep-equals `runGoogleTool(...)` output; legacy executor called with mapped legacy name + caller-scoped `{user_id,org_id}`.
- **Cross-tenant calls fail** — identity comes only from `ctx`; a `user_id`/`org_id` smuggled in tool args is ignored (asserted).
- **Runtime adds no material latency** — measured per-call overhead **< 20 ms** over the injected executor (50-call loop).
- **Never hangs** — a non-resolving provider call hits the tool deadline → `timeout` status (closes the Phase-0 §10 "mcp/exec has NO timeout" gap).
- **Structured failure** — 401→`reauth_required`, 403→`forbidden`, 429→`rate_limited`, 400/422→`invalid_input`, "not connected"→`not_connected`; secrets (`ya29.…`, `Bearer …`) redacted from output.
- **Oversized result** truncated to the 32 KB budget with `truncated=true`, preview preserved.

## Design notes / decisions

- **DI over import-coupling:** the Gmail plugin takes an injectable `execGoogleTool` (defaults to the real one) so the whole suite runs with no network / DB / OAuth. Production wiring uses the real `runGoogleTool`.
- **Language- & tenant-neutral:** error classification keys off HTTP status codes (not English words); truncation is byte-based; no provider list is hard-coded anywhere except the one-line plugin registration in `index.js`.
- **Connector-wise scripts, not a monolith:** each provider is its own directory under `plugins/`; adding a provider is one `registry.register(...)` line.
- **Frozen contracts:** `validateManifest` returns deep-frozen tools — a test that tried to monkey-patch a tool's `timeoutMs` correctly failed, proving immutability.

## Next

Phase 3: install the real safety-pipeline hooks (ajv schema validation, policy,
connection resolution, `PendingWrite` approval + idempotency, per-tool timeouts,
result normalization, audit, metrics) and add Gmail **writes** through approval.
