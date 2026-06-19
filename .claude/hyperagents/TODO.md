# HyperAgents — Active TODO

The `hyperagents-builder` skill writes the recon+plan phases here BEFORE coding,
then executes them one-by-one, checking each off. One feature at a time.
When all phases ship → move a summary line to [JOURNAL.md](./JOURNAL.md) and clear this.

- `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked (note why)

---

## Current feature: _(none — idle)_

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

## Backlog (known next increments)
- [ ] MCP-connector search in GATHER (Notion/Slack/GitHub) — only when a room enables an MCP connector.
- [ ] Verifier strictness on LLM-authored `done_criterion` (it sometimes demands sections the user didn't ask for → met=false partial). Consider grounding done_criterion to the user's actual ask.
- [ ] Per-owner EXECUTE could optionally allow tool use (recall/connectors) for owners whose slice needs fresh data — currently tool-less for reliability.
