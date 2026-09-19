# SINGULANCE agent operating guide

This folder is the current guide for building and releasing SINGULANCE. Use it instead of broad
legacy `.claude`, journal, or root-README instructions.

## Start a task

The project checkout is on `production-base`, which tracks `origin/singulance-main`. Do **not**
check out `singulance-main` locally: another legacy worktree may already own that branch.

Create a fresh named task worktree from the current production ref:

```bash
git fetch origin singulance-main
git worktree add -b codex/<task> ../HIVE-MIND-<task> origin/singulance-main
```

Codex can create the same task worktree itself. The branch must be `codex/<task>` (or an equivalent
task name), never `singulance-main`.

Choose one skill with `ROUTING.json`:

- `memory-platform` for HIVE ingestion, recall, evidence, entities, and MCP.
- `identity-platform` for users, organizations, projects, usage, billing, and lifecycle.
- `cordis-harness-platform` for HIVE chat, HyperAgents, Cordis, Composio, and Harness.
- `tara-voice-platform` for Tara voice.
- `platform-release` for any local, Enigma, or production deployment.

## Deploy through the Ops Gateway

The Ops Gateway is the preferred deployment interface. It is an already configured MCP server;
agents use its listed tools directly, without setting up a separate MCP server. At the start of a
release, inspect the available tool descriptions and select the narrowest owner:

| Changed artifact | Use the corresponding Ops Gateway deployment tool |
|---|---|
| Da-vinci frontend / Cloudflare Worker | `deploy_cloudflare_frontend` |
| HIVE Core, Control Plane, Employees, or a scoped container service | `deploy_core_services` |
| Native Harness, Cordis plugin, or compiled Harness UI | `deploy_harness_runner` |

Supply the exact pushed SHA, target `production`, affected service(s), and release note. The tool
records the prior Worker version or image as the rollback identity and returns the deployed version
and health result. If a named tool is unavailable, use the currently listed equivalent—tool
descriptions are the live contract.

### Frontend / Cloudflare

1. Commit and push the Da-vinci SHA first.
2. Update and commit the parent `frontend/Da-vinci` gitlink.
3. Push the parent change to `origin/singulance-main`.
4. Use `deploy_cloudflare_frontend` with that exact frontend SHA. Verify the public route and note
   the Worker version returned for rollback.

### Core and production containers

1. Push the parent SHA to `origin/singulance-main`.
2. Use `deploy_core_services` for only the affected service group. The production helper builds an
   immutable artifact from that SHA and recreates only those services.
3. Verify the changed API or authenticated route and retain the prior image reported by the tool.

### Harness runner

1. Build and push an immutable Harness image from the exact pushed Harness SHA through the Harness
   release path.
2. Use `deploy_harness_runner` with the matching pushed HIVE-MIND SHA and that image digest.
3. It recreates only `hivemind-harness-runner` (and its tunnel companion), reports the previous
   image, and preserves the rest of the stack. Verify health, bootstrap, and the changed chat
   behavior.

Do not deploy a frontend-only change through container tooling, and do not rebuild Core or Harness
for an unrelated Worker deployment.

## Finish

Run the focused check for the changed boundary, commit, push, deploy through the owning tool when
requested, and report the SHA, deployment version/image, route result, and rollback identity. Once
merged and no longer needed, remove the clean task worktree normally to reclaim space.
