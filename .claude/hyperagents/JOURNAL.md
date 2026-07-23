# HyperAgents — Ship Journal

Append-only. **Newest first.** One entry per shipped feature/fix. Written by the
`hyperagents-builder` skill immediately after a ship (commit pushed + verified).

Entry format:
```
---

---

---

---

## 2026-07-23 — Lead/call tool-discipline (prompt-driven, not hardcoded) + tool-selection sandbox
- **commits:** through `fe8b2f92f` (employees), singulance-main. Image LIVE.
- **what:** replaced leave-it-to-chance triggering with explicit prompt guidance + a sandbox to
  tune it. Agent persona (agentscope_factory) + director planner (engine.py) now say: SEE/REUSE
  the shared lead book (list_prospects) before acting on/finding leads; discover NEW only when the
  book lacks them or the user asks (discovery is room/Places, agents never invent firms);
  save_prospect with a note when qualifying; propose_call when a live call beats an email (phone
  given → propose_call directly, else list_prospects first).
- **sandbox:** scripts/quality/tool_sandbox.py — feeds varied queries through one LLM tool-calling
  round with the REAL tool schemas + guidance, prints which tools fire, NO side effects. Used it to
  catch + fix two over/under-triggers (existing-lead action answered blind; phone-given routed to
  list). Final verified triggers (deployed fe8b2f92f): our-leads→list_prospects; reach-out/email
  existing→list_prospects; call X at +49→propose_call; add lead→save_prospect; pricing/decision→
  recall; give-lead-a-call (no phone)→list_prospects (then propose_call).
- hm-core/hm-control untouched; --no-deps.

## 2026-07-23 — Shared LEAD BOOK (list_prospects/save_prospect + notes) + popup diagnosis
- **commits:** `58b02e2f6` (employees), singulance-main. Image LIVE.
- **lead book:** every room shares one org-scoped, persistent prospect store (memories tagged
  'prospect') so agents REUSE leads instead of re-discovering. Tools (always-registered):
  list_prospects(query) — see existing leads + note + when; save_prospect(company, note, phone,
  email, website) — add a lead with a PERSONAL NOTE (createdAt = when). _places_search
  auto-persists ≤15 contactable discoveries with a note; claim-key dedups re-discovery.
  save_prospect_emulated async client helper (master emulation).
- **verified E2E (live):** save_prospect → memory created; list_prospects('Solvis Test') → count:1
  with the note + phone/website + timestamp. Test lead cleaned up. recall healthy; --no-deps.
- **popup diagnosis:** delivery is SOUND — propose emits call_contract → turn-event handler appends
  it → SSE flush pushes EVERY event type unfiltered → FE onAny dispatches hm:call-contract →
  <CallContractModal>. "No popup" = no agent invoked propose_call in that room (fires only when an
  agent decides a call is warranted — the intended 'only when needed'). To see it: run a room with
  a task where calling a named prospect (name + phone) is the obvious next step.

## 2026-07-23 — propose_call: the OS decides to call in-room → contract popup fires
- **commits:** `020e5875d` (employees + control), singulance-main. Images LIVE at that tag.
- **what:** the last link — an agent/director calls `propose_call(company, phone, why)` when a live
  call is the right move → sidecar POSTs control `propose` with the EXPLICIT prospect + the turn's
  callback_url → contract generates (goal/strategy + auto language + concrete Cartesia voice) →
  live `call_contract` event → `<CallContractModal>` popup → Approve → TARA dials. Never dials on
  its own (queued campaign; first-contact HITL).
- **files:** agentscope_tools.py (propose_call tool, always-registered, safe; provenance carries
  callback_url), api_hyper_rooms.py (arm callback_url), campaigns.js propose (accepts explicit
  prospect/prospects).
- **verified E2E (live):** propose with an explicit German prospect → HTTP 200, campaign=queued,
  contract {language:de, voice_style:'warm professional', voice_id:38aabb6a… (real Cartesia),
  German goal+strategy}. Test campaign cleaned up. hm-core recall healthy; --no-deps.
- **NOT exercised:** the actual dial (queued → needs human Start → TARA) — HITL-gated, never auto-placed.

## 2026-07-23 — TARA call-contract: auto voice/language/strategy + first-contact-HITL popup
- **commits:** `ad8de6663` (BE: employees+control) · Da-vinci `7165961` + gitlink `f069846dd` (FE).
- **images LIVE:** employees/control `prod-20260723-ad8de6663`, fe `latest` (both containers).
- **what:** when HyperAgents proposes an outbound call, the contract now AUTO-CONFIGURES the voice
  call + gates it behind a visible popup:
  - `api_outreach.generate` (call) emits `language` (inferred from prospect), `strategy`
    (conversation plan), `voice_style` (tone) alongside goal/opener/context.
  - `campaigns.js`: persists them; `resolveVoiceId` picks a concrete Cartesia voice from TARA's
    live `/voices` catalog by language+tone; `executeCall` passes language+voice_id + folds
    strategy into TARA's directive. `propose` generates the first contract up front + returns it +
    pushes a live `call_contract` event to the room callback_url.
  - FE `<CallContractModal>` (AppShell, global `hm:call-contract` from the SSE handler): shows
    goal/strategy/language/voice + Approve&call / Not now. Approve → startOutreachCampaign (dial);
    reject → stopOutreachCampaign. Nothing dials without it (first-contact HITL made visible).
- **verified:** sidecar generate live returns {language:de, voice_style:'warm professional',
  German strategy} for a German firm; propose endpoint auth/flag/validation green; FE compiles +
  `hm:call-contract` in the shipped bundle; both FE containers 200; hm-core untouched (--no-deps).
- **NOT exercised:** a real dial to a real phone — correctly HITL-gated; never auto-placed a call.
- **scorecard:** reused the modal/global-event + approval + propose patterns (no rebuild); TARA
  DialRequest already accepted voice_id/language (pure connection); verified the enrichment live
  via a safe LLM-only call (no side effect). --no-deps everywhere.

## YYYY-MM-DD — <title>
- **commits:** <parent sha(s)> (+ Da-vinci <sha> if FE)
- **what:** one line
- **why:** the failure/gap it fixes
- **files:** ...
- **verified:** how (e2e command + observed result)
- **gotchas:** anything the next session must know
- **scorecard:** recon-held? feature-recon caught prior art? verify first-try or N reworks? wasted rounds? → harness change proposed (or "none")
```

---

## 2026-07-23 — Gates closed + user-facing FE: plan-limit popup · P0 enforce+columns · P6 autonomy · 5xx toast
- **commits:** `b457c4f2a` (402 fix) · Da-vinci `ab4eaf4` + gitlink `07df69ab3` (5xx toast) ·
  `3e878fb5b` (P0 columns) · `dcf70b4bc` (P6 autonomy). All singulance-main.
- **images LIVE:** control-plane `prod-20260723-dcf70b4bc` (402 fix + P1 + P6) · core
  `prod-20260723-3e878fb5b` (P0 columns) · employees `c3fe566bb` (P0 enforce) ·
  `hivemind/fe:latest` on BOTH hm-fe + hivemind-next-frontend-1 (5xx toast). All --no-deps.
- **Usage-limit popup (the user's bug):** room/project-limit 402s emitted internal code
  'PLAN_LIMIT' but the FE modal needs 'plan_limit_exceeded' → silent console 402. Fixed
  capacityErrorResponse + both project-limit paths to the FE contract (resource→modal key,
  suggested_plan, upgrade_url). Verified live: 402 body matches isPlanLimitError → modal fires.
  Backend-only (existing FE modal/interceptor already deployed).
- **FE 5xx/network toast:** mycompany openTask was a silent `catch {}`. Added shared/serviceError.js
  + interceptor emit + ServiceErrorToast (AppShell), mirroring the plan-limit pattern. Built
  hivemind/fe:latest, recreated BOTH FE containers (NOT via deploy-fe.sh — it SSHes to a remote +
  `git reset --hard` which would nuke local work + only touches hm-fe). Verified: HTTP 200 + toast
  code in the shipped bundle. Da-vinci committed+pushed (ab4eaf4), parent gitlink bumped.
- **P0 enforce:** shadow logs empty (no would-rejects) → flipped HYPER_PROVENANCE_GATE=enforce
  (employees force-recreate). Junk saves now rejected.
- **P0 first-class columns:** applied produced_by_turn/agent/actionable/provenance to
  hivemind.memories (nullable/no-default = metadata-only, CONCURRENTLY index) + schema.prisma +
  migration 20260723090000 + client regen + core deployed. prisma-graph-store populates them
  (uuid-guarded, hyperagents-only, additive). CAVEAT: the canonical V5 ingest normalizer replaces
  source_metadata, so columns don't auto-populate via that path yet (threading provenance through
  the normalizer = documented follow-up, NOT rushed into the hot path). Recall verified healthy.
- **P6 autonomy:** enabled the ONLY safe autonomy — HYPER_OUTREACH_AUTONOMY=on lets the drain
  worker autonomously advance/execute HUMAN-authorized campaigns; assertAutonomousSendAllowed
  enforces the hard first-contact-HITL invariant (only 'running' human-created campaigns). Cold
  origination (OS contacts a new audience with no human) deliberately NOT built — outbound-safety
  line (consent/deliverability/legal). Verified via node.
- **verified:** full cluster healthy; gates live (P0=enforce, P6=on, governor caps present);
  hm-core recall OK; both FE containers 200. deploy-fe.sh + CLAUDE.md paths verified before trust
  (per owner instruction — not blindly followed; the SSH/reset script was rejected).
- **scorecard:** verified the deploy pipeline before running (deploy-fe.sh would have destroyed
  local FE work + missed the mycompany container); every plan-limit/5xx fix reused the existing
  modal/interceptor pattern (no rebuild); RISK items shipped safe (enforce reversible, columns
  additive+guarded, autonomy HITL-hard-invariant); --no-deps everywhere (no core-recreate incident).
- **commits:** `8167ce651` (P1) · `0b9cd8105` (P0) · `4770a8c87` (P2) · `c3fe566bb` (P6), all singulance-main.
- **images LIVE:** `hivemind/employees:prod-20260723-c3fe566bb` (P0+P2+P1-pydantic) ·
  `hivemind/control-plane:prod-20260723-c3fe566bb` (P1-js+P6-js). **hm-core NOT redeployed**
  (server.js uses none of these modules) → chat/recall untouched, verified healthy after.
- **P1 — version-tolerant seam contracts.** `core/src/contracts/hyper-seams.js` (single
  source of truth: buildRoomTurnPayload + normalizeTurnEvent, drop-undefined / default-missing /
  ignore-unknown / stamp schema_version) + dispatchHyperRoomTurn stamps it; pydantic
  RoomTurn/Chat/CreateTeamTask/ApprovalDecision get explicit `extra='ignore'` + optional
  schema_version. 5 JS asserts + pydantic tolerance green; **live smoke: endpoint accepted
  schema_version + an unknown field with HTTP 200 (no 422)**.
- **P0 — provenance + actionable-gate (shadow).** _TURN_PROVENANCE contextvar armed at
  room-turn start; save_memory stamps source_platform='hyperagents' + source_metadata
  {turn/room/produced_by/actionable} (NO schema migration — uses existing columns). Gate
  `HYPER_PROVENANCE_GATE` off|log|**enforce**, DEFAULT 'log' (shadow — logs would-rejects,
  never blocks). Verified: enforce+junk → not posted; good fact → posted w/ full provenance.
  Optional first-class columns authored as a GATED artifact (decision-docs/p0-provenance-optional-migration.md).
- **P2 — Governor.** governor.py: kill switch (HYPER_KILL_SWITCH, refuses turn instantly +
  seals 'disabled') + per-turn token cap (HYPER_TURN_TOKEN_CAP → cost_capped) + outbound cap
  (HYPER_OUTBOUND_CAP). All DEFAULT off/0 = behavior-neutral. Kill-switch functional path green
  (orchestrate NOT called). Complements the existing per-org pause-all.
- **P6 — Outreach Contract.** outreach-contract.js + guard at campaigns.js executeTarget (the
  send choke point for FE + drain worker): kill switch (global/outreach-specific) + per-org
  daily cap, skip-not-throw, DEFAULT-neutral, stacks on the existing hard cross-campaign dedup.
  Autonomous ORIGINATION intentionally NOT built — human-gated (decision-docs/p6-outreach-autonomy-gate.md).
- **verified:** each phase unit/integration-tested in-container BEFORE deploy; both images
  deployed with `--no-deps` (the P4-incident lesson — core never recreated); post-deploy: both
  new containers healthy, no boot errors, P1 tolerance live, hm-core recall OK.
- **OPEN human gates (owner decision):** (1) flip P0 `HYPER_PROVENANCE_GATE=enforce` after
  reviewing shadow logs; (2) optionally apply the P0 first-class-column migration; (3) authorize
  P6 autonomous origination (needs P0 live + per-org opt-in + first-contact HITL + caps + consent).
- **scorecard:** recon held (cartographer map verified against grep/Read; only 1 caller of the
  toolkit builder + an existing contextvar mechanism made P0 cheap); feature-recon caught prior art
  everywhere (existing pydantic models, per-org pause-all, outreach dedup/pacing) → extended not
  rebuilt; RISK phases (P0/P6) shipped SAFE (shadow / default-neutral / gated) not rushed; deploy
  used --no-deps so no repeat of the P4 core-recreate incident. → harness unchanged (rules held).

## 2026-07-23 — P4: Cerebras-direct synth path + HYPER_SYNTH_MODEL seam (synth kept = gpt-oss-120b)
- **commits:** `c0150cf17` (singulance-main, pushed) · image `hivemind/employees:prod-20260723-c0150cf17` (LIVE)
- **what:** made the final-report synth writer model-selectable via `HYPER_SYNTH_MODEL`, and added
  a **Cerebras-direct** call path so a Cerebras-hosted id routes to `api.cerebras.ai` with
  `CEREBRAS_API_KEY`, bypassing OpenRouter (owner policy: "GLM from Cerebras, not OpenRouter";
  keeps synth off the OR bill + hits Cerebras automatic prompt-caching). New `_cerebras_chat`
  (+ `_route_cerebras_direct`, `_CEREBRAS_DIRECT_MODELS={zai-glm-4.7}`), wired into `_groq` BEFORE
  the OpenRouter-direct branch; usage accounting + `cached_tokens` metered; optional
  `prompt_cache_key` (stable `hyper:{org}:{proj}:{bucket}`) gated by `HYPER_CEREBRAS_PROMPT_CACHE_KEY`
  (account-enabled → else 400). Also guarded an unguarded `j['choices']` return that crashed
  `_plan_gather` with KeyError when OpenRouter returned a 200 w/o choices; and added a `__main__`
  guard to `quality_eval.py` so it's importable (enables a synth-A/B harness).
- **why:** owner asked to route final synthesis to a frontier writer. Explored deepseek-v4-pro
  (rejected: OpenRouter mesh non-deterministic — Fireworks 19s but Together/DigitalOcean 145-192s
  fallbacks under burst) then owner chose Cerebras `zai-glm-4.7` (measured 4-7s / 2.8-3.4k-char
  report, single wafer-scale provider, deterministic, prompt-cache 1664 cached tok observed).
- **DECISION — synth kept = gpt-oss-120b:** controlled A/B (grounding held constant via injected
  `company_brief`, only synth swapped, n=2): **gpt-oss-120b 0.85 vs zai-glm-4.7 0.758** (GLM ties/wins
  strategy+gtm, trails brand+regulatory). GLM passes the 0.7 floor but is a small measured dip vs
  current prod; owner chose to KEEP 120b. So `.env HYPER_SYNTH_MODEL=openai/gpt-oss-120b` (no live
  behavior change) — the GLM Cerebras-direct path stays baked + tested, one env flip from live.
- **files:** `employees-service/src/hivemind_employees/hyper/engine.py`,
  `.../api_hyper_rooms.py` (auto-mode synth inherits HYPER_SYNTH_MODEL),
  `employees-service/scripts/quality/quality_eval.py`.
- **verified:** GLM routing proof (live): `Cerebras-direct served model=zai-glm-4.7 ms=7362
  out_tok=3427 cached=1664`, final 5187 chars. New image room turn (synth=120b): `openai/gpt-oss-120b
  provider=Together ms=13301`, final 3826 chars — no regression. hm-core recall functional post-deploy.
- **⚠️ DEPLOY INCIDENT + RECOVERY (critical lesson):** `VERSION=<tag> docker compose … up -d employees`
  WITHOUT `--no-deps` **also recreated hm-core** (core is employees' `depends_on`), rebuilding core
  from compose context `..` = the **DIRTY `/root/hivemind` feat tree**, tagging it with MY employees
  sha → hm-core silently ran unintended core code (src md5 `da750e…` vs intended `62d884…`). Caught
  it in post-deploy verify; restored with `VERSION=prod-20260723-caa3fb10d docker compose … up -d
  --no-deps core` (recall warm-up ✅, digest matches). **RULE: deploy employees ALWAYS with
  `--no-deps` and pass VERSION = the employees tag; core stays on `.env` VERSION.** hm-control/
  byod/tara were untouched (not deps).
- **gotchas:** `.env VERSION=caa3fb10d` tracks CORE; employees runs `c0150cf17` via override — a
  blanket `docker compose up` (no per-service override + `--no-deps`) would try employees@caa3fb10d
  (nonexistent) and rebuild core from the dirty tree. `zai-glm-4.7` is a BARE id (no slash) → needs
  `_route_cerebras_direct`, NOT `_route_direct_openrouter` (which keys on "/"). rollback marker:
  `.last-employees-p4-rollback` → prod-20260723-014457f1f.
- **scorecard:** recon held (verified every model/provider/latency with live probes before coding);
  feature-recon caught the existing `synth_model` seam (extended, didn't rebuild); verify caught TWO
  real issues before ship (deepseek latency non-determinism → model change; the core-recreate incident
  → recovered) = the adversarial-verify loop paid off. → harness change: added `--no-deps` to the
  deploy rule here + CONTEXT lessons + a memory ([[hyper-employees-deploy-no-deps]]).

## 2026-07-23 — F0: sidecar LLM canonicalized (gpt-oss via Cerebras, no groq/llama) + git-workflow fix
- **commits:** `d4331670c` (singulance-main) · image `hivemind/employees:prod-20260723-deafcccc9` (LIVE)
- **what:** closed the Brain/OS LLM gap — the Python employees-service still used llama
  defaults + a Groq-first provider pin while JS core was canonical. Now: sim/digest/journal
  defaults llama-3.1-8b-instant → openai/gpt-oss-20b; sim fallbacks drop llama-3.3; provider
  pins drop Groq (120b→[Cerebras,Together], 20b→[Together,Cerebras]); OpenRouter body sets
  `reasoning.effort=low` so gpt-oss emits clean content for the extractive digest/journal
  tasks (the reason they were on llama).
- **why:** owner rule "Cerebras or OpenRouter only, no Groq/llama" for text; the OS was
  running strategy/debate on the banned providers.
- **files:** `employees-service/src/hivemind_employees/hyper/engine.py`.
- **verified:** baked image live — `engine._openrouter_chat('openai/gpt-oss-120b')` →
  `provider=Cerebras, content='pong'`; hm-employees healthy; singulance-main features
  (method-skills, maps-discovery) intact (I first mis-copied feat's older engine.py — caught
  the divergence, re-applied edits to the singulance-main version).
- **residual (flagged, NOT changed):** `HYPER_WEB_MODEL=groq/compound-mini` = agentic
  web-search, no gpt-oss twin (same class as whisper/vision passthrough JS-side) — owner call.
  `_OR_MODEL_MAP` llama entries are a dead safety map (no llama usage by default).
- **git-workflow fix (root of recurring pain):** `/root/hivemind` is on `feat/mneme-foundation`
  (dirty, diverged); PROD is `singulance-main`; the clone's fetch refspec was FEAT-ONLY
  (`+refs/heads/feat/…`) → `origin/singulance-main` never updated → stale-ref push rejections +
  editing the wrong branch's files. FIXED: refspec → `+refs/heads/*:refs/remotes/origin/*`, and
  created a permanent clean worktree **`/root/hivemind-main`** on a real `singulance-main` branch
  tracking origin. Edit/commit/build/push there; `/root/hivemind` stays for `.env`+compose only.
- **gotchas:** sidecar engine.py DIVERGED between feat and singulance-main — always work from
  `/root/hivemind-main` now. Deploy employees via shell `VERSION=<tag> docker compose --env-file
  /root/hivemind/.env … up -d employees` (don't mutate the shared .env VERSION core uses).
- **scorecard:** recon held (verified every model/route with grep + a live Cerebras smoke, no agent);
  feature-recon caught the divergence + the existing synth_model seam; verify passed after 1 rework
  (the feat-vs-singulance engine.py mis-copy — now permanently prevented by the worktree). → harness
  change: added "Canonical dev tree" to CONTEXT/deploy-topology so no session repeats the branch trap.

## 2026-07-23 — CONTEXT/TODO rewritten to live ground truth; Singulance-OS program set
- **what:** the `.claude/hyperagents/` docs were a month stale and described a DIFFERENT box
  (ssh 116.202.24.69 / /Users/amar / branch `main`). Rewrote CONTEXT.md + TODO.md from
  verified current state on THIS box; opened the "AI Company OS" program in TODO.
- **verified ground truth (grep/Read + `docker exec hm-employees env`, this session):**
  - Deploy = local docker: compose service `employees` → `hivemind/employees:${VERSION}` →
    container `hm-employees:8060`. Running `prod-20260722-rmyd4f127595`. Ship = build image +
    `docker compose --env-file /root/hivemind/.env … up -d employees` (the `--env-file` is mandatory).
  - PROD branch is **`singulance-main`** (not `main`; the working `/root/hivemind` checkout is a
    dirty diverged `feat/mneme-foundation`). Deploys build from a singulance-main worktree.
  - 3 sidecar surfaces: rooms (`api_hyper_rooms.py` `/room-turn`), round-table (`api_team_tasks.py`
    → `hyper/engine.py` `room.run()`/`run_director`, `/{task_id}`), employee chat (`/{slug}/chat`).
  - FE `/employees/mycompany` = `HyperAgents.jsx` hero = CompanyDashboard; components:
    CompanyDashboard/HyperOnboarding/OnboardingTerminal/CampaignPanel/LeadsView/AgentAvatar.
  - engine.py has the P4 seam live: `synth_model = synth_model or self.director_model` (~970),
    `_debate` (~1441). `HYPER_SYNTH_MODEL` unused.
  - **LLM inconsistency confirmed:** JS core is canonicalized (Cerebras→OpenRouter/gpt-oss-120b,
    no groq/llama) but the Python sidecar is NOT — `GROQ_URL` + `_GROQ_DEAD` primary path, and
    llama/groq defaults (`HYPER_WEB_MODEL=groq/compound-mini`; code `_SIM/_DIGEST/_JOURNAL=llama-3.1-8b-instant`;
    env `MIND_READER/COGNITION_WRITER/GROQ_INFERENCE/HIVEMIND_LLM_MODEL`=llama). `HYPER_AUTO_*`=gpt-oss-120b already.
  - Active test org on this box = MANDI `807ebb88…` / user `c8876290…`.
- **next (owner priority):** F0 employees-service LLM canonicalization → P3 eval baseline → then the plan.
- **gotchas:** don't trust the old box/paths; the parked 2026-06-19 "Agentic orchestrator" feature
  (flag OFF) is NOT this program — left as-is.
- **scorecard:** recon held (verified every claim with grep/env, no agent); feature-recon caught the
  parked agentic feature + the existing synth_model seam (extend, don't rebuild); doc-only, no deploy. → harness change: none.

## 2026-06-19 — FULL VISION COMPLETE: real artifacts (Google re-auth) + email recipient
- **commits:** `ec4ae0d2`
- **what:** User re-authorized Google with write scopes. Verified docs_create + gmail_create_draft bridge probes → 200 with real URLs (was 403). Fixed the agentic email path to resolve recipients (`_resolve_recipients` → verified_contacts; the stash hardcoded []).
- **verified e2e (agentic, default-on, 120b):**
  - doc turn → REAL Google Doc produced (docs.google.com/document/d/18zr1h4G3yK…), grounded.
  - email turn → REAL Gmail draft + approval card to amarsai2005@gmail.com.
  - strategy/answer → grounded + full simulation (challenge/silent-when-ungrounded/revise).
- **THE VISION IS LIVE:** GATHER → PLAN → EXECUTE(owners, tool-grounded) → DRAFT → SIMULATE(debate/skeptic/peer-review) → REVISE → PRODUCE(real doc/sheet/email draft) → VERIFY(grounding gate) → PERSIST. Multi-agent simulation + robust recall + real artifacts + zero fabrication, all on AgentScope (ReActAgent/MsgHub/structured JSON plan) + gpt-oss-120b. Flag default-on.
- **note:** grounding gate may escalate an email/doc whose claims aren't fully grounded (honest — draft still surfaced with the UNVERIFIED flag, never fabricated-sealed). Connector-cert + renewal-cron also fixed this session (expired-cert outage on the connect-UI).

## 2026-06-19 — Multi-agent SIMULATION restored in the agentic loop (debate/skeptic/peer-review)
- **commits:** `a183a4d7`
- **what:** SIMULATE phase between EXECUTE and SYNTHESIZE: lead DRAFTs → reactors challenge/support/extend (skeptic lane opposes) via reused `_run_reactor` in a MsgHub → lead REVISES real challenges → converge → synth. Reactors are tool-less (`_mk(..., toolless=True)`) so gpt-oss returns clean react JSON instead of wrapping it in a fake `JSON` tool call (→400). Reuses REACTOR_INSTRUCTIONS + react/peer_review events (FE already renders).
- **why:** The agentic rewrite went linear and dropped the swarm interaction the user values (debate, skepticism, support). This puts it back, grounded.
- **verified (CNJE strategy, 120b):** maya-ortiz CHALLENGED the conversion-rate assumption (evidence: SOM Capture memory); lina-park stayed SILENT rather than fabricate ("can't fabricate, react false"); lead REVISED flagging UNVERIFIED. reactor failed: 0, complete, grounded=True. Grounded skepticism — no invented dissent.
- **agentic loop now:** GATHER → PLAN → EXECUTE(owners) → DRAFT → SIMULATE(debate) → REVISE → SYNTHESIZE → PRODUCE → VERIFY → PERSIST. Flag default-on.
- **next:** the only remaining gap is doc/email ARTIFACTS (Google OAuth read-only 403 → user re-auth with Docs/gmail.compose). Everything else (answer/decision/strategy + full simulation + grounding) works end-to-end.

## 2026-06-19 — Agentic orchestrator DEFAULT-ON: guaranteed gather + intent guard
- **commits:** `08c56fc4` (flag now DEFAULT-ON; `HYPER_AGENTIC_ORCHESTRATOR=off` disables)
- **what:** (1) Guaranteed recall GATHER up front, injected into lead/owners/synth context → fixes CEO-not-found recall variance. (2) Conservative intent guard: planning/strategy → answer (don't over-classify to doc/email needing OAuth). (3) Flipped flag default-on — the agentic swarm loop is now the live room behavior.
- **verified:** 'who is CEO of solvis' → met=True grounded=True BOTH runs ("Gabriele Münzer, evidence support"). Answer/decision/planning work end-to-end, grounded, no fabrication. Health 200.
- **live behavior:** gather → decompose (lead JSON plan) → per-owner tool-grounded execution (recall, MsgHub) → synthesize → produce → verify → persist (goalkeeper).
- **known constraints (honest):** agentic is slower/costlier than the deterministic path (multi-agent, gpt-oss-120b); doc/email ARTIFACTS still 403 until the org re-authorizes Google with Docs/gmail.compose scopes (surfaced as "re-authorize", not fabricated); FE renders plan/execute/verify via existing handlers (no bespoke subtask widget yet). To revert instantly: set `HYPER_AGENTIC_ORCHESTRATOR=off`.

## 2026-06-19 — ROOT CAUSE of the produce gap: Google OAuth read-only (not the orchestrator)
- **commits:** `b78e9848`
- **finding:** The doc/email artifact never produced because this org's Google connector is authorized READ-ONLY. Direct bridge call `docs_create` → `Google API 403: "Request had insufficient authentication scopes" PERMISSION_DENIED`. NOT an orchestrator bug — the agentic loop calls docs_create correctly; Google rejects the write.
- **agentic fixes shipped (flag off):** produce-BEFORE-verify (verifier was running before produce → artifact_ok always false); agents recall/reason-only (no connector write tools — gpt-oss owners spammed docs_create with placeholder args → 400s); synth writes the COMPLETE deliverable; `google_exec_emulated` returns the error; `_surface_produce_error` reports a 403 as "re-authorize the connector" + doesn't thrash-retry (scope errors aren't retryable).
- **state:** agentic loop (plan→decompose→execute→ground→produce-call→verify→persist) is BUILT + grounds with no fabrication; answer/decision outputs work (no Google write). doc/email artifacts are blocked ONLY by the missing Google write scope.
- **USER ACTION to fully unblock (I cannot — OAuth grant is the user's):** re-authorize the org's Google connector with **Docs** + **gmail.compose** scopes. Then doc/email artifacts produce end-to-end. Verify after: direct `docs_create` bridge call returns a url (not 403).

## 2026-06-19 — Agentic orchestrator on gpt-oss-120b + JSON plan — flag OFF (produce gap)
- **commits:** `cc52f40d` (flag `HYPER_AGENTIC_ORCHESTRATOR` default OFF; `HYPER_AGENTIC_MODEL` default `openai/gpt-oss-120b`)
- **what:** `_route_groq` respects explicit `openai/gpt-oss-*` (no force-downgrade); agentic agents run 120b. Lead plan via JSON CONTENT + `_first_json_object` (NOT AgentScope `structured_model` — on Groq gpt-oss emits plan as content not a `generate_response` tool call → 400 "did not call a tool"). Lead declares `intended_output`.
- **verified (flag forced on, 120b):** lead classifies `out=doc/answer/email` correctly, decomposes into subtasks, owners execute with tools, grounds to REAL facts (Münzer, Beladeweiche features), `grounded_ok=true`, no fabrication. The plan/decompose/execute/ground chain WORKS on 120b.
- **REMAINING (the produce last-mile — flag stays OFF, next focused block):**
  1. **Connector-exec 400**: owners call `docs_create` but `POST /api/connectors/google/exec` returns 400 (placeholder/malformed args from the owner; the deterministic path works because `_produce_output` gets clean synth content). Need clean payload + content.
  2. **Agent narrates, doesn't call**: owners write "docs_create title=… (placeholder)" instead of invoking the tool with the REAL recalled content; `tools_used empty`. Need the producing-owner to actually invoke its connector tool with real content + capture the artifact URL.
  3. **Persistence**: loop until functionally done (artifact produced), not one pass.
- **gotchas:** AgentScope `structured_model` is INCOMPATIBLE with Groq gpt-oss (forces a tool call the model won't emit → 400). Use JSON-content + parse, or Groq-native `response_format` strict (bypasses AgentScope). gpt-oss-20b can't do nested tool schemas; 120b can but the produce path still needs clean tool-arg payloads.
- **scorecard:** recon ✓✓ (AgentScope API + Groq structured-output docs). Multiple smoke iterations on the box isolated the real blockers (20b ceiling → 120b; structured_model 400 → JSON content; produce → connector-exec 400). Honest checkpoint: prod stays on the verified deterministic path; agentic reaches ground-truth-grounded plan+execute but not artifact-produce. The produce block is the next session's work.

## 2026-06-19 — Agentic orchestrator P1 (structured flat plan + MsgHub) — flag OFF
- **commits:** scaffold `ffee9849`, working `77004cd8` (flag `HYPER_AGENTIC_ORCHESTRATOR`, default OFF)
- **what:** New `_orchestrate_agentic`: lead decomposes the task via STRUCTURED OUTPUT (`_AgenticPlan` = goal/done_criterion/subtasks:list[str], one forced generate_response) → owners each execute their 'Owner — task' with single-arg tools (recall + connectors) in a MsgHub → lead synthesizes → reuse grounding gate + verify + produce + seal. `build_react_agent` gained optional `plan_notebook` (+ activates the gated `plan_related` group). `_agent_reply_resilient` retries the harmony tool-name leak.
- **why:** User wants a non-deterministic autonomous loop (gather→subtasks→execute) for ANY task. AgentScope = the substrate.
- **gotchas:** gpt-oss-20b CANNOT emit the nested PlanNotebook `create_plan` schema (omits required `expected_outcome`, invents params, malforms JSON → 400). FLAT structured output (list[str]) + Python-built plan is the reliable path on gpt-oss. `enable_meta_tool=True` (connectors present) gates plan tools in `plan_related` — must activate. The deterministic path stays live; flag OFF until parity.
- **verified:** smoke (flag forced on, JEE room): first attempt structured plan empty→goalkeeper rework→`subtasks=4 status=COMPLETE met=true grounded_ok=true`, verifier "CEO claim fully supported by the documented source". Grounds to real Münzer, no fabrication.
- **scorecard:** recon ✓ (AgentScope API verified twice). 2 smoke iterations caught the real ceiling (nested-schema 400 → flat structured plan) — the AskUserQuestion fork ("structured flat plan") was right. verify-on-box was essential (would've shipped a broken nested-plan path otherwise). Residual: P2 agent-driven produce, multi-task-shape verify (doc/email), P4 FE subtask rendering — all before default-on.

## 2026-06-19 — Agent-driven personified HIVEMIND recall for contacts (incremental)
- **commits:** `0ed615a3`
- **what:** EXECUTE owners now recall HIVEMIND by name for any person/recipient their slice needs (only report "missing" after recall returns nothing); producer prefers an owner-recalled grounded recipient over the deterministic org/Gmail resolver; one retry on gpt-oss's flaky harmony tool-name leak.
- **why:** User: room never searched HIVEMIND for the Solvis CEO — only org_directory+Gmail. Chose incremental (agent-driven recall) over the full MsgHub/PlanNotebook refactor.
- **files:** `api_hyper_rooms.py` (`_execute_assignments` recall steer + retry, `_produce_output` recipient from execution).
- **verified:** "who is CEO of solvis" → recalls memory, grounds to REAL MD **Gabriele Münzer**, honest that email isn't on file; not fabricated Schröder. grounded_ok=true.
- **gotchas:** gpt-oss-20b intermittently leaks `<|channel|>commentary` into the tool NAME → Groq 400 (server-side, can't intercept pre-validation; retry recovers the flaky case). A non-gpt-oss tool-reliable model would remove it entirely.
- **scorecard:** recon ✓ (AgentScope orchestrator primitives verified: MsgHub/PlanNotebook/structured-output). User redirected me OFF deterministic intent branches → switched to agent-driven recall. verify NOT first-try — surfaced the harmony-leak 400 (added retry). RESIDUAL (deferred by user): "create doc AND email" still escalates + doesn't produce the doc when recipient is missing — that's the **full MsgHub + PlanNotebook agent-driven orchestration** refactor (TODO), where the agent itself drives recall→doc→draft via tools instead of the deterministic producer. → proposed: that refactor is the real next arc.

## 2026-06-19 — Tool-grounded execution + hard grounding gate (stop fabrication)
- **commits:** `30d03725`
- **what:** EXECUTE owners now run real tools (recall + connectors) in a bounded ReAct loop and ground every claim; a GROUNDING GATE verifies BEFORE save/seal so `grounded_ok=false` → not saved, not RESOLVED, UNVERIFIED banner.
- **why:** Solvis transcripts fabricated CEO "Markus Schröder", fake specs w/ invented Confluence citations, fake doc link + email — all sealed RESOLVED. Tool-less owners (max_iters=1) narrated from imagination; grounding was advisory.
- **files:** `api_hyper_rooms.py` (`_execute_assignments` tool-enabled, `_orchestrate` grounding gate + tool_call_counts moved before gate, `_verify_turn` fabrication-tell rules).
- **verified:** JEE room — "who is CEO of solvis" now grounds to REAL MDs Münzer/Kube (not fabricated Schröder), grounded_ok=true; ungroundable spec request stays honest (grounded_ok, no fake specs, not RESOLVED); clean recall, no tool-call 400s. cost 249–760/turn.
- **gotchas:** Registered recall tool name is `recall`, NOT `hivemind_recall` (that's only the `enabled_tool_names` gate key) — NEVER hardcode tool names in a prompt or you get Groq 400 `tool_use_failed`. Grounding gate is in the DEBATE path + the goalkeeper (all templates loop on grounded_ok); swarm/deep_sim save-gate still TODO.
- **scorecard:** recon-held ✓ (ground-truthed the tool-less bug myself; AgentScope research accurate). feature-recon ✓ (extended, didn't rebuild). verify NOT first-try — 2 bugs caught on box (tool_call_counts NameError from moving verify above its def; hardcoded `hivemind_recall`→400), 2 fix rounds. Wasted: a branch-confusion scare (Bash git defaults to the stale suspicious-goldstine worktree; my Edits target the main worktree) — no wrong action, caught pre-commit. → harness changes proposed: 2 new CONTEXT gotchas (below).

## 2026-06-19 — EXECUTE phase (owners do their slices in phases, any room type)
- **commits:** `a1e3c6bd`, pointer `f565d04d` (+ Da-vinci `8a5492f`)
- **what:** New `_execute_assignments` runs after RECON-PRE, before the template dispatch (so it applies to debate/swarm/deep_sim). Each assigned owner agent does their slice in persona with sequential handoff; executed work folds into the shared preamble; FE renders each as a phase.
- **why:** Plan steps/assignments were decorative (only string-injected). Every template synthesized a solo lead plan and sealed in one pass — no per-owner execution, no phased deep interaction, ended too quickly.
- **files:** `api_hyper_rooms.py` (`_execute_assignments`, `_orchestrate` wiring, preamble, `_verify_turn` assignments_ok rule); `HyperAgents.jsx` (SSE allowlist + execute panel + Layers import).
- **verified:** Direct sidecar fire on JEE/CNJE room → `[plan]→[gather]→[recon-pre]→[execute] owners=4→[debate]→[verify]`, `assignments_ok+artifact_ok+grounded_ok=true`, cost 1517. FE build clean.
- **gotchas:** Executors are tool-less single-shot (reliable, no fake-JSON-tool-call 400s). Bounded by `HYPER_ROOM_EXECUTE_MAX_OWNERS=5`.

## 2026-06-19 — Mandatory all-source GATHER + intent guard (no email-death)
- **commits:** `a18e61d5`
- **what:** GATHER fans out across ALL enabled sources in parallel (contacts + topical gmail + drive). Intent guard: planning/strategy Q → decision/answer, email only on explicit send-verb/address. Recipient-gap → grounded answer, never escalate. Verifier: answer/decision text IS the deliverable.
- **why:** "what should be the plan with Ethan" was mis-classified as email → skeptic escalated 4 rounds on a non-existent recipient, producing nothing; GATHER was gmail/recipient-fixated (drive-only sweep).
- **files:** `api_hyper_rooms.py` (`_plan_turn`, `_SEND_INTENT_RE`, `_gather_evidence`, `_recon_pre`, `_output_production_directive`, `_verify_turn`).
- **verified:** JEE room → `intended_output=decision`, parallel gather, status complete, no escalation, artifact_ok+grounded_ok=true.
- **gotchas:** All enabled connectors today are Google-native (gmail/docs/sheets); no room enables an MCP connector yet — MCP search in GATHER is the next increment.

## 2026-06-19 — Recon drives a rework loop until the deliverable is sound
- **commits:** `54d2cd7b` (and `ec59287e` skeptic-evidence-awareness)
- **what:** Goalkeeper no longer breaks the instant a draft exists; loops while `not met AND (not artifact_ok OR not grounded_ok)`, `reset_turn_outputs()` between rounds. Verifier marks an ungrounded pending draft `met=false`. Literal recipient address trusted.
- **why:** A recon-rejected draft sealed RESOLVED instead of being reworked — it gave up instead of working to success.
- **files:** `api_hyper_rooms.py` (goalkeeper loop, `_goalkeeper_should_continue`, `_verify_turn`, `_resolve_recipients`), `agentscope_tools.py` (`reset_turn_outputs`).
- **verified:** Singapore room → 3 rework rounds tightened grounding (met=F grounded=F → F → met=T grounded=T gaps=0) + real Gmail draft + approval.

<!-- next entry goes ABOVE this line -->

## 2026-06-19 — Agentic doc body was plan-JSON → fixed (separate plan/synth agents)
- **commit:** `a3d145fe`
- Doc content came out as the raw plan JSON because ONE lead agent did both the STRICT-JSON plan and the prose synth (JSON-mode memory contamination). Now plan_agent (JSON) is separate from a fresh lead_agent (prose draft/synth/revise).
- Verified: real Google Doc with prose markdown + correct title (Solvis Product Feature Catalogue), not JSON, not the room goal.
