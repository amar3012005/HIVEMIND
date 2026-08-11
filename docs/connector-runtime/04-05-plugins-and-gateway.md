# Connector Runtime V1 — Phases 4–5: Provider plugins + MCP gateway

**Status: built & unit-verified (64/64 across P2–P5b), all additive/flag-off.**
Nothing wired into live surfaces yet — that is the deploy-gated cutover (P6+).

## Phase 4 — provider plugins (connector-wise scripts)

| Connector | Script | Wraps | Tools |
|---|---|---|---|
| gmail | `plugins/gmail/` | `runGoogleTool` (google-native) | search/get_message/get_thread/list_labels/list_drafts (read) + create_draft/send_draft/send (write, approval) |
| google_docs | `plugins/google_docs/` | `runGoogleTool` | search/get (read) + create/append (write) |
| google_sheets | `plugins/google_sheets/` | `runGoogleTool` | get_range (read) + create/append_rows (write) |

Shared `plugins/google-base.js` (`GoogleFamilyPlugin`) removes copy-paste while
each provider stays its own small script + one `registry.register()` line — not a
monolith. Legacy names (`gmail_search`, `drive_search`, `docs_get`, …) are
inbound aliases so existing callers keep working during migration.

**Deferred to the gateway-coupled step:** Slack (SlackBridge) and the MCP-backed
notion/github/linear — these are naturally served through the MCP runner /
gateway plumbing, so they land alongside the live cutover rather than as
standalone REST wrappers.

## Phase 5 — capability token + stateless MCP gateway

- **`capability-token.js`** — 5-min **Ed25519** (asymmetric) tokens. Claims: sub/org/role/surface/connectors/access/projects/room/sid/jti/iat/exp, aud=`hivemind-connector-runtime`. Verify checks sig/aud/iss/exp/surface + Redis JTI revocation (degrades **open** if Redis is down, per plan §9). Public key exported for Employees/TARA to validate without the signing key. `node:crypto` only — no JWT dependency.
- **`mcp-gateway.js`** — pure JSON-RPC handler for MCP streamable-HTTP, protocol **`2025-11-25`** (the version the Phase-1 AgentScope 1.0.21 `HttpStatelessClient` negotiated). Methods: initialize / tools/list / tools/call / ping / notifications. **Execution context is derived only from verified token claims** — the client/model can never set identity. Read-only grants hide *and* forbid write tools; per-connector grant enforced; `CanonicalConnectorResult` → MCP content.
- **`mcp-routes.js`** — HTTP handlers: `POST /api/connectors/runtime/capabilities` (issue; grant = requested ∩ registered ∩ surface-enabled; identity from authenticated principal) and `POST /mcp/connectors/:id` (bearer verify → dispatch; notification→202; revoked/invalid→401). Kept Express-free so the server.js switch-case wiring is a thin flag-gated shim added only at cutover.

## Test coverage (live `hm-core` node, `node --test`)

| Suite | Tests | Covers |
|---|---|---|
| P2 | 21 | contracts, registry/alias, Gmail read parity, cross-tenant, errors, truncation, deadline, latency<20ms |
| P3 | 13 | ajv validation, approval (one draft, provider-not-called), idempotency, double-approve-once, tamper→forbidden, audit fail-closed, role floor |
| P4 | 6 | registry integrity/no-collisions, Google read parity, write→approval, surface gating |
| P5 | 14 | token mint/verify/expiry/tamper/surface/revocation/degrade; gateway initialize/list/call/grant/read-only-block/notifications |
| P5b | 10 | capability issuance (intersection, identity-from-principal, flag gate); gateway bearer/verify/dispatch/notification/revoked, end-to-end issue→call |
| **Total** | **64/64** | |

## What remains (all deploy-gated)

1. **server.js mount** — thin `CONNECTOR_RUNTIME_MCP`-gated switch-case calling `handleCapabilityRequest` / `handleGatewayRequest` (+ `getConnectorRuntime` singleton with prisma/audit/redis wired).
2. **Live tool-calling accuracy** — real AgentScope `HttpStatelessClient` → gateway → runtime → Gmail read, result-parity vs the legacy path (the Phase-1 spike proved the client mechanics against a synthetic server; this proves it against the real gateway).
3. **P6–9 cutover** — flag-flip per surface (HyperAgents → Director → Chat → TARA), canary each.
4. **P10 durable sync; P11 legacy removal.**

The toolkit is architecturally complete and unit-green; steps 1–4 require a
production deploy of the (flag-off) runtime image, then progressive flag flips.
