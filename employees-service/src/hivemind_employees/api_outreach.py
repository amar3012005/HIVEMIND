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
    lead_id: Optional[str] = None
    company: str
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    address: Optional[str] = None
    source_url: Optional[str] = None
    fit_reason: Optional[str] = None
    outreach_angle: Optional[str] = None
    notes: Optional[str] = None


class GenerateRequest(BaseModel):
    channel: str  # email | call
    turn_id: str
    sender_email: str = ""
    sender_name: str = ""
    sender_company: str = ""
    company_context: str = ""
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
    # `final_report.content` is the canonical Room report. Older runs used
    # body/text/report, so keep those fallbacks for historical campaigns.
    body = ""
    for l in lines:
        if not isinstance(l, dict):
            continue
        if l.get("t") in _REPORT_EVENTS and (l.get("content") or l.get("body") or l.get("text") or l.get("report")):
            body = str(l.get("content") or l.get("body") or l.get("text") or l.get("report"))
        elif not body and l.get("t") == "line" and len(str(l.get("text") or "")) > 400:
            body = str(l.get("text"))
    return body[:_MAX_REPORT_CHARS]


def _email_system_prompt(req: GenerateRequest) -> str:
    from .hyper.skills import load_method_skill
    from .hyper.engine import _SKILLS as _ENGINE_SKILLS

    skill = (load_method_skill("cold-email-sequence") or "")[:900]
    polish = str(_ENGINE_SKILLS.get("polished-email") or "")[:700]
    sender = str(req.sender_company or req.sender_name or req.sender_email or "the sender company").strip()
    prompt = (
        "You are the Outreach Intelligence operator preparing one email to a specific prospect. "
        "Apply these method skills exactly:\n" + skill + "\n" + polish + "\n"
        "GROUNDING RULES: this is Touch 1 to this firm. Derive the why-now hook and value point from "
        "the company context, Room result, retained fit rationale, outreach angle, and verified prospect "
        "profile below. Use only supplied facts. The copy must be distinct to this prospect and must not "
        "infer its customers, needs, or activity from a name, address, or domain. Use the sender brand exactly "
        f"as supplied: {sender}. Do not insert a website, product name, claim, or metric that is absent from "
        "the supplied context. Under 160 words. Never invent contacts or placeholders."
    )
    if req.sender_email:
        prompt += (
            f" SENDER IDENTITY: send as {req.sender_name or req.sender_email} from "
            f"{req.sender_company or 'the sender company'} at {req.sender_email}. Sign with this exact verified "
            "identity and do not invent a title or role."
        )
    return prompt + (
        ' Respond with ONLY a JSON object: {"subject": "...", "body": "..."} '
        "(body is plain markdown with no Subject line)."
    )


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
        f"Lead ID: {p.lead_id or '—'}\n"
        f"Company: {p.company}\nWebsite: {p.website or '—'}\n"
        f"Address: {p.address or '—'}\nPhone: {p.phone or '—'}\nEmail: {p.email or '—'}\n"
        f"Source: {p.source_url or '—'}\nFit rationale: {p.fit_reason or '—'}\n"
        f"Outreach angle: {p.outreach_angle or '—'}\nNotes: {p.notes or '—'}"
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
        sys = _email_system_prompt(req)
    else:
        sys = (
            "You prepare ONE outbound phone call by an AI voice agent (TARA) to a specific "
            "prospect, grounded in the team report below. Respond with ONLY a JSON object: "
            '{"goal": "...", "opener": "...", "context": "...", "language": "...", "strategy": "...", "voice_style": "..."} — '
            "goal: one outcome-framed sentence for the call "
            "(e.g. 'Book a 15-minute intro about X with the office manager'); opener: the first "
            "spoken line, naming the firm and why we're calling, natural and brief; "
            "context: a compact prospect brief (max 500 chars) the voice agent keeps in working "
            "memory during the call — firm name, what they do / why they fit, and any prior-call "
            "learnings worth applying; "
            "language: the BCP-47 code the call should be conducted in, inferred from the prospect "
            "(company location / website TLD / market) — e.g. 'de' for a German firm, else 'en'; "
            "strategy: <=200 chars — the conversation plan (how to open, what to probe, the ask, how "
            "to handle the likely objection) so TARA speaks with intent; "
            "voice_style: 2-3 words describing the ideal voice tone for THIS prospect + strategy "
            "(e.g. 'warm professional', 'crisp formal', 'friendly energetic'). "
            "Never invent facts about the firm."
        )
    company_context = str(req.company_context or "").strip()[:6000]
    user = (f"COMPANY CONTEXT (grounding):\n{company_context or '(use the sealed Room report and verified sender identity)'}\n\n"
            f"TEAM REPORT (grounding):\n{report or '(no report body — use the firm data only)'}\n\n"
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
    # Auto-selected call parameters (the "contract" TARA dials with): language + a
    # conversation strategy + the ideal voice tone. Control-plane resolves voice_style →
    # a concrete Cartesia voice_id from TARA's catalog at dial time; language flows straight
    # through (TARA resolves a language-appropriate voice when no explicit id is given).
    _lang = str(obj.get("language") or "").strip().lower()[:8] or "en"
    _strategy = str(obj.get("strategy") or "").strip()[:200]
    _voice_style = str(obj.get("voice_style") or "").strip()[:40]
    return {"goal": goal[:300], "opener": opener[:400],
            "context": context[:600], "language": _lang,
            "strategy": _strategy, "voice_style": _voice_style,
            "tokens": usage.get("total", 0)}
