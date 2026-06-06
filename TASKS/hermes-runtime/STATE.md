# STATE — hermes-runtime

- **Current phase:** 1 (Config contract) — NOT STARTED
- **Next concrete action:** In hm-core, add the Hermes Agent JSON config — a schema file (`core/src/hermes/agent-config.schema.json` or a JS schema module), a validator function, and one sample agent (`Competitor Watcher`) matching the contract in README §"The Hermes Agent config contract". No infra. `node --check` + validator accepts sample / rejects malformed.
- **Branch:** (none yet — create `claude/hermes-phase-1` on first run)
- **Last verdict:** PLAN complete; folder scaffolded; cron registered. Phase 1 pending first cron fire.
- **Phases:** 1 Config contract · 2 hm-hermes image+compose · 3 HiveMind MCP wiring · 4 hm-control client · 5 Competitor Watcher e2e · 6 GATE pods-per-client
- **Done:** none
- **Do NOT:** edit `core/src/server.js` blindly · `git pull` on prod · start Phase 6 before Phase 5 is solid · commit secrets.
