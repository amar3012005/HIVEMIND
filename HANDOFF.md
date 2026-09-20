# WorkRun AgentScope progression handoff

## Source and branch

- Base recovery branch: `codex/workrun-source-parity` at `d7aa00529`.
- Active branch: `codex/workrun-artifact-link`.
- Current pushed head: `d3dd7b400`.
- This is local-only work. No shared container, preview, or production service
  was replaced.

## Completed, verified phases

1. `6caef15e2 fix(workruns): link artifacts by AgentScope session`
   - `hivemind_record_artifact` forwards the server-minted AgentScope session
     identity and hm-core resolves it under the authenticated user/org before
     linking the durable artifact pointer to the WorkRun.
2. `7ecd5d35f feat(workruns): progressively activate native capabilities`
   - AgentScope Tasks, PlaybookList/Get, and cancellation remain basic.
   - Workspace tools, workspace skills/MCPs, team controls, and non-basic HIVE
     extensions are named AgentScope ToolGroups, activated only by
     `reset_tools`.
   - Tool-result events recover their tool name from the matching call id.
3. `d3dd7b400 feat(workruns): allow direct answers before company planning`
   - The single native AgentScope run now answers self-contained requests with
     no tools; company work follows playbook selection, native Tasks, then one
     needed ToolGroup.

## Verification output

Run from `/Users/amar/HIVE-MIND-workrun-artifact-link`:

```text
docker run --rm --volume "$PWD/deploy/hm-agent-runtime-v2:/work:ro" --workdir /work --entrypoint python hm-agent-runtime-v2:local -m unittest discover -s tests -p 'test_*.py' -v
Ran 14 tests in 0.018s
OK

(cd core && npm test -- tests/unit/work-runs-plan.test.js tests/unit/workrun-artifact-link.test.js tests/unit/workrun-playbook-catalog.test.js)
# tests 8
# pass 8
# fail 0
```

The Docker test includes a real AgentScope 2.0.8 Toolkit assertion: `TaskCreate`
is initially available and `Bash` appears only after activating `workspace`.

## Current next phase

Implement layered catalog resolution for AgentScope `PlaybookList`/`PlaybookGet`:

1. Preserve `global:*` catalog entries.
2. Resolve the current WorkRun from the authenticated AgentScope session id.
3. Add employee-global learned playbook and room-local playbook data as scoped
   catalog entries, without trusting a caller-supplied org, room, or employee.
4. Keep catalog metadata compact; return detailed instructions only on
   `PlaybookGet`.
5. Add unit coverage for global-only fallback, scoped local entries, and
   cross-user/session rejection.

## Decisions

- Do not create a second execution loop or keyword router. The AgentScope model
  decides direct answer versus company work from the bounded system contract.
- Keep the existing Da-vinci HM Rooms UI untouched until the runtime contract is
  stable; the current UI already consumes stable event identities.
- Do not rebuild the shared `hm-agent-runtime-local` container from this
  worktree. Exact dependency/runtime tests run from an isolated container using
  `hm-agent-runtime-v2:local`.

## Exact next action

Extend the internal playbook endpoints so an authenticated AgentScope session
receives only the global, employee-global, and room-local catalog entries bound
to its own WorkRun.
