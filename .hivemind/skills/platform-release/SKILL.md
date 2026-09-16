---
name: platform-release
description: Release a verified SINGULANCE change from a clean worktree through the correct local, Enigma, or production artifact path, including Harness runner images and rollback proof.
---

# Platform release

Use this skill after the change is implemented and verified. It turns a clean,
merged source revision into one explicit deployable artifact; it is not a reason
to rebuild the platform or to patch a running container.

## Release contract

1. Select `.hivemind/manifests/<environment>.json`, resolve its named source
   ref to an exact SHA, and use a clean worktree created from that ref. Never
   substitute `main`, the current checkout, a local source mount, or a dirty
   server tree.
2. Confirm the changed boundary and release only its artifact: Worker/frontend,
   Core/control service, migration, Harness runner, or another named service.
   A multi-artifact change is a deliberate sequence with its own evidence for
   each artifact.
3. Before cutover record the current deployment identity and a usable rollback
   target. Build from the exact source SHA, validate the artifact, then deploy
   through the repository's canonical helper or versioned service manifest.
4. Recreate only the affected service with its existing secret source,
   network, volume, ingress, and health check. Never use `docker exec`, copy
   environment files between environments, or recreate dependencies merely
   because a sibling service changed.
5. Verify health plus the affected real route. For authenticated/user-facing
   work, run the changed route's canary; a build, image import, or HTTP 200 is
   supporting evidence, not completion by itself.
6. Record SHA, artifact digest/version, migration result if applicable,
   canary result, rollback target, and exact limitation if browser proof is
   unavailable.

Read [the production runbook](references/production-runbook.md) for a
production deployment or Harness runner release. For local and Enigma, use
the repository's environment-specific refresh/release command rather than
adapting production Compose commands.

## Worktree closeout

After the target commit is confirmed merged remotely and the released artifact
no longer depends on the task checkout, preserve the commit/release record and
remove the clean local worktree. Use non-force removal; unresolved changes or
an unmerged branch are evidence to stop. Deleting a remote branch is separate
from removing a local worktree and requires explicit release policy or user
authorization.
