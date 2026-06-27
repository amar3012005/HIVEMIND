# Governance Changelog — the accountability ledger

One dated entry per turn. Quotes commits + the verifier's verdict. Records RED turns too. Newest first.

---

## 2026-06-26 — Governance crew created
- type: setup   verdict: GREEN
- decided: a 4-agent loop (architect/builder/verifier/scribe) distilled from this session's failure modes.
- built: `.claude/governance/` (README, LOOP, agents/*, journals/*, this ledger).
- state: active (the loop is now the process for setup/bug/feature work).
- residuals: none.
- refs: `.claude/governance/README.md`, `LOOP.md`.

## 2026-06-26 — BYOD data residency: gaps closed
- type: feature   verdict: GREEN
- decided: customer box = DATA only (Postgres + Qdrant / `.amr`); engine + global info central; one seam.
- built: split client + `runWithOrg` context proxy (B4) · per-org Qdrant · control-plane
  `/v1/selfhost/{enroll,register}` + curated-schema bootstrap (B3) · public PG image (B1) · standalone
  `infra/setup.sh` (A3) · tara in compose + extras documented (A1) · transport guide (B2).
- verified: register e2e on prod (throwaway org) → `{ok, migrated:true}`, schema applied; managed (sai)
  recall + ingest intact after every deploy; prod inert by default (no registry file).
- state: deployed + INERT (activates when a customer registers — the shared registry file is the switch).
- residuals: hermes/playwright/stt source not in main repo (need Dockerfiles/images); central must join
  the customer tailnet (operational); a real full customer-box acceptance run pending.
- refs: `docs/architecture/*`, `byod/` + `byod` branch, `infra/` + `infra` branch.

## 2026-06-26 — `.amr` engine + dual-write + reverts
- type: feature   verdict: GREEN
- decided: `.amr` = additive vector+graph index (replaces Qdrant), Postgres keeps rows (dual). Dreams =
  cognitive-layer memories, NOT tables.
- built: dual-write mode · `.amr` lexical recall + no-PG write · dreams→cognitive layer · typed-graph in `.amr`.
- REVERTED (recorded honestly): the over-complication — 5 sidecar tables (userProfile/clusterIndex/…)
  + profile/cognition `if(isMnemeOrg)` branches. They were a SQL schema imposed on `.amr`; backed out.
- verified: sai recall (vector+lexical) on `.amr`; managed intact.
- state: deployed.
- refs: `CHANGELOG/2026-06-26-mneme-amr-engine.md`.

## 2026-06-27 — Phase 1+2: push-model data plane (PG+Qdrant agent) + central=0 for remote
- type: feature   verdict: GREEN (residuals)
- decided: agent = pure Postgres+Qdrant with its OWN `hm` schema (no .amr/Prisma/enums) → kills schema-drift class. Engine PUSHES finished memory over bearer HTTP; never touches customer DB. .amr is a later swap behind the same API.
- built: P1 — rewrote byod/agent/server.mjs (write/recall/lexical/hydrate/list/edge/update-tags/delete/purge/health, atomic-ish row+vector, dedicated hm schema). P2a — engine→agent push lands (storeMemory orgIsRemote → amrWrite). P2b — central=0: createMemory pushes row to agent immediately (vector later); subgraph writes (sourceMetadata/version/relationship) skip central for remote; getMemory/getMemories/listMemories route to agent (remoteHydrate/remoteList + mapAgentRow).
- verified: all 8 agent routes curl-green; save → central Δ0 / agent Δ+1 (vector_synced=t) / recall+list from agent; ingest completes; managed structurally unaffected (only the registered remote org branches).
- state: deployed via docker cp to hm-core (EPHEMERAL — needs git pull+rebuild for durability, per E1). Committed to feat/mneme-foundation + byod branch.
- residuals: enrichment-queue central source_metadata write for remote (non-fatal, gate next); stale agent Qdrant test points (purge); registry must be agentUrl+token ONLY (pgUrl empty — stale pgUrl revives dead direct-PG path).
- refs: docs/PRODUCTION_COMPASS.md, byod/agent/server.mjs, core/src/memory/prisma-graph-store.js, core/src/vector/mneme/remote-backend.js.

## 2026-06-27 — Self-host onboarding e2e: auto-connect + residency + recall (fresh org)
- type: feature   verdict: GREEN
- decided: production model = Option B (creds embedded in the curl; agent self-registers on boot; engine stateless, registry = connection state; FE polls status, survives tab close). Beats Option A (agent-asks/user-accepts = friction).
- built: hosting_mode persisted on org (managed|self_host) + surfaced in payloads; FE AppShell gate (self_host & !connected → SelfHostSetup before overview, auto-flips on connect); onboarding ask-once (consume login-page choice, auto-create); PrismaGraphStore.searchMemories remote branch (embed→amrRecall→agent) — THE real API recall entry (gate was in the wrong searchMemories); SINGULANCE-branded setup.sh terminal UX (banner + connected box); registry perms fix.
- verified e2e on fresh self-host org d39518cb (myserver agent → singulance engine): non-interactive setup → agent boots → auto-registers → status reachable; save → central Δ0 / agent Δ+1 (vector_synced); RECALL returns agent content ("Skyforge…Bremen"); baked durable; managed/personal central path unaffected (orgIsRemote=false).
- 3 types resolved: Personal→central pool; Enterprise-managed→central + per-org Qdrant collection (provisionForPlan); Enterprise-self-host→agent (PG+Qdrant). One seam: memoryBackend(org).
- residuals: phantom-org in logs = RECALL_WARMUP_ORG hardcoded default (harmless warmup, set RECALL_WARMUP_ORG or ignore); FE deploy to singulance is docker-cp (box submodule inaccessible → image can't rebuild) — live but not durable; agent-side enrichment for remote deferred.
- next: production compass phases (outbox spine, etc.).

## 2026-06-27 — Self-host graph layer fixed (entity tags + co-mention edges on agent)
- type: fix   verdict: GREEN   commits: cf26d739, 41c3f9e1, e6285f21 (core) · byod c19dcdd5
- symptom: relationships/entity-graph dead for remote (self-host) orgs — 0 entity tags, 0 edges on agent.
- 4 chained root causes, each fixed:
  1. _attachEntityCoMentionEdges hard-returned on 0 co-mention candidates BEFORE extracting the
     memory's own entity:*/temporal tags → now continues to self-tag extraction (helps central first-memory too).
  2. candidate pool queried central Postgres (empty for remote) → added amrListRecent → agent /v1/list
     (flat filter + new user_id scoping).
  3. store.updateMemory threw 'record not found' for remote (tag persist + type upgrade) → remote branch
     routes tags/is_latest/memory_type to agent via amrUpdate → new agent /v1/update (PG+Qdrant).
  4. central edge-existence pre-flight dropped every edge (candidates absent from central) → skipped for
     remote (agent /v1/list already deleted_at-filtered; agent enforces existence on insert).
- verified e2e (singulance engine save → myserver agent PG read): entity:* tags land on agent; Δ3 edges
  (Updates + 2×Mentions) on hm.relationships; recall green; central=0 (residency held).
- deploy gotchas hit + logged: (a) `docker compose up` WITHOUT `--env-file ../.env` boots core with blank
  HIVEMIND_ADMIN_SECRET (environment: <<:*common-env interpolates ${VAR} from shell, overriding env_file)
  → FATAL; always pass --env-file. (b) git checkout from stale origin (forgot fetch) + a build that missed
  the edit (image older than disk) → ALWAYS fetch before checkout + verify `docker exec hm-core grep <marker>`.
- topology reaffirmed: ENGINE=singulance hm-core (all builds/deploys); /infra CLIENT AGENT=myserver
  hm-byod-agent+postgres (push target, read-only verification). No myserver engine touched.
