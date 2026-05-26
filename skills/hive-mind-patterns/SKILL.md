---
name: hive-mind-patterns
description: Coding patterns extracted from HIVE-MIND repository via git history analysis
version: 1.0.0
source: local-git-analysis
analyzed_commits: 200
---

# HIVE-MIND Patterns

Persistent-memory engine for AI. Multi-surface (Chrome ext, dashboard, MCP, CLI). Node 20 / Express / Prisma / Postgres / Qdrant. Frontend: React CRA (Da-vinci submodule).

## Commit Conventions

**Format:** `<type>(<scope>): <subject>` — conventional commits with mandatory scope.

Observed type distribution (200 commits):
- `fix(<scope>):` — 60+ (most frequent; bug-fix culture)
- `feat(<scope>):` — 35+
- `chore(submodule):` — 26 (Da-vinci submodule bumps after frontend changes)
- `docs(<scope>):` — 3
- `perf(<scope>):` — 2
- `merge(<scope>):` — 2
- `debug(<scope>):` — 3 (temporary diagnostic commits)

**Scopes are subsystem-coded**, not folder paths:
- `recall`, `recall-router`, `cognition-loop`, `cluster-index`
- `agent`, `agent-v2`, `react-agent`, `memory-engine`, `smart-router`, `smart-memory`
- `oauth`, `oauth-discovery`, `oauth-gate`, `oauth-ui`, `oauth/register`
- `ext` (Chrome extension), `ingest`, `ingest-tree`, `ingest-queue`, `ingest-persist`
- `enrich`, `connectors`, `connector-store`, `nango`, `mcp-registry`
- `gmail-sync`, `gmail-ingest`, `gmail-preview`, `slack`, `salesforce`
- `submodule` (always pairs with Da-vinci bump)

**Subject style:** lowercase verb, em-dash for clauses, no period.
Example: `fix(recall-router): raise HOP1_TIMEOUT_MS from 1500 → 4000ms`

## Code Architecture

```
core/
├── src/
│   ├── agent/          # ReAct agent + tool-registry + toolkit-factory
│   ├── memory/         # recall-router, cognition-loop, graph-engine,
│   │                   # cluster-index, smart-ingest-router, prisma-graph-store
│   ├── connectors/
│   │   ├── framework/  # connector-store, sync-engine
│   │   └── providers/  # slack, gmail, salesforce, gdocs, gemini
│   ├── ingestion/      # pipeline-orchestrator, persistence
│   ├── services/       # image-ingest, assistant-identity, chat-ingest-distill
│   ├── server.js       # main Express (most-modified file: 45 changes)
│   └── control-plane-server.js  # OAuth + CLI auth
├── prisma/             # schema + migrations
└── scripts/            # eval-harness, backfill, reingest

frontend/Da-vinci/      # React CRA submodule (always bumped via chore(submodule))
extensions/chrome/      # MV3 ext (background.js, side-panel.js, chat-overlay.js)
```

**File-change hotspots** (top 5):
1. `core/src/server.js` (45) — central Express, gets every endpoint
2. `frontend/Da-vinci` submodule (33)
3. `core/src/agent/react-agent-v2.js` (23)
4. `core/src/memory/recall-router.js` (19)
5. `core/src/memory/graph-engine.js` (15)

## Workflows

### Frontend change shipping
1. Edit inside `frontend/Da-vinci/...`
2. Commit inside submodule with normal `feat/fix(<scope>):` message
3. Parent repo: `chore(submodule): bump Da-vinci → <short-sha> (<desc>)`
4. Vercel auto-deploys on main push

### Memory/recall change
1. Edit `core/src/memory/<file>.js`
2. Always test path through `recall-router.js` (lots of fix commits there — fragile)
3. Run `core/scripts/eval-harness.mjs` (6 commits = test harness actively used)
4. Memory schema change → Prisma migration in `core/prisma/migrations/`

### Ingest pipeline change
1. Smart-router decides path → `pipeline-orchestrator` → `persistence`
2. Enrichment via `gpt-oss-20b` w/ `gpt-oss-120b` fallback on parse_error
3. Always handle: 25P02 (txn aborted), FK violation pre-flight, dedup via source_metadata join

### Connector/OAuth change
1. Backend: `core/src/connectors/providers/<provider>/`
2. Framework hooks: `connector-store.js`, `sync-engine.js`
3. Nango unique_keys MUST match Nango dashboard (multiple fix commits)
4. OAuth issuer derived from request Host (NOT hardcoded) — Claude rejects mismatch

### Chrome extension change
1. Edit `extensions/chrome/{background,side-panel,chat-overlay}.js`
2. MV3 manifest: optional_host_permissions for AI chat sites
3. Reload ext → side-panel scope ≠ background scope (separate workers)

## Memory Discipline (HIVEMIND-specific)

Mandatory in this repo per CLAUDE.md:
- After any file Edit → `hivemind_ingest_code`
- Architectural choice → `hivemind_log_decision`
- Rename/move/split → `hivemind_track_refactor`
- End of task → `hivemind_save_conversation` w/ tag `session-progress`
- Tag every memory: `file:<path>`, `fn:<name>`, `bug|fix|gotcha`, `session-trail-YYYY-MM-DD`

## Known Fragile Areas (high fix-commit density)

| Area | Fix count | Pattern |
|------|-----------|---------|
| recall / recall-router | 20+ | tier ordering, FTS columns, project-scope fallback, timeout tuning |
| cognition-loop / cluster-index | 10+ | snake_case payloads, UUID casts, entity_keys backfill |
| oauth | 7 | issuer host derivation, CORS, dynamic client registration |
| ingest | 6+ | 25P02 cascade, FK pre-flight, dedup metadata join |
| chrome ext | 6 | selection capture, upload UI, scope leaks (getConfig undefined) |

When touching these — recall prior bug memories first via `hivemind_recall_bugs`.

## Testing Patterns

- No traditional unit-test suite at root level
- `core/scripts/eval-harness.mjs` — main eval harness (poll-by-tag for queued ingest)
- `tests/` directory exists but ad-hoc
- Smoke test via `/tmp/test-*.mjs` one-shot scripts (see prior session: `test-recall-router.mjs`)

## Anti-patterns Observed

- `<all_urls>` content scripts → Chrome Web Store rejection
- Inline OAuth issuer (hardcoded) → MCP client rejection
- camelCase payloads to `graph-engine._buildMemoryRecord` (expects snake_case)
- Passing `tools` param to fallback "STOP calling tools" LLM call (agent loop exhaustion bug)
- Stripping LLM-passed args via overly-strict `validateAndSanitize` schema gate
