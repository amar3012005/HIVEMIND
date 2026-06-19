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
```

---

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
