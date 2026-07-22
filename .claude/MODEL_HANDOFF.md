# Model Handoff — working knowledge for whichever Claude runs this repo next

Written 2026-07-06. This is the knowledge-transfer layer that sits *above*
`ONBOARDING.md` (the mechanics) and `CLAUDE.md` (the rules): how to reason
in this repo. Any Claude model in Claude Code inherits all skills, agents,
workflows, and hooks automatically — nothing here is model-specific.

## Core operating principles (in priority order)

1. **Recall before you think.** This repo has persistent memory (HIVEMIND
   MCP + code-review-graph). The answer to "how should I do X?" is usually
   already stored — a prior decision, a bug that bit us, a half-built
   version of the feature. Run the CLAUDE.md bootstrap recalls first, then
   `feature-recon` before building anything. Building something that
   already exists is the #1 waste in this repo's history.

2. **The graph before grep.** `semantic_search_nodes` / `query_graph` /
   `get_impact_radius` answer structural questions (callers, blast radius,
   test coverage) in a fraction of the tokens of file scanning. Grep is
   the fallback, not the default.

3. **Verify before ship, always.** `main` IS prod here. The pipeline is
   recon → build → `review-changes` (adversarial, skeptic-verified
   findings only) → `ship` skill → `deploy-verify`. Never shortcut the
   review because a change "looks trivial" — the recurring prod incidents
   were all "trivial" changes (staged-uncommitted files blocking pull,
   missing down migrations, restart without migrate).

4. **Adversarial self-checking beats confidence.** When reviewing or
   researching: generate findings, then try to *refute* each one before
   reporting. Findings that survive a genuine refutation attempt are
   worth the user's time; the rest are noise. This is baked into the
   `review-changes` workflow — keep that pattern for anything new.

5. **Memory discipline is not optional.** Every session that ends without
   a master-index memory (`session-trail-<date>` + `master-index`) is a
   session the next model can't rehydrate. Log decisions with *rationale
   and alternatives* — future models need to know why, not just what.

## Reasoning patterns worth keeping

- **Scope before depth.** For any non-trivial ask: enumerate what the task
  touches (files, tenants, migrations, contracts) *before* editing. The
  `cartographer` + `historian` agents in parallel are the cheap way.
- **Tier the effort.** Doc tweak ≠ auth change. TRIVIAL gets a direct fix;
  STANDARD gets recon + review; RISK (auth, payments, migrations, tenant
  scoping, recall pipeline) gets the full `ship-feature` chain including
  threat-modeler and TDD-RED.
- **Fan out independent work, serialize dependent work.** Multiple agents
  in one message when tasks don't share state; never parallel-edit the
  same files without worktree isolation.
- **Report outcomes faithfully.** If a test fails, say so with output.
  A green summary over a red reality is the worst failure mode.

## Repo-specific gotchas (hard-won)

- Commit author must be `amarsai3012005 <amarsai3012005@users.noreply.github.com>`.
- Stage explicit paths only — the tree always has unrelated dirty files.
- ESM everywhere; migrations need a down path; every query tenant-scoped.
- `myserver` is production with real customer data — read-only `hm` script
  commands are safe; anything mutating requires `--confirm` and intent.
- Frontend is the `Da-vinci` submodule: it ships via Vercel + a submodule
  bump in this repo, not via the backend deploy path.
- Recall-eval is the regression gate for anything touching memory/recall —
  a deploy that passes smoke but regresses recall-eval gets rolled back.

## For the next model

You are not starting fresh. Run the bootstrap recalls, read this file and
ONBOARDING.md, and you have everything: the skills encode the workflows,
the agents encode the specializations, HIVEMIND encodes the history.
The only thing that changes between models is raw capability — the
judgment lives in this directory. Use it.
