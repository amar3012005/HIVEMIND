"""Outreach campaign generation — per-prospect personalized email / call-goal.

Called by the control-plane outreach module (core/src/outreach/campaigns.js) once
per target: takes the sealed turn's report as grounding + one prospect row and
returns either an email {subject, body} or a call {goal, opener}. One plain LLM
call (run_mention_reply routing: Groq-primary, OpenRouter fallback) — no director,
no debate; the debate already happened in the turn that produced the report.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .db import init_pool
from .hyper.engine import run_mention_reply

log = logging.getLogger("hivemind_employees.outreach")

router = APIRouter()

_REPORT_EVENTS = ("final_report", "seal")
_MAX_REPORT_CHARS = 9000


class _Prospect(BaseModel):
    company: str
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    address: Optional[str] = None


class GenerateRequest(BaseModel):
    channel: str  # email | call
    turn_id: str
    sender_email: str = ""
    prospect: _Prospect


async def _report_for_turn(turn_id: str) -> str:
    """The sealed turn's produced report/final text — grounding for personalization."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT lines FROM hivemind.hyper_turns WHERE id = $1::uuid", turn_id,
        )
    if not row:
        return ""
    raw = row["lines"]
    lines = json.loads(raw) if isinstance(raw, str) else list(raw or [])
    # Last final_report/seal body, else the last synthesis-ish line with real text.
    body = ""
    for l in lines:
        if not isinstance(l, dict):
            continue
        if l.get("t") in _REPORT_EVENTS and (l.get("body") or l.get("text") or l.get("report")):
            body = str(l.get("body") or l.get("text") or l.get("report"))
        elif not body and l.get("t") == "line" and len(str(l.get("text") or "")) > 400:
            body = str(l.get("text"))
    return body[:_MAX_REPORT_CHARS]


def _json_block(text: str) -> Optional[Dict[str, Any]]:
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None


@router.post("/outreach/generate")
async def generate(req: GenerateRequest) -> Dict[str, Any]:
    if req.channel not in ("email", "call"):
        return {"error": "channel must be email|call"}
    report = await _report_for_turn(req.turn_id)
    p = req.prospect
    firm = (
        f"Company: {p.company}\nWebsite: {p.website or '—'}\n"
        f"Address: {p.address or '—'}\nPhone: {p.phone or '—'}\nEmail: {p.email or '—'}"
    )
    if req.channel == "email":
        sys = (
            "You write ONE cold-outreach email to a specific prospect, grounded in the team "
            "report below. Personal, specific, non-generic: one why-now hook tied to THIS firm, "
            "one concrete value point from the report, one clear ask (a short intro call). "
            "Under 160 words. Never invent facts, links, phone numbers or placeholder addresses."
            + (
                f" SENDER IDENTITY: the email is sent from {req.sender_email} — sign off with the "
                f"sender's real name/role if known (else just the address) and this exact address."
                if req.sender_email else ""
            )
            + ' Respond with ONLY a JSON object: {"subject": "...", "body": "..."} '
            "(body is the email text, plain markdown, no Subject: line inside it)."
        )
    else:
        sys = (
            "You prepare ONE outbound phone call by an AI voice agent (TARA) to a specific "
            "prospect, grounded in the team report below. Respond with ONLY a JSON object: "
            '{"goal": "...", "opener": "..."} — goal: one outcome-framed sentence for the call '
            "(e.g. 'Book a 15-minute intro about X with the office manager'); opener: the first "
            "spoken line, naming the firm and why we're calling, natural and brief. "
            "Never invent facts about the firm."
        )
    user = f"TEAM REPORT (grounding):\n{report or '(no report body — use the firm data only)'}\n\nPROSPECT:\n{firm}"
    content, usage = await run_mention_reply(
        [{"role": "system", "content": sys}, {"role": "user", "content": user}], temp=0.5,
    )
    obj = _json_block(content or "")
    if not obj:
        log.warning("[outreach] generate: no JSON in model output (turn=%s)", req.turn_id[:8])
        return {"error": "generation produced no usable output"}
    if req.channel == "email":
        subject = str(obj.get("subject") or "").strip().strip("*")
        body = str(obj.get("body") or "").strip()
        if not subject or not body:
            return {"error": "generation missing subject/body"}
        return {"subject": subject[:500], "body": body, "tokens": usage.get("total", 0)}
    goal = str(obj.get("goal") or "").strip()
    opener = str(obj.get("opener") or "").strip()
    if not goal:
        return {"error": "generation missing goal"}
    return {"goal": goal[:300], "opener": opener[:400], "tokens": usage.get("total", 0)}
