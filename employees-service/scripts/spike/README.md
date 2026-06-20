# HyperAgent Engine v2 — Single Director + `debate` Tool

> **One director agent, native Groq tools, one session.** It gathers from the company
> brain, convenes the room's personas for a real debate when a decision is warranted,
> loads skills for polish, and produces real artifacts — replacing a ~3,000-line
> multi-agent orchestrator while *genuinely* preserving the hyperagent room.

This is the result of an end-to-end exploration (spikes in this folder). It is **tested,
not yet wired into production** — see *Status* at the bottom.

---

## The product, kept intact

HyperAgents are **sentinel agents living inside HIVEMIND** that simulate a shared-room
discussion — support, connection, skepticism — and **grow smarter over time**. v2 keeps
that promise and makes it *honest*, not theater:

- The room still debates with **distinct personas** and **real skepticism**.
- It's **genuinely multi-agent at the moment that matters** (the `debate` tool fans out
  independent persona LLM calls) — just efficient everywhere else (one director).
- **Grow smarter** is a real mechanism, not a tagline: agents ground in HIVEMIND **and
  write back**, per-user profiles sharpen, the **skills registry** expands, and the
  dreaming/cognitive layer compounds the memory. The room gets sharper as the brain fills.

---

## Architecture

```
                ┌──────────────────────────  DIRECTOR (gpt-oss-120b, native tools)  ──────────────────────────┐
  user query ──▶│  gather → (debate when warranted) → load skill → produce → synthesize & seal               │
                └───┬───────────────┬────────────────────┬──────────────────┬───────────────────────────────┘
                    ▼               ▼                    ▼                  ▼
              recall / web /   debate(topic) ──▶ persona sub-calls    load_skill(name)   guarded produce
              drive_search /   (the REAL room:   (independent LLM     (polished-doc /    docs_create /
              docs_get /       stance→challenge  calls per employee,  polished-email /   sheets_create /
              sheets_get       →support, R1..Rn) skeptic opposes)     brand-voice)       gmail_create_draft
                    │                                                                          │
                    └────────────────────── SHARED BLACKBOARD (free — one process) ◀───────────┘   guard: reject
                       every gathered fact accumulates; debate + produce read it                placeholder/fake links
```

- **Gather** tools mine HIVEMIND + live connectors; results accumulate on a **shared
  blackboard** (free in one process — the coordination gap of the parallel design vanishes).
- **`debate(topic, rounds)`** is the heart: the room's personas run as **independent
  sub-LLM-calls** — Round 1 stances, Round 2 challenge/support each other; the skeptic
  lane opposes. Returns the transcript the director synthesizes. Emits the FE's
  `round_start` / per-persona `react` / `swarm_verdict` events → the UI shows the room.
- **Skills** load *within* the call (model-driven, no pre-insert) → quality on demand.
- **Guarded produce** lets the agent *act* safely: a write with placeholder/empty args or
  a body that references a link with **no real Google URL** is rejected → the agent retries
  with the real create-result URL. (Kills the fabricated-link failure mode.)

---

## Proof (live run, Solvis room, 6 real employees)

**Query:** *"Decide: heat-pump line vs solar+storage next year? Debate it as the team, then
write the decision as a polished Google Doc."*

| | |
|---|---|
| **Flow** | gather (recall ×4 + drive_search + docs_get ×5) → `debate` (2 rounds, 5 personas) → `load_skill('polished-doc')` → `docs_create` |
| **Debate R1** | Jonah (skeptic) challenged the either/or framing · Nora → heat-pump (70% subsidy, >1M installs) · Maya → solar+storage · Victor → heat-pump · Lina → solar integration |
| **Debate R2** | Real cross-challenge: *"Maya's resource split is UNVERIFIED"*, *"Lina's argument is weakest — no R&D cost quantification"*, *"Nora discounts solar despite convergence"* |
| **Output** | Real Google Doc — *Solvis Strategic Decision: Prioritise Heat-Pump Line FY2025* (exec summary, market context with UNVERIFIED notes, rationale, quarterly plan, next steps) |
| **Cost** | **13 tool calls · 35.5s · 71,993 tokens · one director session** |

Distinct grounded stances + genuine skepticism + a polished, grounded artifact — not mush,
no fabrication.

---

## Why this replaces the old orchestrator (evidence from the spikes)

| Capability | Old multi-agent orchestrator | v2 director | Evidence |
|---|---|---|---|
| Gather (HIVEMIND + connectors + web) | parallel owners + recon | native tool loop, verifies | `groq_agent.py` |
| **Take action** (docs/sheets/email) | centralized producer (couldn't let agents act on Groq) | **agent acts via guarded tools** | sheet→email + doc→CEO done in one session |
| Debate / skepticism | full swarm (40–175s, goalkeeper loops) | `debate` tool, real persona calls | `groq_director.py` |
| Catch fabrication | independent skeptic | **single agent + recall catches it** (1.8k tok) | `groq_fab_test.py` — all variants CAUGHT a planted 45% lie |
| Polish | baked prompts | **skills loaded on demand** | `load_skill` |
| Shared context | lost when parallel | **free shared blackboard** (one process) | — |
| Lines / cost | ~3,000 lines, 40–175s | one session, 6–42s | — |

**Single-call simulation** (`groq_sim.py`) is even cheaper (4k tok, 6s) when full
independence isn't needed; the `debate` tool is the rigorous middle ground (real
independent personas, surfaced to the FE).

---

## Model policy (per call type, all env-tunable)

| Phase | Model | Why |
|---|---|---|
| Director / synthesis | `gpt-oss-120b` (Groq) | strong reasoning, native tools, 0 harmony 400s |
| Persona sub-calls (debate) | `gpt-oss-120b` / `llama-3.1-8b-instant` | sharp; 8b cheap for high volume |
| Recon / verify (if used) | `deepseek-v4-flash` (OpenRouter) | reliable judgment |

Routing is model-aware (Groq direct vs OpenRouter); `reasoning_effort` only for gpt-oss.

---

## Status & next step

- ✅ **Tested** end-to-end (this README's run). Spikes: `groq_agent.py` (gather+act),
  `groq_sim.py` (personas/skills as tools), `groq_fab_test.py` (fabrication rigor),
  `groq_director.py` (the unified engine).
- ▶ **P4 (production):** wire `_orchestrate_single_agent` behind `HYPER_SINGLE_AGENT`, emit
  the room's FE events from the director + `debate` tool, route by template (auto/answer/
  doc/email → director; explicit debate/council → keep the swarm). Then A/B in the FE and
  flip the default.

Run any spike: `docker exec hm-employees python /app/scripts/spike/<file>.py`
