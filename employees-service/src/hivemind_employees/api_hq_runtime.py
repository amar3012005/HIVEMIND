"""Bounded specialist execution for the durable HQ runtime.

This is deliberately separate from the human HyperAgents Room pipeline. One
request claims one persisted HQ Work Order, invokes one assigned employee with
read/prepare tools, stores one immutable result, and returns. It never debates,
publishes, spends, or creates a synthetic user turn.
"""
from __future__ import annotations

import json
import logging
import re
from urllib.parse import urlparse
from typing import Any, Dict, Optional

from agentscope.message import Msg
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from .agents.agentscope_factory import build_react_agent
from .bootstrap_client import fetch_bootstrap
from .config import get_settings
from .db import (
    complete_hyper_work_order,
    get_hq_work_order,
    list_employees_by_ids,
    resolve_hq_evidence,
    start_hyper_work_order,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/hq", tags=["hq-runtime"])


class HqWorkOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    work_order_id: str
    org_id: str


class HqWorkOrderResponse(BaseModel):
    ok: bool
    status: str
    work_order_id: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


def _require_master_key(token: Optional[str]) -> None:
    expected = get_settings().hivemind_master_api_key
    if not expected:
        raise HTTPException(503, "service not configured (master key missing)")
    if token != expected:
        raise HTTPException(401, "Invalid admin token")


def _message_text(reply: Any) -> str:
    content = getattr(reply, "content", "") if reply is not None else ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                value = block.get("text") or block.get("content")
                if value:
                    parts.append(str(value))
            elif block is not None:
                parts.append(str(block))
        return "\n".join(parts).strip()
    return str(content or "").strip()


def _json_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def _identity_tokens(company: Any) -> tuple[str, str]:
    value = company if isinstance(company, dict) else {}
    name = str(value.get("name") or value.get("company_name") or value.get("title") or "")
    website = str(value.get("website") or value.get("website_url") or value.get("url") or "")
    normalized = re.sub(r"[^a-z0-9]+", "", name.lower())
    try:
        domain = urlparse(website if "://" in website else f"https://{website}").hostname or ""
        domain = domain.lower().removeprefix("www.")
    except Exception:
        domain = ""
    return normalized, domain


def _evidence_identity(snapshot: Dict[str, Any]) -> tuple[str, str]:
    payload = snapshot.get("payload") if isinstance(snapshot.get("payload"), dict) else {}
    return _identity_tokens(payload.get("company"))


def _identity_mismatch(room_company: Any, snapshots: list[Dict[str, Any]]) -> Optional[str]:
    room_name, room_domain = _identity_tokens(room_company)
    if not room_name and not room_domain:
        return None
    for snapshot in snapshots:
        evidence_name, evidence_domain = _evidence_identity(snapshot)
        name_conflict = bool(room_name and evidence_name and room_name != evidence_name)
        domain_conflict = bool(room_domain and evidence_domain and room_domain != evidence_domain)
        if domain_conflict or (name_conflict and not room_domain):
            return (
                f"Company identity mismatch: Company Room resolves to "
                f"{room_domain or room_name}, but evidence {snapshot.get('id')} resolves to "
                f"{evidence_domain or evidence_name}. A fresh tenant baseline is required."
            )
    return None


@router.post("/work-order/execute", response_model=HqWorkOrderResponse)
async def execute_hq_work_order(
    req: HqWorkOrderRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> HqWorkOrderResponse:
    _require_master_key(x_api_key)
    order = await get_hq_work_order(req.work_order_id, req.org_id)
    if not order:
        raise HTTPException(404, "HQ Work Order not found")
    if order.get("status") in {"completed", "failed", "blocked"}:
        return HqWorkOrderResponse(ok=order.get("status") == "completed", status=order["status"], work_order_id=req.work_order_id)
    if not await start_hyper_work_order(req.work_order_id, req.org_id):
        return HqWorkOrderResponse(ok=False, status="already_claimed", work_order_id=req.work_order_id)

    employee_ids = []
    if order.get("owner_employee_id"):
        employee_ids.append(order["owner_employee_id"])
    employee_ids.extend(value for value in order.get("participant_ids", []) if value not in employee_ids)
    employees = await list_employees_by_ids(employee_ids, org_id=req.org_id)
    if not employees:
        error = "No active specialist is assigned to this Company Room."
        await complete_hyper_work_order(work_order_id=req.work_order_id, org_id=req.org_id, status="blocked", summary=error, output={}, evidence=[], artifacts=[], usage={}, error=error)
        return HqWorkOrderResponse(ok=False, status="blocked", work_order_id=req.work_order_id, error=error)

    by_id = {str(row.get("id")): row for row in employees}
    employee = by_id.get(str(order.get("owner_employee_id"))) or employees[0]
    bootstrap = {str(row.get("id")): row for row in await fetch_bootstrap()}
    boot = bootstrap.get(str(employee.get("id")), {})
    api_key = boot.get("api_key")
    # Legacy/draft employees may predate scoped API-key minting. The existing
    # Room runtime uses an empty key plus explicit user/org emulation headers;
    # preserve that tenant-safe behavior so HQ can delegate to the same agents.
    api_key = api_key or ""

    skills = _json_list(order.get("selected_skills"))
    evidence = _json_list(order.get("required_evidence"))
    criteria = _json_list(order.get("acceptance_criteria"))
    evidence_snapshots = await resolve_hq_evidence(req.org_id, [str(value) for value in evidence])
    identity_error = _identity_mismatch(order.get("room_company"), evidence_snapshots)
    if identity_error:
        await complete_hyper_work_order(
            work_order_id=req.work_order_id, org_id=req.org_id, status="blocked",
            summary=identity_error, output={"code": "company_identity_mismatch"},
            evidence=evidence, artifacts=[], usage={}, error=identity_error,
        )
        return HqWorkOrderResponse(
            ok=False, status="blocked", work_order_id=req.work_order_id,
            result={"code": "company_identity_mismatch"}, error=identity_error,
        )
    merged = {
        **employee,
        "hyper": boot.get("hyper"),
        "active_prompt_version": boot.get("active_prompt_version"),
        "evo_playbook": boot.get("evo_playbook") or [],
        "connectors": [],
        "connectors_read_only": True,
        "tools": [
            "hivemind_recall", "hivemind_list_memories", "hivemind_get_memory",
            "hivemind_traverse_graph", "hivemind_at", "hivemind_list_projects",
        ],
        "max_iters": 12,
    }
    agent = build_react_agent(
        merged, api_key, user_id=order.get("owner_user_id"), org_id=req.org_id,
    )
    prompt = f"""HQ SPECIALIST WORK ORDER
Title: {order.get('title')}
Objective: {order.get('objective')}
Company Room: {order.get('room_tag')}
Room mandate: {order.get('room_goal') or 'Complete the assigned specialist result.'}
Selected methods: {', '.join(str(v) for v in skills) or 'use your specialist judgment'}
Required evidence references: {', '.join(str(v) for v in evidence) or 'use current company memory'}
Resolved immutable evidence snapshots:
{json.dumps(evidence_snapshots, ensure_ascii=False)[:18000] if evidence_snapshots else 'No artifact snapshot resolved; use current company memory and mark this gap.'}
Acceptance criteria:
{chr(10).join('- ' + str(v) for v in criteria) or '- Return a concrete, evidence-grounded result.'}

Complete only this bounded assignment. The source references above are artifact
IDs, not Memory IDs; do not call get_memory with them. Use the resolved snapshots
first, then call recall only for a specific remaining evidence gap.
Do not publish, send, spend, mutate external systems, or invent measurements.
Return a compact result packet with headings: RESULT, EVIDENCE, ARTIFACTS,
METRICS, BLOCKERS, RECOMMENDATION. Explicitly mark unknowns.
"""
    try:
        reply = await agent(Msg(name="hq", content=prompt, role="user"))
        text = _message_text(reply)
        if not text:
            raise RuntimeError("specialist returned no usable result")
        usage = getattr(reply, "usage", None) or (getattr(reply, "metadata", None) or {}).get("usage") or {}
        packet = {
            "text": text,
            "owner_employee_id": str(employee.get("id")),
            "owner_slug": employee.get("slug"),
            "skills": skills,
            "tool_calls": int(getattr(agent, "tool_call_count", 0)),
        }
        await complete_hyper_work_order(
            work_order_id=req.work_order_id, org_id=req.org_id, status="completed",
            summary=text[:1200], output=packet, evidence=evidence, artifacts=[], usage=usage if isinstance(usage, dict) else {},
        )
        return HqWorkOrderResponse(ok=True, status="completed", work_order_id=req.work_order_id, result=packet)
    except Exception as exc:
        error = str(exc)[:1000]
        log.exception("HQ specialist Work Order failed: %s", error)
        await complete_hyper_work_order(
            work_order_id=req.work_order_id, org_id=req.org_id, status="failed",
            summary=error, output={}, evidence=evidence, artifacts=[], usage={}, error=error,
        )
        return HqWorkOrderResponse(ok=False, status="failed", work_order_id=req.work_order_id, error=error)
