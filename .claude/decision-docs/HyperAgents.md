# HyperAgents — the AI Company OS (authoritative state + flags)

> HIVEMIND is the **Brain** (memory cortex). HyperAgents is the **OS** — *run your institution
> as an AI company*: a founding team of digital employees that plan, debate, act, verify, and
> reach out, all grounded in the org's brain. This doc is the single source of truth for what is
> built + LIVE, the architecture, every flag, and the envisioned end-state.
>
> Reconciled against `singulance-main @ 787d18a85` · 2026-07-23. Deploy topology + engine detail
> live in `.claude/hyperagents/CONTEXT.md` (+ JOURNAL.md for the ship history).

---

## 1. Surfaces (what the user touches)

| Surface | Route | Container | Purpose |
|---|---|---|---|
| **Company dashboard** | `next.singulancelabs.com/hivemind/app/employees/mycompany` | `hivemind-next-frontend-1` (`hivemind/fe:latest`) | Company HQ: the founding team, tasks, deliverables |
| **Rooms** (round-table) | in-app; `POST /internal/hyper/room-turn` | `hm-employees` (sidecar) | Multi-agent debate → grounded deliverable |
| **Team tasks** | `POST /v1/hyper/tasks/*` → director | `hm-control` → `hm-employees` | A task opens a room, the team runs it |
| **Employee chat** | `/v1/employees/{slug}/chat` | `hm-employees` | 1:1 with a single digital employee |
| **Outreach** | campaign UI + drain worker | `hm-control` (`outreach/campaigns.js`) | Email/call campaigns over prospects (TARA calls) |

**Runtimes:** control-plane (JS, `hm-control`) ↔ employees sidecar (Python AgentScope, `hm-employees`)
↔ core (JS, `hm-core`, the recall/chat/ingest brain). FE = Da-vinci (`hivemind/fe:latest`, both
`hm-fe` + `hivemind-next-frontend-1`).

---

## 2. The pipeline (a room turn)

`PLAN → GATHER → RECON-PRE → EXECUTE → SIMULATE → PRODUCE → RECON-POST → GOALKEEPER`

- **Gather** grounds every claim in recall / HIVEMIND web / connectors.
- **Debate** (P7): round 2 REACTs to named peers ("challenge or build on X's point") — robust, not echo.
- **Synth** writes the final deliverable (a strong model; see LLM policy).
- **Goalkeeper** re-plans against unmet gaps up to a cap; honest dead-ends stop instead of looping.
- **Terminal writes** + HITL: outward sends (email) are draft+approve; internal artifacts run post-consensus.

---

## 3. LLM policy (canonical — Cerebras / OpenRouter ONLY, no Groq/llama)

- **Core (JS):** `cerebras` (direct `api.cerebras.ai`) primary → `openrouter` failover, model
  `openai/gpt-oss-120b`. (`core/src/llm/llm-config.js`.)
- **Sidecar (Python):** OpenRouter-primary for gpt-oss (Cerebras provider), provider-pinned; groq
  fully retired. A **Cerebras-direct** path exists for natively-hosted ids (e.g. `zai-glm-4.7`)
  via `_cerebras_chat` — bypasses OpenRouter, uses `CEREBRAS_API_KEY`, hits Cerebras auto prompt-cache.
- **Synth model** is selectable via `HYPER_SYNTH_MODEL`. A/B (n=2) kept **gpt-oss-120b (0.85) over
  zai-glm-4.7 (0.758)**; GLM Cerebras-direct path stays baked, one env flip away.

---

## 4. Program status (P0–P7 closed loop) — ALL LIVE

| Phase | What | Status (2026-07-23) |
|---|---|---|
| **F0/F0b** | Sidecar LLM canonical (Cerebras/gpt-oss); web-intel → HIVEMIND | ✅ live |
| **P3** | Quality eval harness (mean_quality baseline 0.956) | ✅ live |
| **P7** | Round-table debate reacts to named peers | ✅ live |
| **P4** | `HYPER_SYNTH_MODEL` seam + Cerebras-direct synth path | ✅ live (synth = gpt-oss-120b) |
| **P1** | Version-tolerant seam contracts (JS SoT + pydantic `extra=ignore`) | ✅ live |
| **P0** | Provenance + actionable-gate; first-class provenance columns | ✅ live (**gate=enforce**) |
| **P2** | Governor — kill switch + per-turn token cap + outbound cap | ✅ live (levers off by default) |
| **P6** | Outreach Contract + human-approved auto-generation | ✅ live (**autonomy + auto-propose on**) |

### Cross-cutting, also live
- **TARA call-contract (voice outbound with first-contact HITL popup):** when HyperAgents
  proposes an outbound call, the contract auto-selects **language** (inferred from the prospect —
  e.g. a German firm → `de`), a **conversation strategy**, and a **voice** (resolved to a concrete
  Cartesia voice from TARA's live `/voices` catalog by language+tone). `propose` generates the
  contract + pushes a live `call_contract` event; the FE `<CallContractModal>` shows goal/strategy/
  language/voice with **Approve & call / Not now**. Approve → Start the campaign → TARA dials with
  the contract (plans + speaks with intent). **Nothing dials without the popup approval** (hard
  first-contact HITL). Files: `api_outreach.py`, `outreach/campaigns.js` (`resolveVoiceId`,
  `executeCall`, `propose`), `components/CallContractModal.jsx`, `HyperAgents.jsx` (SSE dispatch).
- **Plan-limit popup:** 402s emit `plan_limit_exceeded` → the FE `<PlanLimitModal>` fires
  (was a silent console 402). Backend `capacityErrorResponse` + project-limit paths.
- **Service-error toast:** any 5xx / network failure → global `<ServiceErrorToast>` (was a silent
  `catch {}` on mycompany). `shared/serviceError.js` + interceptor + AppShell.
- **Provenance columns auto-fill:** `produced_by_turn/agent/actionable/provenance` on
  `hivemind.memories`, populated post-create from the original payload (canonical normalizer strips
  it mid-pipeline, so we set it after the create — hyperagents-agent saves only, uuid-guarded).
- **Onboarding trio distribution:** the founding 3 are picked field-relevant AND span complementary
  debate lenses — a guaranteed **challenger [skeptic] + analyst [investigator] + lead
  [strategist/generalist/coordinator]** (deterministic re-cast if the LLM collapses to one lens).

---

## 5. Onboarding — the founding team (genesis)

Company URL → category → the marketplace catalog (`MARKETPLACE`, 5 fields × 5 professions, mirrors
FE `shared/field-catalog.js`; each profession tagged with an **archetype** `a` that drives its debate
lens). A picker LLM staffs EXACTLY 3, **field-relevant + lens-balanced**:
- **[skeptic]** — challenges assumptions, surfaces risk (the anti-yes-man).
- **[investigator]** — evidence, data, metrics, unit economics.
- **[strategist] / [generalist] / [coordinator]** — direction + execution.

A deterministic guarantee re-casts a redundant pick to any missing lens (keeping the human name,
preferring an already-chosen field) so **every** founding team debates robustly. The HQ room seats
the trio; the debate assigns lanes/stances (incl. a skeptic) per turn.

---

## 6. Complete flag reference

> All flags are read from `/root/hivemind/.env` (the shared runtime env). **Bold = safety/gate flag.**
> "Prod" = current live value. Unlisted `HYPER_*` tuning flags default to sane in-code values.

### Safety / Governor / gates (P0, P2)
| Flag | Prod | Default | Effect |
|---|---|---|---|
| **`HYPER_PROVENANCE_GATE`** | `enforce` | `log` | P0 actionable-gate: `off`\|`log`(shadow)\|`enforce`(reject junk agent saves) |
| `HYPER_MIN_FACT_CHARS` | — | `15` | Min content length for an "actionable" fact |
| **`HYPER_KILL_SWITCH`** | off | off | Master stop — refuses ALL room turns instantly (+ blocks outreach) |
| `HYPER_KILL_SWITCH_REASON` | — | "paused by operator" | Message surfaced when the kill switch is engaged |
| **`HYPER_TURN_TOKEN_CAP`** | `0` | `0` (∞) | Per-turn token ceiling across goalkeeper rounds → seals `cost_capped` |
| **`HYPER_OUTBOUND_CAP`** | `0` | `0` (∞) | Max outward sends a single turn may queue |
| `HYPER_DAILY_TOKEN_CAP` | — | in-code | Org/day token budget (returns 402 on writes when spent) |

### Outreach / TARA autonomy (P6)
| Flag | Prod | Default | Effect |
|---|---|---|---|
| **`HYPER_OUTREACH_AUTONOMY`** | `on` | `on` | Drain worker autonomously advances **human-authorized** campaigns; `off` = FE-driven only |
| **`HYPER_OUTREACH_AUTO_PROPOSE`** | `on` | `off` | OS may auto-generate **queued (proposed)** campaigns; a human must Start them (first-contact HITL) |
| **`HYPER_OUTREACH_KILL_SWITCH`** | off | off | Outreach-specific stop (in addition to the global kill switch) |
| **`HYPER_OUTREACH_DAILY_CAP`** | `0` | `0` (∞) | Per-org rolling-24h outreach send cap |

> **HARD INVARIANT (not a flag):** autonomy NEVER cold-originates. The drain only advances a
> `running` campaign; a campaign exists only because a human created + Started it after reviewing
> the prospects. There is no code path for the OS to build a target list and send with no human
> approval — deliberate (consent / deliverability / legal).

### Synth / models (P4, F0)
| Flag | Prod | Effect |
|---|---|---|
| `HYPER_SYNTH_MODEL` | `openai/gpt-oss-120b` | Final-report writer. Bare Cerebras id → `_cerebras_chat`; namespaced → OpenRouter |
| `HYPER_SYNTH_MAX_TOKENS` | `4000` | Synth generation budget |
| `HYPER_SYNTH_TIMEOUT_S` | `90` | Synth deadline |
| `HYPER_AUTO_GATHER` / `HYPER_AUTO_DEBATE` | `gpt-oss-120b` | Gather / debate models |
| `HYPER_MODEL_RECON` | `gpt-oss-120b` | Recon-pre/post model |
| `HYPER_DIRECTOR_MODEL` / `HYPER_PERSONA_MODEL` | (default `gpt-oss-120b`) | Orchestrator / persona models |
| `HYPER_CEREBRAS_DIRECT_MODELS` | `zai-glm-4.7` | Ids routed direct to `api.cerebras.ai` |
| `HYPER_CEREBRAS_PROMPT_CACHE_KEY` | off | Account-gated Cerebras `prompt_cache_key` routing hint |
| `HYPER_OPENROUTER_PRIMARY` | `1` | gpt-oss routes direct to OpenRouter from call 1 |
| `HYPER_OR_IGNORE` | (slow hosts) | OpenRouter provider blacklist (DekaLLM, DeepInfra, …) |
| `HYPER_DEBATE_MAX_TOKENS` | `700` | Per-debate-turn cap |

### Pipeline / loops / tuning (representative)
| Flag | Effect |
|---|---|
| `HYPER_CYCLE_ENABLED` (`true`) | Cognition/company cycle on |
| `HYPER_ROOM_GOALKEEPER_MAX_ROUNDS` | Goalkeeper re-plan cap |
| `HYPER_ROOM_AGENT_MAX_ITERS` | Per-agent tool-loop cap |
| `HYPER_WEB_BUDGET` | Web-search calls per turn |
| `HYPER_GATHER_DEEPEN(_MAX_Q)` | Recall-sufficiency recursion |
| `HYPER_EVOLVE_*` | Self-evolving per-employee playbooks |
| `HYPER_SIM_*` | Population-simulation (ontology/personas/report) |
| `HYPER_JOURNAL_*` / `HYPER_DIGEST_*` | Per-turn journal + digest |
| `HYPER_CONNECTOR_TOOL_CAP` / `HYPER_MCP_TOOLS_PER_CONNECTOR` | Connector tool budgets |
| `HYPER_SELF_REVISE(_MAX_CYCLES)` | Producer self-revision |
| `HYPER_WEB_INTEL_PROVIDER` (`hivemind`) | Web intel via HIVEMIND (not groq) |

---

## 7. Deploy (RISK tier — always `--no-deps`, verify recall)

Per-service, from the **`/root/hivemind-main`** singulance-main worktree (NOT the dirty
`/root/hivemind` feat tree):
```bash
docker build -f Dockerfile.production        -t hivemind/core-api:prod-<date>-<sha> /root/hivemind-main       # core
docker build -f Dockerfile.control-plane     -t hivemind/control-plane:prod-<date>-<sha> /root/hivemind-main  # control
docker build -f employees-service/Dockerfile -t hivemind/employees:prod-<date>-<sha> /root/hivemind-main/employees-service
VERSION=<tag> docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d --no-deps <service>
```
- **`--no-deps` is MANDATORY** — a bare `up -d employees` recreates hm-core (a dependency) from the
  dirty tree (bit us once). Pass VERSION per service; never bump `.env` VERSION (it's shared).
- **FE:** build `hivemind/fe:latest` from `frontend/Da-vinci` (commit+push the submodule first,
  bump the parent gitlink), then recreate BOTH `hm-fe` (`-p 8088:80`, bridge) and
  `hivemind-next-frontend-1` (`-p 127.0.0.1:2388:80`, net `hivemind-next`). **Do NOT use
  `scripts/deploy-fe.sh`** — it SSHes to a remote + `git reset --hard` (destroys local work) +
  only touches hm-fe.
- Live images: core `prod-20260723-beb3b5184` · control `prod-20260723-787d18a85` · employees
  `prod-20260723-c3fe566bb` · fe `latest`.

---

## 8. Envisioned end-state (the satisfying loop)

A user pastes their company URL and, within minutes, has a **living AI company**:
1. **Genesis** — a lens-balanced founding trio (challenger + analyst + lead), grounded in the org brain.
2. **Every turn is traceable** — provenance (turn/agent/actionable) on every fact the team writes;
   the actionable-gate keeps junk out (`enforce`).
3. **Robust decisions** — round-tables debate with real dissent (P7), grounded in recall + web +
   connectors, verified by a goalkeeper, never looping on dead-ends.
4. **Bounded + safe** — the Governor caps token + outbound spend and offers an instant kill switch;
   nothing runs away.
5. **Action with a human in the loop** — the OS proposes outreach (auto-propose), assembles the
   targets, and TARA executes — but a human always approves first contact; caps + dedup + kill
   switch stack on top.
6. **Nothing fails silently** — plan limits show an upgrade popup; service outages show a toast.

### Open, deliberately-gated follow-ups
- **Cold origination** (OS contacts a new audience with zero human approval) — intentionally NOT
  built; would require per-org opt-in + consent/legal review + first-contact HITL retained.
- **Auto-trigger of auto-propose on turn-seal** — the `propose` capability is live + enabled; wiring
  an automatic call on every outreach-room seal is the next increment (currently invoked explicitly).
- **GLM synth cutover** — flip `HYPER_SYNTH_MODEL=zai-glm-4.7` for a faster/cheaper synth if the
  small quality dip (0.758 vs 0.85) is acceptable.
- **Provenance columns via the canonical path** — auto-fill currently rides a post-create update;
  threading provenance through the V5 normalizer would make it universal.
