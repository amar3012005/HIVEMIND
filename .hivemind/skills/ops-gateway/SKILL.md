---
name: ops-gateway
description: Use or diagnose SINGULANCE's native remote MCP deployment tools for Cloudflare frontend, scoped Core services, and the Harness runner. Do not use this skill for implementation work.
---

# SINGULANCE Ops Gateway

Use this skill only when a task is ready for deployment or when its native deployment tools are
missing or failing. The production MCP endpoint is:

`https://core.singulancelabs.com/api/mcp`

This is remote MCP. The agent should already have HIVE-MIND tools in its normal inventory. Do not
create a local MCP process, copy a token into a repository, or deploy through a website domain.

## Choose the owner

- Da-vinci Cloudflare frontend: `deploy_cloudflare_frontend` with the exact pushed Da-vinci SHA.
- Core, Control Plane, or Employees: `deploy_core_services` with the exact pushed parent SHA and
  only the affected services from `core`, `control-plane`, and `employees`.
- Native Harness/Cordis: build and publish the immutable runner image from the Harness SHA first,
  then use `deploy_harness_runner` with the matching parent SHA and image digest.
- Existing release: `get_release_status` with its returned `instance_id`.

The deploy tools require a master credential or an API key whose scope includes `ops:deploy`.
Ordinary HIVE-MIND user keys do not expose them. If the tools are absent, verify the exact endpoint,
the credential scope, and refresh the remote MCP connection before changing application code.

## Release outcome

Pass only committed, pushed SHA/digest values. Use the returned release instance to observe the
result, verify the affected public route, and report its artifact/version and rollback identity.
Never substitute SSH edits or an all-services restart for a missing tool.
