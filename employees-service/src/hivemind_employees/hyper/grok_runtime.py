"""Contracts for the cumulative Grok-style HyperAgents runtime.

This module is deliberately domain neutral.  It builds compact manifests from
the employees already hired into a Room and selects real participants by the
owner lanes emitted by the versioned Director plan.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, Iterable, List

RUNTIME_MODES = (
    "off", "shadow_roster", "persistent_agents", "durable_assignments",
    "real_tools", "collaboration", "browser", "skills", "routines", "full",
)
_RANK = {value: index for index, value in enumerate(RUNTIME_MODES)}

_CAPABILITY_GROUPS = {
    "research": {"research", "researcher", "investigation", "investigator", "market-research"},
    "review": {"review", "reviewer", "verification", "verifier", "skeptic"},
    "strategy": {"strategy", "strategist", "planning", "planner", "lead"},
    "communication": {"communication", "communicator", "writer", "editor"},
    "browser": {"browser", "web", "web-research", "browser-operator"},
}


def canonical_capabilities(*values: Any) -> set[str]:
    """Return domain-neutral routing capabilities from declared metadata.

    Compound role labels (for example ``Customer & Market Researcher``) must
    satisfy a narrower Director lane without task-text keyword routing.  The
    registry is deliberately small and describes reusable abilities, not
    companies, departments, playbooks, or requested deliverables.
    """
    tokens: set[str] = set()
    for value in values:
        if isinstance(value, (list, tuple, set)):
            tokens.update(canonical_capabilities(*value))
            continue
        text = str(value or "").strip().lower()
        if not text:
            continue
        normalized = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
        tokens.add(normalized)
        tokens.update(part for part in normalized.split("-") if part)
    expanded = set(tokens)
    for canonical, aliases in _CAPABILITY_GROUPS.items():
        if tokens.intersection(aliases):
            expanded.add(canonical)
            expanded.update(aliases)
    return expanded


def normalize_runtime_mode(value: Any) -> str:
    mode = str(value or "off").strip().lower()
    return mode if mode in _RANK else "off"


def mode_at_least(value: Any, required: str) -> bool:
    return _RANK[normalize_runtime_mode(value)] >= _RANK[required]


def agent_instance_id(org_id: str, employee_id: str, version: int = 1) -> str:
    digest = hashlib.sha256(f"{org_id}:{employee_id}:v{version}".encode()).hexdigest()[:32]
    return f"ha-{digest}-v{version}"


def capability_manifest(employee: Dict[str, Any], org_id: str, version: int = 1) -> Dict[str, Any]:
    """Return only routing metadata; never send persona text or credentials."""
    declared = canonical_capabilities(
        employee.get("_lane"), employee.get("lane"), employee.get("role_archetype"),
        employee.get("capabilities"), employee.get("skills"), employee.get("tools"),
    )
    return {
        "employee_id": str(employee.get("id") or ""),
        "agent_instance_id": agent_instance_id(org_id, str(employee.get("id") or ""), version),
        "slug": str(employee.get("slug") or ""),
        "name": str(employee.get("name") or employee.get("slug") or "Agent"),
        "lane": str(employee.get("_lane") or employee.get("role_archetype") or "Communicator"),
        "tools": sorted({str(item) for item in (employee.get("tools") or []) if str(item)}),
        "connectors": sorted({str(item) for item in (employee.get("enabled_connectors") or []) if str(item)}),
        "capabilities": sorted(declared),
        "status": str(employee.get("status") or "draft"),
        "processing_version": version,
    }


def build_roster_manifest(participants: Iterable[Dict[str, Any]], org_id: str, version: int = 1) -> List[Dict[str, Any]]:
    return [capability_manifest(employee, org_id, version) for employee in participants]


def select_active_agents(
    participants: List[Dict[str, Any]],
    planned_orders: Iterable[Dict[str, Any]],
    lead_id: str = "",
    *,
    maximum: int = 3,
) -> List[Dict[str, Any]]:
    """Select the smallest real roster subset required by a structured plan.

    No task-text or domain keyword routing is allowed here.  The Director's
    declared owner lanes are matched to actual Room participants.
    """
    if not participants:
        return []
    selected: List[Dict[str, Any]] = []

    def add(employee: Dict[str, Any]) -> None:
        if employee and all(str(row.get("id")) != str(employee.get("id")) for row in selected):
            selected.append(employee)

    lead = next((p for p in participants if str(p.get("id")) == str(lead_id)), participants[0])
    add(lead)
    for order in planned_orders:
        wanted = canonical_capabilities(order.get("owner_lane"), order.get("required_capabilities"))
        if not wanted:
            continue
        owner = next((p for p in participants if wanted.intersection(canonical_capabilities(
            p.get("_lane"), p.get("lane"), p.get("role_archetype"),
            p.get("capabilities"), p.get("skills"), p.get("tools"),
        ))), None)
        if owner:
            add(owner)
        if len(selected) >= max(1, maximum):
            break
    return selected
