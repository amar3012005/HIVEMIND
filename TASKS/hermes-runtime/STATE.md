# STATE — hermes-runtime

- **Current phase:** 2 (hm-hermes image + compose) — ⛔ BLOCKED (artifacts done + locally verified; prod boot/deploy needs human go)
- **Why blocked:** booting requires (a) pulling new third-party image `nousresearch/hermes-agent` onto Hetzner, (b) mutating the LIVE Coolify stack (new service hm-hermes, ports 8642/9119, volume), (c) secrets `HERMES_API_SERVER_KEY` + `HERMES_DASHBOARD_PASSWORD`. Safety rails: prod infra of this kind is human-gated, not autonomous.
- **Unblock (operator):** follow `services/hm-hermes/README.md` runbook — set the two secrets in Coolify env, run the ISOLATED smoke test (`docker run … -p 18642:8642 … gateway run` then curl `:18642`), then apply the compose change via Coolify redeploy. Verify gates: `:8642` answers · dashboard `:9119` loads · restart → `/opt/data` persists. Then mark Phase 2 DONE, advance to Phase 3.
- **Branch:** Phase 2 = `claude/hermes-phase-2` (committed). Phase 1 = `claude/hermes-phase-1`.
- **Last verdict:** Phase 2 artifacts GREEN locally — `services/hm-hermes/{Dockerfile,shim.mjs,.env.example,README.md}` + `hm-hermes` service & `hermes-data` volume in `docker-compose.coolify.yml`. `docker compose config` valid; shim `node --check` clean. NOT deployed (human gate).
- **Phases:** 1 ✅ Config contract · 2 ⛔ hm-hermes image+compose (artifacts done, deploy gated) · 3 HiveMind MCP wiring · 4 hm-control client · 5 Competitor Watcher e2e · 6 GATE pods-per-client
- **Done:** Phase 1 (config contract). Phase 2 artifacts (deploy pending human).
- **Do NOT:** edit `core/src/server.js` blindly · `git pull` on prod · pull/run new images or edit live Coolify stack without human go · start Phase 6 before Phase 5 · commit secrets.
