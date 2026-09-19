# SINGULANCE agent entrypoint

Start with [`.hivemind/README.md`](.hivemind/README.md), then load the one relevant skill from
[`.hivemind/ROUTING.json`](.hivemind/ROUTING.json). This is the concise, current operating guide
for Codex, Claude, Grok, and other coding agents.

Use `production-base` as this project's local starting branch. It tracks
`origin/singulance-main`; task branches must be new names such as `codex/<task>`. Do not switch a
shared checkout to `singulance-main`—that name is the remote promotion target, not a task branch.
