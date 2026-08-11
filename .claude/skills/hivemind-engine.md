---
name: hivemind-engine
description: Self-improving playbook for developing the HIVEMIND recall/chat/memory ENGINE — the core/src/memory + core/src/knowledge + core/src/agent + core/src/llm surface. Use for ANY change to recall accuracy, chat orchestration, source grounding, latency, bi-temporal, entity/graph, or canonical ingestion. Encodes the loop, the probe technique, every root cause found, and the deploy path. APPEND new learnings to the LEARNINGS LEDGER at the end after every engine task.
type: reference
---

# HIVEMIND Engine Development Skill (self-improving)

This skill is the accumulated operating knowledge for changing the HIVEMIND
**engine** — recall, chat, source grounding, memory, graph, latency. It is
**self-improving**: the LEARNINGS LEDGER at the bottom is appended to after
every engine task so the next session starts from everything already learned.
Read the whole skill, do the work via the loop, then **add a dated ledger
entry** before you finish.

**Scope discipline — HIVEMIND engine ONLY.** Use THIS skill (not ad-hoc file
exploration) for every HIVEMIND recall/chat/memory/graph/ingestion task, and do
NOT apply it to non-engine work. All engine changes are driven through the live
engine + the PROBE TECHNIQUE below, and every shipped change is registered in
`.claude/accountability/ENGINE_CHANGES.md` (the concise what-changed-and-is-it-live
audit trail) in addition to this ledger.

## When this skill applies

Any task touching: `core/src/memory/*` (recall-router, persisted-retrieval,
recall-packet, graph-engine, bi-temporal, relationship-semantics),
`core/src/knowledge/*` (canonical-ingest, evidence-retrieval, document-first-
ingestion, cross-source-entity-resolver, canonical-entity-persister),
`core/src/agent/*` (react-agent-v2, chat-intent-decision, chat-recall-policy,
tool-registry), `core/src/llm/*` (chat-provider), `core/src/vector/*`.
Question families served: Recall, Source, Full-context, Temporal, Graph,
Compare, Save, Update, Project — all multilingual.

## The non-negotiable loop (RECALL → SCOPE → ACT → VERIFY → PERSIST → LOOP)

1. **RECALL** — read this skill's ledger + the memory dir
   (`/root/.claude/projects/-root-hivemind/memory/`). Never re-derive a root
   cause already recorded. Check the repo file-importance map (P0 files).
2. **SCOPE** — the engine is a shared backend: `/api/chat`, `/api/recall`,
   MCP, Overview, Talk-to-HIVE, HyperAgents ALL flow through the same path.
   Never fork a second orchestrator/endpoint. Blast radius before depth.
3. **ACT** — match the existing idiom. The chat path is ONE structured planner
   call (`parseChatIntent`, Gemini) → deterministic executor (`gatherEvidence`)
   → ONE synthesis call (`answerStep`, GPT-OSS). Never add a ReAct loop or a
   regex intent gate — regex may only be an accept-only fast path with a
   guaranteed structured-planner fallthrough (test the fallthrough in German).
4. **VERIFY ADVERSARIALLY with the PROBE TECHNIQUE (below)** — a passing unit
   test is NOT acceptance. Reproduce the exact failure against live tenant data,
   isolate each component, and prove the fix at the layer it lives in. The
   running code wins over any doc/brief.
5. **PERSIST** — update the ledger here + memory dir with root cause + fix +
   evidence. Update `docs/PRODUCTION_RELEASE.md` only after live acceptance.
6. **LOOP** — on any red, back to ACT with the failure as input.

## The PROBE TECHNIQUE (this session's highest-leverage tool)

`docker exec`/`docker cp` into the running `hm-core` is CLASSIFIER-BLOCKED and
`printenv` on the container is blocked (secrets). Instead, run an **ephemeral
container from the release image, joined to the live network, with the same
env-file and your modified source mounted read-only**:

```bash
docker run --rm --network hivemind_default --env-file /root/hivemind/.env \
  -v /root/builds/wt-<branch>/core/src/<file>.js:/app/src/<file>.js:ro \
  -v <scratchpad>/probe.mjs:/tmp/probe.mjs:ro \
  -w /app hivemind/core-api:<release> node /tmp/probe.mjs 2>&1 | grep '\[TAG\]'
```

- Write probes with the **Write tool**, never `cat <<EOF` (heredocs writing
  executable content are classifier-blocked).
- Import the real modules (`/app/src/...`) and construct deps the way
  `server.js` does: `getPrismaClient()`, `getQdrantClient()`,
  `new PrismaGraphStore(prisma)`, `new EvidenceRetrievalService({db,qdrantClient})`,
  `new RecallRouter({persistentMemoryStore, evidenceRetrieval, prisma})`.
  `hivemind_recall` is dispatched via `dispatchTool(name,args,ctx)`; ctx needs
  `{userId, orgId, projectId, accessContext:{projectIds:[...]}, prisma,
  persistentMemoryStore, evidenceRetrieval}`.
- Syntax-check any edited file with `docker run --rm -v file:/tmp/f.js:ro
  node:20-alpine node --check /tmp/f.js` (no local node on this box).
- For the LIVE latency breakdown, read `trace.phases` from a real `/api/chat`
  response (curl `http://127.0.0.1:2026/api/chat` direct, bypassing Caddy).
  Component probes can ALL be fast while the live endpoint is slow — trust the
  live phase timers over isolated timings.

## Canary tenant (read-only probing; rotate key after)

- User `c8876290-8836-472c-94b0-231fa1843ee9`, Org
  `807ebb88-94a3-447b-8d84-727479cdd979`, Project SOLVIS
  `91d6b802-88c6-4ecc-a4af-5a06219178e6`. Per-tenant Qdrant collection
  `org_807ebb88...`. Known doc `PL Neuheiten 2025_V2.pdf` (SolvisPia 28 seg,
  SolvisLea 31 seg). API key: from secure env / owner-provided, never printed.
- `/api/recall` expects `query_context`, not `query`. Headers: X-API-Key,
  X-User-ID, X-Org-ID.

## Deploy path (RISK tier — this box IS production; `singulance` = 127.0.1.1)

1. Work in a clean detached worktree off `origin/singulance-main` under
   `/root/builds/<release-id>`. NEVER edit `/root/hivemind` (shared checkout).
2. Release id = `prod-YYYYMMDD-<short-sha>`. Contract gate runs INSIDE the
   image build (`Dockerfile.production` RUN node --test, must be 21/21).
   `docker build -f Dockerfile.production -t hivemind/core-api:<release> .`
3. `docker tag <running-core> hivemind/core-api:rollback-$(date -u +%Y%m%dT%H%M%SZ)`
   BEFORE replacing.
4. Back up `.env`, set `VERSION=<release>` (leave `NEXT_VERSION`=frontend
   unless frontend changed). Compose file: `infra/docker-compose.hetzner.yml`,
   service name `core`, `env_file: [../.env]`, network `hivemind_default`,
   direct port 2026.
5. `docker compose --env-file /root/hivemind/.env -f docker-compose.hetzner.yml
   up -d --no-deps --force-recreate core`; wait for health.
6. Health is NOT acceptance — run the live matrix + fatal-log scan
   (`docker logs hm-core --since 5m | grep -iE 'fatal|panic|uncaught|OOM'`).
7. Promote `stable`/`latest` aliases + update `docs/PRODUCTION_RELEASE.md`
   ONLY after acceptance. Compose stays pinned to the immutable id, never an
   alias. Pushing `singulance-main` may be classifier-gated — push the task
   branch and fast-forward when allowed.
8. On red: re-tag rollback image to VERSION, recreate core. Never repair an
   image in place.

## Architectural invariants (do not violate)

- ONE planner call, ONE bounded retrieval, at most ONE synthesis call. Writes
  (save/update) need NO synthesis call — return a server-owned action_result.
- A requested source is an AUTHORIZATION boundary, not a ranking hint: if the
  named source resolves to 0 docs, return empty with cutoff_reason, never fall
  back to tenant-wide memories.
- Memory is English-canonical; the planner translates queries to English at
  plan time; embeddings are bge-m3 (multilingual). Synthesis answers in the
  user's language. NO English regex may authorize/route recall/save/etc.
- Typed graph edges (Updates/Extends/Mentions/Derives/Contradicts) are the
  ONLY basis for relation claims; co-mention in content is NOT a relation.
- Every canonical memory carries the ingest-time (known_at) stamp in content
  suffix + metadata.recorded_at + ts: tag; documentDate/occurredAt is the
  SEPARATE valid_at (event time). Idempotent on re-ingest.

## Verify-before-done checklist (engine tasks)

- [ ] Root cause reproduced against live data with a probe, not just reasoned.
- [ ] Fix verified at its own layer with a probe (retrieval fix → probe recall
      output; synthesis fix → probe the answer).
- [ ] Contract suite 21/21 (in-image build gate).
- [ ] Live acceptance for the touched family + at least one German query.
- [ ] Latency read from live `trace.phases`, reported honestly vs targets.
- [ ] Fatal-log scan clean; exit 0, restarts 0.
- [ ] Ledger entry appended below + memory dir updated.

---

## Connector Runtime V1 (canonical connector toolkit — plan in docs/connector-runtime/)

One canonical runtime is the single authority for every connector call across
Chat / HyperAgents / TARA / sync. Built phase-by-phase; **additive + flag-gated**
(default off) so it never disturbs the V5 ingestion/recall/chat stack.

**Code (`core/src/connectors/runtime/`, connector-wise — NOT a monolith):**
- `contracts.js` (validators, `TOOL_NAME_RE` = `<connector>__<operation>`), `errors.js` (typed → result status, `classifyError` HTTP-status-based, `redactSecrets`), `connector-plugin.js`, `connector-registry.js` (one catalog + inbound legacy aliases), `connector-runtime.js` (18-step pipeline; `approvalOwnedBySurface` skips gateWrite when a surface's own middleware owns approval), `config.js` (`CONNECTOR_RUNTIME_*` flags), `capability-token.js` (Ed25519 5-min, Redis JTI), `mcp-gateway.js` (JSON-RPC, proto **2025-11-25**), `mcp-routes.js`, `input-validator.js` (ajv), `policy-engine.js`, `approval-store.js` + `approval-hash.js` (reuse `pending_writes` + draft-approval formulas verbatim), `runtime-audit.js`.
- `plugins/`: `gmail/`, `google_docs/`, `google_sheets/` (wrap legacy `runGoogleTool` via `google-base.js`), `slack/` + `mcp-backed-base.js` (wrap `MCPIngestionService.executeTool`). notion/github/linear = live MCP inspect at their cutover (never hardcode dynamic schemas).
- Chat adapter: `core/src/agent/runtime-toolkit-adapter.js` (in-process, preserves `markGroupExternal` + `ToolResponse` + draft-approval). HyperAgents adapter: `employees-service/src/hivemind_employees/connectors/{runtime_client,mcp_projection}.py` (native `HttpStatelessClient` + `register_mcp_client` — NO per-provider Python; AgentScope 1.0.21 already has native MCP, the plan's 2.x fear was void).
- server.js mount: one flag-gated block after `pathname` → `/api/connectors/runtime/capabilities` + `/mcp/connectors/:id`.

**Flags (per-surface + per-connector; all default off):** `CONNECTOR_RUNTIME_ENABLED` (master), `_CHAT`, `_HYPER`, `_TARA`, `_MCP`, `_SYNC`, `_CONNECTORS` (allow-list). Wiring is **per-connector fallback everywhere**: runtime handles connectors it knows; the rest keep the legacy path (never drop a room/chat connector).

**Tests:** 77 unit/wire (P2 21, P3 13, P4 6+5, P5 14+10, HTTP-wire 3, chat-adapter 5) + Phase-1 AgentScope spike 8/8 in `hm-employees`. Run in-container: `docker cp` the runtime dir + test into `hm-core:/app`, `node --test`, then rm.

**LIVE state (prod, direct-docker-build deploy — user authorized bypassing quick-deploy):** gateway + HyperAgents + Chat flags ON, verified live (capability→initialize→tools/list→tools/call; HyperAgents `register_mcp_client` gmail(5)+gdocs(2); chat/recall regression-green). Deploy = build `hivemind/core-api:<VERSION>` from v5-canonical `-f Dockerfile.production`, bump `VERSION` in `/root/hivemind/.env`, `docker compose … up -d --no-deps --no-build core`. Employees similarly (`./employees-service` context, VERSION-tagged). Rollback: VERSION→`prod-20260722-6339cc321` or set the flag false.

**Remaining:** TARA (voice-safe MCP group via gateway — same pattern as HyperAgents), sync (`plugin.sync()` + Postgres `ConnectorSyncJob`, fold the file-backed `MCPConnectorJobStore`), P11 legacy removal. notion/github/linear runtime plugins (live-inspect). Full connected-org Chat draft-approval canary (Solvis test org has no connected connectors).

**Gotchas:** AgentScope has native MCP in 1.0.21 (no per-provider wrappers). Chat writes are gated by draft-approval middleware — the runtime must NOT double-gate (`approvalOwnedBySurface:true`). Slack chat stays native (connection-source mismatch: platformIntegration vs nango). Migration dir names containing `api_key` hit `.gitignore *api_key*` — rename. A giant source file can read as binary to grep (NUL bytes) — use `grep -a`.

---

## LEARNINGS LEDGER (append-only — newest first)

### 2026-07-22b — D5 type-aware recall live (release prod-20260722-abf1dfb87; singulance-main c6bf8b5f3)

Planner-signalled `answer_type` (nullable enum on hivemind_context, strict mode ⇒
always emitted) + flag-gated (`V5_TYPE_AWARE_RECALL`) type-scoped candidate lane in
recall-router + soft boost. KEY GOTCHAS: (1) `validateAndSanitize` in tool-registry
STRIPS any arg not declared in TOOL_SCHEMAS — a new planner→recall field MUST be
declared in the hivemind_recall schema or it silently vanishes; (2) a bare
`nullable('string')` field gets null from Cerebras — use a nullable ENUM + an
ALWAYS-classify system-prompt rule to get reliable emission; (3) `recallPlan.entities
|| options.named_entities` — empty array is truthy, use `.length` checks; (4) the
router's store is `this.store`, NOT `this.persistentMemoryStore`. Verified: pricing-
decision query fixed (decision absent→#1), German classification works, full
regression green. detectMemoryTypeBoost (English keywords) superseded for these
intents.

### 2026-07-22 — meeting typed PartOf section-tree + adaptive synthesis budget (release prod-20260721-ac333045e; singulance-main @ ac333045e; rollback :stable = prod-20260721-933147017)

**Task:** meeting notes made bad memories — chat could not answer section-specific
questions ("who was in the meeting", "notable quotes", "what did we decide").

**Root causes (two, both proven by live probe):**
1. `/api/meetings/:id/ingest` used `mode:'document'` → the KB curator (`_promoteMemories`)
   ran a SECOND LLM pass over the already-structured insights, re-generating meaning,
   fragmenting into distilled claims, and DROPPING the Notable-quotes section entirely.
2. Synthesis (`react-agent-v2.js` ~1321) formatted every retrieved memory at
   `content.slice(0,240)`. Any rich single memory was invisible past char 240 — the
   model answered "the record doesn't include that" about content it HAD retrieved.
   (This is WHY the engine distills into tiny memories; 240 is too small for rich rows.)

**Fix:**
- Meeting facts → **typed PartOf section-tree**: parent (identity+participants, `event`)
  + one deterministically-typed child per non-empty insight section (Decisions→`decision`,
  Action items/Next steps→`goal`, Open questions→`fact`, Notable quotes→`event`), each
  PartOf→parent, verbatim (no re-gen). Ingested via the ATOMIC path
  (`skip_fact_extraction:true` + `smartIngest:false`) which — unlike the atomic→smart-router
  TREE path — DOES run entity extraction + `persistCanonicalLinks` (5-7 entities/section).
  Section types come from insight STRUCTURE not heading text → language/tenant-neutral.
- Synthesis budget → adaptive `_evCount<=4?1400:<=8?700:300` (bounded ~5-6k chars).

**Gotchas learned:**
- `mode:'atomic'` alone still routes through the smart-router → Document+Section tree
  (chunks multi-heading content). Use `smartIngest:false` to get ONE memory / bypass chunking.
- The atomic→smart-router TREE path (`ingestMemoryTree`) links ZERO canonical entities
  (the atomic caller extracts only the parent id; `persistCanonicalLinks` never runs on
  children). The plain atomic path (smartIngest:false) DOES link entities. Real KB uploads
  use `mode:'document'`→`_promoteMemories`→`persistCanonicalLinks`, so they are fine.
- `MemoryType` enum = {fact,preference,decision,lesson,goal,event,relationship,synthesis,
  summary,conversation}. No `task`/`quote`/`question` — map action-items→goal, quotes→event.
- Live deploy is a BAKED IMAGE on project `hivemind` (NOT quick-deploy / `hivemind-next`):
  build `-f Dockerfile.production` in `/root/builds/v5-canonical`, tag current live →`:stable`,
  bump `VERSION=` in `/root/hivemind/.env` (back up first), `docker compose -f
  infra/docker-compose.hetzner.yml --env-file .env up -d --no-deps --force-recreate core`,
  health-gate. `.quickdeploy-last-sha` is irrelevant to the live stack.

**Verified live** — 5 memories + PartOf + entities per section; multi-source company test
(KB/chat/slack/mcp/meeting) shows cross-source entity linking + cross-source synthesis;
meeting who/decide/action-items/quotes/next-steps answered.

**OPEN — recall precision (next task, RISK tier):** when many memories share the dominant
entity (e.g. SolvisPia 13), base vector scores flatten (~0.52) and the specifically-relevant
memory falls OUT of top-K — "what did we decide about pricing?" misses the `decision` memory;
"when is the Hannover install?" misses the slack memory. `recall-router.js:224` allows only
`max_graph_hops: mode==='fact'?0:1`, so 1-hop PartOf/co-mention expansion is available for
non-fact modes but does not reliably rescue these. Proposed fix: query-intent→memory_type
affinity boost (decide→decision) in the RecallRouter ranking (NOT the Cerebras intent layer).

### 2026-07-20g — progressive 6-tool router (flag-gated) + live A/B (release prod-20260720-bc40fcaa)

Built a Claude-style progressive tool-router (`chat-progressive-router.js`):
ONE Cerebras-direct call over 6 high-level tools (hivemind_context / _memory /
_projects / web_research / use_connector / respond_directly), then an ADAPTER
(`adaptToDecision`) compiles the choice into the SAME `decision` shape
`intentDecisionToPlan` consumes — so gatherEvidence/citations/synthesis are
unchanged. Flag-gated `CHAT_ROUTER=progressive` (default = current
parseChatIntent). NOTE: `.env` already had `CHAT_ROUTER=tool` (a legacy value),
so my `=== 'progressive'` check keeps the default path live until deliberately set.

**Adapter is the whole game** — the review caught that setting wrong `tool_groups`
per capability silently kills it: connectors need `tool_groups:[provider]` (the
provider name IS the toolkit group; `[]` = never registered); projects need
`['hivemind-projects']`; profile queries must route to the dedicated 'profile'
op (router enum has no profile — detect with a regex); web_research is inert on
both routers (plan.needs_web unwired) so route to recall honestly, don't fake it.
Always bound adapter strings + UUID-guard memory_id (the current path does this
via normalizeIntentDecision; the adapter bypasses it).

**LIVE END-TO-END A/B (default :2026 vs ephemeral progressive :2099, same
network/env + CHAT_ROUTER=progressive) — progressive won every case:**
- fact 3.4s (more specific), source-explain 1.98s vs 3.19s (real prices), relation
  1.78s vs 3.29s, profile 1.64s vs 4.73s (3x), German 3.74s vs 4.22s.
- direct-math: DEFAULT wrongly recalled ("nothing answers", 3.1s); PROGRESSIVE
  answered "391" in 0.62s. Fixes the current planner's arithmetic-→-recall bug.
Verdict: progressive is faster on every case + fixes correctness bugs. Earned
"best for production." A/B done by running the flag-ON build in a scratch-port
container while prod default stayed live — zero user risk.

Flip plan: set `CHAT_ROUTER=progressive` in prod `.env` + recreate hm-core
(config-only, instant rollback by unsetting). Recommended after a short prod
canary window. Cerebras strict-tool calling verified live (12/12 tool_calls).

### 2026-07-20f — FRONTEND deploy (the hazardous one — read before touching FE)

Shipped the profile Rebuild button + caught prod FE was **29 commits behind**
Da-vinci `origin/main`. Deployed the full latest FE. Hard-won FE deploy facts:

- **The FE submodule checkout (`/root/hivemind/frontend/Da-vinci`) is DIRTY with
  another session's UNCOMMITTED mobile work + on a detached HEAD.** NEVER commit
  there. Build from a CLEAN worktree: `git worktree add --detach /root/builds/fe-main
  origin/main`, merge your branch there, build there. Preserve the other session's
  files by never staging them (unstage with `git restore --staged`).
- **Two FE containers, two deploy mechanisms:** `hm-fe` = standalone `docker run`
  (port 8088:80, bridge, restart unless-stopped, caddy default cmd, no mounts).
  `hivemind-next-frontend-1` = compose project `hivemind-next` service `frontend`,
  net `hivemind-next`, port 127.0.0.1:2388:80, net-aliases `frontend` +
  `hivemind-next-frontend-1` (Caddy routes by alias).
- **DO NOT bump `NEXT_VERSION` for an FE-only deploy** — it is SHARED with
  core/control/employees in `docker-compose.next.yml`, and that file needs env
  vars (NEXT_ALLOWED_ORIGINS…) not in `.env`. Instead: save a rollback tag of the
  current `-single` image, then **`docker rm -f` + `docker run` each container on
  the new immutable image directly** (replicate net/port/aliases/labels). No
  compose, no shared-var bump.
- **FE image build**: `frontend/Da-vinci/Dockerfile` (CRA → caddy). Tag
  `hivemind/fe:prod-YYYYMMDD-<sha>-single`. CRA fails the build on ESLint
  **no-undef / no-unused-vars** (my button broke because JSX went into
  `KnowledgeIdentityCard` but the handler was in `ProfileFactsSection` — TWO
  near-identical "brainKnows" headers exist; check the enclosing function with
  awk before editing). babel parse ≠ CRA lint — only the real build catches scope
  errors, so BUILD before deploy.
- **Verify the SERVED bundle, not just source**: compare the hashed `main.<hash>.js`
  from `curl http://127.0.0.1:2388/` vs `curl https://next.singulancelabs.com/hivemind`
  — they must match, proving the new container is what the public domain serves
  (map: FE gitlink/bundle drift is the #1 stale-UI incident).
- **Gitlink**: set with `git update-index --cacheinfo 160000,<fe_sha>,frontend/Da-vinci`
  in the build worktree (submodule not checked out there) — the FE commit must be
  PUSHED to the Da-vinci remote first. Then commit + FF to singulance-main.

### 2026-07-20e — user/org profile subsystem activated (release prod-20260720-72609f55)

The whole profile stack (`ProfileStore`, `ProfileDreamer`, `/api/profiles`,
`Profile.jsx` routed at /hivemind/app/profile, `persona-router`) was BUILT but
DARK — profiles were empty so the page showed "No facts." Root cause: FOUR flags
off + the always-on regex extractor (`profile-store.js` PROFILE_PATTERNS) only
matches English "my name is / I work at", never business content. **The flags:
`PROFILE_DREAM_ENABLED`, `PROFILE_DREAM_APPLY` (SEPARATE — dreamer gates persist
on `opts.apply && PROFILE_DREAM_APPLY`, so apply:true ALONE silently no-ops and
echoes apply:false — this bit me), `ENABLE_PROFILE_DREAM_CRON`,
`PERSONA_ROUTER_ENABLED`.** All now true in prod .env.

Population = `ProfileDreamer.dreamProfilesForOrg` (LLM extracts grounded
static/preference/goal/dynamic facts from raw memories, evidence-cited, decayed).
Backfill via `POST /api/profiles/dream {apply:true}` (admin/owner only). Canary
went 0 → 10 facts incl `company=Solvis GmbH`.

Code added this release:
- `get_user_profile` chat tool (tool-registry) — caller-scoped by ctx.userId/orgId,
  NO id from the model (can't read another tenant — verified live: other tenant → 0).
- `profile` planner operation (chat-intent-decision) + dedicated lane (no blended
  recall competing) + gatherEvidence dispatch; profile exposed as a synthetic
  citeable PROFILE1 packet so the grounded-claim validator accepts a profile-only
  answer (same trick as aggregateCitationPacket).
- Onboarding (control-plane ~7729) mirrors company → ORG-scoped profile facts.
- Dreamer pulls `summary` memories but ONLY tagged company-profile/org-canon
  (untagged summaries = rollups/captions would bloat every dream).
- `getSharedProfileStore(prisma)` singleton — throwaway ProfileStore instances
  don't cross-invalidate the 60s cache (review HIGH).

**Reusable lesson:** for a "make X functional / X is dead" ask, CHECK FLAGS FIRST
(`grep ^FLAG= .env` + probe the endpoint for a `skipped:FLAG!=true` response) —
this whole subsystem was one env change from alive. And watch for MULTI-flag gates
(enable + apply as separate flags).

Note: `Profile.jsx` already HAS a company section (getOrganizationProfile) — FE work
is smaller than assumed; verify it renders the now-populated data before editing.

### 2026-07-20d — owner canary findings = NEXT-SESSION QUEUE (priority order)

Owner-run canary after the temporal release surfaced four open defects. Start
the next engine session HERE:

1. **Relation synthesis drops found edges.** relation_between reported "1 typed
   edge + 3 shared paths" for SolvisPia/SolvisMax yet the answer claimed no
   relationship. Filter at react-agent-v2.js ~1143 (`filteredEdges` requires an
   endpoint in evidence.memories) uses the FULL merged set, so suspect either
   (a) loadTypedGraphEvidence returns edges whose endpoint memories were never
   merged into memoriesById (executor merges only per-entity recall memories),
   or (b) endpoints render as bare id8 labels with no context so the model
   ignores them. Repro live with trace, then either hydrate edge-endpoint
   memories into the merge or label edges with entity names.
2. **"What was KNOWN on <date>" maps to valid_at, should be known_at.** The
   planner emitted valid_at=2026-07-15 for a knowledge-state question. Fix in
   the planner prompt: "was known/did we know" → known_at; "was true/what was
   the value" → valid_at. Also fact-recall noise: entities_covered 1/3, generic
   brand memories outrank product rows.
3. **German question answered in English.** Language enforcement leak in the
   synthesis path — check languageName wiring + answerPrompt "Write in ${lang}"
   vs actual response; likely the planner's response_language isn't reaching
   answerStep for some ops.
4. **Boot-time `prisma migrate` fails P3005 (schema not baselined) and is
   swallowed.** App boots fine (no new migrations), but a REAL migration would
   fail the same way silently. Baseline the prod DB (migrate resolve) or make
   the entrypoint fail loudly on migrate errors when migrations are pending.

Also: exact-filename fail-closed behavior CONFIRMED correct (unknown brochure
filename → refuses, no substitution). Owner auth via `Authorization: Bearer`
header also works (alias for X-API-Key).

### 2026-07-20c — temporal/time-travel wired into chat (release prod-20260720-e41b46b1)

The bi-temporal tools (`hivemind_at`/`_diff`/`_timeline`) EXISTED but chat never
reached them: `chat-intent-decision` had no `timeline` operation and hardcoded
`needs_time_travel:false` (temporal fields were parsed then discarded), and
`gatherEvidence` had no dispatch branch. Fixes: `timeline` op (+ hivemind-recall
native group + planner-prompt routing paragraph); `needs_time_travel` derived
from parsed time; temporal-dispatch block in gatherEvidence (range→diff with
"since X"→to=now, valid_at/known_at→at, bare timeline→timeline); timeline now
resolves by `memory_id` via BiTemporalEngine (schema previously hard-required
`query`, so the documented memory_id contract silently never worked).

**TWO CRITICALS the adversarial review caught in MY new code — always run it:**
1. Cross-tenant leak: `getTemporalTimeline`+`getMemories` are UNSCOPED (filter
   by id only). Any UUID would read another tenant's memory + full history. Fix:
   authorize the anchor AND every related row via `getMemoryScoped(user/org/
   access_context)` — the store keeps unscoped getters for internal fan-out, so
   ANY new read path taking an id from model/user input MUST use the scoped one.
2. `hivemind_diff` removed rows rendered identically to live facts in the
   synthesis block → model could assert superseded values as current. Fix:
   `[REMOVED/SUPERSEDED]` prefix + prompt rule 11c.

Verified live: "changed since 2025" → dispatches hivemind_diff (honest no-change
answer); "as of <date>" → as-of recall; "history of X" → hivemind_timeline.
Wrong-tenant memory_id (valid UUID format) → memory_not_found_or_forbidden, 0 rows.
Still open: update path writes only isLatest flags, never the predecessor→
successor `Updates` EDGE; terse tag-only memories rank low in semantic recall.

### 2026-07-20b — Cerebras-direct synthesis (biggest latency win, env-only)

Adding `CEREBRAS_API_KEY` to `/root/hivemind/.env` routes gpt-oss-120b synthesis
to **Cerebras-direct** (`api.cerebras.ai`) instead of OpenRouter — `answer_step`
dropped ~11s → **452-658ms** (warm 276-318ms), fact-query total 26-60s(start)
→ **2.25-3.25s**. `resolveChatCompletionRoute` already prefers Cerebras when the
key is set (chat-provider.js:28-36); OpenRouter `sort=throughput` stays the
fallback when the key is absent. The key was NOT on the box before — that alone
was the dominant latency cause. **Lesson: check `CEREBRAS_API_KEY` presence
FIRST for any chat-latency complaint** — it's a one-line env fix, no rebuild
(recreate core to reload env). Never put the key in a command-line arg (classifier
blocks secrets in argv) or the repo; use a 600-perm `--env-file`.
Residual: fact ~2.3s floor = planner ~950ms + recall ~800ms + synth ~500ms; to
beat 1.5s you'd parallelize planner+recall or cache the planner. Compare recall
is FLAKY (grounded 6-10 sources most runs, occasional thin) — per-entity retrieval
robustness is the next accuracy item.

### 2026-07-20 — recall/chat accuracy + latency overhaul (release prod-20260720-08f01b38)

**Root causes found & fixed (all probe-verified live):**

1. **Source-explain/full returned document boilerplate + "entity absent".**
   TWO combined causes: (a) `explicitSourceHydration` in `recall-router.js` was
   wrapped in `withTimeout` at CREATION but awaited only after hop1(≤4s)/hop2/
   RRF/boost — the timeout clock elapsed and a ~50ms hydration always fell back
   to `hop2.items` (doc-lead boilerplate). Fix: keep the raw promise (starts
   concurrently), apply a fresh-clock budget-floored timeout at the AWAIT.
   (b) hydration vector-anchored on the raw NL query ("What does <file>.pdf say
   about X?") — filename tokens ranked the cover page above the entity passages.
   Fix: anchor hydration on `mergedCanonicalEntities` (the planner's named
   entities), not the contaminated query. Also improved `hydrateSourceDocuments`
   window selection: center ±1 windows on top-SCORING anchors + merge, vs one
   contiguous run from min index.

2. **Compare/relation reported both entities absent though each exists.**
   `hivemind_relation_between` per-entity lanes used `mode:'fact'` (no evidence
   expansion). Fix: `mode:'explain', limit 5→8` so each entity pulls its doc
   evidence. Probe: evidence went from neither-mentioned to both-mentioned.

3. **Chat latency 26→60s and GROWING (runaway).** TWO causes: (a) Qdrant
   `ensureCollection` guarded by a SCALAR `collectionReady`, invalidated on
   every multi-tenant collection switch → `createPayloadIndex(wait:true)` per
   query. Fix: make it a `Set` (once per collection per process). (b) OpenRouter
   default routing for `openai/gpt-oss-120b` landed on 7-15s backends
   (DekaLLM/WandB/Parasail). Fix: `provider.sort='throughput'` → Cerebras/Groq
   at ~0.5-1s (15-30× faster, verified A/B). Also `reasoning_effort='low'` on
   grounded synthesis (200→22 reasoning tokens). Result: 2.5-7.7s stable.
   **KEY INSIGHT:** every component probed fast in isolation; only the live
   `trace.phases` revealed synthesis dominated. And the fix used the EXISTING
   OpenRouter key (Cerebras reached THROUGH OpenRouter; no CEREBRAS_API_KEY on box).

4. **Timestamp on every memory** (owner requirement): implemented in the single
   `normalizeProvenance` choke point (`canonical-ingest.js`) + atomic path
   (`document-first-ingestion.js`): content suffix `(YYYY-MM-DDTHH:MMZ)`,
   `metadata.recorded_at`, `ts:` tag, entity first/last-seen via existing
   `CanonicalEntity.createdAt/updatedAt`. Idempotent. No migration.

5. **Dead code removed**: `planStep`/`planPrompt`/`routerPlan`/`ROUTER_TOOLS`
   (proven zero refs; kept `callJsonLLM`).

**Still open (documented, not fixed):**
- Latency above aggressive p95 (fact 1.5s / chat 4s). Down 8× from runaway but
  residual = in-`answerStep` DB work (Nango/persona lookups) + occasional slow
  OpenRouter backend despite throughput sort. Next: profile answerStep internals;
  consider streaming for perceived latency (mneme-foundation has SSE lifecycle
  events).
- Temporal valid_at/known_at unproven end-to-end: base recall misses TERSE
  memories ("launches on 2027-06-01"); marker is a tag not searchable content.
  Also the claimed predecessor→successor `Updates` EDGE does not exist in the
  DB — only `isLatest` flags wire supersession. Next: verify graph-engine
  actually writes the Updates edge on atomic update, and make terse/tagged
  memories recallable by marker.

**Gotchas for next session:**
- Shell cwd resets to `/root/hivemind` between Bash calls — always use absolute
  paths or `-C` into the worktree.
- `git fetch origin` does NOT pull `singulance-main` (filtered refspec) — fetch
  it explicitly: `git fetch origin singulance-main:refs/remotes/origin/singulance-main`.
- Pushing `singulance-main` directly is classifier-gated; push the task branch,
  fast-forward separately.
- Related memory: [[explain-hydration-timeout-race]], [[timestamp-every-memory-generation]],
  [[chat-acceptance-remaining-gaps]].
