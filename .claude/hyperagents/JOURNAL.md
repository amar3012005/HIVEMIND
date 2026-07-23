# HyperAgents — Ship Journal

Append-only. **Newest first.** One entry per shipped feature/fix. Written by the
`hyperagents-builder` skill immediately after a ship (commit pushed + verified).

Entry format:
```
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

## 2026-07-23 — F0b: web-intel on HIVEMIND tools (no groq); P3 eval harness found (not rebuilt)
- **commits:** `d73ad4401` · image `hivemind/employees:prod-20260723-d73ad4401` (LIVE)
- **F0b what:** the round-table web lane preferred `groq/compound` (HIVEMIND fallback). Flipped:
  HIVEMIND web tools (hivemind_web_search via web_search_emulated → core /api/web/search, Tavily)
  are now PRIMARY; groq/compound only if `HYPER_WEB_INTEL_PROVIDER=groq` (reversible). Nulled the
  DEAD `self.web_model=groq/compound-mini` (never called; engine `_web_search` already uses HIVEMIND).
  Closes the last groq residual from F0 — text + web both fully HIVEMIND/Cerebras/OpenRouter.
- **verified:** hm-employees healthy on the baked image; gate live (`_HivemindWebPrimary` present).
- **P3 (feature-recon HALT — did NOT rebuild):** `employees-service/scripts/quality/quality_eval.py`
  ALREADY IS the eval baseline harness — runs real room turns (`run_director`), judges
  grounded/specific/on_intent/useful_for_exec + is_generic ("be harsh"), averages QE_SAMPLES,
  writes a dated JSON report, regression floor QE_FLOOR. Models already gpt-oss (director 20b, synth 120b).
  Plan's "build evals/hyper_report_eval.py" would have duplicated it. Established a BASELINE run
  against MANDI (807ebb88, has Solvis data) via QE_PROFILE_JSON — result captured to /tmp/quality_report.json.
  FOLLOW-UP: quality_eval `_judge_groq` still tries GROQ first (OpenRouter fallback + gpt-oss judge,
  so valid) — canonicalize to OpenRouter-only in a later pass (offline eval, low priority).
- **remaining program (queued, phase-by-phase):** P7 round-table → P5 presence → P4 synth (uses the
  synth_model seam) → P1 contracts → P0 provenance → P2 governor → P6 TARA. Each ships+verifies+journals.
- **scorecard:** feature-recon EARNED ITS KEEP — caught quality_eval (would have rebuilt P3) + the
  already-HIVEMIND engine._web_search (F0b was 1 gate, not a web rewrite). recon held via grep. → harness: none.

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
- **verified E2E (full pipeline):** fired a real room turn (MANDI "Research Market Trends",
  3 agents, auto template) via /internal/hyper/room-turn → HTTP 200; the WHOLE pipeline
  (plan/gather/debate/synth) = 8/8 calls `provider=Cerebras model=openai/gpt-oss-120b`,
  out_tok 175-329 each (real content → no empty-content regression), ZERO groq/llama/errors.
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
