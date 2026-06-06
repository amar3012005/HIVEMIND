# STATE — hermes-runtime

- **Current phase:** 2 (hm-hermes image + compose) — NOT STARTED
- **Next concrete action:** Add `hm-hermes` Dockerfile from `nousresearch/hermes-agent:latest` (+ `--shm-size`, resource limits) + a shim that reads a task spec from hm-control and invokes Hermes; add `hm-hermes` service to `docker-compose.coolify.yml` (volume `/opt/data`, ports 8642/9119, `API_SERVER_ENABLED=true`, generated `API_SERVER_KEY`, dashboard auth). VERIFY: container boots, gateway `:8642` health + dashboard reachable, state persists across restart. Deploy via verify+rollback on Hetzner. This phase needs server access — if blocked, mark BLOCKED + log.
- **Branch:** Phase 1 = `claude/hermes-phase-1` (committed). Phase 2 → `claude/hermes-phase-2`.
- **Last verdict:** Phase 1 GREEN — `core/src/hermes/agent-config.schema.json` + `agent-config.js` (ajv validator + SAMPLE_COMPETITOR_WATCHER). Tests: sample valid; missing-required / bad memory_mode / cron-without-expr / bad status all rejected. Prod deploy DEFERRED (dormant module, unused until Phase 4 wires it into hm-control — deploy then).
- **Phases:** 1 ✅ Config contract · 2 hm-hermes image+compose · 3 HiveMind MCP wiring · 4 hm-control client · 5 Competitor Watcher e2e · 6 GATE pods-per-client
- **Done:** Phase 1 (config contract)
- **Do NOT:** edit `core/src/server.js` blindly · `git pull` on prod · start Phase 6 before Phase 5 is solid · commit secrets.
