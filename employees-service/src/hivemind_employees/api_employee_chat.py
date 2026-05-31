"""One-on-one chat with a Digital Employee.

`POST /v1/employees/{slug}/chat` runs a single ReAct turn against one
employee, scoped to a stable conversation_id so multiple turns share
memory. Used by the Playground UI in DigitalEmployees to let humans
talk directly with an agent outside the multi-employee TeamRoom flow.

Conversation memory is in-process (kept alive between turns inside the
sidecar) so the same conversation_id can carry over many turns. When
the sidecar restarts the conversation resets — acceptable for now;
later we can back this with Redis or the InMemoryMemory dump.
"""
from __future__ import annotations

import logging
from typing import Dict, Optional

from agentscope.agent import ReActAgent
from agentscope.message import Msg
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .agents.agentscope_factory import build_react_agent
from .bootstrap_client import fetch_bootstrap, fetch_employee_profile
from .config import get_settings
from .db import list_running_employees

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/employees", tags=["employee-chat"])


class ChatRequest(BaseModel):
    text: str = Field(..., min_length=1, description="User message")
    conversation_id: Optional[str] = Field(
        None,
        description="Stable id to carry agent memory across turns. Omit to start a fresh thread.",
    )


class ChatResponse(BaseModel):
    employee_slug: str
    conversation_id: str
    reply: str


# conversation_id → ReActAgent (with InMemoryMemory). Resets on sidecar restart.
_CHAT_AGENTS: Dict[str, ReActAgent] = {}


def _require_master_key(token: Optional[str]) -> None:
    settings = get_settings()
    expected = settings.hivemind_master_api_key
    if not expected:
        raise HTTPException(503, "service not configured (master key missing)")
    if token != expected:
        raise HTTPException(401, "Invalid admin token")


async def _resolve_employee(slug: str) -> Dict:
    # Fast path: a deployed/running employee (already in the sidecar's DB view).
    rows = await list_running_employees()
    for r in rows:
        if r.get("slug") == slug:
            return r
    # Fallback: 1-on-1 chat does NOT need a running container — it builds an
    # ephemeral in-process agent. Pull the profile (any non-archived status,
    # incl. draft) + api_key from control-plane so draft employees are chattable.
    profile = await fetch_employee_profile(slug)
    if profile and profile.get("id"):
        return profile
    raise HTTPException(404, f"employee slug={slug} not found")


def _conv_key(employee_id: str, conversation_id: str) -> str:
    return f"{employee_id}:{conversation_id}"


async def _get_or_build_agent(emp: Dict, conv_key: str) -> ReActAgent:
    if conv_key in _CHAT_AGENTS:
        return _CHAT_AGENTS[conv_key]
    # If emp already carries api_key (chat-profile fallback for draft/paused),
    # use it directly. Otherwise resolve via the running-employee bootstrap.
    api_key = emp.get("api_key")
    merged_emp = emp
    if not api_key:
        boot = {b["id"]: b for b in await fetch_bootstrap()}
        boot_emp = boot.get(emp["id"], {})
        api_key = boot_emp.get("api_key")
        merged_emp = {
            **emp,
            "hyper": boot_emp.get("hyper"),
            "active_prompt_version": boot_emp.get("active_prompt_version"),
        }
    if not api_key:
        raise HTTPException(412, "employee has no bootstrap api_key")
    agent = build_react_agent(merged_emp, api_key)
    _CHAT_AGENTS[conv_key] = agent
    return agent


@router.post("/{slug}/chat", response_model=ChatResponse)
async def chat_with_employee(
    slug: str,
    req: ChatRequest,
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
) -> ChatResponse:
    _require_master_key(x_admin_token)

    emp = await _resolve_employee(slug)
    conversation_id = req.conversation_id or f"adhoc-{emp['id']}"
    key = _conv_key(emp["id"], conversation_id)
    agent = await _get_or_build_agent(emp, key)

    try:
        reply: Msg = await agent(Msg(name="user", content=req.text, role="user"))
    except Exception as exc:
        log.exception("chat_with_employee failed (slug=%s): %s", slug, exc)
        raise HTTPException(502, f"agent failure: {exc}") from exc

    content = reply.content if reply is not None else ""
    if isinstance(content, list):
        text_parts = []
        for blk in content:
            if isinstance(blk, dict):
                text_parts.append(blk.get("text") or "")
            else:
                text_parts.append(str(blk))
        content = "\n".join(p for p in text_parts if p)

    return ChatResponse(
        employee_slug=slug,
        conversation_id=conversation_id,
        reply=(content or "").strip(),
    )
