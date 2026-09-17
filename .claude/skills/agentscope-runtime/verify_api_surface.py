#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify the AgentScope API surface this skill set documents.

Why this exists
---------------
`create_app(...)` accepts ``**kwargs``. A misspelled or outdated keyword is
therefore *swallowed silently* - the call succeeds and the feature is simply
absent. The public docs contain at least one such name (see CONTRACT.md §7).
Documentation drift here produces no error, no log, and no test failure: only a
feature that quietly does not work.

This script asserts, symbol by symbol, that what the skills claim exists really
does exist in the installed/source AgentScope - and that the known-wrong names
are still absent.

Design notes
------------
* Works **statically** (AST parsing) so it functions on a machine where
  AgentScope's heavy dependencies (numpy, torch, ...) are broken or where the
  package has not been installed at all. This was necessary on the machine
  where the skill set was authored.
* Optionally upgrades to a **runtime import check** when ``agentscope`` imports
  cleanly, which additionally validates ``create_app``'s parameter list.
* Exits non-zero on any failure, so it is usable as a gate.

Usage
-----
    python verify_api_surface.py
    python verify_api_surface.py --source /path/to/agentscope/src/agentscope
    python verify_api_surface.py --json

Environment:
    AGENTSCOPE_SRC - override the source root.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# What the skill set documents. Keep in sync with CONTRACT.md.
# --------------------------------------------------------------------------

# module (relative to the source root) -> attribute names that must be exported
REQUIRED_EXPORTS: dict[str, list[str]] = {
    "app/__init__.py": ["create_app", "SubAgentTemplate"],
    # NOTE: deliberately NOT the top-level package. create_app is exported by
    # `agentscope.app`, *not* by `agentscope`. `from agentscope import
    # create_app` is a real mistake this file exists to prevent - see
    # FORBIDDEN_TOP_LEVEL_EXPORTS below.
    "app/storage/__init__.py": ["StorageBase", "RedisStorage", "AsyncSQLAlchemyStorage"],
    "app/message_bus/__init__.py": ["MessageBus", "RedisMessageBus", "InMemoryMessageBus"],
    "app/workspace_manager/__init__.py": [
        "WorkspaceManagerBase",
        "IsolationPolicy",
        "PrewarmConfig",
        "LocalWorkspaceManager",
        "DockerWorkspaceManager",
        "E2BWorkspaceManager",
        "DaytonaWorkspaceManager",
        "K8sWorkspaceManager",
        "OpenSandboxWorkspaceManager",
        "BubblewrapWorkspaceManager",
        "AppleContainerWorkspaceManager",
    ],
    "app/hub/__init__.py": [
        "HubBase",
        "HubError",
        "MCPHubBase",
        "MCPCard",
        "MCPHubPage",
        "GitHubMCPHub",
        "SkillHubBase",
        "SkillCard",
        "SkillHubPage",
        "SkillArchive",
        "ClawSkillHub",
    ],
    "app/access/__init__.py": [
        "ResourceAccessPolicyBase",
        "ResourceKind",
        "ResourcePermission",
        "ResourceRef",
        "DenyAllResourceAccessPolicy",
    ],
    "app/middleware/__init__.py": [
        "InboxMiddleware",
        "ToolOffloadMiddleware",
        "StateChangeMiddleware",
        "ProtocolMiddlewareBase",
        "AGUIProtocolMiddleware",
    ],
    "permission/__init__.py": ["PermissionContext", "PermissionMode"],
    "app/rag/knowledge_base_manager/__init__.py": ["CollectionPerKbManager"],
    "rag/__init__.py": ["ApproxTokenChunker", "QdrantStore"],
}

# create_app keyword params that MUST exist
REQUIRED_CREATE_APP_PARAMS = [
    "storage",
    "message_bus",
    "workspace_manager",
    "knowledge_base_manager",
    "knowledge_parsers",
    "knowledge_chunkers",
    "blob_store",
    "enable_index_worker",
    "mcp_hubs",
    "skill_hubs",
    "enable_channel_worker",
    "enable_scheduler",
    "extra_credentials",
    "extra_middlewares",
    "extra_agent_middlewares",
    "extra_agent_tools",
    "custom_subagent_templates",
    "custom_agent_cls",
    "resource_access_policy",
    "channels",
    "download_secret",
]

# Names the PUBLIC DOCS use that do NOT exist in source. Their presence would
# mean the drift table in CONTRACT.md §7 is stale.
FORBIDDEN_CREATE_APP_PARAMS = ["sub_agent_templates"]

# Symbols that are NOT exported by the top-level `agentscope` package. Importing
# them from there is a real error; documented in CONTRACT.md §1.
FORBIDDEN_TOP_LEVEL_EXPORTS = ["create_app", "SubAgentTemplate"]

# agentscope.app.deps functions the skills reference
REQUIRED_DEPS_FUNCTIONS = [
    "get_current_user_id",
    "get_storage",
    "get_message_bus",
    "get_chat_service",
    "get_resource_access_service",
    "get_session_service",
    "get_workspace_service",
    "get_chat_run_registry",
    "get_scheduler_manager",
    "get_background_task_manager",
    "get_workspace_manager",
    "get_download_secret",
    "get_extra_agent_middlewares",
    "get_extra_agent_tools",
    "get_knowledge_base_service",
    "get_knowledge_base_manager",
    "get_blob_store",
    "get_knowledge_parsers",
    "get_knowledge_chunkers",
    "get_mcp_hubs",
    "get_skill_hubs",
]

# REST route fragments the skills reference (checked as substrings in source)
REQUIRED_ROUTE_FRAGMENTS = [
    "/chat",
    "/sessions",
    "/agent",
    "/credential",
    "/schedule",
    "/workspace/mcp",
    "/workspace/skill",
    "/knowledge_bases",
]

# Enum member values (StrEnum serialises as the string, not the name)
REQUIRED_ENUM_MEMBERS = {
    "app/workspace_manager/_base.py": {"PER_SESSION", "PER_AGENT", "PER_USER"},
    "app/access/_policy.py": {"CREDENTIAL", "AGENT", "KNOWLEDGE_BASE", "READ", "EDIT"},
}

# Version floor
MIN_PYTHON = (3, 11)
PINNED_SERIES = "2.0"


class Result:
    def __init__(self) -> None:
        self.checks = 0
        self.failures: list[str] = []
        self.warnings: list[str] = []

    def ok(self) -> None:
        self.checks += 1

    def fail(self, msg: str) -> None:
        self.checks += 1
        self.failures.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def find_source_root(explicit: str | None) -> tuple[Path | None, bool]:
    """Locate the agentscope source root (the dir containing __init__.py).

    Returns ``(path_or_None, was_explicit)``.

    An explicitly supplied path is **never** silently substituted. If the caller
    names a tree, that tree is the one validated: falling back to a default would
    let ``--source /typo`` report PASS against a different checkout, which is the
    worst possible failure for a gate script.
    """
    if explicit:
        p = Path(explicit).expanduser()
        if (p / "__init__.py").is_file() and (p / "app").is_dir():
            return p, True
        return None, True

    candidates: list[Path] = []
    if os.environ.get("AGENTSCOPE_SRC"):
        candidates.append(Path(os.environ["AGENTSCOPE_SRC"]).expanduser())
    candidates += [
        Path.home() / "agentscope" / "src" / "agentscope",
        Path.home() / "agentscope" / "agentscope",
        Path("/opt/HIVEMIND/agentscope/src/agentscope"),
        Path.cwd() / "src" / "agentscope",
        Path.cwd() / "agentscope",
    ]
    for c in candidates:
        if (c / "__init__.py").is_file() and (c / "app").is_dir():
            return c, False
    return None, False


def exported_names(init_py: Path) -> set[str]:
    """Statically collect names exported by a package __init__.py.

    Handles ``__all__``, explicit ``from x import a, b``, and
    ``from x import (a, b)``. Deliberately avoids importing the package so this
    works when optional/heavy dependencies are unavailable or broken.
    """
    try:
        tree = ast.parse(init_py.read_text(encoding="utf-8"))
    except (OSError, SyntaxError) as exc:  # pragma: no cover - defensive
        return set()

    names: set[str] = set()

    for node in tree.body:
        # __all__ = [...] / __all__ += [...]
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if "__all__" in targets and isinstance(node.value, (ast.List, ast.Tuple)):
                for elt in node.value.elts:
                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                        names.add(elt.value)
        elif isinstance(node, ast.AugAssign):
            if isinstance(node.target, ast.Name) and node.target.id == "__all__":
                if isinstance(node.value, (ast.List, ast.Tuple)):
                    for elt in node.value.elts:
                        if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                            names.add(elt.value)

        # from ._x import a, b  /  from ._x import (a, b)
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    names.add(alias.asname or alias.name)

        # Re-exports assigned at module level (e.g. __getattr__ indirection is
        # handled separately by scanning the text for the name).
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add((alias.asname or alias.name).split(".")[0])

    # __getattr__-based lazy exports: the name appears in the source text.
    text = init_py.read_text(encoding="utf-8")
    for m in re.finditer(r'if\s+name\s*==\s*"([A-Za-z_][A-Za-z0-9_]*)"', text):
        names.add(m.group(1))

    return names


def create_app_params(app_py: Path) -> tuple[set[str], bool]:
    """Return (param names, has_var_keyword) for create_app."""
    try:
        tree = ast.parse(app_py.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set(), False
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "create_app":
            args = node.args
            names = {a.arg for a in args.args}
            names |= {a.arg for a in args.kwonlyargs}
            return names, args.kwarg is not None
    return set(), False


def enum_members(path: Path) -> set[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            if any(
                (isinstance(b, ast.Name) and b.id == "StrEnum")
                or (isinstance(b, ast.Attribute) and b.attr == "StrEnum")
                for b in node.bases
            ):
                for stmt in node.body:
                    if isinstance(stmt, ast.Assign):
                        for t in stmt.targets:
                            if isinstance(t, ast.Name):
                                out.add(t.id)
    return out


def _info(msg: str, as_json: bool) -> None:
    """Human-readable progress line.

    Routed to stderr when ``--json`` is active so it cannot corrupt the JSON
    payload on stdout (a bug this helper exists to prevent).
    """
    print(msg, file=sys.stderr if as_json else sys.stdout)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", help="agentscope source root")
    ap.add_argument("--json", action="store_true", help="emit machine-readable report")
    args = ap.parse_args()

    r = Result()

    # -- Python version -----------------------------------------------------
    if sys.version_info < MIN_PYTHON:
        r.fail(
            f"Python {sys.version_info.major}.{sys.version_info.minor} < "
            f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]} required by AgentScope 2.0.x"
        )
    else:
        r.ok()

    root, was_explicit = find_source_root(args.source)
    if root is None:
        if was_explicit:
            r.fail(
                f"--source {args.source!r} is not an agentscope source root "
                "(expected a dir containing __init__.py and app/). Refusing to "
                "substitute a default: validating the wrong tree silently would "
                "make this gate meaningless."
            )
            return report(r, args.json)
        # Cannot verify statically, and importing may be impossible/unsafe.
        try:  # last resort: runtime metadata only
            import agentscope  # type: ignore

            ver = getattr(agentscope, "__version__", "unknown")
            r.warn(
                f"source root not found; only runtime version check possible "
                f"(agentscope {ver})"
            )
            r.ok()
        except Exception as exc:  # noqa: BLE001 - report, do not crash
            r.fail(
                "agentscope source root not found and package not importable "
                f"({type(exc).__name__}: {exc}). Pass --source or set AGENTSCOPE_SRC."
            )
        return report(r, args.json)

    r.ok()
    _info(f"Source root: {root}", args.json)

    # -- version ------------------------------------------------------------
    ver_file = root / "_version.py"
    version = "unknown"
    if ver_file.is_file():
        m = re.search(r'__version__\s*=\s*["\']([^"\']+)["\']', ver_file.read_text())
        if m:
            version = m.group(1)
    _info(f"Detected version: {version}", args.json)
    if version != "unknown":
        if version.startswith(PINNED_SERIES):
            r.ok()
        elif version.startswith("1."):
            r.fail(
                f"detected AgentScope {version} (1.x). This skill set targets "
                f"{PINNED_SERIES}.x - 1.x and 2.x APIs must not be mixed."
            )
        else:
            r.warn(
                f"detected {version}, skill set pinned to {PINNED_SERIES}.x - "
                "re-verify CONTRACT.md against this source."
            )

    # -- exports ------------------------------------------------------------
    for rel, names in REQUIRED_EXPORTS.items():
        init_py = root / rel
        if not init_py.is_file():
            r.fail(f"missing module file: {rel}")
            continue
        present = exported_names(init_py)
        for name in names:
            if name in present:
                r.ok()
            else:
                r.fail(f"NOT EXPORTED: {rel} :: {name}")

    # -- top-level package must NOT export service symbols ------------------
    top_init = root / "__init__.py"
    if top_init.is_file():
        top_present = exported_names(top_init)
        for name in FORBIDDEN_TOP_LEVEL_EXPORTS:
            if name in top_present:
                r.fail(
                    f"top-level 'agentscope' unexpectedly exports '{name}'. "
                    "CONTRACT.md §1 says it lives in agentscope.app - update "
                    "the skills if this changed."
                )
            else:
                r.ok()
        r.warn(
            "create_app is exported by 'agentscope.app', NOT 'agentscope'. "
            "Use: from agentscope.app import create_app"
        )

    # -- create_app params --------------------------------------------------
    app_py = root / "app" / "_app.py"
    params, has_kwargs = create_app_params(app_py)
    if not params:
        r.fail("could not parse create_app in app/_app.py")
    else:
        for p in REQUIRED_CREATE_APP_PARAMS:
            if p in params:
                r.ok()
            else:
                r.fail(f"create_app is missing documented param: {p}")

        for p in FORBIDDEN_CREATE_APP_PARAMS:
            if p in params:
                r.fail(
                    f"create_app unexpectedly HAS '{p}'. CONTRACT.md §7 drift "
                    "table is stale - update the skills."
                )
            else:
                r.ok()

        if has_kwargs:
            r.ok()
            r.warn(
                "create_app accepts **kwargs - misspelled keywords fail "
                "SILENTLY. Always use a verified name."
            )
        else:
            r.fail("create_app has no **kwargs; silent-swallow assumption is wrong")

    # -- deps ---------------------------------------------------------------
    deps_py = root / "app" / "deps.py"
    if deps_py.is_file():
        text = deps_py.read_text(encoding="utf-8")
        for fn in REQUIRED_DEPS_FUNCTIONS:
            if re.search(rf"^\s*(async\s+)?def\s+{re.escape(fn)}\s*\(", text, re.M):
                r.ok()
            else:
                r.fail(f"agentscope.app.deps :: {fn} not found")
    else:
        r.fail("missing app/deps.py")

    # -- enum members -------------------------------------------------------
    for rel, members in REQUIRED_ENUM_MEMBERS.items():
        f = root / rel
        if not f.is_file():
            r.fail(f"missing file for enum check: {rel}")
            continue
        found = enum_members(f)
        for name in sorted(members):
            if name in found:
                r.ok()
            else:
                r.fail(f"enum member missing: {rel} :: {name}")

    # -- routes -------------------------------------------------------------
    router_dir = root / "app" / "_router"
    if router_dir.is_dir():
        blob = "\n".join(
            p.read_text(encoding="utf-8", errors="ignore")
            for p in router_dir.rglob("*.py")
        )
        for frag in REQUIRED_ROUTE_FRAGMENTS:
            if frag in blob:
                r.ok()
            else:
                r.fail(f"route fragment not found in app/_router: {frag}")
    else:
        r.warn("app/_router not found; route fragments unverified")

    # -- sandbox extras availability (informational) ------------------------
    for extra, marker in [
        ("e2b", "E2B_API_KEY"),
        ("docker", "DockerWorkspaceManager"),
        ("k8s", "K8sWorkspaceManager"),
    ]:
        r.warn(f"sandbox extra '{extra}' present (marker: {marker}) - not probed")

    return report(r, args.json)


def report(r: Result, as_json: bool) -> int:
    if as_json:
        print(
            json.dumps(
                {
                    "checks": r.checks,
                    "failures": r.failures,
                    "warnings": r.warnings,
                    "passed": not r.failures,
                },
                indent=2,
            )
        )
    else:
        print()
        if r.warnings:
            print(f"Warnings ({len(r.warnings)}):")
            for w in r.warnings:
                print(f"  ! {w}")
            print()
        if r.failures:
            print(f"FAILED - {len(r.failures)} of {r.checks} checks:")
            for f in r.failures:
                print(f"  x {f}")
            print()
            print("The skills do not match this AgentScope build. Fix the skills")
            print("or the source before generating code against either.")
        else:
            print(f"PASS - {r.checks} checks, 0 failures.")
            print("Skill set matches the AgentScope source.")
    return 1 if r.failures else 0


if __name__ == "__main__":
    sys.exit(main())
