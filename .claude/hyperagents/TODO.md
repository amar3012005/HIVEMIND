# HyperAgents — Active TODO

The `hyperagents-builder` skill writes the recon+plan phases here BEFORE coding,
then executes them one-by-one, checking each off. One feature at a time.
When all phases ship → move a summary line to [JOURNAL.md](./JOURNAL.md) and clear this.

- `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked (note why)

---

## Current feature: Agentic orchestrator (AgentScope PlanNotebook + MsgHub) — started 2026-06-19
**Goal:** Replace the deterministic phase machine with an autonomous agent-driven loop that works for ANY task: lead decomposes → each owner gets a SubTask → each runs its own ReAct loop (personified recall + connectors) → MsgHub broadcasts → synthesize → structured verify. No `if intended_output==…`, no `_resolve_recipients`/`_produce_output` branches.
**Recon-redteam verdict:** AgentScope 1.0.19 natively supports it (API verified): `PlanNotebook`(create_plan/finish_subtask + plan-change hook), `MsgHub`(auto-broadcast), `ReActAgent(plan_notebook=, structured_model=)`, `Toolkit` groups. Build behind a flag (safe/reversible); risk = gpt-oss harmony tool-name leak (retry) + token/429 (cap) + FE event parity.
**Feature-recon:** Extends `build_react_agent` (add optional `plan_notebook`) + new `_orchestrate_agentic`; reuses existing grounding gate, `_verify_and_emit`, approval queue, event types. Does NOT touch the live deterministic path until parity.

### Phases
- [x] P1 — DONE (77004cd8): `_orchestrate_agentic` via STRUCTURED flat plan (gpt-oss can't do nested create_plan) → owners execute with tools in MsgHub → synthesis → grounding gate/verify/produce/seal. Smoke: subtasks=4, complete, grounded to real Münzer. Flag OFF.
- [ ] P2 — Agent-driven PRODUCE: synthesizer/owner calls `docs_create`/`gmail_create_draft` itself (approval card still surfaces); drop the deterministic producer for this path.
- [ ] P3 — Robustness: harmony/429 retry per owner, cost cap, max rounds, reuse the hard grounding gate + structured verify, idempotent seal.
- [ ] P4 — FE: render live SubTask states from the plan event; turn the flag ON after parity with the deterministic path.
- [ ] Verify — e2e on JEE/Solvis room for several task shapes (doc, email, answer, doc+email); CEO grounds to real Münzer, doc+email produces the doc + drafts when recipient known.
- [ ] Ship — per phase: commit (author amarsai3012005) + push + JOURNAL.
- [ ] Retrospective — scorecard → JOURNAL; delegate to hivemind-skill-evolver.

> _(template for future features below)_

> When a new feature starts, replace this block with:
>
> ## Current feature: <name> — started YYYY-MM-DD
> **Goal:** <one line>
> **Recon-redteam verdict:** <reuse / build / risks flagged>
> **Feature-recon:** <existing code found — extend X / nothing, net-new>
>
> ### Phases
> - [ ] P1 — <phase> · files: <...> · done-when: <verifiable>
> - [ ] P2 — ...
> - [ ] Verify — e2e on box (command + expected)
> - [ ] Ship — commit (author amarsai3012005) + push + JOURNAL entry
> - [ ] Retrospective — score the run (scorecard → JOURNAL), delegate to `hivemind-skill-evolver`, propose (don't auto-apply) any harness improvement

## Backlog (known next increments)
- [ ] MCP-connector search in GATHER (Notion/Slack/GitHub) — only when a room enables an MCP connector.
- [ ] Verifier strictness on LLM-authored `done_criterion` (it sometimes demands sections the user didn't ask for → met=false partial). Consider grounding done_criterion to the user's actual ask.
- [ ] Extend the GROUNDING GATE (save+seal block) to the swarm + deep_sim paths — it's currently in the debate path + the goalkeeper (all templates loop on grounded_ok, but swarm's own save isn't gated). Debate covers the transcript cases; swarm save-gate is the residual.
- [x] ~~Per-owner EXECUTE tool use~~ — DONE (30d03725): owners now run real tools (recall+connectors) in a bounded ReAct loop.
