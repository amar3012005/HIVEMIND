# Collaboration and Release Decision

Development uses isolated task branches. `singulance-main` is the integration
and release branch, never a shared scratchpad. Frontend SHAs are pushed before
parent gitlinks. Git and the engineering journal record committed work.

Production is only `ssh singulance`. The mandatory authority is
`docs/PRODUCTION_RELEASE_PROTOCOL.md`; follow it before any build, migration,
restart, cleanup, or deploy. Do not derive release truth from an old `.claude`
journal, mutable image alias, or server branch name.

`SINGULANCE-ONBOARD/OPERATIONS.md` currently describes a lighter quick-deploy
model that conflicts with parts of the mandatory immutable-release protocol.
Until the repository owners reconcile them, the mandatory protocol wins and a
session must not blend both procedures.
