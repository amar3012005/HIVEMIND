# Model Handoff Contract

A handoff must state facts, not confidence.

## Required Fields

- Branch, base SHA, current SHA, and clean/dirty state.
- Owned files and services.
- Pushed commits and remote reachability.
- Tests run with exact results.
- Migrations and compatibility implications.
- Production state: `not deployed`, `candidate`, `accepted`, or `rolled back`.
- If accepted: release ID, image digest, tenant canary, and rollback reference.
- Remaining gaps and the next concrete action.

## Never Hand Off As Fact

- “latest,” “live,” or “production-ready” based only on source or a build.
- A frontend change whose submodule commit is not pushed and referenced.
- A production claim inferred from branch names, mutable tags, or old journals.
- A tenant-scope, citation, billing, connector, or storage-parity claim without
  the relevant acceptance evidence.

The next model starts with `.claude/ONBOARDING.md`; do not paste old deployment
commands or secrets into handoffs.
