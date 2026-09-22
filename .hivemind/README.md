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
- `ops-gateway` when calling or diagnosing the native production deployment tools.

## Deploy through the Ops Gateway

The Ops Gateway is the preferred deployment interface. It is an already configured MCP server;
agents use its listed tools directly, without setting up a separate MCP server. At the start of a
release, inspect the available tool descriptions and select the narrowest owner:

**Remote MCP endpoint:** `https://core.singulancelabs.com/api/mcp`

This is the production MCP host. The website, frontend, and generic API domains are not MCP
endpoints. An agent whose HIVE-MIND remote MCP connection is authenticated with a master key or an
API key carrying `ops:deploy` sees the Ops tools in its normal tool inventory. It must not install,
spawn, or configure a local deployment bridge. A normal HIVE-MIND user key intentionally does not
receive deploy capability.

| Changed artifact | Use the corresponding Ops Gateway deployment tool |
|---|---|
| Da-vinci frontend / Cloudflare Worker | `deploy_cloudflare_frontend` |
| HIVE Core, Control Plane, Employees, or a scoped container service | `deploy_core_services` |
| Native Harness, Cordis plugin, or compiled Harness UI | `deploy_harness_runner` |

The direct tool contract is:

| Tool | Required arguments | Result |
|---|---|---|
| `deploy_cloudflare_frontend` | Da-vinci `sha`, optional `note` | Versioned Cloudflare frontend release and rollback identity |
| `deploy_core_services` | parent HIVE-MIND `sha`, scoped `services`, optional `note` | Immutable Core/Control/Employees artifact and scoped recreate |
| `deploy_harness_runner` | parent HIVE-MIND `sha`, immutable runner `image` digest, optional `note` | Runner-only recreate and prior image |
| `get_release_status` | `instance_id` | Release state, evidence, and rollback data |

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

### Copy-paste task opener

```text
Read AGENTS.md and .hivemind/README.md. Select the one relevant .hivemind skill.
Create a clean codex/<task> worktree from origin/singulance-main. Implement and run the focused
check. Commit and push the exact SHA. If this task needs production release, use the already-listed
HIVE-MIND Ops Gateway MCP tool that owns the changed artifact; do not SSH-patch live containers or
set up a local MCP server. Verify the affected public route and report the release instance and
rollback identity.
```

## Finish

Run the focused check for the changed boundary, commit, push, deploy through the owning tool when
requested, and report the SHA, deployment version/image, route result, and rollback identity. Once
merged and no longer needed, remove the clean task worktree normally to reclaim space.
