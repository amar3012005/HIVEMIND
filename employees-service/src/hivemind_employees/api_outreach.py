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
from .hivemind_client import list_tagged_emulated
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
    # Tenant identity — lets generation recall the org's prior outreach learnings.
    user_id: str = ""
    org_id: str = ""


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
    # Prior outreach learnings (distilled from past TARA calls at /calls/end) —
    # guaranteed tag lane; prefer this prospect's own learnings, then org-wide.
    learnings_block = ""
    if req.org_id:
        try:
            rows = await list_tagged_emulated(tags="outreach-learning",
                                              user_id=req.user_id or None,
                                              org_id=req.org_id, limit=6)
            _slug = "".join(ch for ch in p.company.lower() if ch.isalnum())[:24]
            rows.sort(key=lambda r: (_slug not in str(r.get("tags") or "").lower()))
            lines = []
            for r in rows[:4]:
                c = str(r.get("content") or "").replace("\n", " ").strip()
                if c:
                    lines.append(f"- {c[:220]}")
            if lines:
                learnings_block = "\nPRIOR OUTREACH LEARNINGS (from real calls — apply them, don't repeat mistakes):\n" + "\n".join(lines)
        except Exception:  # noqa: BLE001 — learnings are additive, never block generation
            learnings_block = ""
    if req.channel == "email":
        # On-demand EMAIL SKILL — the campaign's Send button triggers this per
        # prospect. Loads the room's method skills (cold-email-sequence craft +
        # polished-email form) and grounds the write on the RUN's report, THIS
        # firm's real data (website/city), and prior-call learnings — never a
        # generic template.
        from .hyper.skills import load_method_skill
        from .hyper.engine import _SKILLS as _ENGINE_SKILLS
        _skill = (load_method_skill("cold-email-sequence") or "")[:900]
        _polish = str(_ENGINE_SKILLS.get("polished-email") or "")[:700]
        sys = (
            "You are the outreach agent SENDING one email to a specific prospect — apply these "
            "method skills exactly:\n" + _skill + "\n" + _polish + "\n"
            "GROUNDING RULES: this is Touch 1 to THIS firm. Derive the why-now hook and value point "
            "from the TEAM REPORT and the firm's own profile below (their business, city, website). "
            "Reference something specific about THEM (what they do / where they operate) so it could "
            "not have been sent to anyone else. Include the firm's REAL website URL from the profile "
            "when referencing them, and our site https://singulancelabs.com as the sender's link. "
            "Brand names exactly: SINGULANCE, HIVEMIND, TARA, HYPERAGENTS. Under 160 words. Never "
            "invent facts, numbers, links, or placeholder contacts."
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
            '{"goal": "...", "opener": "...", "context": "..."} — goal: one outcome-framed sentence for the call '
            "(e.g. 'Book a 15-minute intro about X with the office manager'); opener: the first "
            "spoken line, naming the firm and why we're calling, natural and brief; "
            "context: a compact prospect brief (max 500 chars) the voice agent keeps in working "
            "memory during the call — firm name, what they do / why they fit, and any prior-call "
            "learnings worth applying. Never invent facts about the firm."
        )
    user = (f"TEAM REPORT (grounding):\n{report or '(no report body — use the firm data only)'}\n\n"
            f"PROSPECT:\n{firm}{learnings_block}")
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
    # Prospect brief for the dial ([PROSPECT CONTEXT]); fall back to the firm
    # facts so TARA is never blind even if the model skipped the field.
    context = str(obj.get("context") or "").strip() or (
        f"{p.company} — {p.website or ''}".strip(" —"))
    return {"goal": goal[:300], "opener": opener[:400],
            "context": context[:600], "tokens": usage.get("total", 0)}
