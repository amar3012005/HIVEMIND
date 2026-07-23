---
name: hyperagents-reference
description: Knowledge/architecture map of HIVEMIND HyperAgents (Singulance-OS) — the AI-company OS as built SO FAR. What the subsystem is, its three runtime surfaces, the rooms pipeline, the shipped capability catalog (P0–P7, TARA call-contract, lead book, propose_call, governor, outreach contract), the LLM policy, and key flows. This is the REFERENCE companion to `hyperagents-builder` (which owns the dev WORKFLOW) and defers to `.claude/hyperagents/CONTEXT.md` + `JOURNAL.md` for the deepest, most-current detail. Read for orientation / "what exists / how does X work" questions; use `hyperagents-builder` to actually build/ship.
type: reference
---

# HyperAgents / Singulance-OS — architecture & shipped capabilities

**What it is:** an AI-company OS — digital employees that plan, gather evidence,
debate, execute real work (Google/MCP connectors), and produce verified artifacts,
inside Slack-style rooms + round-table team tasks. Memory grounding is HIVEMIND
(see the `hivemind-engine` skill). This file is the **map + capability catalog**;
the dev **workflow/harness** lives in `hyperagents-builder`; the deepest live detail
lives in `.claude/hyperagents/CONTEXT.md` (orientation) + `JOURNAL.md` (ship history,
newest-first). When they disagree, CONTEXT.md/JOURNAL.md win (they're kept current).

## Three runtime surfaces (all in the `hm-employees` sidecar, :8060)
| Surface | Sidecar route | Backend | FE |
|---|---|---|---|
| **Rooms** (digital-employee rooms) | `POST /room-turn` | `api_hyper_rooms.py` pipeline | `HyperAgents.jsx` rooms view |
| **Round-table** (expert debate → report) | `POST /` + `GET /{task_id}` + `/transcript` | `api_team_tasks.py` → `hyper/engine.py` `room.run()` (`run_director`) | company dashboard |
| **Employee chat** (1:1 persona) | `POST /{slug}/chat` | `api_employees` / engine persona | `EmployeePlayground.jsx` |

## Rooms pipeline (`api_hyper_rooms.py`)
```
PLAN ─ GATHER ─ RECON-PRE ─ EXECUTE ─ SIMULATE ─ PRODUCE ─ RECON-POST ─ GOALKEEPER
```
`_plan_turn → _gather_evidence → _recon_pre → _execute_assignments → (_orchestrate
debate/swarm) → _produce_output → _verify_turn → goalkeeper loop` (cap
`HYPER_ROOM_GOALKEEPER_MAX_ROUNDS=3`). **GROUNDING GATE**: `grounded_ok=false` → the
turn is NOT saved, NOT sealed — never poison recall with a fabricated source. The
goalkeeper reworks toward success, caps retries, fails honest (mirror this posture
when driving any task).

## Round-table engine (`hyper/engine.py`)
`HyperEngine`: `director_model`/`persona_model`/`synth_model` default `gpt-oss-120b`
(`synth_model = synth_model or director_model` is the P4 seam; `HYPER_SYNTH_MODEL`
env flips it). `_debate(topic, rounds)`: round-1 parallel stances → round-2 react →
`swarm_verdict`. Entries: `run()`, `run_director`, `run_mention_reply`,
`evo_reflect_and_merge` (per-agent learned playbook).

## Capability catalog — what's shipped so far (see JOURNAL for commits/dates)
- **P0 — provenance + actionable-gate**: every produced memory carries `produced_by_turn`/`produced_by_agent`/`actionable`/`provenance` (first-class columns, migration `20260723090000`); enforce-mode gate.
- **P1 — version-tolerant seam contracts** (`core/src/contracts/hyper-seams.js`): schema_version on dispatch/turn payloads so sidecar⇄core stay compatible across versions.
- **P2 — Governor**: kill switch + token/outbound caps (`HYPER_DAILY_TOKEN_CAP`, nightly cycle); audit-reflection noise is recall-filtered.
- **P4 — Cerebras-direct synth**: `_cerebras_chat`/`_route_cerebras_direct` in engine; synth kept = `gpt-oss-120b` (A/B 0.85 > 0.758 vs zai-glm-4.7); GLM path one env flip away.
- **P6 — Outreach Contract + human-approved auto-generation**: `core/src/outreach/outreach-contract.js` + `campaigns.js` (`generateTarget`/`executeCall`/`executeEmail`, autonomy gate).
- **TARA call-contract**: when the OS decides to call a prospect, a contract popup auto-chooses voice/language/strategy (Cartesia voice via `resolveVoiceId`) with a first-contact HITL popup. Agent tool `propose_call` fires it in-room; `_TURN_PROVENANCE` contextvar carries turn_id/room_id/org_id/callback_url.
- **Shared LEAD BOOK**: `list_prospects`/`save_prospect` agent tools (+ notes), prospects-as-memories (tag `prospect`), Places auto-persist. Registered unconditionally in `build_hivemind_toolkit`.
- **Tool-discipline**: lead/call guidance is PROMPT-driven persona instructions (not hardcoded English rules) + a tool-selection sandbox (`scripts/quality/tool_sandbox.py`).
- **Onboarding genesis**: balanced trio with distributed skills + uniform skepticism assignment (control-plane).
- **FE (user-facing)**: usage-limit popup (402→`plan_limit_exceeded`), 5xx service-error toast, `CallContractModal`, `HyperAgents.jsx` room + company dashboard, `hyperagents/*` (CompanyDashboard, HyperOnboarding, CampaignPanel, LeadsView).

## Topology & file map (essentials)
- Sidecar `hm-employees` :8060 (Python). Core `hm-core`. Control `hm-control`. FE Da-vinci.
- `employees-service/src/hivemind_employees/api_hyper_rooms.py` — rooms pipeline + prompts.
- `…/hyper/engine.py` — round-table debate, model routing, synth seam.
- `…/agents/agentscope_tools.py` — `propose_call`, `list_prospects`, `save_prospect`, write-gate contextvars, `set_turn_provenance`.
- `…/agents/agentscope_factory.py` — persona + tool-discipline guidance.
- `…/hivemind_client.py` — `recall_emulated`, `org_members_emulated`, `save_prospect_emulated`, `google_exec_emulated`.
- `core/src/control-plane-server.js` — turn/room routes, onboarding, SSE, nightly cycle, plan-limit 402.
- `core/src/outreach/campaigns.js` + `outreach-contract.js` — outreach/calls/email.
- `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx` + `hyperagents/*`.

## LLM policy (canonical — enforce on BOTH runtimes)
**Cerebras (primary) → OpenRouter (failover), model `gpt-oss-120b`, NO Groq, NO llama** for text. JS core enforces at the `groq-fallback` chokepoint (`core/src/llm/llm-config.js`). The Python sidecar is being canonicalized to match (residual `GROQ_URL`/llama defaults are tracked in TODO/JOURNAL — verify current state before assuming).

## Test a turn e2e (no FE, on this box)
`POST hm-employees:8060/internal/hyper/room-turn` with `X-API-Key: $HIVEMIND_MASTER_API_KEY` and a JSON body `{room_id, turn_id(uuid), user_id, org_id, user_message, callback_url:"http://hm-control:3000/internal/hyper/turn-event"}`; watch `docker logs -f hm-employees | grep -E '\[plan\]|gather|recon|execute|verify|goalkeeper'`. **Test email recipient is ALWAYS `amarsai2005@gmail.com`** (safe real send).

## Deploy (sidecar-only — the trap that bit us)
`VERSION=<tag> docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d --no-deps employees`. **ALWAYS `--no-deps`** — without it, `employees` recreates its `depends_on` **hm-core** from the dirty tree under one shared `${VERSION}`, silently running unintended core code. Pass VERSION as a shell override; never bump `.env` VERSION (that's core's). Full deploy detail: `hyperagents-builder` + CONTEXT.md § Deploy.

## Hard-won lessons (don't relearn — full list in CONTEXT.md)
- Recon agents / code-review-graph go STALE — verify "X is absent" with grep/Read before trusting.
- Agents fabricate when tool-less → tool-GROUND them + keep the grounding gate.
- Tool NAME ≠ gate key (`recall` fn vs `hivemind_recall` gate key).
- Email is NEVER sent in-turn — draft + approval card only; never fabricate a recipient.
- `docker compose` needs `--env-file /root/hivemind/.env` or interpolation fails.

## Key IDs (active test org on THIS box)
- org **MANDI** `807ebb88-94a3-447b-8d84-727479cdd979` · user `c8876290-…-231fa1843ee9`.

## Cross-refs
- **Dev workflow / how to build+ship**: `hyperagents-builder` (mandatory pipeline, JOURNAL discipline).
- **Memory grounding / recall**: `hivemind-engine` skill.
- **Deepest live detail**: `.claude/hyperagents/CONTEXT.md` + `JOURNAL.md`; deep code map `core/HYPERAGENTS_CODEBASE_GUIDE.md` (may be partially stale — verify).
