"""Campaign-only, read-only access to the vendored Claude Ads method library."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_-]+", re.I)
_DESCRIPTION_RE = re.compile(r'^description:\s*["\']?(.*?)["\']?\s*$', re.M)
_HEADING_RE = re.compile(r"^#\s+(.+)$", re.M)
_ALLOWED_PATTERNS = (
    "ads/SKILL.md",
    "skills/*/SKILL.md",
    "agents/*.md",
    "ads/references/*.md",
    "control-plane/*.md",
)
_ROLE_LIMIT = 2
_RUN_LIMIT = 8
_BODY_LIMIT = 4500


@dataclass(frozen=True)
class ClaudeAdsResource:
    name: str
    description: str
    path: Path


def _root() -> Path:
    return Path(os.getenv("CLAUDE_ADS_RESOURCE_ROOT", "/opt/hivemind-resources/claude-ads")).resolve()


@lru_cache(maxsize=4)
def _catalog(root_value: str) -> tuple[ClaudeAdsResource, ...]:
    root = Path(root_value).resolve()
    if not root.is_dir():
        return ()
    resources: list[ClaudeAdsResource] = []
    seen: set[str] = set()
    for pattern in _ALLOWED_PATTERNS:
        for path in sorted(root.glob(pattern)):
            resolved = path.resolve()
            if root not in resolved.parents or not resolved.is_file():
                continue
            name = resolved.relative_to(root).as_posix()
            if name in seen:
                continue
            text = resolved.read_text(encoding="utf-8", errors="replace")[:2200]
            match = _DESCRIPTION_RE.search(text)
            heading = _HEADING_RE.search(text)
            description = (match.group(1) if match else heading.group(1) if heading else name).strip()
            resources.append(ClaudeAdsResource(name=name, description=description[:260], path=resolved))
            seen.add(name)
    return tuple(resources)


def available() -> bool:
    return bool(_catalog(str(_root())))


def search(query: str, *, limit: int = 2) -> list[ClaudeAdsResource]:
    """Search metadata only; method bodies stay out of the Director prompt."""
    terms = {token.lower() for token in _TOKEN_RE.findall(str(query or "")) if len(token) > 2}
    if not terms:
        return []
    scored: list[tuple[int, ClaudeAdsResource]] = []
    for resource in _catalog(str(_root())):
        path_words = resource.name.lower().replace("/", " ").replace("-", " ")
        description = resource.description.lower()
        score = sum(5 for term in terms if term in path_words) + sum(2 for term in terms if term in description)
        if score:
            scored.append((score, resource))
    scored.sort(key=lambda row: (-row[0], row[1].name))
    return [resource for _, resource in scored[: max(1, min(_ROLE_LIMIT, limit))]]


def load_assignments(assignments: Any) -> list[dict[str, str]]:
    """Resolve Director assignments into bounded, allowlisted method bodies."""
    loaded: list[dict[str, str]] = []
    seen: set[str] = set()
    rows = assignments if isinstance(assignments, list) else []
    for assignment in rows[:4]:
        if not isinstance(assignment, dict):
            continue
        role = str(assignment.get("role") or "Specialist").strip()[:40]
        task = str(assignment.get("task") or "").strip()[:240]
        query = str(assignment.get("query") or task).strip()[:240]
        for resource in search(query, limit=_ROLE_LIMIT):
            if resource.name in seen or len(loaded) >= _RUN_LIMIT:
                continue
            body = resource.path.read_text(encoding="utf-8", errors="replace")[:_BODY_LIMIT]
            loaded.append({
                "role": role,
                "task": task,
                "resource": resource.name,
                "description": resource.description,
                "body": body,
            })
            seen.add(resource.name)
    return loaded
