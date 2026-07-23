# Claude Session Onboarding

## Five-Minute Bootstrap

```bash
git fetch origin singulance-main
git status --short --branch
git rev-parse HEAD
git submodule status frontend/Da-vinci
git log --oneline origin/singulance-main -12
```

Then read:

1. `.claude/INSTRUCTIONS.md`
2. `docs/BRANCH_PROTOCOL.md`
3. `docs/ENGINEERING_JOURNAL.md`
4. `docs/PRODUCTION_RELEASE.md`
5. The relevant `.claude/decision_docs/*` file

Use an isolated worktree if the current checkout has unrelated changes. Add a
Started journal entry before edits. Push the task branch before describing work
as committed.

## Task Routing

| Task | Start with |
| --- | --- |
| Memory, ingestion, recall, chat | `decision_docs/MEMORY_ENGINE.md` |
| HyperAgents | `hyperagents/CONTEXT.md` |
| TARA/voice | `decision_docs/TARA.md` |
| Frontend | `decision_docs/FRONTEND.md` |
| Security/tenant isolation | `decision_docs/SECURITY.md` |
| Release/containers | `decision_docs/RELEASES.md` |

Production access and credentials are never onboarding prerequisites. Source
work remains separate from release work.
