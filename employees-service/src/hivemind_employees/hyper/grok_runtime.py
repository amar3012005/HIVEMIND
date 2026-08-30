"""Contracts for the cumulative Grok-style HyperAgents runtime.

This module is deliberately domain neutral.  It builds compact manifests from
the employees already hired into a Room and selects real participants by the
owner lanes emitted by the versioned Director plan.
"""
from __future__ import annotations

import hashlib
from typing import Any, Dict, Iterable, List

RUNTIME_MODES = (
    "off", "shadow_roster", "persistent_agents", "durable_assignments",
    "real_tools", "collaboration", "browser", "skills", "routines", "full",
)
_RANK = {value: index for index, value in enumerate(RUNTIME_MODES)}


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
    return {
        "employee_id": str(employee.get("id") or ""),
        "agent_instance_id": agent_instance_id(org_id, str(employee.get("id") or ""), version),
        "slug": str(employee.get("slug") or ""),
        "name": str(employee.get("name") or employee.get("slug") or "Agent"),
        "lane": str(employee.get("_lane") or employee.get("role_archetype") or "Communicator"),
        "tools": sorted({str(item) for item in (employee.get("tools") or []) if str(item)}),
        "connectors": sorted({str(item) for item in (employee.get("enabled_connectors") or []) if str(item)}),
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
    aliases = {"researcher": "investigator", "investigator": "researcher"}
    for order in planned_orders:
        wanted = str(order.get("owner_lane") or "").strip().lower()
        if not wanted:
            continue
        owner = next((
            p for p in participants
            if (actual := str(p.get("_lane") or p.get("role_archetype") or "").lower()) == wanted
            or aliases.get(actual) == wanted or aliases.get(wanted) == actual
        ), None)
        if owner:
            add(owner)
        if len(selected) >= max(1, maximum):
            break
    return selected
