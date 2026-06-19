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
