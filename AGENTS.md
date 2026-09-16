# SINGULANCE agent entrypoint

Read [`.hivemind/EveryAgent.md`](.hivemind/EveryAgent.md) before working in this repository.
It is the sole repository-level operating contract for Codex, Claude, Grok, and other coding agents.

Do not load broad local skill catalogs or legacy `.claude` guidance. Select exactly one relevant
platform skill through [`.hivemind/ROUTING.json`](.hivemind/ROUTING.json), then use the task's
branch and environment constraints from [`.hivemind/BRANCH.json`](.hivemind/BRANCH.json).
