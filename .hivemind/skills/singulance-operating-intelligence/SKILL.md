---
name: singulance-operating-intelligence
description: Execute SINGULANCE/HIVE-MIND engineering work quickly through the relevant platform skill, a clean bounded change, and proportional proof. Use for platform frontend, backend, runner, infrastructure, or release work; do not use as a reason to delay ordinary implementation.
---

# SINGULANCE operating intelligence

## Default: finish the requested job

Treat an explicit user request to change, deploy, test, or repair an in-scope
SINGULANCE system as authority to do the normal engineering work. Start with
the smallest relevant platform skill, identify the affected artifact, then
implement and verify. Do not turn preparation into the deliverable.

Use one skill at a time unless a second skill is directly required by the
changed boundary. Read and follow the target repository's applicable local
instructions and the selected relevant skill; they remain authoritative for
safety, ownership, artifact, and release behavior. Do not load catalogs,
journals, or unrelated playbooks before acting.

Treat instructions as execution guidance, not a reason to defer ordinary
in-scope work. If an instruction names an optional ledger, review tier,
handoff, stale ref, browser controller, or documentation record, use it when
available and continue when it is not. Pause only when an applicable
instruction identifies a concrete safety, access, test, tenant-isolation, or
deployment failure that makes the next action unsafe or impossible.

## Fast execution contract

1. Resolve the target environment and the named branch or worktree. If the
   requested branch is available, use it. A stale local ref, absent optional
   SHA, missing task-ledger client, missing browser-control tool, or absent
   documentation file is context to record, never a reason to stop.
2. Preserve unrelated dirty work. Create a clean worktree only when the active
   checkout cannot safely contain the change. A required repository worktree
   or lock rule still applies; do not require an additional task ledger, model
   handoff, or specialist receipt for a bounded task.
3. Trace the first failing boundary, change the owning code, and run the
   smallest meaningful test or build. Do not investigate every adjacent
   subsystem before fixing a demonstrated failure.
4. Deploy only the changed artifact through its canonical helper. For Harness,
   Worker, Core, or frontend changes, release the affected unit rather than
   rebuilding the platform. Keep the previous artifact/version as rollback.
5. Prove the changed path at the highest available level: focused test for a
   local change; health plus route/smoke check for a deployment; one affected
   authenticated canary when the task is user-facing. If a stronger proof tool
   is unavailable, report that limitation after completing all available work.

## What may actually block execution

Stop only for a concrete condition that makes the next action unsafe or
impossible:

- the target system or destructive target cannot be identified;
- credentials, access, or a required service are genuinely unavailable;
- an external irreversible action is outside the user's request;
- a reproducible test or deployment failure prevents a safe release;
- a security, authorization, tenant-isolation, or migration decision has no
  established owner or rollback.

An implementation can proceed through ordinary ambiguity: inspect the code,
make the smallest reasonable choice, state it in the final handoff, and keep
the diff reversible. Do not wait for a separate model tier or agent merely to
restate evidence the current agent can inspect.

## Lightweight operational record

Record the branch, commit, artifact/version, test result, and rollback target
in the final report or existing release lock when one exists. A Cloudflare Task
Ledger is useful when configured for a multi-stage production task, but it is
best-effort provenance—not a prerequisite for editing, testing, or deploying.
Never fabricate a ledger receipt.

## Production speed with safety

For a production request, use the current target branch, build/recreate only
the affected service, and run the affected canary. Do not require a full
platform rebuild, a broad audit, a model handoff, or a browser session that is
unavailable. Escalate only when the change genuinely crosses an unowned
security boundary, an irreversible migration, or an unknown cross-service
failure.

## Handoff standard

End with only: result, changed artifact(s), verification, deployed version if
applicable, rollback target, and any single concrete remaining limitation.
Do not call a task blocked merely because an optional governance mechanism was
not present.
