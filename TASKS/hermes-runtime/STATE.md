# STATE — hermes-runtime

- **Current phase:** 3 (HiveMind MCP wiring) — NOT STARTED
- **Next concrete action:** Register HiveMind MCP in the hm-hermes default profile so Hermes recall/search/save route to our MCP (memory system of record), not local memories/. Write `/opt/data/profiles/default/mcp.json` (or `/opt/data/mcp.json`) inside the hm-hermes container with the HiveMind MCP server (HIVEMIND_API_URL=https://core.hivemind.davinciai.eu:8050, a per-tenant API key, tenant ctx headers). VERIFY: a Hermes session performs a recall + a save that lands in HiveMind (check via API), not local memories/. Done via `docker exec hm-hermes ...` on myserver.
- **Branch:** Phase 2 = `claude/hermes-phase-2` (committed 6ec713d). Phase 3 → `claude/hermes-phase-3`.
- **Last verdict:** Phase 2 DONE + DEPLOYED. hm-hermes LIVE on myserver via `docker run` (standalone, --restart unless-stopped, --shm-size=1g, vol hermes-data:/opt/data, ports 8642 gateway / 9119 dashboard, network s0k0..._hivemind-network). Verify GREEN: :8642 404 (up), :9119 302 (basic-auth), /opt/data persisted across restart. Secrets in /opt/HIVEMIND/.hm-hermes.env (600). NOTE: standalone docker run, NOT Coolify-managed — compose entry in docker-compose.coolify.yml remains as IaC for later Coolify adoption. Default model anthropic/claude-opus-4.6 (needs key for agent runs — Phase 5).
- **Phases:** 1 ✅ Config contract · 2 ✅ hm-hermes image+compose (deployed) · 3 HiveMind MCP wiring · 4 hm-control client · 5 Competitor Watcher e2e · 6 GATE pods-per-client
- **Done:** Phase 1 (config contract) · Phase 2 (hm-hermes deployed + verified)
- **Do NOT:** edit `core/src/server.js` blindly · `git pull` on prod · disturb other Coolify containers · start Phase 6 before Phase 5 · commit secrets (use /opt/HIVEMIND/.hm-hermes.env).
