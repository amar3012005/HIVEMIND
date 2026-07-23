# HyperAgents / Singulance-OS — Context (read this FIRST)

Single source of truth for the **HyperAgents / Digital-Employees** subsystem —
"Singulance as an OS: run your institution as an AI company." Any new session, on
any device, reads this to get oriented. Pair with [JOURNAL.md](./JOURNAL.md)
(what shipped, newest-first) and [TODO.md](./TODO.md) (current program/phases).

> Auto-engages via the `hyperagents-builder` skill. Follow its pipeline
> (recon-redteam → feature-recon → plan → execute → verify → ship → journal),
> don't freelance. **Verify any "X is absent" recon with grep/Read — recon goes stale.**
> _Rewritten 2026-07-23 from live ground truth; the prior version described a
> different box (ssh 116.202.24.69 / /Users/amar) — that is HISTORICAL, not this env._

---

## Two halves of Singulance
- **Brain** (separate track, already hardened 2026-07): memory / recall / chat —
  `recallPersistedMemories`, one engine, deterministic, drift-guarded. See
  `.claude/decision_docs/MEMORY_ENGINE.md`. HyperAgents SITS ON this substrate.
- **OS** (this subsystem): agents that run the company — onboard → strategize →
  act (outreach) → learn, all over the SAME HIVEMIND memory. The compounding loop.

## The envisioned closed loop (what we build toward)
```
URL onboard → VERIFIED identity + digital-presence graph ─┐
                                                          ▼
                    persistent HIVEMIND memory ◀──────────┤ (grounds every stage)
                          ▼                                │
     expert ROUND-TABLE debate (agents argue real msgs) ──┤
                          ▼                                │
     FRONTIER-model final report (one call) ──────────────┤
                          ▼  emits a machine contract      │
     OUTREACH CONTRACT → TARA sets goal, picks skill, dials│
                          ▼ {outcome, learnings}           │
                    ingested back as memory ───────────────┘
```
Gated by two safety primitives so it can run unattended: **provenance +
actionable-gate** (no LLM-inferred fact may drive an outbound action; must be
`verified` = ≥2 independent sources) and a **Governor** (per-org token + outbound
caps + kill switch). Trust (provenance + governor) is the moat. Full program +
phases: [TODO.md](./TODO.md).

## Three runtime surfaces (all in the `hm-employees` sidecar :8060)
| Surface | Route (sidecar) | Backend | FE |
|---|---|---|---|
| **Rooms** (Slack-style digital-employee rooms) | `POST /room-turn` | `api_hyper_rooms.py` pipeline | `HyperAgents.jsx` rooms view (`/employees/rooms/:id`) |
| **Round-table / team tasks** (expert debate → report) | `POST /` + `GET /{task_id}` + `/{task_id}/transcript` | `api_team_tasks.py` → `hyper/engine.py` `room.run()` (entry `run_director`) | company dashboard / rooms |
| **Employee chat** (1:1 persona) | `POST /{slug}/chat` | `api_employees` / engine persona | `EmployeePlayground.jsx` |

Plus `/approve` (write-approval drain), `/health`, `/health/deep`, `/prewarm`, `/admin/reload`.

## Rooms pipeline (the mental model for `api_hyper_rooms.py`)
```
PLAN ─ GATHER ─ RECON-PRE ─ EXECUTE ─ SIMULATE ─ PRODUCE ─ RECON-POST ─ GOALKEEPER
```
`_plan_turn → _gather_evidence → _recon_pre → _execute_assignments → (_orchestrate
debate/swarm) → _produce_output → _verify_turn → goalkeeper loop in post_room_turn`
(cap `HYPER_ROOM_GOALKEEPER_MAX_ROUNDS=3`). GROUNDING GATE: `grounded_ok=false` →
not saved, not sealed (never poison recall with a fabricated source).

## Round-table engine (`hyper/engine.py`) — P4/P7 target
- `HyperEngine` (class ~938): `director_model`/`persona_model` default gpt-oss-120b;
  **`synth_model = synth_model or self.director_model` (line ~970)** — the P4 seam
  (`HYPER_SYNTH_MODEL` unused today → synth uses the director model).
- `_debate(topic, rounds)` (~1441): round-1 parallel stances → round-2 react →
  `swarm_verdict`. P7 = make round-2 argue the *verbatim* round-1 peer messages.
- `run()` (~1896), `run_director` (entry), `run_mention_reply`, `evo_reflect_and_merge`.

## Topology
```
React FE (Da-vinci submodule → Vercel)
  │ /employees/* → HyperAgents.jsx (mycompany=hero/CompanyDashboard, roster, rooms/:id)
  │ POST /v1/hyper-rooms/:id/turns → hm-control (control-plane-server.js:3000) → 202
  ▼ fire-and-forget kick
hm-employees (Python FastAPI sidecar :8060) /room-turn (or /{task_id} round-table)
  │ pipeline runs; each event → POST /internal/hyper/turn-event
  ▼ appendTurnEvent → hyper_turns.lines (JSONB) event bus
FE reads SSE /turns/:id/stream (250ms poll) + GET fallback. Caddy flush_interval -1.
```

## File map
| File | Container | Owns |
|---|---|---|
| `employees-service/src/hivemind_employees/api_hyper_rooms.py` | hm-employees | Rooms pipeline + agent prompts. |
| `employees-service/src/hivemind_employees/hyper/engine.py` | hm-employees | Round-table debate, model routing, synth_model seam, `_route_direct_openrouter`. |
| `employees-service/src/hivemind_employees/api_team_tasks.py` | hm-employees | Round-table task runner (`room.run()`). |
| `employees-service/src/hivemind_employees/agents/agentscope_tools.py` | hm-employees | Write-gate contextvars, `queue_email_approval`, `record_artifact`. |
| `employees-service/src/hivemind_employees/hivemind_client.py` | hm-employees | `recall_emulated`, `org_members_emulated`, `google_exec_emulated`. |
| `core/src/control-plane-server.js` | hm-control | Turn/room routes, onboarding genesis (profile draft), SSE, nightly cycle (`HYPER_DAILY_TOKEN_CAP`). |
| `core/src/outreach/campaigns.js` | hm-core | `generateTarget` / `executeCall` / `executeEmail` → outreach. |
| `core/src/connectors/runtime/**` + `core/src/connectors/google-native.js` | hm-core | Connector runtime (the canonical toolkit) + Google tools. |
| `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx` | Vercel | Room + company-dashboard UI. |
| `frontend/Da-vinci/src/components/hivemind/app/hyperagents/*` | Vercel | `CompanyDashboard`, `HyperOnboarding`, `OnboardingTerminal`, `CampaignPanel`, `LeadsView`, `AgentAvatar`, `rooms/`, `elements/`. |

**Two git repositories:** Core/sidecar live in the parent `HIVEMIND` repository;
the frontend is the `Da-vinci` submodule. Work on isolated task branches. Push
the frontend commit first, then update the parent gitlink. Integrate complete
work into `singulance-main` through `docs/BRANCH_PROTOCOL.md`.

## Release

Source work does not hot-patch containers. Release only the integrated pushed
commit through `docs/PRODUCTION_RELEASE_PROTOCOL.md`, with one release owner,
rollback, service-specific acceptance, and journal evidence. Never infer the
current box layout or commands from this context file.

## LLM policy (canonical — enforce on BOTH runtimes)
Owner rule: **Cerebras (primary) → OpenRouter (failover), model `gpt-oss-120b`, NO
Groq, NO llama** for text. JS core enforces this at the `groq-fallback` chokepoint
(`core/src/llm/llm-config.js`). **The Python sidecar does NOT yet** — it still has
`GROQ_URL`, a `_GROQ_DEAD` groq-primary path, and llama/groq defaults
(`HYPER_WEB_MODEL=groq/compound-mini`; code defaults `_SIM_AGENT_MODEL`/`_DIGEST_MODEL`/
`_JOURNAL_MODEL=llama-3.1-8b-instant`; env `MIND_READER_MODEL`/`COGNITION_WRITER_MODEL`/
`GROQ_INFERENCE_MODEL`/`HIVEMIND_LLM_MODEL`=llama). Closing this is the first task
(see TODO). `HYPER_AUTO_DEBATE/GATHER/RECON` are already gpt-oss-120b.

## Test harness (e2e a turn without the FE, on this box)
```bash
TID=$(python3 -c 'import uuid;print(uuid.uuid4())')
docker exec hm-core sh -lc 'curl -s -m600 -X POST http://hm-employees:8060/internal/hyper/room-turn \
  -H "X-API-Key: $HIVEMIND_MASTER_API_KEY" -H "Content-Type: application/json" -d @- <<JSON
{"room_id":"<room>","turn_id":"'$TID'","user_id":"<uid>","org_id":"<org>",...,
 "user_message":"...","callback_url":"http://hm-control:3000/internal/hyper/turn-event"}
JSON'
docker logs -f hm-employees | grep -E '\[plan\]|gather\]|recon|execute\]|verify\]|goalkeeper'
```
Test email recipient is ALWAYS `amarsai2005@gmail.com` (user-controlled, safe real send).

## Hard-won lessons (don't relearn)
- Recon agents / code-review-graph can be STALE — verify "X is absent" with grep/Read.
- Never fabricate a recipient; resolve via org directory or a literal address the user typed.
- Agents fabricate when tool-less — tool-GROUND them + keep the grounding gate.
- Tool NAME ≠ gate key ("recall" is the fn; "hivemind_recall" is the gate key).
- Two core replicas historically shared a queue — on this box confirm replica count before assuming.
- Email is NEVER "sent" in-turn — draft + approval card only.
- Do not run ad-hoc Compose or container-copy commands from a feature session.
  The release protocol owns dependency isolation, environment rendering,
  immutable images, rollback, and acceptance.

## Test Fixtures

Resolve authorized disposable tenant/user/room fixtures at test time. Do not
encode customer or production identifiers in persistent agent instructions.
Deep code map (verify before use): `core/HYPERAGENTS_CODEBASE_GUIDE.md`.
