# -*- coding: utf-8 -*-
"""Workspace/sandbox backend selection.

Phase 1 used `LocalWorkspaceManager`, which means the service container *is* the
sandbox: every workspace shares one filesystem namespace, so it is single-tenant
and any agent can read any other agent's files. This module makes the backend a
configuration choice so the same image runs local, single-box-isolated, or
scale-out without a code change.

Backends, and when each is correct:

    local        host directory, NO sandbox. Local dev only.
    bubblewrap   bwrap sandbox. Linux single box, minimal infra.
    docker       one container per workspace. Linux single box, real isolation.
    apple        Apple Container. macOS single box.
    e2b          E2B cloud sandbox. Distributed — required behind a load balancer.
    daytona      Daytona cloud sandbox. Distributed.
    opensandbox  OpenSandbox. Distributed, self-hosted.
    k8s          Pod + PVC. Distributed, existing cluster.

**Distribution is the deciding factor.** `local`, `bubblewrap`, `apple`, and
`docker` keep workspace state on the host running the service process. Behind a
load balancer a request for the same `workspace_id` can land on a node that
cannot reach it. Pick a cloud/cluster backend before scaling past one node.

Isolation grain (`per_agent` | `per_session` | `per_user`) decides how the
working directory is shared across `(user_id, agent_id, session_id)`. It does
NOT disable intra-workspace isolation: MCP clients stay separate per
`agent_id + session_id`, skills stay private per `agent_id`.

`workspace_id` is minted once at session creation and persisted — changing the
policy does not re-partition existing sessions.

Configuration:

    AGENTSCOPE_WORKSPACE_BACKEND    local|bubblewrap|docker|apple|e2b|daytona|opensandbox|k8s (default: docker)
    AGENTSCOPE_ALLOW_UNSAFE_LOCAL_WORKSPACE=1
                                     required to use the unsandboxed local backend
    AGENTSCOPE_WORKSPACE_ISOLATION  per_agent|per_session|per_user
    AGENTSCOPE_WORKSPACE_TTL        idle eviction seconds (default 3600)
    AGENTSCOPE_SANDBOX_IMAGE        base image for docker/k8s
    AGENTSCOPE_SANDBOX_NODE_VERSION node version for npx-based MCPs
    E2B_API_KEY                     read from env by the E2B manager itself
"""

from __future__ import annotations

import logging
import os
from typing import Any

_log = logging.getLogger("hm-agent-runtime.workspace")

# A missing setting must never turn an operating-system WorkRun into an
# unsandboxed host-directory run. Compose also defaults to Docker, but this
# code-level default protects direct Python starts and future deployment shapes
# that do not use those files.
BACKEND = os.getenv("AGENTSCOPE_WORKSPACE_BACKEND", "docker").strip().lower()
ALLOW_UNSAFE_LOCAL = os.getenv("AGENTSCOPE_ALLOW_UNSAFE_LOCAL_WORKSPACE", "0") == "1"
# `per_session` is the default for WorkRuns, not `per_agent`.
#
# Two reasons, both structural:
#
#   1. A session is unique per `(user_id, agent_id, workspace_id)`. Under
#      `per_agent` every WorkRun for one employee resolves to the same
#      workspace, so the second run *resumes the first run's session* instead of
#      starting a new one — and AgentScope answers 409 on a second chat against
#      a live session. One employee could never run two work orders.
#   2. A WorkRun is the isolation boundary the user asked for: one run, one
#      workspace, torn down when the run ends. `per_agent` would share a
#      filesystem across unrelated runs, so one run's scratch files would leak
#      into the next.
#
# `per_agent` remains correct for a long-lived employee that accumulates state
# across runs; that is a different product decision, not this one.
ISOLATION = os.getenv("AGENTSCOPE_WORKSPACE_ISOLATION", "per_session").strip().lower()
TTL = float(os.getenv("AGENTSCOPE_WORKSPACE_TTL", "3600"))
SANDBOX_IMAGE = os.getenv("AGENTSCOPE_SANDBOX_IMAGE", "python:3.12-slim")
NODE_VERSION = os.getenv("AGENTSCOPE_SANDBOX_NODE_VERSION", "20")

# Skill directories seeded into every brand-new workspace.
#
# AgentScope copies these into `skills/.seed` on first start, then equips each
# agent's own partition from that template. The agent sees them through the
# native Skill viewer — a Skill explains *how* to do something; the tools that
# perform the operation stay in `extra_agent_tools`. Seeding them here is what
# makes the playbook catalog reachable without a custom SkillHub.
#
# Each directory must contain a `SKILL.md` whose YAML front matter has BOTH
# `name` and `description` — AgentScope yields a Skill only for files that have
# both, and silently skips the rest.
SKILLS_DIR = os.getenv(
    "AGENTSCOPE_SKILLS_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills"),
)


def _skill_paths() -> list[str]:
    """Every immediate subdirectory of SKILLS_DIR that holds a SKILL.md.

    Returns the *category* directories (business/, market/, outreach/, …) rather
    than each leaf: AgentScope copies a skill path recursively, so passing the
    category keeps the catalog's grouping intact inside the workspace.
    """
    if not os.path.isdir(SKILLS_DIR):
        _log.warning("skills dir %s does not exist; no skills will be seeded", SKILLS_DIR)
        return []
    paths = []
    for entry in sorted(os.listdir(SKILLS_DIR)):
        full = os.path.join(SKILLS_DIR, entry)
        if os.path.isdir(full) and not entry.startswith("."):
            paths.append(full)
    return paths


# Backends whose workspace state lives on the local host. Behind a load
# balancer these are unsafe — the warning below is the guard.
_SINGLE_NODE = {"local", "bubblewrap", "apple", "docker"}


def _isolation_policy() -> Any:
    from agentscope.app.workspace_manager import IsolationPolicy

    try:
        return IsolationPolicy(ISOLATION)
    except ValueError as exc:
        valid = [p.value for p in IsolationPolicy]
        raise ValueError(
            f"AGENTSCOPE_WORKSPACE_ISOLATION={ISOLATION!r} is not one of {valid}",
        ) from exc


def build_workspace_manager(basedir: str) -> Any:
    """Construct the configured workspace manager.

    Raises with an actionable message when the backend's extra is not installed
    — a missing `workspace-e2b` extra otherwise surfaces as an ImportError deep
    inside AgentScope with no hint about the fix.
    """
    isolation = _isolation_policy()

    if BACKEND == "local":
        if not ALLOW_UNSAFE_LOCAL:
            raise RuntimeError(
                "AGENTSCOPE_WORKSPACE_BACKEND=local is unsandboxed and is "
                "refused by default. Use Docker/E2B/etc., or set "
                "AGENTSCOPE_ALLOW_UNSAFE_LOCAL_WORKSPACE=1 only for "
                "deliberate single-tenant debugging.",
            )
        from agentscope.app.workspace_manager import LocalWorkspaceManager

        _log.warning(
            "workspace backend=local: NO sandbox. All workspaces share one "
            "filesystem namespace — single-tenant only. Set "
            "AGENTSCOPE_WORKSPACE_BACKEND=docker (or e2b) before any "
            "multi-tenant use.",
        )
        skills = _skill_paths()
        _log.info("seeding %d skill path(s) from %s", len(skills), SKILLS_DIR)
        return LocalWorkspaceManager(
            basedir=basedir,
            isolation=isolation,
            skill_paths=skills,
        )

    if BACKEND == "bubblewrap":
        from agentscope.app.workspace_manager import BubblewrapWorkspaceManager

        return BubblewrapWorkspaceManager(
            basedir=basedir,
            isolation=isolation,
            ttl=TTL,
        )

    if BACKEND == "apple":
        from agentscope.app.workspace_manager import AppleContainerWorkspaceManager

        return AppleContainerWorkspaceManager(
            basedir=basedir,
            isolation=isolation,
            ttl=TTL,
        )

    if BACKEND == "docker":
        from agentscope.app.workspace_manager import DockerWorkspaceManager

        return DockerWorkspaceManager(
            basedir=basedir,
            isolation=isolation,
            base_image=SANDBOX_IMAGE,
            node_version=NODE_VERSION,
            ttl=TTL,
        )

    if BACKEND == "e2b":
        from agentscope.app.workspace_manager import E2BWorkspaceManager

        # api_key="" -> the manager reads E2B_API_KEY from the environment.
        # Never hardcode it: it must be rotatable and must not be committed.
        return E2BWorkspaceManager(
            isolation=isolation,
            template=os.getenv("E2B_TEMPLATE", "base"),
            api_key="",
            timeout_seconds=int(os.getenv("E2B_TIMEOUT_SECONDS", "300")),
            ttl=TTL,
        )

    if BACKEND == "daytona":
        from agentscope.app.workspace_manager import DaytonaWorkspaceManager

        return DaytonaWorkspaceManager(isolation=isolation, ttl=TTL)

    if BACKEND == "opensandbox":
        from agentscope.app.workspace_manager import OpenSandboxWorkspaceManager

        return OpenSandboxWorkspaceManager(isolation=isolation, ttl=TTL)

    if BACKEND == "k8s":
        from agentscope.app.workspace_manager import K8sWorkspaceManager

        return K8sWorkspaceManager(
            isolation=isolation,
            base_image=SANDBOX_IMAGE,
            ttl=TTL,
        )

    raise ValueError(
        f"AGENTSCOPE_WORKSPACE_BACKEND={BACKEND!r} is not recognised. Valid: "
        "local, bubblewrap, apple, docker, e2b, daytona, opensandbox, k8s",
    )


def describe() -> str:
    note = " (single-node)" if BACKEND in _SINGLE_NODE else " (distributed)"
    unsafe = " unsafe-local=explicit" if BACKEND == "local" else ""
    return f"backend={BACKEND}{note} isolation={ISOLATION} ttl={TTL:g}s{unsafe}"
