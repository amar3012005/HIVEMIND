# STATE — hermes-runtime

- **Current phase:** 4 (hm-control Hermes client) — NOT STARTED
- **Next concrete action:** In hm-control (`core/src/control-plane-server.js`, NEVER core/src/server.js) add the internal Hermes service client: `runOnce(agent_id, payload)` → POST to the hm-hermes gateway (OpenAI-compatible API at `http://hm-hermes:8642` over the hivemind network, Bearer API_SERVER_KEY from /opt/HIVEMIND/.hm-hermes.env), + status + log poll/callback. FE→hm-control only (no direct FE→Hermes). VERIFY: hm-control starts a trivial job and reads its status+logs. Keep it a small additive module hm-control imports.
- **Branch:** P1 claude/hermes-phase-1 · P2 claude/hermes-phase-2 · P3 claude/hermes-phase-3 (MCP wiring, runtime config on box — no repo code change) · P4 → claude/hermes-phase-4.
- **Last verdict:** Phase 3 DONE. HiveMind MCP wired into hm-hermes default profile: config.yaml has `hivemind` server (url /api/mcp, Authorization Bearer ${MCP_HIVEMIND_API_KEY} — env-ref, no literal secret; key in /opt/data/.env), 32/32 tools enabled, `hermes mcp test` connects, survives restart. NOTE: connection uses master key → default-tenant memory; per-tenant consumer tokens are Phase 6. Full recall+save-lands-in-HiveMind e2e proof deferred to Phase 5 (needs a model API key for an agent session).
- **Phases:** 1 ✅ Config contract · 2 ✅ image+compose (deployed) · 3 ✅ HiveMind MCP wiring · 4 hm-control client · 5 Competitor Watcher e2e · 6 GATE pods-per-client
- **Done:** P1 config contract · P2 hm-hermes deployed · P3 MCP wired
- **Do NOT:** edit `core/src/server.js` blindly · `git pull` on prod · commit secrets (master key lives in /opt/data/.env + /opt/HIVEMIND/.hm-hermes.env) · start Phase 6 before Phase 5.
