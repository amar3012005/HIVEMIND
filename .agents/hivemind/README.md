# HIVE-MIND agent entrypoint

This folder is the one stable entrypoint for coding agents in this repository.
It is intentionally a pointer, not a copied playbook.

1. Read `CONTRACT.json`, then the canonical contract under
   `platform/ground-truth/`.
2. Select exactly one task owner using `ROUTING.json`.
3. Create and validate a task manifest before delegating a mechanical or bounded
   change.
4. Use only the files, commands, and checks named by that manifest.
5. For a release, validate a release manifest and preserve rollback evidence.

Do not create parallel `.claude`, `.agent`, or repository-local copies of these
rules. Historical documentation is evidence, not authority; inventory it before
an approved archive task moves it.
