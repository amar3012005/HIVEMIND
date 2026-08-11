"""Artifact governance owned by the Outreach Intelligence domain."""

from __future__ import annotations

from typing import Any


def lifecycle_checks(
    request: dict[str, Any],
    *,
    discovered: int,
    persisted: int,
    drafted: int,
    proposed_actions: int,
) -> list[dict[str, Any]]:
    """Validate the Room-owned lifecycle without inventing an HQ quota."""
    raw_requested = request.get("requested_count")
    minimum = max(1, int(raw_requested)) if raw_requested is not None else 1
    explicit = raw_requested is not None
    observed = {
        "discover": max(0, int(discovered)),
        "persist": max(0, int(persisted)),
        "draft": max(0, int(drafted)),
    }
    checks = []
    for phase, count in observed.items():
        if request.get(phase) is not True:
            continue
        checks.append({
            "criterion": f"outreach:{phase}",
            "type": "domain_artifact",
            "expected": (f"explicit minimum={minimum}" if explicit else "at least one verified result"),
            "observed": f"count={count}",
            "passed": count >= minimum,
        })
    if request.get("deliver") is True:
        checks.append({
            "criterion": "outreach:authority_handoff",
            "type": "authority_handoff",
            "expected": "at least one authority-gated proposed action",
            "observed": f"count={max(0, int(proposed_actions))}",
            "passed": proposed_actions > 0,
        })
    return checks
