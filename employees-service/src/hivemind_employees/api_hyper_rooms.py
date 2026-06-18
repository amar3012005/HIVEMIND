"""Hyper Agents — Rooms orchestrator.

Slack/WhatsApp-style multi-agent workspace running Cognitive Swarm
Intelligence on the HIVEMIND substrate. Called by the control-plane's
POST /v1/hyper-rooms/:id/turns; this endpoint runs the actual debate:

    1. Router picks a Lead (closest CSI lane to the user_message)
    2. Lead generates full response (reuses build_react_agent, so the
       HIVEMIND MCP tools are available. Public web access is routed
       through one dedicated web-intel worker per room turn, not every
       agent.
    3. Up to 2 Reactors run a "quiet-check" pass; reactors in opposing
       lanes (Strategist↔Skeptic, Builder↔Skeptic, Communicator↔Skeptic)
       are biased toward speaking up.
    4. If any reactor returns agreement='challenge' with confidence>0.7,
       Lead revises (round 2), Challenger validates or escalates once.
    5. Seal — the control-plane writes status=complete + cost roll-up
       and stops the SSE stream.

Each event is POSTed back to the control-plane callback so the SSE
stream attached to the turn can flush it. No second event bus — the
DB row IS the bus, control-plane just appends.

Reuses, does NOT duplicate:
    - agents.agentscope_factory.build_react_agent
    - bootstrap_client.fetch_bootstrap
    - db.list_running_employees
    - api_employee_chat._CHAT_AGENTS cache pattern
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Set

import httpx
from agentscope.agent import ReActAgent
from agentscope.message import Msg
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .agents.agentscope_factory import build_react_agent
from .agents.agentscope_tools import (
    begin_turn_write_gate,
    drain_pending_writes,
    execute_pending_write,
)
from .bootstrap_client import fetch_bootstrap, report_eval, report_metrics
from .config import get_settings
from .db import (
    get_permanent_lead_id,
    get_permanent_skeptic_id,
    get_room_connector_grants,
    get_room_enabled_connectors,
    get_room_template,
    get_trust_scores,
    get_turn_seq,
    list_employees_by_ids,
    list_running_employees,
    update_trust,
)
from .hivemind_client import recall_emulated

log = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/hyper", tags=["hyper-rooms"])


# ─── Budget constants ────────────────────────────────────────────────
# Token caps removed — agents use full model context. The runtime
# bounds are the model's own context window (Groq llama ~128k, Claude
# ~200k). No per-line or per-turn truncation here.

MAX_REACTORS = 2
ROUND_2_CHALLENGE_THRESHOLD = 0.45

# Full toolkit for hyper-room agents — all HIVEMIND read paths + save
# + time travel. Web access is reserved for one dedicated web-intel worker
# inside the room orchestrator, not every employee.
DEFAULT_HYPER_TOOLS = [
    "hivemind_recall",
    "hivemind_list_memories",
    "hivemind_get_memory",
    "hivemind_traverse_graph",
    "hivemind_query_with_ai",
    "hivemind_recall_bugs",
    "hivemind_why_code",
    "hivemind_at",
    "hivemind_list_projects",
    "hivemind_save_memory",
]

WEB_INTEL_TOOLS = [
    "hivemind_web_search",
    "hivemind_web_research",
]

WEB_INTEL_HINTS = (
    "latest", "current", "recent", "today", "now", "web", "internet", "browse",
    "public", "website", "docs", "documentation", "news", "market", "benchmark",
    "competitor", "competitors", "compare", "comparison", "external", "publicly",
    "search", "source", "sources", "pricing", "review", "report", "regulation",
    "law", "policy", "release", "version", "product page", "homepage",
)

WEB_INTEL_GROQ_TOOLS = ("web_search", "visit_website")

HYPER_ROOM_AGENT_MAX_ITERS = int(os.environ.get("HYPER_ROOM_AGENT_MAX_ITERS", "3"))
BLACKBOARD_MIN_SCORE = float(os.environ.get("HYPER_ROOM_BLACKBOARD_MIN_SCORE", "0.45"))

ROLE_LANES = ("Strategist", "Builder", "Skeptic", "Researcher", "Communicator")

ROLE_LANE_HINTS: Dict[str, List[str]] = {
    "Strategist":   ["strategy", "plan", "vision", "direction", "ceo", "founder", "pm"],
    "Builder":      ["engineer", "build", "ship", "code", "architect", "dev", "cto", "infra"],
    "Skeptic":      ["critic", "risk", "adversar", "challenge", "qa", "security", "audit", "review"],
    "Researcher":   ["research", "data", "analy", "science", "study", "inquir", "curious", "explore"],
    "Communicator": ["comm", "writer", "market", "copy", "design", "customer", "support", "sales"],
}

ADVERSARIAL_PAIRS = (
    ("Strategist", "Skeptic"),
    ("Builder", "Skeptic"),
    ("Communicator", "Skeptic"),
)


# ─── Conversation-agent cache — shared with api_employee_chat ──

_ROOM_AGENTS: Dict[str, ReActAgent] = {}

# ─── B3 repeat-guard: rolling per-room normalized line history ───
# Bounded in-memory dedup. Keys: room_id. Values: list of normalised
# tokens-fingerprints from prior reactor lines. Prevents 'we re-litigate
# the same risk every turn' anti-pattern.
_ROOM_PRIOR_LINES: Dict[str, List[str]] = {}
_REPEAT_GUARD_MAX = 80  # rolling window per room
_WEB_INTEL_PAYLOADS: Dict[str, Dict[str, Any]] = {}
# Phase 1 — the lead's turn plan, keyed by turn_id. Consumed by later phases
# (assignment-driven execution, goalkeeper) and surfaced to the FE.
_PLAN_BY_TURN: Dict[str, Dict[str, Any]] = {}

# Phase 4 — writes held for the user's approval, keyed by approval_id. Each
# record carries the bridge descriptor + creds needed to replay the call once
# approved (via /internal/hyper/approve). Bounded to avoid unbounded growth.
_PENDING_APPROVALS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_PENDING_APPROVALS_CAP = 500


async def _register_and_emit_approvals(
    req: "RoomTurnRequest", pending: List[Dict[str, Any]]
) -> None:
    """Stash each queued write (with creds for replay) and surface an approval
    card to the FE. The side effect has NOT fired — it runs only on approve."""
    for rec in pending:
        approval_id = rec.get("approval_id")
        if not approval_id:
            continue
        _PENDING_APPROVALS[approval_id] = {
            **rec,
            "user_id": req.user_id,
            "org_id": req.org_id,
            "room_id": req.room_id,
            "turn_id": req.turn_id,
            "callback_url": req.callback_url,
        }
        while len(_PENDING_APPROVALS) > _PENDING_APPROVALS_CAP:
            _PENDING_APPROVALS.popitem(last=False)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "approval_request",
            "approval_id": approval_id,
            "label": rec.get("label"),
            "summary": rec.get("summary"),
            "bridge": rec.get("bridge"),
        })
    log.info("[approval] room=%s queued=%d writes for approval",
             req.room_id, len(pending))

# ─── A1 decision sink — explicit save-intent regex ───
_SAVE_INTENT_RE = re.compile(
    r"\b(save (this|that|it)|remember (this|that)|log (this|that)|"
    r"write (this|that) (down|to memory)|capture this)\b",
    re.IGNORECASE,
)

_VALUE_FACT_RE = re.compile(
    r"(?:€|\$|£|EUR|USD|GBP)\s?\d+(?:[.,]\d+)?(?:\s?[kKmMbB])?(?:\s*/\s?(?:mo|month|seat|user|yr|year))?|"
    r"\b\d+(?:[.,]\d+)?\s?(?:%|percent|users?|seats?|GB|MB|TB|minutes?|hours?|days?|weeks?|months?|years?|ARR|MRR|revenue|customers?|partners?|tasks?|tickets?)\b|"
    r"\b\d{1,4}(?:[/-]\d{1,2}){1,2}\b|"
    r"\b\d+(?:[.,]\d+)?\b",
    re.IGNORECASE,
)
_DATE_FACT_RE = re.compile(
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|"
    r"dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?|\b(?:q[1-4]|h[12])\s*\d{2,4}\b",
    re.IGNORECASE,
)
_QUOTED_FACT_RE = re.compile(r"[\"“”']([^\"“”']{3,80})[\"“”']")
_NAMED_FACT_RE = re.compile(r"\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,4}\b")
_CONSTRAINT_RE = re.compile(
    r"\b(?:must|should|need(?:s)?|only|do not|don't|cannot|can't|never|"
    r"now|given|instead|because|so|therefore|make sure|fix|validate|compare)\b",
    re.IGNORECASE,
)
_MISSING_CURRENT_FACT_PATTERNS = (
    re.compile(r"\buser\b.{0,80}\b(?:did(?: not|n't)|has(?: not|n't)|does(?: not|n't)|never)\b.{0,80}\b(?:supply|provide|give|share|include)\b", re.IGNORECASE),
    re.compile(r"\b(?:no|without|lacks?|missing)\b.{0,60}\b(?:concrete|exact|specific)?\s*(?:user\s+)?(?:details?|figures?|numbers?|values?|requirements?|constraints?|context|facts?)\b", re.IGNORECASE),
    re.compile(r"\bneed(?:s|ed)?\b.{0,40}\b(?:exact|specific|concrete)\b.{0,50}\b(?:details?|figures?|numbers?|values?|requirements?|constraints?|facts?)\b", re.IGNORECASE),
)
_REAL_GAP_RE = re.compile(
    r"\b(?:cost-to-serve|unit economics|margin|usage logs?|churn|elasticity|"
    r"validation|evidence|memory evidence|pilot|survey|benchmark|customer data|"
    r"legal|security|risk|implementation|owner|deadline)\b",
    re.IGNORECASE,
)

# Decision-template flag — set via room metadata later. For now: any
# turn that closes with verdict=resolved OR explicit save-intent.


def _uniq_keep_order(values: List[str], limit: int = 12) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for raw in values:
        value = re.sub(r"\s+", " ", str(raw or "")).strip(" \t\n\r.,;:")
        key = value.lower()
        if not value or key in seen:
            continue
        seen.add(key)
        out.append(value)
        if len(out) >= limit:
            break
    return out


def _extract_current_user_facts(text: str) -> Dict[str, List[str]]:
    """Extract topic-agnostic current-turn facts supplied by the user.

    Inspired by AgentScope memory marks: keep the user's latest facts as
    explicit state separate from long-term memory so employee agents do not
    re-litigate missing details the user just provided.
    """
    source = text or ""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", source) if s.strip()]
    constraints = [s[:220] for s in sentences if _CONSTRAINT_RE.search(s)]
    named = [
        v for v in _NAMED_FACT_RE.findall(source)
        if len(v) > 2 and v.lower() not in {"i", "the", "and", "for", "now"}
    ]
    return {
        "values": _uniq_keep_order(_VALUE_FACT_RE.findall(source), 16),
        "dates": _uniq_keep_order(_DATE_FACT_RE.findall(source), 8),
        "quoted": _uniq_keep_order(_QUOTED_FACT_RE.findall(source), 8),
        "names": _uniq_keep_order(named, 16),
        "constraints": _uniq_keep_order(constraints, 8),
    }


def _has_current_user_facts(facts: Dict[str, List[str]]) -> bool:
    return sum(len(v) for v in facts.values()) >= 2


def _format_current_turn_state(user_message: str, blackboard: Optional[Dict[str, Any]] = None) -> str:
    facts = _extract_current_user_facts(user_message)
    memory_titles: List[str] = []
    if blackboard:
        for row in (blackboard.get("memory_hits") or [])[:8]:
            title = str(row.get("title") or row.get("memory_title") or "").strip()
            if title:
                memory_titles.append(title)
    if not _has_current_user_facts(facts) and not memory_titles:
        return ""
    lines = [
        "CURRENT TURN STATE (AgentScope-style marked memory; authoritative for this turn):",
        f"[user_message] {user_message[:1200]}",
    ]
    for key, label in (
        ("values", "user_fact:value"),
        ("dates", "user_fact:date"),
        ("quoted", "user_fact:quoted"),
        ("names", "user_fact:name"),
        ("constraints", "user_fact:constraint"),
    ):
        vals = facts.get(key) or []
        if vals:
            lines.append(f"[{label}] " + "; ".join(vals[:10]))
    if memory_titles:
        lines.append("[memory:title] " + "; ".join(_uniq_keep_order(memory_titles, 8)))
    lines.append(
        "Employee rule: use [user_fact] values as current truth; use [memory] for durable context; "
        "escalate only for a real remaining [gap], not for facts already listed here."
    )
    return "\n".join(lines)


def _claims_missing_current_user_facts(text: str) -> bool:
    candidate = text or ""
    if _REAL_GAP_RE.search(candidate) and not re.search(r"\buser\b", candidate, re.IGNORECASE):
        return False
    return any(pattern.search(candidate) for pattern in _MISSING_CURRENT_FACT_PATTERNS)


def _extract_jsonish_string(raw: str, field: str, limit: int = 2000) -> str:
    m = re.search(rf'"{re.escape(field)}"\s*:\s*"([^"]*)"', raw or "")
    return (m.group(1).strip()[:limit] if m else "")


def _extract_jsonish_list(raw: str, field: str, limit: int = 8) -> List[str]:
    m = re.search(rf'"{re.escape(field)}"\s*:\s*\[([^\]]*)\]', raw or "")
    if not m:
        return []
    return [x.strip()[:300] for x in re.findall(r'"([^"]+)"', m.group(1))[:limit]]


def _normalize_for_dedup(text: str) -> str:
    """Strip punctuation/case for shingle dedup. 4-gram key."""
    t = re.sub(r"[^\w\s]", " ", (text or "").lower())
    toks = [w for w in t.split() if len(w) > 3]
    return " ".join(toks[:12])  # first 12 substantive tokens = fingerprint


def _line_already_raised(room_id: str, line: str) -> bool:
    """B3: cheap repeat-detection. True if this reactor line restates a
    prior one in the same room."""
    fp = _normalize_for_dedup(line)
    if not fp or len(fp) < 12:  # too-short fingerprints unreliable
        return False
    prior = _ROOM_PRIOR_LINES.get(room_id, [])
    # Substantial overlap: shared 4+ consecutive tokens
    fp_words = fp.split()
    for p in prior:
        p_words = p.split()
        # Sliding 4-gram intersect
        if len(p_words) < 4 or len(fp_words) < 4:
            continue
        fp_grams = {" ".join(fp_words[i:i+4]) for i in range(len(fp_words) - 3)}
        p_grams = {" ".join(p_words[i:i+4]) for i in range(len(p_words) - 3)}
        if fp_grams & p_grams:
            return True
    return False


def _remember_line(room_id: str, line: str) -> None:
    if not line:
        return
    fp = _normalize_for_dedup(line)
    if not fp:
        return
    buf = _ROOM_PRIOR_LINES.setdefault(room_id, [])
    buf.append(fp)
    # Trim
    if len(buf) > _REPEAT_GUARD_MAX:
        del buf[: len(buf) - _REPEAT_GUARD_MAX]


# ─── A2 completion verifier ───
def _is_substantive_lead(text: str, had_memory_context: bool) -> bool:
    """True if lead/synth text passes the no-empty-seal gate.

    Rules:
    - non-trivial length (>=120 chars)
    - AND (cites a memory title via "<...>" OR contains "from \"" pattern
      OR explicit 'nothing on file' acknowledgement when no memory context)
    """
    if not text or len(text.strip()) < 120:
        return False
    cite_patterns = (
        re.search(r'from\s+["“][^"”]{6,}["”]', text),
        re.search(r'["“][^"”]{6,}["”]\s*(?:memo|brief|doc|note)', text, re.IGNORECASE),
        re.search(r'(?:per|see)\s+["“][^"”]{6,}["”]', text, re.IGNORECASE),
    )
    if any(cite_patterns):
        return True
    if not had_memory_context and re.search(r'nothing on file', text, re.IGNORECASE):
        return True
    return False


# ─── A1 decision sink — POST to /api/memories with master key + emulation ─
async def _save_room_decision(
    *,
    user_id: str,
    org_id: str,
    room_id: str,
    turn_id: str,
    user_message: str,
    decision_text: str,
    trigger: str,
) -> Optional[str]:
    """Persist a room decision as a HIVEMIND memory. Returns memory id
    or None on failure. Uses master key + X-HM-User-Id/Org-Id emulation
    so we don't require per-employee scoped keys."""
    settings = get_settings()
    master = settings.hivemind_master_api_key
    if not master:
        log.warning("decision-sink: no master key; skipping save room=%s", room_id)
        return None
    title = f"Room decision · {user_message[:80]}"
    body = (
        f"Trigger: {trigger}\n"
        f"User asked: {user_message}\n\n"
        f"Decision / closing line:\n{decision_text.strip()}\n"
    )
    tags = [
        "room-decision",
        f"room:{room_id}",
        f"turn:{turn_id}",
        "hyper-rooms",
    ]
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(15.0, connect=5.0),
            headers={
                "Authorization": f"Bearer {master}",
                "X-API-Key": master,
                "X-HM-User-Id": user_id,
                "X-HM-Org-Id": org_id,
                "Content-Type": "application/json",
            },
        ) as c:
            r = await c.post(
                "/api/memories",
                json={
                    "title": title,
                    "content": body,
                    "tags": tags,
                    "memory_type": "decision",
                    "sync": True,
                },
            )
            r.raise_for_status()
            data = r.json()
            mid = data.get("id") or (data.get("memory") or {}).get("id")
            log.info("decision-sink: saved room=%s memory=%s trigger=%s", room_id, mid, trigger)
            return mid
    except Exception as exc:  # noqa: BLE001
        log.warning("decision-sink: save failed room=%s err=%s", room_id, exc)
        return None


def _extract_memory_rows(resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = resp.get("memories") or resp.get("combined") or []
    return rows if isinstance(rows, list) else []


def _score_memory_row(row: Dict[str, Any]) -> float:
    try:
        return float(row.get("score", 0) or 0)
    except Exception:
        return 0.0


def _format_memory_rows(rows: List[Dict[str, Any]], *, limit: int = 6, snippet_chars: int = 300) -> str:
    lines_out: List[str] = []
    for r in rows[:limit]:
        title = (r.get("title") or "").strip()
        content = (r.get("content") or "").replace("\n", " ").strip()
        if not content:
            continue
        snippet = content[:snippet_chars] + ("..." if len(content) > snippet_chars else "")
        prefix = f'"{title}" - ' if title else ""
        mid = str(r.get("id") or r.get("memory_id") or "").strip()
        suffix = f" [memory_id={mid}]" if mid else ""
        lines_out.append(f"- {prefix}{snippet}{suffix}")
    return "\n".join(lines_out)


async def _build_turn_blackboard(
    *,
    query: str,
    user_id: str,
    org_id: str,
    api_key: str = "",
    project_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build one shared turn context that every room agent reads.

    This is the HyperAgents version of MiroFish's blackboard: one bounded
    memory fan-out before the debate, not one broad ReAct recall loop per
    agent. Agents can still use tools for targeted gaps.
    """
    company_brief, recall_resp = await asyncio.gather(
        _build_company_brief(query, user_id, org_id, api_key, project_id=project_id),
        recall_emulated(
            query,
            user_id=user_id,
            org_id=org_id,
            api_key=api_key,
            max_memories=8,
            project_id=project_id,
        ),
        return_exceptions=True,
    )
    if isinstance(company_brief, Exception):
        log.warning("[blackboard] company brief failed: %s", company_brief)
        company_brief = ""
    if isinstance(recall_resp, Exception):
        log.warning("[blackboard] query recall failed: %s", recall_resp)
        recall_resp = {}
    project_rows = [
        r for r in _extract_memory_rows(recall_resp)
        if _score_memory_row(r) >= BLACKBOARD_MIN_SCORE
    ]
    project_rows.sort(key=_score_memory_row, reverse=True)
    project_hit_count = len(project_rows)
    if project_id and project_hit_count == 0:
        try:
            expanded_resp = await recall_emulated(
                f"{query} product roadmap pricing revenue marketing strategy customers launch plan brand positioning",
                user_id=user_id,
                org_id=org_id,
                api_key=api_key,
                max_memories=10,
                project_id=project_id,
            )
            project_rows = [
                r for r in _extract_memory_rows(expanded_resp)
                if _score_memory_row(r) >= 0.38
            ]
            project_rows.sort(key=_score_memory_row, reverse=True)
            project_hit_count = len(project_rows)
        except Exception as exc:  # noqa: BLE001
            log.warning("[blackboard] expanded project recall failed: %s", exc)
    org_fallback_rows: List[Dict[str, Any]] = []
    org_fallback_used = False
    if project_id and project_hit_count == 0:
        try:
            org_resp = await recall_emulated(
                query,
                user_id=user_id,
                org_id=org_id,
                api_key=api_key,
                max_memories=6,
                project_id=None,
            )
            org_fallback_rows = [
                r for r in _extract_memory_rows(org_resp)
                if _score_memory_row(r) >= BLACKBOARD_MIN_SCORE
            ]
            org_fallback_rows.sort(key=_score_memory_row, reverse=True)
            org_fallback_used = bool(org_fallback_rows)
        except Exception as exc:  # noqa: BLE001
            log.warning("[blackboard] org fallback recall failed: %s", exc)
    rows = project_rows + org_fallback_rows
    rows.sort(key=_score_memory_row, reverse=True)
    candidate_block = ""
    formatted = _format_memory_rows(rows, limit=6, snippet_chars=300)
    if formatted:
        label = "PROJECT-SCOPED CANDIDATE MEMORIES" if project_id and project_hit_count else "CANDIDATE MEMORIES"
        if project_id and project_hit_count == 0 and org_fallback_rows:
            label = "ORG FALLBACK MEMORIES (project scope had no direct hits)"
        candidate_block = (
            f"{label} (most relevant to the user's question):\n"
            + formatted
            + "\n"
        )
    context_text = (str(company_brief or "") + candidate_block).strip()
    if context_text:
        context_text += "\n"
    hit_count = len(rows)
    confidence = min(1.0, hit_count / 3.0)
    return {
        "context_text": context_text,
        "memory_hits": rows,
        "hit_count": hit_count,
        "confidence": confidence,
        "project_id": project_id or None,
        "project_scoped": bool(project_id),
        "project_hit_count": project_hit_count,
        "project_confidence": min(1.0, project_hit_count / 3.0),
        "org_fallback_used": org_fallback_used,
        "org_fallback_hit_count": len(org_fallback_rows),
        "memory_ids": [
            str(r.get("id") or r.get("memory_id"))
            for r in rows
            if r.get("id") or r.get("memory_id")
        ][:20],
    }


def _is_fast_decision_candidate(user_message: str, room_template: str) -> bool:
    if room_template != "decision":
        return False
    msg = (user_message or "").strip().lower()
    if len(msg) > 1200 or len(msg.split()) > 180:
        return False
    heavy_terms = (
        "debate", "from every angle", "full analysis", "audit", "review all",
        "brainstorm", "compare", "pros and cons", "risk register", "deep dive",
    )
    return not any(term in msg for term in heavy_terms)


def _has_strong_challenge(reactions: List[Dict[str, Any]]) -> bool:
    return any(
        r.get("agreement") == "challenge"
        and float(r.get("confidence", 0) or 0) >= ROUND_2_CHALLENGE_THRESHOLD
        for r in reactions
    )


def _schedule_decision_save(
    *,
    callback_url: Optional[str],
    user_id: str,
    org_id: str,
    room_id: str,
    turn_id: str,
    user_message: str,
    decision_text: str,
    trigger: str,
) -> None:
    async def _runner() -> None:
        mid = await _save_room_decision(
            user_id=user_id,
            org_id=org_id,
            room_id=room_id,
            turn_id=turn_id,
            user_message=user_message,
            decision_text=decision_text,
            trigger=trigger,
        )
        if mid:
            await _emit_event(callback_url or "", turn_id, {
                "t": "decision_saved",
                "memory_id": mid,
                "trigger": trigger,
            })
        else:
            await _emit_event(callback_url or "", turn_id, {
                "t": "warning",
                "code": "decision_save_failed",
                "trigger": trigger,
            })

    asyncio.create_task(_runner())


def _require_master_key(token: Optional[str]) -> None:
    settings = get_settings()
    expected = settings.hivemind_master_api_key
    if not expected:
        raise HTTPException(503, "service not configured (master key missing)")
    if token != expected:
        raise HTTPException(401, "Invalid admin token")


LEGACY_ROLE_MAP = {
    "coordinator":  "Strategist",
    "strategist":   "Strategist",
    "operator":     "Strategist",
    "investigator": "Researcher",
    "researcher":   "Researcher",
    "analyst":      "Researcher",
    "skeptic":      "Skeptic",
    "critic":       "Skeptic",
    "challenger":   "Skeptic",
    "auditor":      "Skeptic",
    "builder":      "Builder",
    "engineer":     "Builder",
    "developer":    "Builder",
    "architect":    "Builder",
    "communicator": "Communicator",
    "writer":       "Communicator",
    "marketer":     "Communicator",
}


def derive_lane(employee: Dict[str, Any]) -> str:
    """Pick a CSI lane from roleArchetype + persona/name. Deterministic.

    1. If roleArchetype is already a canonical lane → use it.
    2. If it's a legacy role name we can map → map.
    3. Keyword score over name+slug+persona.
    """
    existing = (employee.get("roleArchetype") or "").strip()
    if existing in ROLE_LANES:
        return existing
    mapped = LEGACY_ROLE_MAP.get(existing.lower())
    if mapped:
        return mapped
    haystack = " ".join(
        str(employee.get(k, "") or "") for k in ("roleArchetype", "name", "slug", "persona")
    ).lower()
    best, best_score = "Communicator", 0
    for lane in ROLE_LANES:
        score = sum(1 for h in ROLE_LANE_HINTS[lane] if h in haystack)
        if score > best_score:
            best, best_score = lane, score
    return best


def opposing_lanes(lane: str) -> Set[str]:
    out: Set[str] = set()
    for a, b in ADVERSARIAL_PAIRS:
        if a == lane:
            out.add(b)
        elif b == lane:
            out.add(a)
    return out


def _pick_reactors(
    participants: List[Dict[str, Any]], lead: Dict[str, Any], max_reactors: int = MAX_REACTORS
) -> List[Dict[str, Any]]:
    """Prefer opposing-lane agents (CSI debate gate) then top non-lead lanes."""
    opposing = opposing_lanes(lead["_lane"])
    others = [p for p in participants if p["id"] != lead["id"]]
    others.sort(
        key=lambda p: (
            0 if p["_lane"] in opposing else 1,  # opposing first
            p.get("slug", ""),
        )
    )
    return others[:max_reactors]


def _pick_lead_rotating(
    participants: List[Dict[str, Any]],
    _user_message: str,
    seq: int,
    skeptic_id: Optional[str],
) -> Dict[str, Any]:
    """Stateless lead rotation across consecutive turns.

    Eligible = all participants except the locked skeptic. Ordered
    deterministically by slug so the modulo is stable across processes.
    seq is 1-based, so use (seq - 1). Consecutive seq values advance the
    index by 1, cycling the lead role across turns.

    _user_message is reserved (rotation is purely seq-based); the @mention
    lead override is applied at the call site before this is reached.
    """
    if not participants:
        raise ValueError("no participants")
    eligible = [p for p in participants if p["id"] != skeptic_id] or participants
    eligible = sorted(eligible, key=lambda p: p.get("slug", ""))
    idx = (max(seq, 1) - 1) % len(eligible)
    return eligible[idx]


def _pick_lead_fixed(
    participants: List[Dict[str, Any]],
    permanent_lead_id: Optional[str],
    skeptic_id: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Resolve a fixed per-room lead, or fall back to the first eligible agent."""
    if permanent_lead_id:
        locked = next((p for p in participants if p["id"] == permanent_lead_id), None)
        if locked is not None and locked["id"] != skeptic_id:
            return locked
        log.warning(
            "[hyper] permanent_lead_id %s not among participants or collides with skeptic — falling back",
            permanent_lead_id,
        )
    eligible = [p for p in participants if p["id"] != skeptic_id] or participants
    if not eligible:
        return None
    return sorted(eligible, key=lambda p: p.get("slug", ""))[0]


def _pick_skeptic_rotating(
    participants: List[Dict[str, Any]],
    permanent_skeptic_id: Optional[str],
    seq: int,
    lead_id: str,
) -> Optional[Dict[str, Any]]:
    """Resolve the Skeptic for this turn.

    If permanent_skeptic_id is set AND that employee is present -> always
    that employee (NO rotation). If the configured permanent skeptic is NOT
    among participants (left the room, archived, paused, stale config), do
    NOT silently return None — that would skip the entire adversarial round.
    Instead fall through to lane rotation so the room still gets a Skeptic;
    the call site surfaces a 'configured_skeptic_absent' warning event.
    Else rotate the Skeptic over Skeptic-lane participants (or any non-lead
    participant when no Skeptic lane exists), deterministic by slug + seq.
    """
    if permanent_skeptic_id:
        locked = next((p for p in participants if p["id"] == permanent_skeptic_id), None)
        if locked is not None:
            return locked
        log.warning(
            "[hyper] permanent_skeptic_id %s not among participants — falling "
            "through to Skeptic rotation so the round is not skipped",
            permanent_skeptic_id,
        )
    pool = [p for p in participants if p.get("_lane") == "Skeptic" and p["id"] != lead_id] \
        or [p for p in participants if p["id"] != lead_id]
    if not pool:
        return None
    pool = sorted(pool, key=lambda p: p.get("slug", ""))
    # Offset by 1 so lead and skeptic don't rotate in lockstep onto the same edge.
    return pool[(max(seq, 1) - 1 + 1) % len(pool)]


# ─── Callback to control-plane ────────────────────────────────────────

_CALLBACK_CLIENT: Optional[httpx.AsyncClient] = None


def _get_callback_client() -> httpx.AsyncClient:
    global _CALLBACK_CLIENT
    if _CALLBACK_CLIENT is None:
        _CALLBACK_CLIENT = httpx.AsyncClient(timeout=10.0)
    return _CALLBACK_CLIENT


async def _emit_event(callback_url: str, turn_id: str, event: Dict[str, Any]) -> None:
    """POST an event back to the control-plane append hook.

    Failures here are non-fatal — orchestration keeps going so the
    user still gets a sealed turn even if the SSE stream missed a
    chunk (reload will read the final state from DB).
    """
    if not callback_url:
        return
    settings = get_settings()
    headers = {
        "X-API-Key": settings.hivemind_master_api_key or "",
        "Content-Type": "application/json",
    }
    body = {"turn_id": turn_id, "event": event}
    try:
        client = _get_callback_client()
        await client.post(callback_url, headers=headers, content=json.dumps(body))
    except Exception as exc:  # noqa: BLE001
        log.warning("hyper-rooms event POST failed: %s", exc)


# ─── Agent build / reuse ──────────────────────────────────────────────


async def _build_agent_for_room(
    room_id: str,
    emp: Dict[str, Any],
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    project_id: Optional[str] = None,
    allow_web_tools: bool = False,
) -> ReActAgent:
    """Cache one agent per (room, employee) so memory carries across turns.

    Overrides the employee's `tools` list with the full HIVEMIND toolset
    (read paths + save + time-travel; web only for the dedicated intel worker) so swarm agents have the
    same reach as the MCP-driven Talk-to-HIVE assistant.
    """
    # Room-level connector toggles (like the web tool): every agent in the room
    # gets the enabled connectors' tools for the run. Fetch BEFORE the cache key
    # so toggling a connector on/off rebuilds the agent (else a cached tool-less
    # agent is served and the connectors never attach).
    try:
        emp_connectors = await get_room_enabled_connectors(room_id, org_id=org_id)
    except Exception:  # noqa: BLE001 — never fail a turn over connectors
        emp_connectors = []
    key = f"{room_id}:{emp['id']}:{','.join(sorted(emp_connectors))}"
    if key in _ROOM_AGENTS:
        return _ROOM_AGENTS[key]
    boot = {b["id"]: b for b in await fetch_bootstrap()}
    boot_emp = boot.get(emp["id"], {}) or {}
    api_key = boot_emp.get("api_key")
    # When the employee has no scoped HIVEMIND key (legacy rows where the
    # mint failed at create-time), don't fail the turn — strip tools so the
    # agent still produces a chat reply with no recall/save reach. Caller
    # already pre-fetches memory context into the lead prompt, so the
    # bubble stays grounded even without tool access.
    if not api_key:
        log.warning(
            "employee %s missing scoped api_key — building tool-less agent",
            emp.get("slug"),
        )
        # Use master key + emulation headers (X-HM-User-Id/X-HM-Org-Id)
        # so tools still execute as the room owner instead of bailing
        # tool-less. Without this, agents fall back to "nothing on file".
        merged = {
            **emp,
            "tools": DEFAULT_HYPER_TOOLS + (WEB_INTEL_TOOLS if allow_web_tools else []),
            "connectors": emp_connectors,
            "max_iters": (8 if emp_connectors else HYPER_ROOM_AGENT_MAX_ITERS),
            "hyper": boot_emp.get("hyper"),
            "active_prompt_version": boot_emp.get("active_prompt_version"),
        }
        agent = build_react_agent(merged, "", user_id=user_id, org_id=org_id, project_id=project_id)
        _ROOM_AGENTS[key] = agent
        return agent
    merged = {
        **emp,
        # Force the full hyper toolkit regardless of what's stored on the
        # employee row — gives every swarm participant equal reach.
        "tools": DEFAULT_HYPER_TOOLS + (WEB_INTEL_TOOLS if allow_web_tools else []),
        "connectors": emp_connectors,
        "max_iters": HYPER_ROOM_AGENT_MAX_ITERS,
        "hyper": boot_emp.get("hyper"),
        "active_prompt_version": boot_emp.get("active_prompt_version"),
    }
    agent = build_react_agent(merged, api_key, user_id=user_id, org_id=org_id, project_id=project_id)
    _ROOM_AGENTS[key] = agent
    return agent


def _msg_to_text(reply: Optional[Msg]) -> str:
    if reply is None:
        return ""
    content = reply.content
    if isinstance(content, list):
        parts = []
        for blk in content:
            if isinstance(blk, dict):
                parts.append(blk.get("text") or "")
            else:
                parts.append(str(blk))
        text = "\n".join(p for p in parts if p).strip()
    else:
        text = (content or "").strip()
    # Strip any leaked llama-3 function-call syntax that the runtime
    # failed to lift into a structured tool call. Users should never
    # see <function=name>{...}</function> as plain text.
    if "<function=" in text:
        text = re.sub(r"<function=[\s\S]*?</function>", "", text).strip()
        # Also nuke residual single-line variants
        text = re.sub(r"<function=[^\n>]+>", "", text).strip()
    return text


def _web_intel_needed(user_message: str, blackboard: Dict[str, Any], room_template: str) -> bool:
    """Decide whether the turn needs external/public evidence.

    Prefer web whenever the room may benefit from current or public
    evidence. This is intentionally broad: the dedicated web worker can
    still return `needed=false` if it finds the turn is fully covered by
    shared memory.
    """
    msg = (user_message or "").lower()
    if not msg:
        return False
    external_signals = any(term in msg for term in WEB_INTEL_HINTS)
    public_current_signals = any(term in msg for term in (
        "trademark", "domain", "availability", "available", "current", "latest",
        "today", "news", "public", "external", "competitor", "market size",
        "law", "legal", "regulation", "docs", "release", "version",
    ))
    decision_signals = any(term in msg for term in (
        "should", "best", "better", "compare", "comparison", "recommend",
        "decide", "decision", "evaluate", "choose", "rename", "rebrand",
        "brand", "legal", "law", "trademark", "domain", "pricing", "market",
        "competitor", "current", "latest", "public", "evidence", "source",
        "sources", "available", "availability", "release", "version", "docs",
    ))
    project_scoped = bool(blackboard.get("project_scoped"))
    if project_scoped:
        project_hits = int(blackboard.get("project_hit_count", 0) or 0)
        internal_hits = int(blackboard.get("hit_count", 0) or 0)
        internal_conf = float(blackboard.get("confidence", 0) or 0)
        if project_hits > 0 and not (external_signals or public_current_signals):
            return False
        if internal_hits > 0 and internal_conf >= 0.55 and not (external_signals or public_current_signals):
            return False
        return bool(external_signals or public_current_signals or internal_hits == 0 or internal_conf < 0.35)
    if room_template in ("deep_sim", "swarm", "decision"):
        return True
    if external_signals or decision_signals:
        return True
    if float(blackboard.get("confidence", 0) or 0) < 0.7:
        return True
    return int(blackboard.get("hit_count", 0) or 0) < 3


def _build_memory_audit_event(
    *,
    blackboard: Dict[str, Any],
    web_allowed: bool,
    room_template: str,
) -> Dict[str, Any]:
    project_scoped = bool(blackboard.get("project_scoped"))
    project_hit_count = int(blackboard.get("project_hit_count", 0) or 0)
    hit_count = int(blackboard.get("hit_count", 0) or 0)
    source = "project" if project_hit_count > 0 else ("org_fallback" if blackboard.get("org_fallback_used") else "none")
    if not web_allowed:
        reason = "project_memory_sufficient" if project_hit_count > 0 else "internal_memory_sufficient"
    elif project_scoped and hit_count == 0:
        reason = "project_and_org_memory_missing"
    elif project_scoped and project_hit_count == 0:
        reason = "project_memory_missing"
    else:
        reason = "public_or_current_evidence_needed"
    return {
        "t": "memory_audit",
        "project_scoped": project_scoped,
        "project_id": blackboard.get("project_id"),
        "source": source,
        "project_hits": project_hit_count,
        "org_fallback_used": bool(blackboard.get("org_fallback_used")),
        "org_fallback_hits": int(blackboard.get("org_fallback_hit_count", 0) or 0),
        "memory_hits": hit_count,
        "confidence": float(blackboard.get("confidence", 0) or 0),
        "web_allowed": bool(web_allowed),
        "web_reason": reason,
        "template": room_template,
    }


async def _build_web_intel_agent_for_room(
    room_id: str,
    emp: Dict[str, Any],
    user_id: str,
    org_id: str,
    project_id: Optional[str],
) -> ReActAgent:
    """Build the one web-enabled Hyper agent for this turn.

    Fallback path when the direct Groq Compound web pass is unavailable.
    This agent gets the Hivemind web MCP tools plus normal HIVEMIND read
    tools, and it is the only agent allowed to browse on behalf of the room.
    """
    synthetic = {
        **emp,
        "id": f"{room_id}:web-intel",
        "slug": emp.get("slug") or "web-intel",
        "name": emp.get("name") or "Web Intel",
        "role_archetype": "Researcher",
        "persona": (
            "You are the room's dedicated external-intelligence specialist. "
            "Use web access only when the current room turn needs public or live "
            "evidence. Prefer Hivemind memory first, browse only for gaps, and "
            "return a concise evidence dossier with sources, caveats, and a clear POV."
        ),
        "llm_provider": os.environ.get("HYPER_WEB_INTEL_PROVIDER", "groq"),
        "model": os.environ.get("HYPER_WEB_INTEL_MODEL", "gpt-oss-20b"),
        "tools": DEFAULT_HYPER_TOOLS + WEB_INTEL_TOOLS,
        "max_iters": int(os.environ.get("HYPER_WEB_INTEL_MAX_ITERS", "2")),
    }
    return await _build_agent_for_room(
        room_id,
        synthetic,
        user_id=user_id,
        org_id=org_id,
        project_id=project_id,
        allow_web_tools=True,
    )


def _format_web_intel_context(payload: Dict[str, Any]) -> str:
    if not payload:
        return ""
    lines = ["WEB INTEL DOSSIER (dedicated HyperAgents web worker):"]
    if payload.get("pov"):
        lines.append(f"[pov] {payload['pov']}")
    if payload.get("answer"):
        lines.append(f"[answer] {payload['answer']}")
    if payload.get("sources"):
        src_lines = []
        for src in payload["sources"][:6]:
            if isinstance(src, dict):
                title = (src.get("title") or src.get("url") or "source").strip()
                url = (src.get("url") or "").strip()
                snippet = (src.get("snippet") or "").strip()
                src_lines.append(f"- {title}" + (f" ({url})" if url else "") + (f": {snippet}" if snippet else ""))
            else:
                src_lines.append(f"- {str(src)[:250]}")
        if src_lines:
            lines.append("[sources]")
            lines.extend(src_lines)
    if payload.get("gap"):
        lines.append(f"[gap] {payload['gap']}")
    if payload.get("confidence") is not None:
        lines.append(f"[confidence] {payload['confidence']}")
    lines.append(
        "Use this dossier as the only external evidence in the room. Other agents should "
        "consume it from shared context rather than browsing themselves."
    )
    return "\n".join(lines)


def _web_sources_for_turn(turn_id: str) -> List[Dict[str, Any]]:
    payload = _WEB_INTEL_PAYLOADS.get(turn_id) or {}
    sources = payload.get("sources")
    return sources if isinstance(sources, list) else []


def _join_context(*parts: str) -> str:
    return "\n".join(part.strip() for part in parts if part and part.strip())


def _room_goal_context(goal: Optional[str]) -> str:
    clean = re.sub(r"\s+", " ", str(goal or "")).strip()
    if not clean:
        return ""
    return (
        "ROOM GOAL — the standing objective for this room. Every agent should "
        "optimize the discussion toward this outcome, not only answer the latest message:\n"
        f"{clean}\n"
    )


def _compact_report_item(value: Any, limit: int = 260) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return ""
    return text[:limit].rstrip() + ("..." if len(text) > limit else "")


def _goal_terms(goal: str) -> List[str]:
    stop = {
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
        "is", "it", "of", "on", "or", "our", "that", "the", "their", "this",
        "to", "toward", "we", "with", "within",
    }
    terms: List[str] = []
    for raw in re.findall(r"[a-z0-9][a-z0-9\-]{2,}", str(goal or "").lower()):
        if raw not in stop and raw not in terms:
            terms.append(raw)
    return terms[:18]


def _build_goal_progress(
    *,
    room_goal: str,
    final_text: str,
    action_items: Optional[List[Any]],
    evidence_count: int,
    source_count: int,
    claims_count: int,
    dissent_count: int,
    status: str,
) -> Dict[str, Any]:
    goal = _compact_report_item(room_goal, 500)
    if not goal:
        return {
            "status": "missing_goal",
            "score": 0,
            "label": "No room goal",
            "summary": "This turn cannot be scored against a standing objective because the room has no goal.",
            "signals": [],
        }
    terms = _goal_terms(goal)
    body = f"{final_text or ''} {' '.join(_compact_report_item(a, 160) for a in (action_items or []))}".lower()
    matched = [term for term in terms if term in body]
    coverage = (len(matched) / max(len(terms), 1)) if terms else 0.35
    score = 35
    score += min(30, round(coverage * 30))
    if final_text and len(final_text.strip()) >= 80:
        score += 10
    if action_items:
        score += 10
    if evidence_count:
        score += 8
    if source_count:
        score += 4
    if claims_count >= 2:
        score += 5
    if dissent_count:
        score += 3
    if status in ("failed", "escalated"):
        score -= 15
    score = max(0, min(100, int(score)))
    if score >= 78:
        label = "On track"
        progress_status = "on_track"
    elif score >= 55:
        label = "Partially advanced"
        progress_status = "partial"
    else:
        label = "Needs follow-up"
        progress_status = "needs_followup"
    signals = []
    if matched:
        signals.append(f"Goal terms reflected: {', '.join(matched[:6])}")
    if action_items:
        signals.append(f"{len(action_items[:8])} next action(s) captured")
    if evidence_count:
        signals.append(f"{evidence_count} memory evidence link(s)")
    if source_count:
        signals.append(f"{source_count} web source(s)")
    if dissent_count:
        signals.append(f"{dissent_count} dissent/risk signal(s) preserved")
    if not signals:
        signals.append("No strong progress signals detected")
    summary = (
        f"{label}: this turn moved the room goal forward with {evidence_count} memory link(s)"
        f"{' and ' + str(source_count) + ' web source(s)' if source_count else ''}."
    )
    return {
        "status": progress_status,
        "score": score,
        "label": label,
        "summary": summary,
        "matched_terms": matched[:8],
        "signals": signals[:6],
    }


def _build_harness_quality_check(
    *,
    room_goal: str,
    final_text: str,
    evidence_count: int,
    source_count: int,
    claims_count: int = 0,
    reviews_count: int = 0,
    votes_count: int = 0,
    web_intel_used: bool = False,
    project_scoped: bool = False,
    project_memory_hits: int = 0,
) -> Dict[str, Any]:
    checks = [
        {"name": "room_goal", "ok": bool(_compact_report_item(room_goal, 20)), "detail": "standing objective present"},
        {"name": "final_synthesis", "ok": bool(final_text and len(final_text.strip()) >= 60), "detail": "lead conclusion is substantive"},
        {"name": "evidence_links", "ok": evidence_count > 0 or source_count > 0, "detail": f"{evidence_count} linked memories, {source_count} linked sources"},
        {"name": "project_memory_first", "ok": (not project_scoped) or project_memory_hits > 0 or not web_intel_used, "detail": f"{project_memory_hits} project memory hits before web"},
        {"name": "web_sources", "ok": (not web_intel_used) or source_count > 0, "detail": f"{source_count} linked sources"},
        {"name": "perspective_trace", "ok": claims_count > 0 or reviews_count > 0 or votes_count > 0, "detail": f"{claims_count} claims, {reviews_count} reviews, {votes_count} votes"},
    ]
    failed = [c["name"] for c in checks if not c["ok"]]
    return {
        "t": "harness_check",
        "status": "pass" if not failed else "warn",
        "failed": failed,
        "checks": checks,
        "cleanup": {
            "bounded_memory_links": min(evidence_count, 12),
            "bounded_source_links": min(source_count, 8),
            "report_sections": ["conclusion", "goal_progress", "actions", "perspectives", "risks", "evidence"],
        },
    }


def _build_final_report(
    *,
    user_message: str,
    final_text: str,
    template: str,
    room_goal: str = "",
    status: str = "complete",
    verdict: Optional[str] = None,
    score: Optional[float] = None,
    lead: Optional[Dict[str, Any]] = None,
    action_items: Optional[List[Any]] = None,
    evidence_ids: Optional[List[Any]] = None,
    evidence: Optional[List[Dict[str, Any]]] = None,
    sources: Optional[List[Dict[str, Any]]] = None,
    claims: Optional[List[Dict[str, Any]]] = None,
    reviews: Optional[List[Dict[str, Any]]] = None,
    votes: Optional[List[Dict[str, Any]]] = None,
    objections: Optional[List[Any]] = None,
    web_intel_used: bool = False,
    project_scoped: bool = False,
    project_memory_hits: int = 0,
) -> Dict[str, Any]:
    """Build a readable report event from already-computed room artifacts.

    This intentionally avoids a post-turn LLM call: the report should make the
    transcript consumable without adding latency after the simulation finishes.
    """
    title = "Final report"
    verdict_text = verdict or status or "complete"
    lead_name = (lead or {}).get("name") or (lead or {}).get("slug") or "lead"
    lines: List[str] = [
        f"## {title}",
        "",
        f"**Question:** {_compact_report_item(user_message, 500)}",
        f"**Room goal:** {_compact_report_item(room_goal, 500)}" if room_goal else "",
        f"**Outcome:** {verdict_text}" + (f" · score {score}" if score is not None else ""),
        f"**Lead:** {lead_name}",
        "",
        "### Conclusion",
        _compact_report_item(final_text, 2400) or "No final synthesis was produced.",
    ]

    useful_actions = [_compact_report_item(a, 220) for a in (action_items or [])]
    useful_actions = [a for a in useful_actions if a]
    if useful_actions:
        lines.extend(["", "### Next actions"])
        lines.extend(f"- {a}" for a in useful_actions[:8])

    if claims:
        lines.extend(["", "### Strongest perspectives"])
        for claim in claims[:6]:
            who = claim.get("agent") or claim.get("agent_slug") or claim.get("agent_name") or "agent"
            stance = claim.get("stance") or claim.get("lane") or "view"
            body = claim.get("claim") or claim.get("hypothesis") or claim.get("refined_hypothesis") or ""
            item = _compact_report_item(body, 260)
            if item:
                lines.append(f"- {who} ({stance}): {item}")

    challenge_items: List[str] = []
    for obj in objections or []:
        if isinstance(obj, dict):
            challenge_items.append(_compact_report_item(
                obj.get("challenge") or obj.get("content") or obj.get("review") or obj.get("line") or obj,
                260,
            ))
        else:
            challenge_items.append(_compact_report_item(obj, 260))
    if reviews:
        for review in reviews:
            if str(review.get("agreement", "")).lower() == "challenge":
                challenge_items.append(_compact_report_item(review.get("content") or review.get("review"), 260))
    challenge_items = [c for c in challenge_items if c]
    if challenge_items:
        lines.extend(["", "### Risks and dissent"])
        lines.extend(f"- {c}" for c in challenge_items[:6])
    if project_scoped and web_intel_used and project_memory_hits == 0:
        lines.extend([
            "",
            "### Harness warning",
            "- Project memory returned no direct hits before web-intel ran. Treat the answer as externally biased until Solvis/project memories are added or re-scoped.",
        ])

    if votes:
        lines.extend(["", "### Vote snapshot"])
        for vote in votes[:8]:
            voter = vote.get("voter") or vote.get("agent") or "agent"
            target = vote.get("vote_for_hypothesis_id") or vote.get("vote") or "none"
            vote_score = vote.get("score")
            reason = vote.get("reason") or vote.get("content") or ""
            lines.append(f"- {voter}: {target}" + (f" · {vote_score}/5" if vote_score is not None else "") + (f" · {_compact_report_item(reason, 160)}" if reason else ""))

    evidence_rows = []
    for row in evidence or []:
        if not isinstance(row, dict):
            continue
        mid = str(row.get("id") or row.get("memory_id") or "").strip()
        if not mid:
            continue
        evidence_rows.append({
            "id": mid,
            "title": _compact_report_item(row.get("title") or row.get("content") or "Memory", 90),
            "snippet": _compact_report_item(row.get("content") or "", 220),
        })
    known_ids = {row["id"] for row in evidence_rows}
    for mid in [str(e) for e in (evidence_ids or []) if e]:
        if mid not in known_ids:
            evidence_rows.append({"id": mid, "title": "Memory evidence", "snippet": ""})
            known_ids.add(mid)
    source_rows = []
    for src in sources or []:
        if not isinstance(src, dict):
            continue
        url = str(src.get("url") or "").strip()
        title = _compact_report_item(src.get("title") or url or "Source", 120)
        if url or title:
            source_rows.append({
                "title": title,
                "url": url,
                "snippet": _compact_report_item(src.get("snippet") or "", 220),
            })
    dissent_count = len(challenge_items)
    progress = _build_goal_progress(
        room_goal=room_goal,
        final_text=final_text,
        action_items=action_items,
        evidence_count=len(evidence_rows),
        source_count=len(source_rows),
        claims_count=len(claims or []),
        dissent_count=dissent_count,
        status=status,
    )
    lines.extend([
        "",
        "### Goal progress",
        f"**{progress['label']} · {progress['score']}/100**",
        progress["summary"],
    ])
    for signal in progress.get("signals", [])[:4]:
        lines.append(f"- {signal}")
    if evidence_rows or source_rows or web_intel_used:
        lines.extend(["", "### Evidence"])
        if evidence_rows:
            lines.append(f"- {len(evidence_rows[:12])} relevant memories are linked below.")
        if source_rows:
            lines.append(f"- {len(source_rows[:8])} web sources are linked below.")
        if web_intel_used:
            lines.append("- External web-intel dossier was consulted for public/current evidence.")

    return {
        "t": "final_report",
        "title": title,
        "template": template,
        "status": status,
        "verdict": verdict_text,
        "weighted_score": score,
        "room_goal": room_goal or "",
        "goal_progress": progress,
        "project_memory_hits": project_memory_hits,
        "project_scoped": project_scoped,
        "evidence": evidence_rows[:12],
        "sources": source_rows[:8],
        "content": "\n".join(lines).strip(),
    }


async def _run_groq_compound_web_intel(
    req: "RoomTurnRequest",
    lead: Dict[str, Any],
    blackboard: Dict[str, Any],
    memory_context: str,
    room_template: str,
) -> Dict[str, Any]:
    api_key = (
        os.environ.get("HYPER_WEB_INTEL_GROQ_API_KEY")
        or os.environ.get("GROQ_API_KEY")
        or os.environ.get("LLM_API_KEY")
        or ""
    )
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not configured for web intel")
    model = os.environ.get("HYPER_WEB_INTEL_GROQ_MODEL", "groq/compound")
    groq_version = os.environ.get("HYPER_WEB_INTEL_GROQ_VERSION", "latest")
    prompt = (
        "You are the dedicated web-intelligence worker for one HyperAgents room turn.\n"
        "Use Hivemind memory first. If the answer is already covered by the shared room context, "
        "do not browse. If the turn needs live public evidence, use the built-in Compound web tools.\n"
        "Return STRICT JSON only with this schema:\n"
        "{\"needed\": true|false, \"pov\": \"one sentence on the angle you chose\", "
        "\"answer\": \"concise external evidence summary\", "
        "\"sources\": [{\"title\":\"...\", \"url\":\"...\", \"snippet\":\"...\"}], "
        "\"gap\": \"what remains unverified, if anything\", "
        "\"confidence\": 0.0-1.0}\n\n"
        f"Lead lane: {lead['_lane']}\n"
        f"Room template: {room_template}\n"
        f"User message:\n{req.user_message}\n\n"
        f"Shared memory context:\n{memory_context or '(none)'}\n\n"
        f"Blackboard confidence: {blackboard.get('confidence', 0)}\n"
        f"Blackboard hits: {blackboard.get('hit_count', 0)}\n"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a precise web-intelligence analyst. Stay factual and concise."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "compound_custom": {"tools": {"enabled_tools": list(WEB_INTEL_GROQ_TOOLS)}},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Groq-Model-Version": groq_version,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        resp = await client.post("https://api.groq.com/openai/v1/chat/completions", headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = (message.get("content") or "").strip()
    payload_out: Dict[str, Any] = {}
    if text:
        try:
            m = re.search(r"\{[\s\S]+\}", text)
            if m:
                parsed = json.loads(m.group(0))
                if isinstance(parsed, dict):
                    payload_out = parsed
        except Exception as exc:  # noqa: BLE001
            log.warning("[web-intel] groq parse failed turn=%s: %s", req.turn_id, exc)
    if not payload_out:
        payload_out = {
            "needed": True,
            "pov": "external evidence specialist",
            "answer": text[:3000] if text else "",
            "sources": [],
            "gap": "",
            "confidence": 0.5,
        }
    if not isinstance(payload_out.get("sources"), list):
        payload_out["sources"] = []
    return payload_out


async def _run_web_intel_turn(
    req: "RoomTurnRequest",
    lead: Dict[str, Any],
    blackboard: Dict[str, Any],
    memory_context: str,
    room_template: str,
) -> str:
    if not _web_intel_needed(req.user_message, blackboard, room_template):
        return ""
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "typing", "agent": "web-intel", "kind": "web_intel",
    })
    try:
        payload = await _run_groq_compound_web_intel(
            req=req,
            lead=lead,
            blackboard=blackboard,
            memory_context=memory_context,
            room_template=room_template,
        )
    except Exception as groq_exc:  # noqa: BLE001
        log.warning("[web-intel] groq compound failed turn=%s: %s — falling back to Hivemind web tools",
                    req.turn_id, groq_exc)
        web_agent = await _build_web_intel_agent_for_room(
            req.room_id,
            lead,
            user_id=req.user_id,
            org_id=req.org_id,
            project_id=req.project_id,
        )
        prompt = (
            "[WEB INTEL — dedicated external evidence worker for this HyperAgents turn.]\n"
            "Use Hivemind recall first, then browse only if needed. Do not browse if the answer is already in memory.\n"
            f"Lead lane: {lead['_lane']}\n"
            f"User message:\n{req.user_message}\n\n"
            f"Shared memory context:\n{memory_context or '(none)'}\n\n"
            "Return STRICT JSON only:\n"
            "{\"needed\": true|false, \"pov\": \"one sentence on the angle you chose\", "
            "\"answer\": \"concise external evidence summary\", "
            "\"sources\": [{\"title\":\"...\", \"url\":\"...\", \"snippet\":\"...\"}], "
            "\"gap\": \"what remains unverified, if anything\", "
            "\"confidence\": 0.0-1.0}"
        )
        try:
            reply = await web_agent(Msg(name="user", content=prompt, role="user"))
            text = _msg_to_text(reply)
            payload = {}
            try:
                m = re.search(r"\{[\s\S]+\}", text)
                if m:
                    parsed = json.loads(m.group(0))
                    if isinstance(parsed, dict):
                        payload = parsed
            except Exception as exc:  # noqa: BLE001
                log.warning("[web-intel] parse failed turn=%s: %s", req.turn_id, exc)
            if not payload:
                payload = {
                    "needed": True,
                    "pov": "external evidence specialist",
                    "answer": text[:3000],
                    "sources": [],
                    "gap": "",
                    "confidence": 0.5,
                }
            if not isinstance(payload.get("sources"), list):
                payload["sources"] = []
        except Exception as exc:  # noqa: BLE001
            log.warning("[web-intel] turn=%s failed: %s", req.turn_id, exc)
            return ""
    dossier = _format_web_intel_context(payload)
    if dossier:
        _WEB_INTEL_PAYLOADS[req.turn_id] = payload
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "web_intel",
            "agent": "web-intel",
            "content": payload.get("answer") or "",
            "sources": payload.get("sources") or [],
            "gap": payload.get("gap") or "",
            "confidence": float(payload.get("confidence") or 0.5),
        })
    return dossier


def _report_turn(emp_id: str, query: str, reply: Optional[Msg]) -> None:
    """Best-effort fire-and-forget per-turn metrics + eval for one agent
    bubble. Mirrors the token-extract block in api_employee_chat.py:
    reply.usage || reply.metadata.usage -> total_tokens or input+output.
    Schedules report_metrics + report_eval as background tasks; never
    raises (metrics/eval are non-critical to the turn)."""
    _tok = 0
    try:
        _u = getattr(reply, "usage", None) or (getattr(reply, "metadata", None) or {}).get("usage")
        if isinstance(_u, dict):
            _tok = int(_u.get("total_tokens")
                       or (int(_u.get("input_tokens", 0)) + int(_u.get("output_tokens", 0)))
                       or 0)
    except Exception:  # noqa: BLE001 — metrics are non-critical
        _tok = 0
    asyncio.create_task(report_metrics(emp_id, tokens=_tok, messages=1))
    asyncio.create_task(report_eval(emp_id, query, _msg_to_text(reply)))


# ─── Reactor "quiet-check" — cheap JSON pass ───────────────────────────

REACTOR_INSTRUCTIONS = """\
You are an EMPLOYEE at HIVEMIND — a teammate, not an outside expert.
The Lead colleague just spoke. ENGAGE when the topic touches your lane —
silence only when the topic is clearly outside your expertise AND you have
no memory evidence to add. The room expects active multi-voice debate, not
a monologue. Use your hivemind tools (recall / traverse / web) if you need
to ground a counter-point.

Reply in STRICT JSON ONLY (no preamble, no code fence):
{
  "react": true | false,
  "agreement": "agree" | "extend" | "challenge",
  "confidence": 0.0 - 1.0,
  "line": "...",  // ONE sentence, max ~25 words, Slack tone
  "evidence": ["[user_fact:value] 20 users", "memory title"],  // optional, max 3
  "gap": "the still-open risk or missing proof"                 // required when challenging
}

Hard rules:
- ONE sentence, ~25 words max. Conversational, 'we / our' voice, no headers, no bullets.
- The line must be a CONCRETE point, fact, risk, or counter — NOT a suggestion to do
  something later. BANNED: "let's recall", "we should consider", "let's clarify",
  "let's also look at", "we need to check". If all you have is a process suggestion,
  stay silent: {"react": false}.
- Cite concrete evidence when challenging — name the memory or person.
- If challenging, compare the current [user_fact] state and [memory] state first.
  Do not claim a detail is missing when the current user message already supplied it.
- STICK TO THE USER'S TOPIC. Do not pivot to project management — no inventing
  owners, dates, deadlines, or sub-task assignments. If the memory doesn't name
  a person responsible, you don't either.
- DO NOT invent facts. If you're not sure, stay silent: {"react": false}.
- "challenge" only with a substantive counter-point (state the actual risk/flaw).
- "extend" only if you add a NEW concrete fact or angle the Lead missed.
- "agree" only if you add a real +1 (skip if you'd just say 'I agree').
- Role voices:
    Skeptic       — surface risk, demand evidence
    Researcher    — cite data / recall outcomes
    Builder       — ask "how does this ship?"
    Communicator  — translate / reframe for clarity
    Strategist    — pull back to goals / sequencing
- If silent: return {"react": false} only.
"""


async def _run_reactor(
    agent: ReActAgent,
    user_message: str,
    lead_line: str,
    lead_name: str,
    reactor_lane: str,
    is_opposing: bool,
    blackboard_context: str = "",
    current_turn_state: str = "",
) -> Dict[str, Any]:
    """Returns a dict like
        {"react": bool, "agreement": str|None, "confidence": float, "line": str}
    """
    bias = " (Your lane is opposing the Lead's — speak up if you have a real challenge.)" if is_opposing else ""
    prompt = (
        f"{REACTOR_INSTRUCTIONS}\n"
        + (
            "SHARED BLACKBOARD — already recalled for this turn. Use this before tools; "
            "only call tools for one targeted missing fact.\n"
            f"{blackboard_context}\n"
            if blackboard_context else ""
        )
        + (current_turn_state + "\n" if current_turn_state else "")
        + f"User asked: {user_message}\n\n"
        + f"Lead ({lead_name}, lane {reactor_lane}'s opposite={is_opposing}) said:\n"
        + f"{lead_line}\n\n"
        + f"Your lane: {reactor_lane}.{bias}\n"
        + f"Reply with the JSON now."
    )
    try:
        reply = await agent(Msg(name="user", content=prompt, role="user"))
        text = _msg_to_text(reply)
        # Strip code fences
        m = re.search(r"\{[\s\S]+\}", text)
        if not m:
            return {"react": False}
        parsed = json.loads(m.group(0))
        if not parsed.get("react"):
            return {"react": False}
        line = (parsed.get("line") or "").strip()
        if not line:
            return {"react": False}
        return {
            "react": True,
            "agreement": parsed.get("agreement") or "extend",
            "confidence": float(parsed.get("confidence") or 0.5),
            "line": line[:2000],
            "gap": str(parsed.get("gap") or "")[:500],
            "evidence": [str(x)[:160] for x in (parsed.get("evidence") or [])[:6]] if isinstance(parsed.get("evidence"), list) else [],
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("reactor failed: %s", exc)
        return {"react": False}


# ─── Pydantic ──────────────────────────────────────────────────────────


class RoomTurnRequest(BaseModel):
    room_id: str
    turn_id: str
    user_id: str
    org_id: str
    user_message: str = Field(min_length=1, max_length=8000)
    participant_ids: List[str] = Field(default_factory=list)
    callback_url: Optional[str] = None
    flyby_decision: Optional[str] = None
    flyby_spec: Optional[Dict[str, Any]] = None
    # Project scope: when set, every agent recall/save in this turn is scoped to
    # the project HIVEMIND so the room stays about that project.
    project_id: Optional[str] = None
    room_goal: Optional[str] = None
    # Phase 4 — write-approval policy: "ask" holds side-effectful connector
    # writes for the user's approval; "auto" lets them fire. When unset, the
    # gate defaults to "ask" if the room has connectors enabled, else "auto".
    write_policy: Optional[str] = None


class RoomTurnResponse(BaseModel):
    ok: bool
    cost_tokens: int
    status: str
    # Phase 4 — writes the team queued for the user's approval this turn (each
    # carries approval_id/label/summary; the side effect has NOT fired yet).
    pending_approvals: Optional[List[Dict[str, Any]]] = None
    # Phase 5 — recon/verify verdict vs the lead's done_criterion
    # {met, artifact_ok, assignments_ok, grounded_ok, gaps[], note}.
    verification: Optional[Dict[str, Any]] = None


class ApprovalDecisionRequest(BaseModel):
    approval_id: str
    decision: str  # "approve" | "deny"


# ─── Meeting-template overlays (Phase 4 PR-3) ──────────────────────────
# Eight AI-Company-inspired templates. Each one injects a prompt prelude
# into the lead/synth pipeline so the same orchestrator flow yields
# topic-appropriate behaviour (e.g. retrospective wants "what worked / what
# didn't / actions", standup wants status report, etc.). Phase-machine
# stays the SAME — only the framing differs. Avoids 8 forked orchestrators.
TEMPLATE_OVERLAYS: Dict[str, Dict[str, str]] = {
    "debate": {
        "label": "Debate",
        "lead_hint": "",
        "synth_hint": "",
    },
    "decision": {
        "label": "Decision (DACI)",
        "lead_hint": (
            "MEETING MODE: DACI Decision. Lead is Driver. Bias toward committing "
            "to one path with explicit Approver / Consulted / Informed if memory "
            "names them. Output must end with a clear COMMITMENT line."
        ),
        "synth_hint": "End with: 'DECISION: ...' on its own line.",
    },
    "swarm": {
        "label": "Swarm (R1-R5)",
        "lead_hint": "",
        "synth_hint": "",
    },
    "brainstorm": {
        "label": "Brainstorm",
        "lead_hint": (
            "MEETING MODE: Brainstorm. Generative-only. Suspend criticism. "
            "Encourage volume + variety. Skeptic challenges still allowed but "
            "should propose NEW options rather than kill existing ones."
        ),
        "synth_hint": (
            "Output: top 5-8 ideas as a bulleted list, sorted by novelty + "
            "feasibility. No premature pick. No 'best option'."
        ),
    },
    "council": {
        "label": "Council (majority vote)",
        "lead_hint": (
            "MEETING MODE: Council. Each participant is an expert peer. Lead is "
            "facilitator, not decision-maker. Final outcome requires majority "
            "APPROVE (3/5 or higher)."
        ),
        "synth_hint": (
            "Output: APPROVED / CONDITIONAL / REJECTED based on vote count. "
            "List the conditions explicitly when CONDITIONAL."
        ),
    },
    "lean_coffee": {
        "label": "Lean Coffee",
        "lead_hint": (
            "MEETING MODE: Lean Coffee. Rotate through 2-3 sub-topics in the "
            "user's question. Time-box each. Light, exploratory. No deep dive."
        ),
        "synth_hint": "Output: per-topic 2-3 sentences. End with 'Carry forward: …'.",
    },
    "retrospective": {
        "label": "Retrospective",
        "lead_hint": (
            "MEETING MODE: Retrospective. Frame answer as: WHAT WORKED / WHAT "
            "DIDN'T / WHAT TO CHANGE. Pull memory evidence for each bucket. "
            "Skeptic emphasises what didn't work."
        ),
        "synth_hint": (
            "Output STRICT structure:\n"
            "WHAT WORKED:\n- ...\nWHAT DIDN'T:\n- ...\nWHAT TO CHANGE:\n- ..."
        ),
    },
    "review": {
        "label": "Review (checklist)",
        "lead_hint": (
            "MEETING MODE: Review. Treat the user's question as something to "
            "evaluate against a checklist. Each reactor scores one dimension. "
            "Skeptic surfaces missed criteria."
        ),
        "synth_hint": (
            "Output: dimension-by-dimension verdict + overall PASS / NEEDS_WORK / FAIL."
        ),
    },
    "standup": {
        "label": "Standup",
        "lead_hint": (
            "MEETING MODE: Standup. Status report. Brief. Each participant: "
            "YESTERDAY / TODAY / BLOCKERS based on memory. No deep deliberation."
        ),
        "synth_hint": (
            "Output STRICT structure per participant if relevant, or merged:\n"
            "YESTERDAY: ...\nTODAY: ...\nBLOCKERS: ..."
        ),
    },
    "deep_sim": {
        "label": "Deep Simulation",
        "lead_hint": (
            "MEETING MODE: Deep Simulation. Build a live Slack-style simulation: "
            "ontology/capability check, specialist flyby if needed, then propose, "
            "peer-review, revise, vote, and conclude."
        ),
        "synth_hint": "Output a decisive conclusion with assumptions, risks, and next decisions.",
    },
}


# Auto-pick template from user message via keyword scoring (no LLM, cheap).
# Returns template key or None when caller already specified one.
_TEMPLATE_KEYWORDS: Dict[str, List[str]] = {
    "decision": ["should we", "decide", "go/no-go", "commit", "approve", "pick one"],
    "brainstorm": ["brainstorm", "ideas", "what could", "options for", "how might we"],
    "council": ["vote", "council", "team think", "majority", "everyone's take"],
    "lean_coffee": ["talk through", "discuss multiple", "couple topics", "quick chat"],
    "retrospective": ["retro", "retrospective", "what went wrong", "what worked", "post-mortem", "postmortem"],
    "review": ["review", "evaluate", "score", "rate", "audit this", "check this"],
    "standup": ["status", "where are we", "what's the state", "standup", "stand-up"],
    "swarm": ["why", "what do you all think", "from every angle", "perspectives", "team analysis"],
    "deep_sim": ["simulate", "simulation", "real life", "real-life", "2-5 years", "long term", "future scenario", "all perspectives"],
}


def recommend_template(user_message: str, default: str = "debate") -> str:
    """Score templates by keyword presence in user message. Returns best
    match or default. No LLM call — cheap heuristic. Set
    ROOM_TEMPLATE_AUTO_PICK=true env to enable in orchestrator."""
    if not user_message:
        return default
    msg = user_message.lower()
    best, best_score = default, 0
    for tpl, keys in _TEMPLATE_KEYWORDS.items():
        score = sum(1 for k in keys if k in msg)
        if score > best_score:
            best_score = score
            best = tpl
    return best


def _is_deep_sim_prompt(user_message: str) -> bool:
    msg = (user_message or "").lower()
    triggers = (
        "simulate", "simulation", "real life", "real-life", "long simulation",
        "2-5 years", "2 to 5 years", "long term", "future scenario",
        "all perspectives", "like mirofish", "mirofish",
    )
    return any(t in msg for t in triggers)


def get_template_overlay(template: str) -> Dict[str, str]:
    return TEMPLATE_OVERLAYS.get(template, TEMPLATE_OVERLAYS.get("debate", {}))


# ─── Deep simulation (MiroFish-style live room) ────────────────────────

DEEP_SIM_ROLES: Dict[str, List[str]] = {
    "strategist": ["strategy", "growth", "roadmap", "pricing", "gtm", "market", "profit", "moat"],
    "finance": ["finance", "revenue", "arr", "margin", "profit", "cash", "runway", "unit economics", "pricing"],
    "builder": ["build", "product", "engineering", "infra", "code", "platform", "scale", "technical"],
    "skeptic": ["risk", "legal", "compliance", "security", "failure", "downside", "assumption", "audit"],
    "researcher": ["research", "evidence", "data", "customer", "market", "competitive", "benchmark"],
    "communicator": ["sales", "partner", "message", "brand", "customer", "story", "positioning"],
}


def _employee_role_text(emp: Dict[str, Any]) -> str:
    return " ".join(
        str(emp.get(k, "") or "")
        for k in ("name", "slug", "persona", "roleArchetype", "_lane")
    ).lower()


def _build_task_ontology(user_message: str) -> Dict[str, Any]:
    msg = (user_message or "").lower()
    required = {"strategist", "skeptic", "researcher", "communicator"}
    if any(k in msg for k in DEEP_SIM_ROLES["finance"]):
        required.add("finance")
    if any(k in msg for k in DEEP_SIM_ROLES["builder"]):
        required.add("builder")
    if len(user_message.split()) > 18 or any(k in msg for k in ("long term", "2-5", "future", "scenario", "simulate")):
        required.update({"finance", "builder"})
    entity_types = ["Question", "Organization", "Person", "Product", "Market", "Customer", "Risk", "Constraint", "Opportunity", "Decision"]
    edge_types = ["supports", "contradicts", "depends_on", "owned_by", "impacts", "requires_review"]
    return {
        "mode": "deepresearch",
        "entity_types": entity_types,
        "edge_types": edge_types,
        "required_roles": sorted(required),
        "rounds": ["collect", "debate", "revise", "vote", "conclude"],
        "gate_policy": {
            "min_roles_covered": min(4, len(required)),
            "reviewed_ratio": 0.75,
            "requires_provenance": True,
        },
    }


def _assess_workforce_coverage(participants: List[Dict[str, Any]], ontology: Dict[str, Any]) -> Dict[str, Any]:
    coverage: Dict[str, List[str]] = {}
    for role in ontology.get("required_roles", []):
        hints = DEEP_SIM_ROLES.get(role, [])
        matched: List[str] = []
        for emp in participants:
            text = _employee_role_text(emp)
            lane = (emp.get("_lane") or "").lower()
            if role == "strategist" and lane == "strategist":
                matched.append(emp["slug"])
            elif role == "builder" and lane == "builder":
                matched.append(emp["slug"])
            elif role == "skeptic" and lane == "skeptic":
                matched.append(emp["slug"])
            elif role == "researcher" and lane == "researcher":
                matched.append(emp["slug"])
            elif role == "communicator" and lane == "communicator":
                matched.append(emp["slug"])
            elif any(h in text for h in hints):
                matched.append(emp["slug"])
        coverage[role] = sorted(set(matched))
    missing = [role for role, slugs in coverage.items() if not slugs]
    critical_missing = [role for role in missing if role in ("finance", "builder", "skeptic", "researcher")]
    return {
        "coverage": coverage,
        "missing_roles": missing,
        "needs_flyby": bool(critical_missing),
        "critical_missing": critical_missing,
    }


def _build_flyby_spec(req: "RoomTurnRequest", assessment: Dict[str, Any]) -> Dict[str, Any]:
    candidates = assessment.get("critical_missing") or assessment.get("missing_roles") or ["finance"]
    msg = (req.user_message or "").lower()
    if "finance" in candidates and any(k in msg for k in DEEP_SIM_ROLES["finance"]):
        role = "finance"
    else:
        priority = ["skeptic", "finance", "builder", "researcher", "strategist", "communicator"]
        role = next((p for p in priority if p in candidates), candidates[0])
    title = {
        "finance": "Unit Economics CFO",
        "builder": "Systems Builder",
        "skeptic": "Red-Team Operator",
        "researcher": "Market Evidence Analyst",
    }.get(role, f"{role.title()} Specialist")
    slug = f"flyby-{role}"
    return {
        "id": f"flyby:{req.turn_id}:{role}",
        "name": title,
        "slug": slug,
        "role": role,
        "roleArchetype": "Skeptic" if role == "skeptic" else ("Builder" if role == "builder" else "Researcher"),
        "llm_provider": "groq",
        "model": os.environ.get("GROQ_INFERENCE_MODEL", "openai/gpt-oss-20b"),
        "persona": (
            f"Temporary flyby employee for this room only. You are a high-conviction {title}. "
            "Speak like an internal operator with a strong point of view. Challenge weak assumptions, "
            "use company memory when available, and make enterprise-grade tradeoffs explicit."
        ),
        "reason": f"The current room does not visibly cover the {role} lens needed for this question.",
    }


def _participant_brief(participants: List[Dict[str, Any]]) -> str:
    return "\n".join(
        f"- {p.get('name', p.get('slug'))} ({p.get('slug')}, lane={p.get('_lane')}): "
        f"{str(p.get('persona') or '')[:180]}"
        + (
            f" | contract={((p.get('hyper') or {}).get('persona_contract') or p.get('persona_contract') or {}).get('stance', '')}"
            if ((p.get('hyper') or {}).get('persona_contract') or p.get('persona_contract'))
            else ""
        )
        for p in participants
    )


async def _build_deep_sim_role_context(
    *,
    query: str,
    participants: List[Dict[str, Any]],
    user_id: str,
    org_id: str,
    api_key: str = "",
    project_id: Optional[str] = None,
) -> Dict[str, str]:
    """Persona-specific recall packs for deep simulations.

    MiroFish gives each spawned persona a world/profile slice. This gives each
    existing HyperAgent an equivalent lens-specific evidence pack while still
    sharing one blackboard.
    """
    async def _recall_for(emp: Dict[str, Any]) -> str:
        lane = emp.get("_lane") or derive_lane(emp)
        slug = emp.get("slug", "agent")
        role_terms = " ".join(DEEP_SIM_ROLES.get(lane.lower(), [])) or lane
        probes = [
            f"{query} {lane} perspective {role_terms}",
            f"{query} risks evidence constraints for {slug}",
            f"{query} decisions revenue customers product roadmap",
        ]
        rows: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        for probe in probes:
            try:
                resp = await recall_emulated(
                    probe,
                    user_id=user_id,
                    org_id=org_id,
                    api_key=api_key,
                    max_memories=10,
                    project_id=project_id,
                )
                for r in _extract_memory_rows(resp):
                    mid = str(r.get("id") or r.get("memory_id") or r.get("title") or "")
                    if not mid or mid in seen or _score_memory_row(r) < 0.35:
                        continue
                    seen.add(mid)
                    rows.append(r)
            except Exception as exc:  # noqa: BLE001
                log.warning("[deep-sim] role recall failed slug=%s probe=%s err=%s", slug, probe[:50], exc)
        rows.sort(key=_score_memory_row, reverse=True)
        formatted = _format_memory_rows(rows, limit=8, snippet_chars=420)
        if not formatted:
            return ""
        return (
            f"PERSONA EVIDENCE PACK for {emp.get('name', slug)} ({lane}). "
            "Use these facts through your own role lens; do not just repeat the shared blackboard:\n"
            + formatted
            + "\n"
        )

    packed = await asyncio.gather(*[_recall_for(emp) for emp in participants], return_exceptions=True)
    out: Dict[str, str] = {}
    for emp, value in zip(participants, packed):
        if isinstance(value, Exception):
            out[emp.get("slug", "")] = ""
        else:
            out[emp.get("slug", "")] = value or ""
    return out


async def _sim_agent_json(
    *,
    req: "RoomTurnRequest",
    emp: Dict[str, Any],
    prompt: str,
    fallback: Dict[str, Any],
) -> Dict[str, Any]:
    try:
        agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
        reply = await agent(Msg(name="user", content=prompt, role="user"))
        _report_turn(emp["id"], req.user_message, reply)
        text = _msg_to_text(reply)
        m = re.search(r"\{[\s\S]+\}", text)
        parsed = json.loads(m.group(0)) if m else None
        if isinstance(parsed, dict):
            return parsed
    except Exception as exc:  # noqa: BLE001
        log.warning("[deep-sim] %s failed: %s", emp.get("slug"), exc)
    return fallback


async def _orchestrate_deep_sim(
    req: "RoomTurnRequest",
    participants: List[Dict[str, Any]],
    lead: Dict[str, Any],
    room_template: str,
    started: float,
) -> "RoomTurnResponse":
    cost_tokens = 0
    decision = (req.flyby_decision or "").strip().lower()
    is_flyby_continuation = decision in ("agree", "disagree")
    ontology = _build_task_ontology(req.user_message)
    if not is_flyby_continuation:
        await _emit_event(req.callback_url, req.turn_id, {"t": "ontology", **ontology})
    assessment = _assess_workforce_coverage(participants, ontology)
    if not is_flyby_continuation:
        await _emit_event(req.callback_url, req.turn_id, {"t": "workforce_assessment", **assessment})

    flyby_spec = req.flyby_spec or (_build_flyby_spec(req, assessment) if assessment.get("needs_flyby") else None)
    if flyby_spec and assessment.get("needs_flyby") and decision not in ("agree", "disagree"):
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "flyby_proposal",
            "spec": flyby_spec,
            "missing_roles": assessment.get("missing_roles", []),
            "reason": flyby_spec.get("reason"),
        })
        return RoomTurnResponse(ok=True, cost_tokens=0, status="awaiting_flyby")
    if flyby_spec and decision == "agree":
        flyby = {
            **flyby_spec,
            "org_id": req.org_id,
            "_lane": derive_lane(flyby_spec),
            "tools": DEFAULT_HYPER_TOOLS,
        }
        participants = participants + [flyby]
        await _emit_event(req.callback_url, req.turn_id, {"t": "flyby_joined", "spec": flyby_spec})
    elif flyby_spec and decision == "disagree":
        await _emit_event(req.callback_url, req.turn_id, {"t": "flyby_skipped", "spec": flyby_spec})

    await _emit_event(req.callback_url, req.turn_id, {"t": "typing", "agent": lead.get("slug"), "kind": "grounding"})
    blackboard = await _build_turn_blackboard(
        query=req.user_message,
        user_id=req.user_id,
        org_id=req.org_id,
        api_key="",
        project_id=req.project_id,
    )
    memory_context = blackboard.get("context_text") or ""
    goal_context = _room_goal_context(req.room_goal)
    if goal_context:
        memory_context = _join_context(goal_context, memory_context)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "simulation_phase",
        "phase": "role_grounding",
        "label": "Role-specific recall",
        "agents": [p.get("slug") for p in participants],
    })
    role_context = await _build_deep_sim_role_context(
        query=req.user_message,
        participants=participants,
        user_id=req.user_id,
        org_id=req.org_id,
        api_key="",
        project_id=req.project_id,
    )
    web_intel_context = ""
    try:
        web_allowed = _web_intel_needed(req.user_message, blackboard, room_template)
        await _emit_event(req.callback_url, req.turn_id, _build_memory_audit_event(
            blackboard=blackboard,
            web_allowed=web_allowed,
            room_template=room_template,
        ))
        web_intel_context = await _run_web_intel_turn(
            req=req,
            lead=lead,
            blackboard=blackboard,
            memory_context=memory_context,
            room_template=room_template,
        )
        if web_intel_context:
            memory_context = _join_context(memory_context, web_intel_context)
            role_context = {
                slug: _join_context(ctx, web_intel_context)
                for slug, ctx in role_context.items()
            }
    except Exception as exc:  # noqa: BLE001
        log.warning("[deep-sim] web intel prefetch failed: %s", exc)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "simulation_phase",
        "phase": "collect",
        "label": "Private investigation",
        "agents": [p.get("slug") for p in participants],
        "blackboard": {"hit_count": blackboard.get("hit_count", 0), "confidence": blackboard.get("confidence", 0)},
        "role_context_agents": [slug for slug, ctx in role_context.items() if ctx],
    })

    roster = _participant_brief(participants)
    claims: List[Dict[str, Any]] = []

    async def _collect(emp: Dict[str, Any]) -> Dict[str, Any]:
        prompt = (
            "[DEEP SIM COLLECT]\n"
            "You are an employee in a live HIVEMIND simulation. Use your persona at full strength.\n"
            f"Question: {req.user_message}\n\n"
            f"Ontology: {json.dumps(ontology)[:2000]}\n\n"
            f"Room roster:\n{roster}\n\n"
            f"Shared blackboard:\n{memory_context or '(no recalled context)'}\n"
            f"{role_context.get(emp.get('slug'), '')}\n"
            "Return STRICT JSON: {\"stance\":\"...\",\"claim\":\"...\",\"evidence\":[\"memory title or id\"],\"risk\":\"...\",\"confidence\":0.0-1.0}."
        )
        return await _sim_agent_json(
            req=req,
            emp=emp,
            prompt=prompt,
            fallback={"stance": "conditional", "claim": "No clear claim returned.", "evidence": [], "risk": "low signal", "confidence": 0.3},
        )

    async def _collect_with_emp(emp: Dict[str, Any]) -> Dict[str, Any]:
        return {"emp": emp, "result": await _collect(emp)}

    tasks = [asyncio.create_task(_collect_with_emp(emp)) for emp in participants]
    for task in asyncio.as_completed(tasks):
        packed = await task
        emp = packed["emp"]
        c = packed["result"]
        claim = {
            "id": f"sim-{emp['slug']}",
            "agent": emp["slug"],
            "lane": emp.get("_lane"),
            "stance": str(c.get("stance", "conditional"))[:80],
            "claim": str(c.get("claim", ""))[:1800],
            "evidence": [str(x)[:160] for x in (c.get("evidence") or [])][:6],
            "risk": str(c.get("risk", ""))[:500],
            "confidence": float(c.get("confidence") or 0.5),
        }
        claims.append(claim)
        cost_tokens += max(120, len(claim["claim"]) // 4)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "simulation_claim",
            **claim,
            "content": claim["claim"],
            "round": 1,
        })

    await _emit_event(req.callback_url, req.turn_id, {"t": "simulation_phase", "phase": "debate", "label": "Peer review"})
    reviews: List[Dict[str, Any]] = []

    async def _review(emp: Dict[str, Any], target: Dict[str, Any]) -> Dict[str, Any]:
        prompt = (
            "[DEEP SIM PEER REVIEW]\n"
            f"You are {emp.get('name', emp.get('slug'))}. Review this teammate claim hard but fairly.\n"
            f"User question: {req.user_message}\n"
            f"Target claim by {target['agent']}: {target['claim']}\n"
            f"Shared blackboard:\n{memory_context or '(no recalled context)'}\n"
            f"{role_context.get(emp.get('slug'), '')}\n"
            "Return STRICT JSON: {\"agreement\":\"agree|extend|challenge\",\"review\":\"...\",\"condition\":\"...\",\"confidence\":0.0-1.0}."
        )
        return await _sim_agent_json(
            req=req,
            emp=emp,
            prompt=prompt,
            fallback={"agreement": "extend", "review": "No review returned.", "condition": "", "confidence": 0.4},
        )

    async def _review_with_emp_target(emp: Dict[str, Any], target: Dict[str, Any]) -> Dict[str, Any]:
        return {"emp": emp, "target": target, "result": await _review(emp, target)}

    review_tasks = []
    for i, emp in enumerate(participants):
        if not claims:
            continue
        target = claims[(i + 1) % len(claims)]
        review_tasks.append(asyncio.create_task(_review_with_emp_target(emp, target)))
    for task in asyncio.as_completed(review_tasks):
        packed = await task
        emp = packed["emp"]
        target = packed["target"]
        r = packed["result"]
        agreement = str(r.get("agreement", "extend")).lower()
        if agreement not in ("agree", "extend", "challenge"):
            agreement = "extend"
        review = {
            "reviewer": emp["slug"],
            "target_hypothesis_id": target["id"],
            "target_author": target["agent"],
            "agreement": agreement,
            "content": str(r.get("review", ""))[:1200],
            "condition": str(r.get("condition", ""))[:400],
            "confidence": float(r.get("confidence") or 0.5),
            "round": 2,
        }
        reviews.append(review)
        cost_tokens += max(80, len(review["content"]) // 4)
        await _emit_event(req.callback_url, req.turn_id, {"t": "peer_review", **review})

    await _emit_event(req.callback_url, req.turn_id, {"t": "simulation_phase", "phase": "revise", "label": "Revision"})
    lead_agent = await _build_agent_for_room(req.room_id, lead, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
    conclusion_prompt = (
        "[DEEP SIM CONCLUSION]\n"
        "You are the lead. Synthesize the simulated Slack session into a strong enterprise decision.\n"
        f"Question: {req.user_message}\n\n"
        f"Claims: {json.dumps(claims)[:6000]}\n\n"
        f"Peer reviews: {json.dumps(reviews)[:6000]}\n\n"
        f"Blackboard: {memory_context[:6000]}\n"
        f"Lead evidence pack: {role_context.get(lead.get('slug'), '')[:4000]}\n"
        "Write 5-8 concise bullets: decision, why, objections addressed, what to watch, next irreversible choice. "
        "Do not soften strong POVs; preserve dissent where unresolved."
    )
    final_reply = await lead_agent(Msg(name="user", content=conclusion_prompt, role="user"))
    _report_turn(lead["id"], req.user_message, final_reply)
    final_text = _msg_to_text(final_reply) or "(lead synthesis failed)"
    cost_tokens += max(250, len(final_text) // 4)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "line",
        "agent": lead.get("slug"),
        "round": 3,
        "kind": "synthesis",
        "content": final_text,
        "tokens": max(250, len(final_text) // 4),
    })

    await _emit_event(req.callback_url, req.turn_id, {"t": "simulation_phase", "phase": "vote", "label": "Decision votes"})
    vote_summary: List[Dict[str, Any]] = []
    for claim in claims:
        support = sum(1 for r in reviews if r["target_hypothesis_id"] == claim["id"] and r["agreement"] in ("agree", "extend"))
        challenge = sum(1 for r in reviews if r["target_hypothesis_id"] == claim["id"] and r["agreement"] == "challenge")
        score = max(1, min(5, 3 + support - challenge))
        vote = {
            "voter": claim["agent"],
            "vote_for_hypothesis_id": claim["id"],
            "score": score,
            "conditions": [r["condition"] for r in reviews if r["target_hypothesis_id"] == claim["id"] and r.get("condition")][:3],
            "content": f"{claim['agent']} backs its {claim['stance']} stance with score {score}/5.",
            "round": 4,
        }
        vote_summary.append(vote)
        await _emit_event(req.callback_url, req.turn_id, {"t": "vote", **vote})

    verdict = "AGREED" if vote_summary and sum(v["score"] for v in vote_summary) / len(vote_summary) >= 3.5 else "CONDITIONAL"
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "swarm_verdict",
        "verdict": verdict,
        "weighted_score": round(sum(v["score"] for v in vote_summary) / max(len(vote_summary), 1), 2),
        "winning_hypothesis_id": max(vote_summary, key=lambda v: v["score"])["vote_for_hypothesis_id"] if vote_summary else None,
        "action_items": [v["conditions"][0] for v in vote_summary if v.get("conditions")][:6],
        "vote_count": len(vote_summary),
    })
    await _emit_event(req.callback_url, req.turn_id, _build_harness_quality_check(
        room_goal=req.room_goal or "",
        final_text=final_text,
        evidence_count=len(blackboard.get("memory_hits", []) or blackboard.get("memory_ids", []) or []),
        source_count=len(_web_sources_for_turn(req.turn_id)),
        claims_count=len(claims),
        reviews_count=len(reviews),
        votes_count=len(vote_summary),
        web_intel_used=bool(web_intel_context),
        project_scoped=bool(req.project_id),
        project_memory_hits=int(blackboard.get("project_hit_count", 0) or 0),
    ))
    # Phase 5 — recon/verify the result against the lead's done-criterion.
    await _verify_and_emit(req, lead, final_text=final_text, blackboard=blackboard)
    await _emit_event(req.callback_url, req.turn_id, _build_final_report(
        user_message=req.user_message,
        final_text=final_text,
        template=room_template,
        room_goal=req.room_goal or "",
        status="complete",
        verdict=verdict,
        score=round(sum(v["score"] for v in vote_summary) / max(len(vote_summary), 1), 2),
        lead=lead,
        action_items=[v["conditions"][0] for v in vote_summary if v.get("conditions")][:6],
        evidence_ids=blackboard.get("memory_ids", []),
        evidence=blackboard.get("memory_hits", []),
        sources=_web_sources_for_turn(req.turn_id),
        claims=claims,
        reviews=reviews,
        votes=vote_summary,
        web_intel_used=bool(web_intel_context),
        project_scoped=bool(req.project_id),
        project_memory_hits=int(blackboard.get("project_hit_count", 0) or 0),
    ))
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "seal",
        "cost_tokens": cost_tokens,
        "status": "complete",
        "duration_ms": int((time.time() - started) * 1000),
        "template": room_template,
        "blackboard": {"hit_count": blackboard.get("hit_count", 0), "confidence": blackboard.get("confidence", 0)},
        "flyby": bool(flyby_spec and decision == "agree"),
        "simulation_claims": len(claims),
        "simulation_reviews": len(reviews),
    })
    _WEB_INTEL_PAYLOADS.pop(req.turn_id, None)
    return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status="complete")


# ─── Swarm orchestrator (Phase 4) ──────────────────────────────────────
#
# Fixed R1-R5 phase machine for `template == 'swarm'` rooms.
#  R1 — independent hypothesis (parallel, anti-anchor, blind)
#  R2 — peer cross-exam (parallel review of 2 OTHER hypotheses)
#  R3 — deep chain-of-thought (lane playbook executed in full)
#  R4 — Skeptic unorthodox challenge (solo, mandatory)
#  R5 — convergence vote + lead synthesis (consensus → verdict)
#
# Visible bubbles per round, internal tool count target 30-70/turn.

# Per-lane playbook injected into agent prompts. Defines mandatory tool
# sequence the agent must run BEFORE writing output. Drives 30-50+ actions
# per turn at the swarm level.
LANE_PLAYBOOKS: Dict[str, str] = {
    "Skeptic": (
        "LANE PLAYBOOK (Skeptic — risk + contradiction hunter):\n"
        "  1. silent: hivemind_recall(query + ' risk OR concern OR blocker')\n"
        "  2. silent: hivemind_recall(query + ' contradiction OR conflict')\n"
        "  3. silent: hivemind_traverse_graph on top hit, depth=2, surface edges of type Contradicts/Updates\n"
        "  4. write only when you have ≥1 concrete contradiction OR risk citing memory_id\n"
    ),
    "Researcher": (
        "LANE PLAYBOOK (Researcher — historical + cross-entity context):\n"
        "  1. silent: hivemind_recall(query)\n"
        "  2. silent: identify top entity:* tag from R1 hits, hivemind_recall(entity_name)\n"
        "  3. silent: hivemind_traverse_graph on top memory, depth=2\n"
        "  4. consume the room's WEB INTEL DOSSIER if present; do not browse directly\n"
        "  5. write with at least 2 cited memory_ids plus the dossier's source urls when available\n"
    ),
    "Builder": (
        "LANE PLAYBOOK (Builder — implementation + status reality):\n"
        "  1. silent: hivemind_recall(query + ' status OR shipped OR blocker')\n"
        "  2. silent: hivemind_recall(query + ' code OR migration OR deploy')\n"
        "  3. silent: traverse top hit for related decisions\n"
        "  4. write the implementation gap or shipping state with cited evidence\n"
    ),
    "Strategist": (
        "LANE PLAYBOOK (Strategist — goals + sequencing impact):\n"
        "  1. silent: hivemind_recall(query)\n"
        "  2. silent: hivemind_recall(query + ' goal OR roadmap OR priority')\n"
        "  3. silent: traverse_graph on top memory, depth=2 to find connected decisions\n"
        "  4. write impact on goals/sequencing with cited evidence\n"
    ),
    "Communicator": (
        "LANE PLAYBOOK (Communicator — audience-fit + translation):\n"
        "  1. silent: hivemind_recall(query)\n"
        "  2. silent: hivemind_recall(query + ' audience OR customer OR stakeholder')\n"
        "  3. write the audience-fit framing or translation with cited evidence\n"
    ),
}


SKEPTIC_PERSONA_PRELUDE = (
    "[YOU ARE THIS ROOM'S PERMANENT SKEPTIC.]\n"
    "Mandate: challenge consensus, surface hidden assumptions, propose unorthodox\n"
    "alternatives. SILENT R1-R3 (no bubbles). SPEAK ONLY R4 with a complete\n"
    "challenge package. R5: vote like everyone else.\n"
    "Mission rules:\n"
    "- Find what nobody else considered. Edge cases. Adversarial framings.\n"
    "- Cite a memory_id for every challenge (no vibes).\n"
    "- Unorthodox angles encouraged: contrarian, counter-intuitive, second-order.\n"
    "- DO NOT echo other agents. Your job = adversarial perspective.\n"
)


HYPER_ROOM_MAX_TOOL_CALLS = int(os.environ.get("HYPER_ROOM_MAX_TOOL_CALLS", "400"))

# Wall-clock budget for a whole swarm turn. The 1.5s/agent stagger repeats
# per round (R1/R2/R3/R5-vote); under a 429 storm the per-call retries stack
# on top. The control-plane SSE stream has NO hard turn timeout — it polls the
# turn row until sealedAt is set (heartbeat keeps the connection alive) — so the
# only ceiling is this self-imposed budget. Recursive CSI convergence runs
# multiple cycles (each ~4 LLM rounds x N agents), so the budget is generous;
# deadline_hit still short-circuits to synthesis/seal if it is ever exceeded.
HYPER_ROOM_MAX_WALL_SECONDS = float(os.environ.get("HYPER_ROOM_MAX_WALL_SECONDS", "600"))

# ─── Recursive CSI convergence ──────────────────────────────────────────
# A swarm turn is no longer a single R1->R5 pass. After the R5 vote, if the
# verdict is not a strong consensus, the swarm RE-SEEDS (carries the refined
# hypotheses forward + injects the prior dissent reasons and the Skeptic's
# unorthodox alternatives) and runs another R2->R5 cycle — mirroring the
# MiroFish / CSI propose -> review -> revise -> vote loop. It stops when the
# verdict converges, the cycle cap is hit, or the cost/deadline cap fires.
HYPER_ROOM_MAX_CYCLES = int(os.environ.get("HYPER_ROOM_MAX_CYCLES", "6"))

# Seal (stop looping) when verdict is AGREED, or CONDITIONAL with a weighted
# score at/above this floor. Below it (weak CONDITIONAL) or DISSENT -> re-run.
HYPER_ROOM_CONVERGE_SCORE = float(os.environ.get("HYPER_ROOM_CONVERGE_SCORE", "3.2"))


def _has_converged(consensus: Dict[str, Any]) -> bool:
    """True when the swarm should stop iterating and seal.
    AGREED always converges; CONDITIONAL converges only when the weighted
    score clears HYPER_ROOM_CONVERGE_SCORE; DISSENT never converges."""
    verdict = consensus.get("verdict")
    if verdict == "AGREED":
        return True
    if verdict == "CONDITIONAL":
        return float(consensus.get("weighted_score") or 0) >= HYPER_ROOM_CONVERGE_SCORE
    return False


# Round prompt templates. Filled with persona + lane + context per agent.

R1_HYPOTHESIS_PROMPT = """\
[SWARM R1 — INDEPENDENT HYPOTHESIS]
You are {persona_name}, a {lane} at HIVEMIND.
{lane_playbook}

Your task NOW: form ONE independent hypothesis on the user's question. You
have NOT seen what teammates think. Do not anchor on any prior bubble.

{candidate_memories}

User asked:
{user_message}

Reply STRICT JSON only:
{{
  "hypothesis": "<2-3 sentences, your independent claim>",
  "confidence": 0.0-1.0,
  "evidence_memory_ids": ["<uuid>", "<uuid>"],
  "lane": "{lane}",
  "reasoning_brief": "<one-line why>"
}}
Min 1 evidence_memory_id from your silent recall. No prose outside JSON.
"""


R2_PEER_REVIEW_PROMPT = """\
[SWARM R2 — PEER CROSS-EXAM]
You are {persona_name}, a {lane} at HIVEMIND.

Hypotheses on the table (from R1):
{hypotheses_table}

Your task NOW: review the TWO hypotheses below (NOT your own). For each,
search HIVEMIND for corroborating OR contradicting evidence (silent
recall/traverse). Then emit one review per target.

Targets to review: {target_ids}

Reply STRICT JSON only (array of reviews):
{{
  "reviews": [
    {{
      "target_hypothesis_id": "<id>",
      "agreement": "agree | challenge | extend",
      "evidence_memory_ids": ["<uuid>"],
      "reason": "<1-2 sentences citing the evidence>"
    }}
  ]
}}
Min 1 evidence_memory_id per review.
PEER ACCOUNTABILITY: begin each "reason" with the target author's NAME
(from the hypotheses table above) and your stance verb — agree, contradict,
or extend — then justify with the evidence. Example: "Contradict Dana: her
claim ignores ... (see <uuid>)."
"""


R3_DEEP_DIVE_PROMPT = """\
[SWARM R3 — DEEP CHAIN-OF-THOUGHT]
You are {persona_name}, a {lane} at HIVEMIND.

Your R1 hypothesis:
{your_hypothesis}

R2 peer reviews about your hypothesis:
{your_reviews}

{lane_playbook}

Your task NOW: execute the lane playbook in FULL. Run all tool steps
silently. Then refine your hypothesis incorporating the new evidence + the
peer reviews. Write the explicit chain-of-thought steps you took (one line
per step). Include lane-specific finding.

Reply STRICT JSON only:
{{
  "refined_hypothesis": "<3-4 sentences>",
  "chain_of_thought": [
    "step 1: <what you did + what memory_id surfaced>",
    "step 2: <...>",
    "step 3: <...>"
  ],
  "evidence_memory_ids": ["<uuid>"],
  "lane_specific_finding": "<your lane's angle — 1 sentence>",
  "confidence": 0.0-1.0
}}
Min 3 chain_of_thought steps, min 2 evidence_memory_ids.
"""


R4_SKEPTIC_PROMPT = """\
[SWARM R4 — SKEPTIC UNORTHODOX CHALLENGE]
{skeptic_prelude}

You have been silent R1-R3. The room produced these refined hypotheses:
{refined_hypotheses_table}

Your task NOW: attack. Find what NOBODY considered. Run silent tool calls
(min 3) searching for contradictions, edge cases, hidden assumptions.
Propose unorthodox alternative framings.

Reply STRICT JSON only:
{{
  "challenges": [
    {{
      "target_hypothesis_id": "<id>",
      "challenge": "<concrete attack, 1-2 sentences>",
      "evidence_memory_ids": ["<uuid>"]
    }}
  ],
  "unorthodox_alternatives": [
    {{
      "angle": "<contrarian framing, 1-2 sentences>",
      "evidence_memory_ids": ["<uuid>"]
    }}
  ],
  "hidden_assumptions": [
    "<assumption everyone shared but didn't state>"
  ]
}}
Min 1 challenge, min 1 unorthodox alternative, min 1 hidden assumption.
"""


R5_VOTE_PROMPT = """\
[SWARM R5 — CONVERGENCE VOTE]
You are {persona_name}, a {lane} at HIVEMIND.

Refined hypotheses:
{refined_hypotheses_table}

Skeptic's challenges + unorthodox alternatives:
{skeptic_output}

Your task NOW: vote. Pick ONE option (a refined hypothesis id OR an
unorthodox alternative id like 'unorthodox-1'). Score 1-5 (5 = strong
support). List any conditions that must hold for your vote.

Reply STRICT JSON only:
{{
  "vote_for_hypothesis_id": "<id | 'unorthodox-1' | 'none'>",
  "score": 1-5,
  "conditions": ["<required condition for approval>"],
  "reason": "<1 sentence>"
}}
PEER ACCOUNTABILITY: your "reason" MUST name at least one OTHER participant
(from the refined hypotheses table above) and state whether you agree with,
contradict, or extend their point. Example: "Agree with Dana — extends Sam's
edge case."
"""


R5_SYNTHESIS_PROMPT = """\
[SWARM R5 — LEAD SYNTHESIS]
You are {lead_name}, the LEAD of this turn. You've been silent R1-R4.

Refined hypotheses:
{refined_hypotheses_table}

Skeptic challenges:
{skeptic_output}

Vote tally (weighted by trust):
{vote_summary}

Verdict computed by consensus formula: {verdict}
Winning hypothesis id: {winning_id}
Room goal: {room_goal}

Your task: synthesise the final answer for the user.
- Tie the answer back to the room goal; say whether the goal moved forward, stalled, or needs follow-up.
- Quote the winning hypothesis (and the runner-up if CONDITIONAL).
- Address the Skeptic's strongest challenge explicitly.
- Cite memory_ids from the union of evidence used across all rounds.
- List action_items extracted from vote.conditions[].

Output: 4-6 short sentences + action_items at end.
"""


# Broad-recall probes for the standing company brief. The query-specific
# recall alone (semantic match on the user's question) misses foundational
# facts — what the business IS, who's involved, what's shipped — so the room
# debates a topic without the company in front of it. MiroFish establishes
# the world (full graph paging) before agents reason; this is the bounded
# HIVEMIND analogue: a handful of orthogonal recalls, deduped + compressed
# once, injected into every agent for the whole turn.
_COMPANY_BRIEF_PROBES: List[str] = [
    "company business model products services what we do",
    "team people founders employees roles who is involved",
    "customers clients partners pipeline revenue",
    "goals roadmap strategy priorities current focus",
]


async def _build_company_brief(query: str, user_id: str, org_id: str,
                               api_key: str = "", max_memories: int = 25,
                               project_id: Optional[str] = None) -> str:
    """Fan out orthogonal recalls (query + company/people/customers/goals),
    dedup by memory id/title, compress to ~25 snippets, return a standing
    COMPANY CONTEXT block. Recalls via master+emulation (recall_emulated) so
    it reaches the org brain even when the rotated lead has no minted key.
    Best-effort: returns '' on any failure so the turn still runs."""
    seen_ids: Set[str] = set()
    seen_titles: Set[str] = set()
    collected: List[Dict[str, Any]] = []
    probes = [query] + _COMPANY_BRIEF_PROBES

    async def _probe(p: str) -> List[Dict[str, Any]]:
        try:
            resp = await recall_emulated(p, user_id=user_id, org_id=org_id,
                                         api_key=api_key, max_memories=8,
                                         project_id=project_id)
            return resp.get("memories") or resp.get("combined") or []
        except Exception as exc:  # noqa: BLE001 — one probe failing must not sink the brief
            log.warning("[brief] recall probe failed (%s): %s", p[:40], exc)
            return []

    # Probes are orthogonal — fan out concurrently so the brief adds one
    # recall-latency to the pre-round phase, not five.
    probe_results = await asyncio.gather(*[_probe(p) for p in probes])
    # Preserve probe order (query first) when deduping so the query-specific
    # hits win ties over the generic company probes.
    for rows in probe_results:
        for r in rows:
            if float(r.get("score", 0)) < 0.40:
                continue
            mid = str(r.get("id") or r.get("memory_id") or "")
            title = (r.get("title") or "").strip()
            key_title = title.lower()
            if (mid and mid in seen_ids) or (key_title and key_title in seen_titles):
                continue
            if mid:
                seen_ids.add(mid)
            if key_title:
                seen_titles.add(key_title)
            collected.append(r)
    if not collected:
        return ""
    # Highest-scored first so the budget keeps the strongest signal.
    collected.sort(key=lambda r: float(r.get("score", 0)), reverse=True)
    lines_out: List[str] = []
    for r in collected[:max_memories]:
        title = (r.get("title") or "").strip()
        content = (r.get("content") or "").replace("\n", " ").strip()
        if not content:
            continue
        snippet = content[:220] + ("…" if len(content) > 220 else "")
        prefix = f'"{title}" — ' if title else ""
        lines_out.append(f"- {prefix}{snippet}")
    if not lines_out:
        return ""
    log.info("[brief] built company context: %d memories from %d probes",
             len(lines_out), len(probes))
    return (
        "COMPANY CONTEXT — standing facts about this business, its people, "
        "products, customers and goals. Ground every claim in these; this is "
        "WHO and WHAT you are reasoning about:\n"
        + "\n".join(lines_out)
        + "\n"
    )


def _consensus_verdict(votes: List[Dict[str, Any]], trust_map: Dict[str, float]) -> Dict[str, Any]:
    """Compute swarm verdict from votes + per-voter trust.
    Returns { verdict, winning_id, weighted_score, action_items[] }.
    """
    if not votes:
        return {"verdict": "DISSENT", "winning_id": None, "weighted_score": 0.0, "action_items": []}
    # Group by hypothesis_id
    tally: Dict[str, Dict[str, Any]] = {}
    for v in votes:
        hid = v.get("vote_for_hypothesis_id") or "none"
        voter = v.get("voter")
        score = float(v.get("score") or 0)
        trust = float(trust_map.get(voter, 0.5))
        if hid not in tally:
            tally[hid] = {"weighted_sum": 0.0, "weight_total": 0.0, "count": 0, "conditions": []}
        tally[hid]["weighted_sum"] += score * trust
        tally[hid]["weight_total"] += trust
        tally[hid]["count"] += 1
        for c in (v.get("conditions") or []):
            if c and c not in tally[hid]["conditions"]:
                tally[hid]["conditions"].append(c)
    # Pick winner. The 'none'/abstain bucket is never a valid winner — a turn
    # where most voters abstained is inconclusive (DISSENT), not a positive
    # consensus on a non-answer. Excluding it also prevents saving a decision
    # memory whose winning_id resolves to nothing downstream.
    real_tally = {hid: agg for hid, agg in tally.items() if hid != "none"}
    winner = max(real_tally.items(), key=lambda kv: kv[1]["weighted_sum"]) if real_tally else (None, None)
    if winner[0] is None or winner[1] is None:
        return {"verdict": "DISSENT", "winning_id": None, "weighted_score": 0.0, "action_items": []}
    weighted_score = winner[1]["weighted_sum"] / max(winner[1]["weight_total"], 0.0001)
    dissent = any(
        float(v.get("score") or 0) <= 2 and (v.get("vote_for_hypothesis_id") or "none") != winner[0]
        for v in votes
    )
    if weighted_score >= 3.5 and not dissent:
        verdict = "AGREED"
    elif weighted_score >= 3.0:
        verdict = "CONDITIONAL"
    else:
        verdict = "DISSENT"
    return {
        "verdict": verdict,
        "winning_id": winner[0],
        "weighted_score": round(weighted_score, 2),
        "action_items": winner[1]["conditions"][:10],
    }


async def _orchestrate_swarm(req: "RoomTurnRequest", participants: List[Dict[str, Any]],
                              lead: Dict[str, Any], skeptic: Optional[Dict[str, Any]],
                              memory_context: str, room_template: str,
                              cost_tokens_initial: int, started: float,
                              memory_audit: Optional[Dict[str, Any]] = None) -> "RoomTurnResponse":
    """Fixed R1-R5 phase machine. Returns RoomTurnResponse."""
    cost_tokens = cost_tokens_initial
    tool_call_counts: Dict[str, int] = {}
    evidence_pool: Set[str] = set()
    memory_audit = memory_audit or {}

    def _turn_tool_total() -> int:
        """Running sum of tool calls across all cached agents this turn.
        Used to enforce the per-turn HYPER_ROOM_MAX_TOOL_CALLS cost cap."""
        total = 0
        for p in participants:
            cached = _ROOM_AGENTS.get(f"{req.room_id}:{p['id']}")
            total += int(getattr(cached, "tool_call_count", 0) or 0)
        return total

    cost_cap_hit = False
    _deadline_emitted = {"v": False}

    async def _deadline_hit(next_round: int) -> bool:
        """True once the turn has exceeded HYPER_ROOM_MAX_WALL_SECONDS.
        Emits a one-shot 'deadline_hit' event so the UI can show the turn
        short-circuited to seal. Treated like a cost-cap short-circuit:
        remaining rounds are skipped and we go straight to synthesis/seal
        with whatever completed, guaranteeing the seal beats the
        control-plane turn timeout."""
        if time.time() - started <= HYPER_ROOM_MAX_WALL_SECONDS:
            return False
        if not _deadline_emitted["v"]:
            _deadline_emitted["v"] = True
            log.warning("[swarm] wall-clock deadline hit turn=%s elapsed=%.1fs cap=%.1fs skip_from_round=%d",
                        req.turn_id, time.time() - started, HYPER_ROOM_MAX_WALL_SECONDS, next_round)
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "deadline_hit",
                "elapsed_s": round(time.time() - started, 1),
                "cap_s": HYPER_ROOM_MAX_WALL_SECONDS,
                "skipped_from_round": next_round,
            })
        return True

    # Pull trust scores once for vote weighting.
    trust_map = await get_trust_scores(req.org_id, [p["id"] for p in participants])
    trust_by_slug = {p.get("slug"): trust_map.get(p["id"], 0.5) for p in participants}

    # Participants who SPEAK in R1-R3 (everyone except lead + skeptic).
    skeptic_id = skeptic["id"] if skeptic else None
    lead_id = lead["id"]
    speakers = [p for p in participants if p["id"] not in (lead_id, skeptic_id)]
    # Edge case: if too few participants, allow lead to speak in R1 (graceful).
    if len(speakers) < 2:
        speakers = [p for p in participants if p["id"] != skeptic_id]

    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_start", "round": 1, "label": "Independent Hypothesis",
        "task": "Each non-lead, non-Skeptic agent forms one independent hypothesis.",
    })

    # ─── R1 — Independent Hypothesis ───────────────────────────────────
    async def _run_r1(emp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
            prompt = R1_HYPOTHESIS_PROMPT.format(
                persona_name=emp.get("name", emp.get("slug")),
                lane=emp["_lane"],
                lane_playbook=LANE_PLAYBOOKS.get(emp["_lane"], ""),
                candidate_memories=memory_context or "(no pre-fetched memories)",
                user_message=req.user_message,
            )
            reply = await agent(Msg(name="user", content=prompt, role="user"))
            _report_turn(emp["id"], req.user_message, reply)
            text = _msg_to_text(reply)
            m = re.search(r"\{[\s\S]+\}", text)
            parsed = json.loads(m.group(0)) if m else None
            if not isinstance(parsed, dict) or not parsed.get("hypothesis"):
                log.info("[swarm] R1 %s: non-JSON/empty reply, dropping", emp.get("slug"))
                return None
            ev_ids = [str(x) for x in (parsed.get("evidence_memory_ids") or []) if x]
            for e in ev_ids:
                evidence_pool.add(e)
            return {
                "id": f"h-{emp['slug']}",
                "agent_id": emp["id"],
                "agent_slug": emp["slug"],
                "agent_name": emp.get("name", emp["slug"]),
                "lane": emp["_lane"],
                "hypothesis": str(parsed.get("hypothesis", ""))[:1500],
                "confidence": float(parsed.get("confidence") or 0.5),
                "evidence_memory_ids": ev_ids,
                "reasoning_brief": str(parsed.get("reasoning_brief", ""))[:300],
            }
        except Exception as exc:
            log.warning("[swarm] R1 %s failed: %s", emp.get("slug"), exc)
            return None

    # Stagger starts so 9-concurrent Groq calls don't 429.
    async def _staggered_r1(emp, idx):
        await asyncio.sleep(0.25 * idx)
        return await _run_r1(emp)
    r1_results = await asyncio.gather(*[_staggered_r1(emp, i) for i, emp in enumerate(speakers)], return_exceptions=False)
    hypotheses = [h for h in r1_results if h]
    for h in hypotheses:
        tokens = max(80, len(h["hypothesis"]) // 4)
        cost_tokens += tokens
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "hypothesis",
            "id": h["id"],
            "agent": h["agent_slug"],
            "lane": h["lane"],
            "content": h["hypothesis"],
            "confidence": h["confidence"],
            "evidence_memory_ids": h["evidence_memory_ids"],
            "tokens": tokens,
            "round": 1,
        })

    if not hypotheses:
        log.warning("[swarm] no R1 hypotheses turn=%s speakers=%d", req.turn_id, len(speakers))
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "seal", "cost_tokens": cost_tokens, "status": "failed",
            "duration_ms": int((time.time() - started) * 1000),
            "reason": "no_r1_hypotheses",
        })
        return RoomTurnResponse(ok=False, cost_tokens=cost_tokens, status="failed")

    log.info("[swarm] R1 done turn=%s hypotheses=%d", req.turn_id, len(hypotheses))
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_end", "round": 1, "hypotheses_count": len(hypotheses),
    })

    # Cost cap: if the per-turn tool ceiling is already exhausted, skip the
    # remaining LLM rounds and go straight to synthesis with R1 hypotheses.
    if _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
        cost_cap_hit = True
        log.warning("[swarm] cost cap hit before R2 turn=%s total=%d cap=%d",
                    req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "cost_cap_hit", "total": _turn_tool_total(),
            "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": 2,
        })
    elif await _deadline_hit(2):
        cost_cap_hit = True

    hyp_by_id = {h["id"]: h for h in hypotheses}
    # Pre-declared so cost-cap skips of R2/R3 leave well-typed empties for
    # the downstream vote + synthesis to consume gracefully.
    peer_reviews: List[Dict[str, Any]] = []
    refined: List[Dict[str, Any]] = []
    refined_by_id: Dict[str, Any] = {}

    # ─── R2 — Peer Cross-Exam ──────────────────────────────────────────
    # ═══ Recursive CSI convergence loop ════════════════════════════════
    # Each cycle is one R2(peer-exam) -> R3(refine) -> R4(skeptic) ->
    # R5(vote) pass. Cycle 1 reviews the R1 hypotheses; cycle 2+ carries the
    # refined hypotheses forward and injects the prior dissent + Skeptic
    # alternatives, then re-runs until the verdict converges (AGREED, or
    # CONDITIONAL >= floor), the cycle cap is hit, or cost/deadline fires.
    # `round` is monotonic across cycles ((cycle-1)*5 + phase) so artifact
    # rows stay unique; events also carry explicit `cycle` + `phase`.
    consensus: Dict[str, Any] = {"verdict": "DISSENT", "winning_id": None, "weighted_score": 0.0, "action_items": []}
    refined_table_str = "(no hypotheses)"
    skeptic_output: Dict[str, Any] = {"challenges": [], "unorthodox_alternatives": [], "hidden_assumptions": []}
    skeptic_output_str = "{}"
    votes: List[Dict[str, Any]] = []
    cycle_verdicts: List[Dict[str, Any]] = []
    prior_ctx = ""  # injected into the hypotheses tables on cycle >= 2

    for cycle in range(1, HYPER_ROOM_MAX_CYCLES + 1):
        def _pr(phase: int) -> int:
            return (cycle - 1) * 5 + phase

        if cycle > 1:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "cycle_start", "cycle": cycle, "max_cycles": HYPER_ROOM_MAX_CYCLES,
                "prior_verdict": consensus.get("verdict"),
                "prior_score": consensus.get("weighted_score"),
                "reason": "re-seeding refined hypotheses + skeptic alternatives to drive convergence",
            })

        # Reset per-cycle phase outputs.
        peer_reviews = []
        refined = []
        refined_by_id = {}
        skeptic_output = {"challenges": [], "unorthodox_alternatives": [], "hidden_assumptions": []}
        votes = []

        # ─── R2 — Peer Cross-Exam ──────────────────────────────────────
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_start", "round": _pr(2), "cycle": cycle, "phase": 2, "label": "Peer Cross-Exam",
            "task": "Each agent reviews 2 OTHER hypotheses with corroborating or contradicting evidence.",
        })
        hyp_table = (prior_ctx + "\n" if prior_ctx else "") + "\n".join(
            f"  [{h['id']}] {h['agent_name']} ({h['lane']}, conf {h['confidence']:.2f}): {h['hypothesis']}"
            for h in hypotheses
        )

        async def _run_r2(emp: Dict[str, Any]) -> List[Dict[str, Any]]:
            # Assign 2 targets that are NOT this agent's own.
            own_id = f"h-{emp['slug']}"
            candidate_ids = [h["id"] for h in hypotheses if h["id"] != own_id]
            target_ids = candidate_ids[:2]
            if not target_ids:
                return []
            try:
                agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
                prompt = R2_PEER_REVIEW_PROMPT.format(
                    persona_name=emp.get("name", emp.get("slug")),
                    lane=emp["_lane"],
                    hypotheses_table=hyp_table,
                    target_ids=", ".join(target_ids),
                )
                reply = await agent(Msg(name="user", content=prompt, role="user"))
                _report_turn(emp["id"], req.user_message, reply)
                text = _msg_to_text(reply)
                m = re.search(r"\{[\s\S]+\}", text)
                parsed = json.loads(m.group(0)) if m else None
                reviews = parsed.get("reviews") if isinstance(parsed, dict) else None
                if not isinstance(reviews, list):
                    return []
                out = []
                for r in reviews:
                    if not isinstance(r, dict):
                        continue
                    ev_ids = [str(x) for x in (r.get("evidence_memory_ids") or []) if x]
                    for e in ev_ids:
                        evidence_pool.add(e)
                    # Normalise to the canonical stance set (agree|challenge|extend).
                    stance = str(r.get("agreement", "extend"))[:20].strip().lower()
                    if stance == "support":
                        stance = "agree"
                    if stance not in ("agree", "challenge", "extend"):
                        stance = "extend"
                    out.append({
                        "reviewer_slug": emp["slug"],
                        "reviewer_name": emp.get("name", emp["slug"]),
                        "target_hypothesis_id": str(r.get("target_hypothesis_id", ""))[:100],
                        "agreement": stance,
                        "evidence_memory_ids": ev_ids,
                        "reason": str(r.get("reason", ""))[:500],
                    })
                return out
            except Exception as exc:
                log.warning("[swarm] R2 %s failed: %s", emp.get("slug"), exc)
                return []

        async def _staggered_r2(emp, idx):
            await asyncio.sleep(0.25 * idx)
            return await _run_r2(emp)
        if not cost_cap_hit:
            r2_lists = await asyncio.gather(*[_staggered_r2(emp, i) for i, emp in enumerate(speakers)], return_exceptions=False)
            peer_reviews = [r for lst in r2_lists for r in lst]
        for r in peer_reviews:
            tokens = max(60, len(r["reason"]) // 4)
            cost_tokens += tokens
            target_author = (hyp_by_id.get(r["target_hypothesis_id"]) or {}).get("agent_name")
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "peer_review",
                "reviewer": r["reviewer_slug"],
                "reviewer_name": r["reviewer_name"],
                "target_hypothesis_id": r["target_hypothesis_id"],
                "target_author": target_author,
                "agreement": r["agreement"],
                "evidence_memory_ids": r["evidence_memory_ids"],
                "content": r["reason"],
                "tokens": tokens,
                "round": _pr(2), "cycle": cycle, "phase": 2,
            })
        log.info("[swarm] R2 done turn=%s cycle=%d reviews=%d capped=%s", req.turn_id, cycle, len(peer_reviews), cost_cap_hit)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_end", "round": _pr(2), "cycle": cycle, "phase": 2, "reviews_count": len(peer_reviews),
        })

        # ─── R3 — Deep Chain-of-Thought ────────────────────────────────
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_start", "round": _pr(3), "cycle": cycle, "phase": 3, "label": "Deep Chain-of-Thought",
            "task": "Each agent refines hypothesis via full lane playbook; emits explicit steps.",
        })
        reviews_by_target: Dict[str, List[Dict[str, Any]]] = {}
        for r in peer_reviews:
            reviews_by_target.setdefault(r["target_hypothesis_id"], []).append(r)

        async def _run_r3(emp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            own_id = f"h-{emp['slug']}"
            own = hyp_by_id.get(own_id)
            if not own:
                return None
            own_reviews = reviews_by_target.get(own_id, [])
            reviews_text = "\n".join(
                f"  - {rv['reviewer_name']} ({rv['agreement']}): {rv['reason']}"
                for rv in own_reviews
            ) or "  (no peer reviews of your hypothesis)"
            try:
                agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
                prompt = R3_DEEP_DIVE_PROMPT.format(
                    persona_name=emp.get("name", emp.get("slug")),
                    lane=emp["_lane"],
                    your_hypothesis=own["hypothesis"],
                    your_reviews=reviews_text,
                    lane_playbook=LANE_PLAYBOOKS.get(emp["_lane"], ""),
                )
                reply = await agent(Msg(name="user", content=prompt, role="user"))
                _report_turn(emp["id"], req.user_message, reply)
                text = _msg_to_text(reply)
                m = re.search(r"\{[\s\S]+\}", text)
                parsed = json.loads(m.group(0)) if m else None
                if not isinstance(parsed, dict) or not parsed.get("refined_hypothesis"):
                    return None
                ev_ids = [str(x) for x in (parsed.get("evidence_memory_ids") or []) if x]
                for e in ev_ids:
                    evidence_pool.add(e)
                steps = [str(s)[:300] for s in (parsed.get("chain_of_thought") or [])][:8]
                refined_one = {
                    "id": own_id,  # Same id — same hypothesis, refined
                    "agent_slug": emp["slug"],
                    "agent_name": emp.get("name", emp["slug"]),
                    "lane": emp["_lane"],
                    "refined_hypothesis": str(parsed.get("refined_hypothesis", ""))[:2000],
                    "chain_of_thought": steps,
                    "evidence_memory_ids": ev_ids,
                    "lane_specific_finding": str(parsed.get("lane_specific_finding", ""))[:500],
                    "confidence": float(parsed.get("confidence") or 0.6),
                }
                return refined_one
            except Exception as exc:
                log.warning("[swarm] R3 %s failed: %s", emp.get("slug"), exc)
                return None

        async def _staggered_r3(emp, idx):
            await asyncio.sleep(0.25 * idx)
            return await _run_r3(emp)
        if not cost_cap_hit and _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
            cost_cap_hit = True
            log.warning("[swarm] cost cap hit before R3 turn=%s total=%d cap=%d",
                        req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "cost_cap_hit", "total": _turn_tool_total(),
                "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": _pr(3), "cycle": cycle,
            })
        elif not cost_cap_hit and await _deadline_hit(_pr(3)):
            cost_cap_hit = True
        if not cost_cap_hit:
            r3_results = await asyncio.gather(*[_staggered_r3(emp, i) for i, emp in enumerate(speakers)], return_exceptions=False)
            refined = [r for r in r3_results if r]
            refined_by_id = {r["id"]: r for r in refined}
        for r in refined:
            tokens = max(150, (len(r["refined_hypothesis"]) + sum(len(s) for s in r["chain_of_thought"])) // 4)
            cost_tokens += tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "chain_of_thought",
                "id": r["id"],
                "agent": r["agent_slug"],
                "lane": r["lane"],
                "steps": r["chain_of_thought"],
                "refined_hypothesis": r["refined_hypothesis"],
                "lane_specific_finding": r["lane_specific_finding"],
                "evidence_memory_ids": r["evidence_memory_ids"],
                "confidence": r["confidence"],
                "tokens": tokens,
                "round": _pr(3), "cycle": cycle, "phase": 3,
            })
        log.info("[swarm] R3 done turn=%s cycle=%d refined=%d capped=%s", req.turn_id, cycle, len(refined), cost_cap_hit)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_end", "round": _pr(3), "cycle": cycle, "phase": 3, "refined_count": len(refined),
        })

        # ─── R4 — Skeptic Unorthodox Challenge ─────────────────────────
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_start", "round": _pr(4), "cycle": cycle, "phase": 4, "label": "Skeptic Unorthodox Challenge",
            "task": "Permanent Skeptic surfaces hidden assumptions + unorthodox alternatives.",
        })
        if not cost_cap_hit and _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
            cost_cap_hit = True
            log.warning("[swarm] cost cap hit before R4 turn=%s total=%d cap=%d",
                        req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "cost_cap_hit", "total": _turn_tool_total(),
                "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": _pr(4), "cycle": cycle,
            })
        elif not cost_cap_hit and await _deadline_hit(_pr(4)):
            cost_cap_hit = True
        if skeptic and refined and not cost_cap_hit:
            try:
                agent = await _build_agent_for_room(req.room_id, skeptic, user_id=req.user_id, org_id=req.org_id)
                refined_table = "\n".join(
                    f"  [{r['id']}] {r['agent_name']} ({r['lane']}): {r['refined_hypothesis']}"
                    for r in refined
                )
                prompt = R4_SKEPTIC_PROMPT.format(
                    skeptic_prelude=SKEPTIC_PERSONA_PRELUDE,
                    refined_hypotheses_table=refined_table,
                )
                reply = await agent(Msg(name="user", content=prompt, role="user"))
                _report_turn(skeptic["id"], req.user_message, reply)
                text = _msg_to_text(reply)
                m = re.search(r"\{[\s\S]+\}", text)
                parsed = json.loads(m.group(0)) if m else None
                if isinstance(parsed, dict):
                    skeptic_output = {
                        "challenges": (parsed.get("challenges") or [])[:6],
                        "unorthodox_alternatives": (parsed.get("unorthodox_alternatives") or [])[:4],
                        "hidden_assumptions": (parsed.get("hidden_assumptions") or [])[:5],
                    }
                    for c in skeptic_output["challenges"]:
                        for e in (c.get("evidence_memory_ids") or []):
                            if e: evidence_pool.add(str(e))
                    for u in skeptic_output["unorthodox_alternatives"]:
                        for e in (u.get("evidence_memory_ids") or []):
                            if e: evidence_pool.add(str(e))
            except Exception as exc:
                log.warning("[swarm] R4 skeptic failed: %s", exc)
            tokens = 200
            cost_tokens += tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "skeptic_challenge",
                "agent": skeptic["slug"],
                "challenges": skeptic_output["challenges"],
                "unorthodox_alternatives": skeptic_output["unorthodox_alternatives"],
                "hidden_assumptions": skeptic_output["hidden_assumptions"],
                "tokens": tokens,
                "round": _pr(4), "cycle": cycle, "phase": 4,
            })
        log.info("[swarm] R4 done turn=%s cycle=%d challenges=%d unorthodox=%d capped=%s",
                 req.turn_id, cycle, len(skeptic_output["challenges"]),
                 len(skeptic_output["unorthodox_alternatives"]), cost_cap_hit)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_end", "round": _pr(4), "cycle": cycle, "phase": 4,
            "challenges_count": len(skeptic_output["challenges"]),
            "unorthodox_count": len(skeptic_output["unorthodox_alternatives"]),
        })

        # ─── R5 Step A — Convergence Vote (parallel) ───────────────────
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "round_start", "round": _pr(5), "cycle": cycle, "phase": 5, "label": "Convergence Vote + Synthesis",
            "task": "Everyone votes on refined hypotheses or unorthodox alternatives. Lead synthesises.",
        })
        # If R3 was skipped (cost-capped) fall back to current hypotheses so
        # there is always a real, voteable table with valid ids.
        if refined:
            refined_table_str = "\n".join(
                f"  [{r['id']}] {r['agent_name']} ({r['lane']}, conf {r['confidence']:.2f}): {r['refined_hypothesis']}"
                for r in refined
            )
        else:
            refined_table_str = "\n".join(
                f"  [{h['id']}] {h['agent_name']} ({h['lane']}, conf {h['confidence']:.2f}): {h['hypothesis']}"
                for h in hypotheses
            ) or "(no hypotheses)"
        vote_table_str = (prior_ctx + "\n" if prior_ctx else "") + refined_table_str
        skeptic_output_str = json.dumps(skeptic_output, indent=2)[:3000]
        voters = list(participants)  # everyone votes

        async def _run_vote(emp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            try:
                agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
                prompt = R5_VOTE_PROMPT.format(
                    persona_name=emp.get("name", emp.get("slug")),
                    lane=emp["_lane"],
                    refined_hypotheses_table=vote_table_str,
                    skeptic_output=skeptic_output_str,
                )
                reply = await agent(Msg(name="user", content=prompt, role="user"))
                _report_turn(emp["id"], req.user_message, reply)
                text = _msg_to_text(reply)
                m = re.search(r"\{[\s\S]+\}", text)
                parsed = json.loads(m.group(0)) if m else None
                if not isinstance(parsed, dict):
                    log.info("[swarm] R5 vote %s: non-JSON reply, dropping (abstain)", emp.get("slug"))
                    return None
                return {
                    "voter": emp["slug"],
                    "voter_id": emp["id"],
                    "vote_for_hypothesis_id": str(parsed.get("vote_for_hypothesis_id", "none"))[:100],
                    "score": max(1, min(5, int(parsed.get("score") or 3))),
                    "conditions": [str(c)[:200] for c in (parsed.get("conditions") or [])][:5],
                    "reason": str(parsed.get("reason", ""))[:300],
                }
            except Exception as exc:
                log.warning("[swarm] R5 vote %s failed: %s", emp.get("slug"), exc)
                return None

        async def _staggered_vote(emp, idx):
            await asyncio.sleep(0.25 * idx)
            return await _run_vote(emp)
        if not cost_cap_hit and _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
            cost_cap_hit = True
            log.warning("[swarm] cost cap hit before R5 vote turn=%s total=%d cap=%d",
                        req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "cost_cap_hit", "total": _turn_tool_total(),
                "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": _pr(5), "cycle": cycle,
            })
        elif not cost_cap_hit and await _deadline_hit(_pr(5)):
            cost_cap_hit = True
        if not cost_cap_hit:
            vote_results = await asyncio.gather(*[_staggered_vote(emp, i) for i, emp in enumerate(voters)], return_exceptions=False)
            votes = [v for v in vote_results if v]
        for v in votes:
            tokens = max(60, len(v.get("reason", "")) // 4)
            cost_tokens += tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "vote",
                "voter": v["voter"],
                "vote_for_hypothesis_id": v["vote_for_hypothesis_id"],
                "score": v["score"],
                "conditions": v["conditions"],
                "content": v["reason"],
                "tokens": tokens,
                "round": _pr(5), "cycle": cycle, "phase": 5,
            })

        consensus = _consensus_verdict(votes, trust_by_slug)
        converged = _has_converged(consensus)
        cycle_verdicts.append({
            "cycle": cycle, "verdict": consensus["verdict"],
            "weighted_score": consensus["weighted_score"], "converged": converged,
        })
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "cycle_end", "cycle": cycle, "max_cycles": HYPER_ROOM_MAX_CYCLES,
            "verdict": consensus["verdict"], "weighted_score": consensus["weighted_score"],
            "winning_hypothesis_id": consensus["winning_id"], "converged": converged,
        })
        log.info("[swarm] cycle %d/%d done turn=%s verdict=%s score=%.2f converged=%s capped=%s",
                 cycle, HYPER_ROOM_MAX_CYCLES, req.turn_id, consensus["verdict"],
                 consensus["weighted_score"], converged, cost_cap_hit)

        # ── Stop or iterate ────────────────────────────────────────────
        if converged or cost_cap_hit:
            break
        if cycle >= HYPER_ROOM_MAX_CYCLES:
            break
        if await _deadline_hit(_pr(5) + 1):
            cost_cap_hit = True
            break
        if not refined:
            # Nothing to carry forward — re-running with no hypotheses would
            # just regenerate the same dissent. Stop and seal what we have.
            break

        # ── Re-seed for the next cycle ─────────────────────────────────
        # Carry the refined hypotheses forward as the new candidate set
        # (ids stay stable: h-{slug}), and build a context preamble of the
        # unresolved dissent + the Skeptic's unorthodox alternatives so the
        # next cycle's reviewers/voters actually try to reconcile, not repeat.
        hypotheses = [{
            "id": r["id"],
            "agent_id": refined_by_id.get(r["id"], {}).get("agent_id"),
            "agent_slug": r["agent_slug"],
            "agent_name": r["agent_name"],
            "lane": r["lane"],
            "hypothesis": r["refined_hypothesis"],
            "confidence": r["confidence"],
            "evidence_memory_ids": r.get("evidence_memory_ids", []),
            "reasoning_brief": r.get("lane_specific_finding", ""),
        } for r in refined]
        hyp_by_id = {h["id"]: h for h in hypotheses}
        dissent_lines = [
            f"  - {v['voter']} scored {v['score']}/5 for {v['vote_for_hypothesis_id']}: {v['reason']}"
            for v in votes if int(v.get("score") or 0) <= 3
        ][:6]
        alt_lines = [
            f"  - {a.get('alternative') or a.get('title') or a.get('idea') or a}"
            for a in (skeptic_output.get("unorthodox_alternatives") or [])
        ][:4]
        prior_ctx = (
            f"[PRIOR CYCLE {cycle} VERDICT: {consensus['verdict']} "
            f"(weighted {consensus['weighted_score']}). The room did NOT reach strong consensus. "
            f"This is convergence cycle {cycle + 1} — RECONCILE the disagreement and converge on one "
            f"defensible answer; do not merely restate your prior position.]\n"
            + ("Unresolved dissent:\n" + "\n".join(dissent_lines) + "\n" if dissent_lines else "")
            + ("Skeptic's unorthodox alternatives to weigh:\n" + "\n".join(alt_lines) if alt_lines else "")
        ).strip()

    # ─── Convergence summary (drives the FE cycle trail) ───────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "convergence",
        "cycles_run": len(cycle_verdicts),
        "max_cycles": HYPER_ROOM_MAX_CYCLES,
        "trail": cycle_verdicts,
        "final_verdict": consensus["verdict"],
        "final_score": consensus["weighted_score"],
        "converged": _has_converged(consensus),
    })

    # ─── R5 Step B — Lead Synthesis ────────────────────────────────────
    # When the cost cap fired before the vote, `votes` is empty and the
    # verdict is DISSENT/none. Invoking the synthesis agent here would burn
    # real tokens to write a "final answer" over an empty table and an empty
    # tally — almost certainly empty or hallucinated. Skip the LLM call and
    # emit a canned marker so the seal reflects reality.
    final_text = ""
    if cost_cap_hit:
        final_text = "[cost cap reached — synthesis skipped]"
        synth_tokens = 0
        log.warning("[swarm] synthesis skipped (cost cap) turn=%s verdict=%s",
                    req.turn_id, consensus["verdict"])
    else:
        try:
            lead_agent = await _build_agent_for_room(req.room_id, lead, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
            vote_summary_lines = []
            for v in votes:
                vote_summary_lines.append(
                    f"  - {v['voter']} (trust {trust_by_slug.get(v['voter'], 0.5):.2f}): "
                    f"vote={v['vote_for_hypothesis_id']} score={v['score']} conditions={v['conditions']}"
                )
            synth_prompt = R5_SYNTHESIS_PROMPT.format(
                lead_name=lead.get("name", lead.get("slug")),
                refined_hypotheses_table=refined_table_str,
                skeptic_output=skeptic_output_str,
                vote_summary="\n".join(vote_summary_lines) or "(no votes)",
                verdict=consensus["verdict"],
                winning_id=consensus["winning_id"] or "none",
                room_goal=req.room_goal or "",
            )
            synth_reply = await lead_agent(Msg(name="user", content=synth_prompt, role="user"))
            _report_turn(lead["id"], req.user_message, synth_reply)
            final_text = _msg_to_text(synth_reply) or ""
        except Exception as exc:
            log.warning("[swarm] R5 synthesis failed: %s", exc)
        if not final_text:
            log.warning("[swarm] empty synthesis turn=%s verdict=%s cost_cap_hit=%s",
                        req.turn_id, consensus["verdict"], cost_cap_hit)
        synth_tokens = max(200, len(final_text) // 4)
    cost_tokens += synth_tokens
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "line",
        "agent": lead.get("slug"),
        "round": 5,
        "content": final_text or "(lead synthesis failed)",
        "kind": "synthesis",
        "tokens": synth_tokens,
    })
    log.info("[swarm] R5 done turn=%s verdict=%s votes=%d capped=%s",
             req.turn_id, consensus["verdict"], len(votes), cost_cap_hit)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_end", "round": 5, "verdict": consensus["verdict"],
    })

    # ─── Swarm verdict event ───────────────────────────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "swarm_verdict",
        "verdict": consensus["verdict"],
        "weighted_score": consensus["weighted_score"],
        "winning_hypothesis_id": consensus["winning_id"],
        "action_items": consensus["action_items"],
        "evidence_memory_ids_union": sorted(evidence_pool)[:50],
        "vote_count": len(votes),
    })

    # ─── Trust updates from votes ──────────────────────────────────────
    try:
        # Lead: positive if verdict not DISSENT and synthesis non-empty
        lead_won = consensus["verdict"] != "DISSENT" and bool(final_text)
        await update_trust(req.org_id, lead["id"], 0.05 if lead_won else -0.05, lead_won)
        # Skeptic bonus: if winner is an unorthodox alternative, big positive
        if skeptic and (consensus["winning_id"] or "").startswith("unorthodox-"):
            await update_trust(req.org_id, skeptic["id"], 0.10, True)
        elif skeptic:
            await update_trust(req.org_id, skeptic["id"], 0.02, True)
        # Other voters: agreement with majority verdict
        for v in votes:
            voted_winner = (v["vote_for_hypothesis_id"] or "") == (consensus["winning_id"] or "")
            delta = 0.03 if voted_winner else -0.01
            await update_trust(req.org_id, v["voter_id"], delta, voted_winner)
    except Exception as exc:
        log.warning("[swarm] trust update failed: %s", exc)

    # ─── Save consensus decision to memory (when AGREED or CONDITIONAL) ─
    saved_memory_id = None
    if consensus["verdict"] in ("AGREED", "CONDITIONAL") and final_text:
        winner = refined_by_id.get(consensus["winning_id"] or "")
        decision_body = (
            f"Verdict: {consensus['verdict']} (weighted score {consensus['weighted_score']})\n\n"
            f"Final answer:\n{final_text}\n\n"
            + (f"Action items:\n- " + "\n- ".join(consensus['action_items']) + "\n\n" if consensus['action_items'] else "")
            + (f"Winning hypothesis ({winner['lane']}): {winner['refined_hypothesis']}\n\n" if winner else "")
            + f"Skeptic surfaced {len(skeptic_output['challenges'])} challenges, "
              f"{len(skeptic_output['unorthodox_alternatives'])} unorthodox alternatives."
        )
        saved_memory_id = await _save_room_decision(
            user_id=req.user_id,
            org_id=req.org_id,
            room_id=req.room_id,
            turn_id=req.turn_id,
            user_message=req.user_message,
            decision_text=decision_body,
            trigger=f"swarm-{consensus['verdict'].lower()}",
        )
        if saved_memory_id:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "decision_saved",
                "memory_id": saved_memory_id,
                "trigger": f"swarm-{consensus['verdict'].lower()}",
            })

    # ─── Collect tool_call_counts from cached agents ───────────────────
    try:
        for p in participants:
            cache_key = f"{req.room_id}:{p['id']}"
            cached_agent = _ROOM_AGENTS.get(cache_key)
            if cached_agent is not None:
                count = int(getattr(cached_agent, "tool_call_count", 0) or 0)
                tool_call_counts[p.get("slug")] = count
                # Reset post-turn so next turn starts fresh.
                try:
                    setattr(cached_agent, "tool_call_count", 0)
                except Exception as exc:  # noqa: BLE001
                    log.debug("tool_call_count reset failed slug=%s: %s", p.get("slug"), exc)
    except Exception as exc:  # noqa: BLE001
        log.warning("[swarm] tool_call_count collection failed: %s", exc)

    # ─── Seal ──────────────────────────────────────────────────────────
    status = "complete" if consensus["verdict"] in ("AGREED", "CONDITIONAL") else "escalated"
    log.info(
        "[swarm] seal turn=%s verdict=%s tool_call_total=%d counts=%s evidence_pool=%d",
        req.turn_id, consensus["verdict"], sum(tool_call_counts.values()),
        tool_call_counts, len(evidence_pool),
    )
    report_claims: List[Dict[str, Any]] = []
    for r in refined or []:
        report_claims.append({
            "agent_slug": r.get("agent_slug"),
            "agent_name": r.get("agent_name"),
            "lane": r.get("lane"),
            "refined_hypothesis": r.get("refined_hypothesis"),
        })
    if not report_claims:
        for h in hypotheses or []:
            report_claims.append({
                "agent_slug": h.get("agent_slug"),
                "agent_name": h.get("agent_name"),
                "lane": h.get("lane"),
                "hypothesis": h.get("hypothesis"),
            })
    await _emit_event(req.callback_url, req.turn_id, _build_harness_quality_check(
        room_goal=req.room_goal or "",
        final_text=final_text,
        evidence_count=len(evidence_pool),
        source_count=len(_web_sources_for_turn(req.turn_id)),
        claims_count=len(report_claims),
        reviews_count=len(peer_reviews),
        votes_count=len(votes),
        web_intel_used="WEB INTEL DOSSIER" in (memory_context or ""),
        project_scoped=bool(memory_audit.get("project_scoped")),
        project_memory_hits=int(memory_audit.get("project_hits", 0) or 0),
    ))
    # Phase 5 — recon/verify the result against the lead's done-criterion.
    await _verify_and_emit(
        req, lead, final_text=final_text,
        tool_call_counts=tool_call_counts,
        blackboard={"hit_count": len(evidence_pool)},
    )
    await _emit_event(req.callback_url, req.turn_id, _build_final_report(
        user_message=req.user_message,
        final_text=final_text,
        template=room_template,
        room_goal=req.room_goal or "",
        status=status,
        verdict=consensus["verdict"],
        score=consensus.get("weighted_score"),
        lead=lead,
        action_items=consensus.get("action_items") or [],
        evidence_ids=sorted(evidence_pool)[:50],
        sources=_web_sources_for_turn(req.turn_id),
        claims=report_claims,
        reviews=peer_reviews,
        votes=votes,
        objections=(skeptic_output.get("challenges") or []),
        web_intel_used="WEB INTEL DOSSIER" in (memory_context or ""),
        project_scoped=bool(memory_audit.get("project_scoped")),
        project_memory_hits=int(memory_audit.get("project_hits", 0) or 0),
    ))
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "seal",
        "cost_tokens": cost_tokens,
        "status": status,
        "duration_ms": int((time.time() - started) * 1000),
        "template": room_template,
        "verdict": consensus["verdict"],
        "winning_id": consensus["winning_id"],
        "evidence_pool_size": len(evidence_pool),
        "tool_call_counts": tool_call_counts,
        "tool_call_total": sum(tool_call_counts.values()),
        "saved_memory_id": saved_memory_id,
        "vote_count": len(votes),
        "cost_cap_hit": cost_cap_hit,
    })
    _WEB_INTEL_PAYLOADS.pop(req.turn_id, None)
    return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)


# ─── Main orchestrator ─────────────────────────────────────────────────


# Phase 1 — output types the lead may pick from user intent.
_PLAN_OUTPUTS = {"email", "doc", "sheet", "slack", "ticket", "crm", "decision", "answer"}


def _first_json_object(text: str) -> Optional[Dict[str, Any]]:
    """Extract the FIRST balanced {...} object and json.loads it. Robust to a
    model emitting trailing/extra braces after a valid object (greedy regex
    grabbed too much)."""
    if not text:
        return None
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start:i + 1])
                    return obj if isinstance(obj, dict) else None
                except Exception:  # noqa: BLE001
                    return None
    return None


async def _plan_turn(
    req: "RoomTurnRequest",
    lead: Dict[str, Any],
    participants: List[Dict[str, Any]],
    enabled_connectors: List[str],
) -> Optional[Dict[str, Any]]:
    """Phase 1 — the lead, IN PERSONA, plans the turn before the team acts.

    Returns {intended_output, done_criterion, steps[], assignments{}, connectors_needed[]}
    or None on failure (caller falls through to the normal flow). Persona is
    untouched: the lead plans as its own character via its built agent.
    """
    roster = ", ".join(
        f"{p.get('name') or p.get('slug')} [{p.get('_lane') or p.get('role_archetype') or 'Communicator'}]"
        for p in participants
    )
    conns = ", ".join(enabled_connectors) if enabled_connectors else "none"
    prompt = (
        f"User request: {req.user_message}\n"
        f"Standing room goal: {req.room_goal or '(none)'}\n"
        f"Your team: {roster}\n"
        f"Connectors enabled this room: {conns} "
        f"(gmail→gmail_search/gmail_get, google_docs→docs_create/docs_append; others via their tools)\n\n"
        "Before the team acts, lay out a SHORT plan. Decide the right OUTPUT from the user's intent "
        "— it is NOT always a document. Reply with STRICT JSON only (no prose, no markdown), exactly these keys:\n"
        '{\n'
        '  "intended_output": one of ["email","doc","sheet","slack","ticket","crm","decision","answer"],\n'
        '  "done_criterion": "<one sentence: how we know the task is fully finished and verified>",\n'
        '  "steps": ["<3-6 ordered steps the team will take>"],\n'
        '  "assignments": {"<agent name or slug from the team>": "<their concrete sub-task>"},\n'
        '  "connectors_needed": ["<subset of the enabled connectors actually needed, [] if none>"]\n'
        '}\n'
        'Intent → output examples: "email them"→email, "message/ping in slack"→slack, '
        '"write a report/brief"→doc, "build a tracker/table"→sheet, "should we…/which option"→decision, '
        'a plain question→answer. Only assign agents that are on the team. Output JSON only.'
    )
    # Build a TOOL-LESS in-persona planner: no tools in the action space means
    # the model can't emit a fake `JSON` tool-call (the llama-3.3 quirk that 400s)
    # — it just returns the plan as text. Persona preserved (active_prompt_version
    # + persona_contract flow through build_react_agent). Single-shot.
    try:
        boot = {b["id"]: b for b in await fetch_bootstrap()}
        boot_emp = boot.get(lead["id"], {}) or {}
        planner_emp = {
            **lead,
            "tools": ["_plan_noop"],   # truthy but matches no real tool → empty toolkit
            "connectors": [],
            "hyper": boot_emp.get("hyper"),
            "active_prompt_version": boot_emp.get("active_prompt_version"),
            "max_iters": 1,
        }
        agent = build_react_agent(
            planner_emp, boot_emp.get("api_key") or "",
            user_id=req.user_id, org_id=req.org_id, project_id=req.project_id,
        )
        reply = await agent(Msg(name="user", content=prompt, role="user"))
    except Exception as exc:  # noqa: BLE001
        log.warning("[plan] lead planning failed: %s", exc)
        return None
    plan = _first_json_object(_msg_to_text(reply) or "")
    if not isinstance(plan, dict):
        # Heuristic salvage so the turn still gets a usable output type.
        plan = {}
    out = str(plan.get("intended_output") or "answer").strip().lower()
    if out not in _PLAN_OUTPUTS:
        out = "answer"
    valid_names = {(p.get("slug") or "") for p in participants} | {(p.get("name") or "") for p in participants}
    raw_assign = plan.get("assignments") if isinstance(plan.get("assignments"), dict) else {}
    assignments = {str(k): str(v)[:400] for k, v in raw_assign.items() if str(k) in valid_names}
    return {
        "intended_output": out,
        "done_criterion": str(plan.get("done_criterion") or "")[:500],
        "steps": [str(s)[:300] for s in (plan.get("steps") or []) if isinstance(s, str)][:6],
        "assignments": assignments,
        "connectors_needed": [c for c in (plan.get("connectors_needed") or [])
                              if isinstance(c, str) and c in (enabled_connectors or [])],
    }


# Artifacts a turn may produce (links the verifier treats as real output).
_ARTIFACT_URL_RE = re.compile(
    r"https?://(?:docs\.google\.com|drive\.google\.com|sheets\.google\.com)/\S+",
    re.IGNORECASE,
)


async def _verify_turn(
    req: "RoomTurnRequest",
    lead: Dict[str, Any],
    *,
    final_text: str,
    tool_call_counts: Optional[Dict[str, int]] = None,
    blackboard: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Phase 5 — recon/verify pass. Before the turn seals, cross-check the
    produced evidence against the lead's `done_criterion`: artifact exists (or
    is queued for approval)? assignments covered? claims grounded? Returns a
    verdict {met, artifact_ok, assignments_ok, grounded_ok, gaps[], note} or
    None when there is no plan to verify against. Sets up P6 (goalkeeper loops
    while met is False). Tool-less single-shot LLM, like the planner."""
    plan = _PLAN_BY_TURN.get(req.turn_id)
    if not plan:
        return None
    pending = drain_pending_writes()  # non-destructive snapshot of queued writes
    produced = sorted(set(_ARTIFACT_URL_RE.findall(final_text or "")))
    evidence = {
        "intended_output": plan.get("intended_output"),
        "done_criterion": plan.get("done_criterion"),
        "assignments": list((plan.get("assignments") or {}).keys()),
        "tools_used": {str(k): int(v) for k, v in (tool_call_counts or {}).items()},
        "writes_pending_approval": [p.get("label") for p in pending],
        "produced_artifacts": produced,
        "memory_hits": int((blackboard or {}).get("hit_count", 0) or 0),
        "final_excerpt": (final_text or "")[:1600],
    }
    prompt = (
        "You are the room's recon/verifier. Cross-check the team's result against the "
        "done-criterion and report gaps. Be strict and evidence-based.\n\n"
        f"EVIDENCE:\n{json.dumps(evidence, ensure_ascii=False)}\n\n"
        "Reply with STRICT JSON only (no prose, no markdown), exactly these keys:\n"
        '{\n'
        '  "met": <true only if the done-criterion is fully satisfied by real evidence>,\n'
        '  "artifact_ok": <intended output was produced OR is queued pending the user\'s approval>,\n'
        '  "assignments_ok": <the assigned sub-tasks appear covered by the result>,\n'
        '  "grounded_ok": <specific factual claims are backed by tools/memory, not invented>,\n'
        '  "gaps": ["<concrete missing/unverified item>", "..."],\n'
        '  "note": "<one sentence>"\n'
        '}\n'
        "Rules: a WRITE that is PENDING APPROVAL counts as done-pending → artifact_ok=true, "
        "and met may be true (work is complete, awaiting the human). grounded_ok=false if the "
        "result asserts specific facts with memory_hits=0 and no tools used. If nothing is "
        "missing, gaps must be []. Output JSON only."
    )
    try:
        boot = {b["id"]: b for b in await fetch_bootstrap()}
        boot_emp = boot.get(lead["id"], {}) or {}
        verifier_emp = {
            **lead,
            "tools": ["_verify_noop"],   # truthy, matches no real tool → empty toolkit
            "connectors": [],
            "hyper": boot_emp.get("hyper"),
            "active_prompt_version": boot_emp.get("active_prompt_version"),
            "max_iters": 1,
        }
        agent = build_react_agent(
            verifier_emp, boot_emp.get("api_key") or "",
            user_id=req.user_id, org_id=req.org_id, project_id=req.project_id,
        )
        reply = await agent(Msg(name="user", content=prompt, role="user"))
    except Exception as exc:  # noqa: BLE001 — never fail a turn over verification
        log.warning("[verify] pass failed: %s", exc)
        return None
    obj = _first_json_object(_msg_to_text(reply) or "")
    if not isinstance(obj, dict):
        return None
    verdict = {
        "met": bool(obj.get("met")),
        "artifact_ok": bool(obj.get("artifact_ok")),
        "assignments_ok": bool(obj.get("assignments_ok")),
        "grounded_ok": bool(obj.get("grounded_ok")),
        "gaps": [str(g)[:200] for g in (obj.get("gaps") or []) if str(g).strip()][:8],
        "note": str(obj.get("note") or "")[:300],
        "produced_artifacts": produced,
        "pending_writes": [p.get("label") for p in pending],
        "intended_output": plan.get("intended_output"),
        "done_criterion": plan.get("done_criterion"),
    }
    return verdict


async def _verify_and_emit(
    req: "RoomTurnRequest",
    lead: Dict[str, Any],
    *,
    final_text: str,
    tool_call_counts: Optional[Dict[str, int]] = None,
    blackboard: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Run the verify pass, emit a `verify` event, stash the verdict on the
    plan (so the handler/P6 goalkeeper can read it), and return it."""
    verdict = await _verify_turn(
        req, lead, final_text=final_text,
        tool_call_counts=tool_call_counts, blackboard=blackboard,
    )
    if verdict is None:
        return None
    plan = _PLAN_BY_TURN.get(req.turn_id)
    if isinstance(plan, dict):
        plan["verification"] = verdict
    await _emit_event(req.callback_url, req.turn_id, {"t": "verify", **verdict})
    log.info("[verify] room=%s met=%s artifact=%s assign=%s grounded=%s gaps=%d",
             req.room_id, verdict["met"], verdict["artifact_ok"],
             verdict["assignments_ok"], verdict["grounded_ok"], len(verdict["gaps"]))
    return verdict


async def _orchestrate(req: RoomTurnRequest) -> RoomTurnResponse:
    """Run one room turn. Emits JSONL events to the control-plane along
    the way, returns the final cost + status.
    """
    started = time.time()
    perf_started = time.perf_counter()
    timing: Dict[str, int] = {}

    def _mark(label: str) -> None:
        timing[label] = int((time.perf_counter() - perf_started) * 1000)

    cost_tokens = 0
    status = "complete"

    # Look up participating employees — explicit user selection, so we
    # ignore the running/deploying Slack-gateway filter and include any
    # non-paused, non-archived employee by id.
    by_id = {r["id"]: r for r in await list_employees_by_ids(req.participant_ids, org_id=req.org_id)}
    participants: List[Dict[str, Any]] = []
    for pid in req.participant_ids:
        emp = by_id.get(pid)
        if not emp:
            # Either paused/archived OR belongs to a different org (the
            # query is now org-scoped). Drop it — never run a foreign-org
            # agent under this request's emulation headers.
            log.warning("[hyper] participant %s not found for org %s — dropping", pid, req.org_id)
            continue
        # Defence-in-depth: even if the query somehow returned a foreign
        # row, refuse to invoke an employee outside the request's tenant.
        if emp.get("org_id") and emp["org_id"] != req.org_id:
            log.warning("[hyper] participant %s org %s != req org %s — dropping",
                        pid, emp.get("org_id"), req.org_id)
            continue
        emp["_lane"] = derive_lane(emp)
        participants.append(emp)

    if not participants:
        await _emit_event(
            req.callback_url, req.turn_id,
            {"t": "error", "message": "Room has no eligible employees (paused or archived)"},
        )
        await _emit_event(
            req.callback_url, req.turn_id,
            {"t": "seal", "cost_tokens": 0, "status": "failed"},
        )
        return RoomTurnResponse(ok=False, cost_tokens=0, status="failed")

    # ── Router ───────────────────────────────────────────────────────
    # @mention override — if user wrote "@slug ..." force that one as lead.
    mention = re.match(r"\s*@([a-z0-9-]+)\b", req.user_message)
    forced: Optional[Dict[str, Any]] = None
    if mention:
        for p in participants:
            if p.get("slug") == mention.group(1):
                forced = p
                break
    # Role rotation: stateless, keyed on the monotonic per-room turn seq
    # (seq lives on hyper_turns, written by the control-plane). Resolve a
    # locked permanent skeptic first so lead rotation can exclude it.
    # All reads are org-scoped so a foreign room/turn id can't leak config.
    permanent_skeptic_id = await get_permanent_skeptic_id(req.room_id, org_id=req.org_id)
    permanent_lead_id = await get_permanent_lead_id(req.room_id, org_id=req.org_id)
    raw_seq = await get_turn_seq(req.turn_id, org_id=req.org_id)
    if raw_seq is None:
        seq = (int(hashlib.sha1(req.turn_id.encode("utf-8")).hexdigest(), 16) % 997) + 1
        log.warning("[hyper] get_turn_seq returned None for turn=%s — using hashed ordinal %d",
                    req.turn_id, seq)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "warning", "code": "turn_seq_unavailable", "fallback_seq": seq,
        })
    else:
        seq = raw_seq
    # Lead: @mention override wins; otherwise use the room's pinned lead.
    # This avoids recomputing router selection on every turn.
    lead = forced or _pick_lead_fixed(participants, permanent_lead_id, permanent_skeptic_id)
    if lead is None:
        raise RuntimeError("no eligible lead")
    reactors = _pick_reactors(participants, lead)

    # B1: per-room template (debate | decision | swarm | brainstorm | council
    # | lean_coffee | retrospective | review | standup | auto). Falls back to
    # 'debate'. 'auto' OR ROOM_TEMPLATE_AUTO_PICK=true triggers keyword scorer.
    room_template = await get_room_template(req.room_id, org_id=req.org_id)
    if room_template == "auto" or os.environ.get("ROOM_TEMPLATE_AUTO_PICK", "").lower() == "true":
        picked = recommend_template(req.user_message, default=room_template if room_template != "auto" else "debate")
        if picked and picked != room_template:
            log.info("[template] auto-picked %s for room %s (was %s)", picked, req.room_id, room_template)
        room_template = picked
    elif _is_deep_sim_prompt(req.user_message):
        log.info("[template] promoted explicit simulation prompt to deep_sim room=%s previous=%s", req.room_id, room_template)
        room_template = "deep_sim"
    # A4: pull trust scores for display only (no routing weight yet).
    trust_map = await get_trust_scores(req.org_id, [p["id"] for p in participants])
    trust_by_slug = {p.get("slug"): trust_map.get(p["id"], 0.5) for p in participants}

    # Permanent Skeptic (swarm template). If permanent_skeptic_id is set the
    # skeptic is locked (no rotation); otherwise rotate over Skeptic-lane
    # participants by seq, falling back to any non-lead participant.
    skeptic = _pick_skeptic_rotating(
        participants, permanent_skeptic_id, seq, lead["id"],
    )
    # Collision guard: an @mention `forced` lead bypasses the skeptic
    # exclusion, and a locked permanent skeptic ignores lead_id — either can
    # make lead.id == skeptic.id. The lead is silent R1-R4 and the skeptic
    # only speaks R4, so the same employee in both roles would never produce
    # a hypothesis or a coherent synthesis. Drop the skeptic for this turn.
    if skeptic and skeptic["id"] == lead["id"]:
        log.warning("[hyper] lead==skeptic (slug=%s) turn=%s — dropping skeptic this turn",
                    lead.get("slug"), req.turn_id)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "warning",
            "code": "lead_skeptic_collision",
            "slug": lead.get("slug"),
        })
        skeptic = None
    # Surface the case where a room has a locked permanent skeptic that is
    # not present this turn — the UI should show the configured challenger
    # was absent and a rotation stand-in (if any) was used instead.
    if permanent_skeptic_id and not any(p["id"] == permanent_skeptic_id for p in participants):
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "warning",
            "code": "configured_skeptic_absent",
            "permanent_skeptic_id": permanent_skeptic_id,
            "stand_in_skeptic": skeptic.get("slug") if skeptic else None,
        })

    if (req.flyby_decision or "").strip().lower() not in ("agree", "disagree"):
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "router",
            "id": f"router:{req.turn_id}:authoritative",
            "lead": lead.get("slug"),
            "reactors": [r.get("slug") for r in reactors],
            "lanes": {p.get("slug"): p["_lane"] for p in participants},
            "template": room_template,
            "trust": trust_by_slug,
            "skeptic": skeptic.get("slug") if skeptic else None,
            "turn_seq": seq,
        })
    _mark("router_ms")

    # ── Phase 1: lead plans the turn IN PERSONA (keystone) ──────────────
    # Before the team acts, the lead lays out steps, assignments, the
    # connectors needed, and — from the user's intent — the right OUTPUT
    # (not always a doc). Surfaced to the FE + stashed for later phases
    # (assignment-driven execution, goalkeeper). Persona untouched.
    try:
        _plan_conns = await get_room_enabled_connectors(req.room_id, org_id=req.org_id)
    except Exception:  # noqa: BLE001
        _plan_conns = []
    try:
        _plan = await _plan_turn(req, lead, participants, _plan_conns)
    except Exception as exc:  # noqa: BLE001 — never fail a turn over planning
        log.warning("[plan] skipped: %s", exc)
        _plan = None
    if _plan:
        _PLAN_BY_TURN[req.turn_id] = _plan
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "plan",
            "agent": lead.get("slug"),
            "intended_output": _plan["intended_output"],
            "done_criterion": _plan["done_criterion"],
            "steps": _plan["steps"],
            "assignments": _plan["assignments"],
            "connectors_needed": _plan["connectors_needed"],
        })
        log.info("[plan] room=%s output=%s steps=%d assignments=%d",
                 req.room_id, _plan["intended_output"], len(_plan["steps"]), len(_plan["assignments"]))
        # Phase 3 — drive execution from the plan. The lead's plan is folded
        # into the turn input so every template (debate/swarm/deep_sim) and
        # every agent acts on it: target output, done-criterion, ordered steps,
        # and each agent's assigned sub-task. Cache-safe — this is turn input,
        # not baked into the (room,emp,connectors)-cached agent, so a fresh plan
        # each turn reaches the same cached agents without a rebuild.
        _assign_lines = "\n".join(
            f"  - {k}: {v}" for k, v in _plan["assignments"].items()
        )
        _steps_str = " → ".join(str(s) for s in _plan["steps"]) if _plan["steps"] else ""
        _preamble_parts = [
            f"[TEAM PLAN — set by {lead.get('name') or lead.get('slug')}]",
            f"Target output: {_plan['intended_output']}.",
            f"Done when: {_plan['done_criterion']}." if _plan.get("done_criterion") else "",
            f"Plan: {_steps_str}." if _steps_str else "",
            (f"Assignments:\n{_assign_lines}" if _assign_lines else ""),
            (
                "Each of you: do YOUR assigned part using your tools (activate the "
                "connector group first if needed), build on each other with healthy "
                "skepticism and peer-review, and drive together to the target output. "
                "Do not stop at discussion — produce the actual output."
            ),
        ]
        _plan_preamble = "\n".join(p for p in _preamble_parts if p)
        req.user_message = f"{_plan_preamble}\n\n---\nUSER REQUEST:\n{req.user_message}"

    # ── Deep simulation template — MiroFish-style live room ───────────
    if room_template == "deep_sim":
        return await _orchestrate_deep_sim(
            req, participants, lead, room_template, started,
        )

    # ── Swarm template — branch into R1-R5 phase machine ──────────────
    if room_template == "swarm":
        # Best-effort pre-fetch memory context for R1 (shared across all agents).
        # Recall via master+emulation (req.user_id/org_id) so it reaches the
        # org brain regardless of whether bootstrap minted a lead key.
        memory_context_swarm = _room_goal_context(req.room_goal)
        swarm_blackboard: Dict[str, Any] = {
            "confidence": 0.0,
            "hit_count": 0,
            "project_id": req.project_id or None,
            "project_scoped": bool(req.project_id),
            "project_hit_count": 0,
            "project_confidence": 0.0,
            "org_fallback_used": False,
            "org_fallback_hit_count": 0,
        }
        try:
            boot_map = {b["id"]: b for b in await fetch_bootstrap()}
            lead_api_key = (boot_map.get(lead["id"], {}) or {}).get("api_key", "") or ""
            company_brief = await _build_company_brief(
                req.user_message, req.user_id, req.org_id, lead_api_key,
                project_id=req.project_id)
            recall_resp = await recall_emulated(
                req.user_message, user_id=req.user_id, org_id=req.org_id,
                api_key=lead_api_key, max_memories=6, project_id=req.project_id)
            rows = recall_resp.get("memories") or recall_resp.get("combined") or []
            rows = [r for r in rows if float(r.get("score", 0)) >= 0.45]
            project_hit_count = len(rows) if req.project_id else 0
            if req.project_id and not rows:
                expanded_resp = await recall_emulated(
                    f"{req.user_message} product roadmap pricing revenue marketing strategy customers launch plan brand positioning",
                    user_id=req.user_id, org_id=req.org_id,
                    api_key=lead_api_key, max_memories=10, project_id=req.project_id)
                rows = expanded_resp.get("memories") or expanded_resp.get("combined") or []
                rows = [r for r in rows if float(r.get("score", 0)) >= 0.38]
                project_hit_count = len(rows)
            org_fallback_used = False
            org_fallback_hit_count = 0
            if req.project_id and not rows:
                org_resp = await recall_emulated(
                    req.user_message, user_id=req.user_id, org_id=req.org_id,
                    api_key=lead_api_key, max_memories=6, project_id=None)
                rows = org_resp.get("memories") or org_resp.get("combined") or []
                rows = [r for r in rows if float(r.get("score", 0)) >= 0.45]
                org_fallback_used = bool(rows)
                org_fallback_hit_count = len(rows)
            candidate_block = ""
            if rows:
                lines_out = []
                for r in rows[:5]:
                    title = (r.get("title") or "").strip()
                    content = (r.get("content") or "").replace("\n", " ").strip()
                    if not content:
                        continue
                    snippet = content[:300] + ("…" if len(content) > 300 else "")
                    prefix = f'"{title}" — ' if title else ""
                    lines_out.append(f"- {prefix}{snippet}")
                if lines_out:
                    candidate_block = (
                        "CANDIDATE MEMORIES (most relevant to the user's question):\n"
                        + "\n".join(lines_out) + "\n"
                    )
            swarm_blackboard = {
                "confidence": 0.55 if rows else 0.0,
                "hit_count": len(rows),
                "project_id": req.project_id or None,
                "project_scoped": bool(req.project_id),
                "project_hit_count": project_hit_count,
                "project_confidence": min(1.0, project_hit_count / 3.0),
                "org_fallback_used": org_fallback_used,
                "org_fallback_hit_count": org_fallback_hit_count,
            }
            memory_context_swarm = _join_context(memory_context_swarm, company_brief + candidate_block)
            if memory_context_swarm:
                memory_context_swarm += "\n"
        except Exception as exc:  # noqa: BLE001
            log.warning("[swarm] pre-fetch failed: %s", exc)
        try:
            web_allowed_swarm = _web_intel_needed(req.user_message, swarm_blackboard, room_template)
            await _emit_event(req.callback_url, req.turn_id, _build_memory_audit_event(
                blackboard=swarm_blackboard,
                web_allowed=web_allowed_swarm,
                room_template=room_template,
            ))
            web_intel_swarm = await _run_web_intel_turn(
                req=req,
                lead=lead,
                blackboard=swarm_blackboard,
                memory_context=memory_context_swarm,
                room_template=room_template,
            )
            if web_intel_swarm:
                memory_context_swarm = _join_context(memory_context_swarm, web_intel_swarm)
                memory_context_swarm += "\n"
        except Exception as exc:  # noqa: BLE001
            log.warning("[swarm] web intel prefetch failed: %s", exc)
        return await _orchestrate_swarm(
            req, participants, lead, skeptic,
            memory_context_swarm, room_template,
            cost_tokens, started,
            memory_audit=_build_memory_audit_event(
                blackboard=swarm_blackboard,
                web_allowed=_web_intel_needed(req.user_message, swarm_blackboard, room_template),
                room_template=room_template,
            ),
        )

    # ── Shared blackboard (grounded RAG) ─────────────────────────────
    # Build one evidence board for the turn, then inject it into every
    # participant prompt. This avoids N broad ReAct recall loops while still
    # letting agents run targeted tools if the board has a real gap.
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "typing", "agent": lead.get("slug"), "kind": "grounding",
    })
    memory_context = ""
    blackboard: Dict[str, Any] = {
        "context_text": "",
        "memory_hits": [],
        "hit_count": 0,
        "confidence": 0.0,
        "memory_ids": [],
    }
    try:
        boot_map = {b["id"]: b for b in await fetch_bootstrap()}
        lead_api_key = (boot_map.get(lead["id"], {}) or {}).get("api_key", "") or ""
        blackboard = await _build_turn_blackboard(
            query=req.user_message,
            user_id=req.user_id,
            org_id=req.org_id,
            api_key=lead_api_key,
            project_id=req.project_id,
        )
        memory_context = blackboard.get("context_text") or ""
    except Exception as exc:  # noqa: BLE001
        log.warning("hyper-rooms blackboard build failed: %s", exc)
    current_turn_state = _format_current_turn_state(req.user_message, blackboard)
    goal_context = _room_goal_context(req.room_goal)
    if goal_context:
        memory_context = _join_context(goal_context, memory_context)
        current_turn_state = _join_context(goal_context, current_turn_state)
    try:
        web_allowed = _web_intel_needed(req.user_message, blackboard, room_template)
        await _emit_event(req.callback_url, req.turn_id, _build_memory_audit_event(
            blackboard=blackboard,
            web_allowed=web_allowed,
            room_template=room_template,
        ))
        web_intel_context = await _run_web_intel_turn(
            req=req,
            lead=lead,
            blackboard=blackboard,
            memory_context=memory_context,
            room_template=room_template,
        )
        if web_intel_context:
            memory_context = _join_context(memory_context, web_intel_context)
            current_turn_state = _join_context(current_turn_state, web_intel_context)
    except Exception as exc:  # noqa: BLE001
        log.warning("hyper-rooms web intel prefetch failed: %s", exc)
    _mark("blackboard_ms")

    # ── Lead generates full response ─────────────────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "typing", "agent": lead.get("slug"), "kind": "lead",
    })
    _mark("lead_start_ms")
    fast_decision_candidate = _is_fast_decision_candidate(req.user_message, room_template)
    lead_text = ""
    lead_agent = None
    lead_prompt = ""
    try:
        lead_agent = await _build_agent_for_room(req.room_id, lead, user_id=req.user_id, org_id=req.org_id, project_id=req.project_id)
        # Provide CSI persona framing in the user-prompt wrapper so we
        # don't have to mutate the agent's underlying system prompt.
        # Chat-tone constraints — this is a Slack-style room, NOT a memo.
        if memory_context:
            grounding = (
                "GROUNDING — you ALREADY have the relevant memories above.\n"
                "- Answer NOW directly from them. Do NOT announce, narrate, or plan tool calls.\n"
                "- Do NOT run broad recall again. Use tools only for one precise missing fact.\n"
                "- BANNED phrases: 'we need to recall', 'let's recall', 'we should traverse', "
                "'let me check', 'we'll review'. You already have the context — use it.\n"
                "- When you state a fact, name its memory title inline: '<claim> — from \"<title>\"'.\n"
                "- If the memories above don't actually cover the question, say so in one sentence, "
                "then give your best direct take.\n"
            )
        else:
            grounding = (
                "GROUNDING — pre-fetch found no obvious match. DO NOT bail with 'nothing on file' yet.\n"
                "- FIRST, silently call hivemind_recall 2-3 times with DIFFERENT queries before answering:\n"
                "    • the user's exact phrasing\n"
                "    • each proper noun in the question (people, projects, places, companies, products)\n"
                "    • a broader related topic the question implies\n"
                "- If ANY recall hits, answer from those memories and quote titles inline: '<claim> — from \"<title>\"'.\n"
                "- If you find a related entity memory, call hivemind_traverse_graph on its id to pull neighbours.\n"
                "- For time-anchored questions, try hivemind_at.\n"
                "- ONLY if every silent tool call returns empty: say 'nothing on file about X yet' in ONE sentence, "
                "then give a concrete take in 2-3 more sentences. Never invent facts.\n"
                "- NEVER narrate the search ('let me check', 'we should recall', 'I'll look') — just call the tools.\n"
            )
        overlay = get_template_overlay(room_template)
        overlay_lead = overlay.get("lead_hint", "")
        template_hint = (
            f"[TEMPLATE: {overlay.get('label', room_template)}]\n{overlay_lead}\n\n"
            if overlay_lead
            else ""
        )
        lead_prompt = (
            f"[CSI swarm — you are an EMPLOYEE at the HIVEMIND organisation. "
            f"You're the LEAD speaking up this turn. Your lane: {lead['_lane']}.]\n\n"
            + template_hint
            + (current_turn_state + "\n" if current_turn_state else "")
            + (memory_context + "\n" if memory_context else "")
            + f"WHO YOU ARE:\n"
            f"- You work AT HIVEMIND. The 'HIVEMIND' in this room = our org / our product.\n"
            f"- Speak from inside the company. Use 'we' / 'our' / 'the team'.\n"
            f"- Reference colleagues + projects by name ONLY when they appear in the memory above.\n\n"
            + grounding
            + f"\nSTAY ON THE TOPIC:\n"
            f"- ANSWER THE USER'S QUESTION DIRECTLY. Do not pivot to a project plan unless they "
            f"explicitly asked for owners/dates.\n"
            f"- Pull facts from the memories above; persona-flavour them in YOUR voice "
            f"({lead['_lane']}).\n"
            f"- Treat CURRENT TURN STATE as authoritative. If the user supplied a value, "
            f"constraint, date, name, or requirement there, use it instead of asking for it again.\n"
            f"- NEVER invent owners, dates, deadlines, or assignments. If memory does not name a "
            f"person responsible, don't assign one.\n"
            f"- If the user adds a constraint mid-thread ('this is only about X'), narrow your "
            f"answer accordingly — do not repeat the previous turn.\n\n"
            f"WRITE LIKE A CHAT MESSAGE:\n"
            f"- 3-4 short sentences. Substance in sentence one.\n"
            f"- Human Slack tone — tight, no filler, no 'Next steps:' boilerplate.\n"
            f"- Quote memory titles inline when stating a fact: '<claim> — from \"<title>\"'.\n\n"
            f"User said:\n{req.user_message}"
        )
        reply = await lead_agent(Msg(name="user", content=lead_prompt, role="user"))
        _report_turn(lead["id"], req.user_message, reply)
        lead_text = _msg_to_text(reply) or "(no response)"
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        # Groq strict-mode validator rejects stringy ints sometimes —
        # the LLM emits `"limit": "10"`. Retry once telling it to stop
        # quoting numbers; on second failure, fall back to a no-tool pass
        # so the turn at least delivers a lead bubble.
        # gpt-oss-20b occasionally emits empty output → output_parse_failed.
        # Treat it the same as a tool-schema error so we retry with a hint
        # and then fall through to the no-tools plain pass.
        is_tool_schema = (
            "tool_use_failed" in msg
            or "did not match schema" in msg
            or "output_parse_failed" in msg
            or "Parsing failed" in msg
        )
        retried = False
        if is_tool_schema and lead_agent:
            try:
                log.warning("lead tool-schema failure; retrying with explicit hint: %s", msg[:200])
                retry_prompt = lead_prompt + (
                    "\n\nIMPORTANT: when calling tools, pass numeric params as JSON numbers "
                    "(e.g. 10) NOT strings (e.g. \"10\"). If unsure, skip the tool call."
                )
                reply2 = await lead_agent(Msg(name="user", content=retry_prompt, role="user"))
                lead_text = _msg_to_text(reply2) or "(no response)"
                retried = True
            except Exception as exc2:  # noqa: BLE001
                log.warning("lead retry also failed: %s", str(exc2)[:200])
                # Final fallback — no tools, plain answer
                try:
                    plain_agent = await _build_agent_for_room(
                        req.room_id + ":notools", {**lead, "tools": []},
                        user_id=req.user_id, org_id=req.org_id,
                    )
                    reply3 = await plain_agent(Msg(name="user", content=req.user_message, role="user"))
                    lead_text = _msg_to_text(reply3) or "(no response)"
                    retried = True
                except Exception as exc3:  # noqa: BLE001
                    log.exception("lead plain fallback failed: %s", exc3)
        if not retried:
            log.exception("lead failure: %s", exc)
            # Surface a placeholder line so the UI doesn't end up with the
            # ghost-bubble symptom ("0 tok · 1 turn" with no agent output).
            placeholder = f"(I hit an error and couldn't respond — {msg[:140]})"
            placeholder_tokens = max(80, len(placeholder) // 4)
            cost_tokens += placeholder_tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "line",
                "agent": lead.get("slug"),
                "round": 1,
                "content": placeholder,
                "tokens": placeholder_tokens,
                "kind": "lead-error",
            })
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "error", "agent": lead.get("slug"), "message": msg, "retryable": True,
            })
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "seal", "cost_tokens": cost_tokens, "status": "failed",
            })
            return RoomTurnResponse(ok=False, cost_tokens=cost_tokens, status="failed")

    # Estimate tokens — agentscope hides counts; use 4 chars ≈ 1 token.
    lead_tokens = max(200, len(lead_text) // 4)
    cost_tokens += lead_tokens

    await _emit_event(req.callback_url, req.turn_id, {
        "t": "line",
        "agent": lead.get("slug"),
        "round": 1,
        "kind": "lead",
        "content": lead_text,
        "tokens": lead_tokens,
    })
    _mark("lead_line_ms")


    # ── Reactors (parallel) ──────────────────────────────────────────
    reaction_tasks = []
    for r in reactors:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "typing", "agent": r.get("slug"), "kind": "react",
        })
        agent = await _build_agent_for_room(req.room_id, r, user_id=req.user_id, org_id=req.org_id)
        is_opp = r["_lane"] in opposing_lanes(lead["_lane"])
        reaction_tasks.append(asyncio.create_task(_run_reactor(
            agent=agent,
            user_message=req.user_message,
            lead_line=lead_text,
            lead_name=lead.get("name", lead.get("slug", "lead")),
            reactor_lane=r["_lane"],
            is_opposing=is_opp,
            blackboard_context=memory_context,
            current_turn_state=current_turn_state,
        )))

    reactions: List[Dict[str, Any]] = []
    if reaction_tasks:
        results = await asyncio.gather(*reaction_tasks, return_exceptions=True)
        for r_emp, result in zip(reactors, results):
            if isinstance(result, Exception):
                continue
            if not result.get("react"):
                # Log abstain (for eval signal) — UI hides these
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "react",
                    "agent": r_emp.get("slug"),
                    "round": 1,
                    "agreement": "abstain",
                    "content": "",
                })
                continue
            line = result["line"]
            # B3: suppress lines that restate prior reactor points in this room.
            if _line_already_raised(req.room_id, line):
                log.info("repeat-guard: suppressed reactor=%s line=%s", r_emp.get("slug"), line[:60])
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "react",
                    "agent": r_emp.get("slug"),
                    "round": 1,
                    "agreement": "abstain",
                    "content": "",
                    "reason": "duplicate",
                })
                continue
            _remember_line(req.room_id, line)
            r_tokens = max(80, len(line) // 4)
            cost_tokens += r_tokens
            event = {
                "t": "react",
                "agent": r_emp.get("slug"),
                "round": 1,
                "agreement": result.get("agreement", "extend"),
                "confidence": float(result.get("confidence", 0.5)),
                "content": line,
                "evidence": result.get("evidence", []),
                "gap": result.get("gap", ""),
                "tokens": r_tokens,
            }
            reactions.append({**event, "emp": r_emp})
            await _emit_event(req.callback_url, req.turn_id, event)

    _mark("reactor_round1_ms")

    fast_decision_exit = (
        fast_decision_candidate
        and not _has_strong_challenge(reactions)
        and _is_substantive_lead(lead_text, bool(memory_context))
        and float(blackboard.get("confidence", 0) or 0) >= 0.34
    )

    # ── Synthesis round (always when reactors spoke, unless fast gate passed) ─
    # Reactors emit suggestion lines ("we should recall X", "what's the next
    # step"). Without a closer, the turn ends on those suggestions — the
    # user sees prompts to do work, not the work itself. Synthesis lets the
    # lead absorb the reactor lines + actually exercise tools (recall /
    # traverse) and produce one final actionable bubble.
    synth_text = ""
    if reactions and not fast_decision_exit:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "typing", "agent": lead.get("slug"), "kind": "synthesis",
        })
        try:
            reactor_summary = "\n".join(
                f"- {r['emp'].get('name', r['emp'].get('slug'))} ({r['emp']['_lane']}): \"{r['content']}\""
                for r in reactions
            )
            synth_prompt = (
                f"[CSI synthesis pass — you're still the HIVEMIND employee. Lane: {lead['_lane']}.]\n\n"
                + (current_turn_state + "\n" if current_turn_state else "")
                + (memory_context + "\n" if memory_context else "")
                + f"USER'S ORIGINAL QUESTION:\n\"{req.user_message}\"\n\n"
                f"YOUR EARLIER LEAD LINE:\n\"{lead_text}\"\n\n"
                f"REACTOR LINES:\n{reactor_summary}\n\n"
                f"INTEGRATE the reactor signal into your answer to the user — do NOT pivot to a "
                f"project plan with owners/dates unless the user asked for one.\n"
                f"  • If a reactor surfaced a NEW fact from memory → fold it in and cite the title.\n"
                f"  • If a reactor challenged a claim → defend with a memory hit, or concede.\n"
                f"  • If the user supplied a concrete fact in CURRENT TURN STATE → incorporate it; "
                f"do not ask for it again.\n"
                f"  • If a reactor's point is outside scope of the user's question → ignore it.\n"
                f"  • The shared blackboard is already above. Only call hivemind_recall / traverse_graph "
                f"for one precise missing fact.\n\n"
                f"OUTPUT: 3-5 short sentences. Stay on the user's question. Chat tone, 'we / our'.\n"
                f"Quote memory titles inline. NEVER invent owners, dates, or deadlines. No 'happy to "
                f"help' fluff.\n"
                + (f"\nTEMPLATE-SPECIFIC OUTPUT REQUIREMENT ({room_template}):\n"
                   f"{get_template_overlay(room_template).get('synth_hint', '')}\n"
                   if get_template_overlay(room_template).get('synth_hint') else "")
            )
            synth_reply = await lead_agent(Msg(name="user", content=synth_prompt, role="user"))
            _report_turn(lead["id"], req.user_message, synth_reply)
            synth_text = _msg_to_text(synth_reply) or ""
            if synth_text.strip():
                synth_tokens = max(200, len(synth_text) // 4)
                cost_tokens += synth_tokens
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "line",
                    "agent": lead.get("slug"),
                    "round": 2,
                    "content": synth_text,
                    "tokens": synth_tokens,
                    "kind": "synthesis",
                })
        except Exception as exc:  # noqa: BLE001
            log.warning("synthesis failed: %s", exc)
        _mark("synthesis_ms")

        # ── Post-synthesis reactor pass (MiroFish-style forward motion) ──
        # After the lead synthesises, reactors get one more turn to push back
        # against the synthesis. This is what makes the room MOVE FORWARD
        # instead of capping after a single lead bubble + one extend. Mirrors
        # MiroFish CSI loop: propose -> review -> revise.
        post_synth_tasks = []
        for r in reactors:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "typing", "agent": r.get("slug"), "kind": "react",
            })
            agent2 = await _build_agent_for_room(req.room_id, r, user_id=req.user_id, org_id=req.org_id)
            is_opp2 = r["_lane"] in opposing_lanes(lead["_lane"])
            post_synth_tasks.append(asyncio.create_task(_run_reactor(
                agent=agent2,
                user_message=req.user_message,
                lead_line=synth_text or lead_text,
                lead_name=lead.get("name", lead.get("slug", "lead")),
                reactor_lane=r["_lane"],
                is_opposing=is_opp2,
                blackboard_context=memory_context,
                current_turn_state=current_turn_state,
            )))
        post_synth_results = await asyncio.gather(*post_synth_tasks, return_exceptions=True)
        for r_emp, result in zip(reactors, post_synth_results):
            if isinstance(result, Exception) or not result.get("react"):
                continue
            line = result["line"]
            if _line_already_raised(req.room_id, line):
                log.info("repeat-guard r2: suppressed reactor=%s", r_emp.get("slug"))
                continue
            _remember_line(req.room_id, line)
            r_tokens = max(80, len(line) // 4)
            cost_tokens += r_tokens
            event = {
                "t": "react",
                "agent": r_emp.get("slug"),
                "round": 2,
                "agreement": result.get("agreement", "extend"),
                "confidence": float(result.get("confidence", 0.5)),
                "content": line,
                "evidence": result.get("evidence", []),
                "gap": result.get("gap", ""),
                "tokens": r_tokens,
            }
            reactions.append({**event, "emp": r_emp})
            await _emit_event(req.callback_url, req.turn_id, event)
        _mark("post_synthesis_ms")
    elif fast_decision_exit:
        _mark("fast_decision_exit_ms")

    # ── Round 2 challenger debate (only if reactor explicitly challenged) ──
    challenger_reaction = next(
        (r for r in reactions if r["agreement"] == "challenge" and r.get("confidence", 0) >= ROUND_2_CHALLENGE_THRESHOLD),
        None,
    )

    # B1 decision template: skip debate loop. The synth bubble is the
    # commitment; we save it and seal. Debate template (default) keeps
    # the revise/validate flow below.
    if room_template == "decision":
        challenger_reaction = None
    # Loop revise+validate while challenger keeps escalating. Caps at
    # MAX_DEBATE_ROUNDS so cost stays bounded. MiroFish pattern: do not
    # seal on unresolved 'escalate' — keep the debate moving until the
    # challenger accepts or the cap hits.
    # MiroFish-style gate: run up to MAX_DEBATE_ROUNDS, but terminate early on
    # convergence (challenger resolves) OR when the debate stops making
    # progress — the challenger repeating the same point with no new evidence
    # for MAX_NO_PROGRESS consecutive rounds. This lets a well-grounded debate
    # run deep (now that agents have the full company brief) instead of dying
    # at a flat cap, while still cutting off a genuine deadlock fast.
    MAX_DEBATE_ROUNDS = int(os.environ.get("HYPER_ROOM_MAX_DEBATE_ROUNDS", "8"))
    MAX_NO_PROGRESS = int(os.environ.get("HYPER_ROOM_MAX_NO_PROGRESS", "2"))
    debate_round = 2
    no_progress = 0
    current_challenge_text = challenger_reaction["content"] if challenger_reaction else ""
    final_verdict: Optional[str] = None
    open_question: str = ""
    last_revise_text: str = ""
    last_gap_signature: str = ""

    def _challenge_repeats(prev: str, nxt: str) -> bool:
        """True when the new challenge is essentially the prior one — same
        point, no new angle. 4-gram Jaccard over normalized text."""
        a, b = _normalize_for_dedup(prev), _normalize_for_dedup(nxt)
        if not a or not b:
            return False
        aw, bw = a.split(), b.split()
        ag = {" ".join(aw[i:i + 4]) for i in range(max(len(aw) - 3, 0))} or {a}
        bg = {" ".join(bw[i:i + 4]) for i in range(max(len(bw) - 3, 0))} or {b}
        inter = len(ag & bg)
        union = len(ag | bg) or 1
        return (inter / union) >= 0.6

    def _gap_repeats(prev: str, nxt: str) -> bool:
        """Structured remaining_gaps are short and often paraphrased. Token
        overlap catches 'staffing/automation plan' repeats without requiring
        identical 4-grams."""
        a, b = _normalize_for_dedup(prev), _normalize_for_dedup(nxt)
        if not a or not b:
            return False
        aw, bw = set(a.split()), set(b.split())
        if not aw or not bw:
            return False
        return (len(aw & bw) / max(1, min(len(aw), len(bw)))) >= 0.6

    while challenger_reaction and debate_round <= MAX_DEBATE_ROUNDS:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "typing", "agent": lead.get("slug"), "kind": "revise",
        })
        try:
            revise_prompt = (
                f"[CSI revision pass round {debate_round} — HIVEMIND employee. Lane: {lead['_lane']}.]\n"
                + (current_turn_state + "\n" if current_turn_state else "")
                + (memory_context + "\n" if memory_context else "")
                + f"USER'S ORIGINAL QUESTION: \"{req.user_message}\"\n"
                + f"{challenger_reaction['emp'].get('name')} ({challenger_reaction['emp']['_lane']}) pushed back:\n"
                + f"\"{current_challenge_text}\"\n\n"
                + f"Reconsider like a real employee: compare [user_fact], [memory], your prior claim, "
                + f"and the challenger's [gap]. If the challenger is right, concede + revise. If standing "
                + f"by, defend with a memory title or a current user fact. Do NOT ask again for any value, "
                + f"date, name, constraint, or requirement already listed in CURRENT TURN STATE. "
                + f"No invented owners / dates. Stay on the user's question. 2-4 sentences, chat tone, 'we / our'."
            )
            reply2 = await lead_agent(Msg(name="user", content=revise_prompt, role="user"))
            revise_text = _msg_to_text(reply2) or "(no revision)"
            last_revise_text = revise_text
            revise_tokens = max(150, len(revise_text) // 4)
            cost_tokens += revise_tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "revise",
                "agent": lead.get("slug"),
                "round": debate_round,
                "content": revise_text,
                "tokens": revise_tokens,
            })

            await _emit_event(req.callback_url, req.turn_id, {
                "t": "typing", "agent": challenger_reaction["emp"].get("slug"), "kind": "validate",
            })
            ch_agent = await _build_agent_for_room(req.room_id, challenger_reaction["emp"], user_id=req.user_id, org_id=req.org_id)
            validate_prompt = (
                f"[CSI validation pass round {debate_round} — lane: {challenger_reaction['emp']['_lane']}.]\n"
                + (current_turn_state + "\n" if current_turn_state else "")
                + f"Current user message:\n\"{req.user_message}\"\n"
                + f"Your original/current challenge was:\n\"{current_challenge_text}\"\n\n"
                + f"{lead.get('name')} responded to your challenge:\n"
                + f"\"{revise_text}\"\n\n"
                + f"Validate using this schematic:\n"
                + f"1. [user_fact] = facts supplied in CURRENT TURN STATE.\n"
                + f"2. [memory] = recalled durable evidence above.\n"
                + f"3. [employee_claim] = lead's revised answer.\n"
                + f"4. [gap] = what remains unresolved after comparing 1-3.\n\n"
                + f"Resolve if the lead used the current user facts or memory evidence well enough. "
                + f"Escalate only if a real gap remains, such as missing validation evidence, unresolved "
                + f"risk, contradictory memory, implementation feasibility, cost/margin proof, legal/security "
                + f"risk, or unclear decision ownership. Never escalate by saying a user-supplied detail is "
                + f"missing when it appears in CURRENT TURN STATE.\n"
                + f"Reply in STRICT JSON:\n"
                + f'{{"verdict": "resolved" | "escalate", "line": "1-2 sentences", '
                + f'"resolved_facts": ["facts now handled"], "remaining_gaps": ["real unresolved gaps"], '
                + f'"next_action": "one concrete action if escalating, else empty string"}}'
            )
            r3 = await ch_agent(Msg(name="user", content=validate_prompt, role="user"))
            validate_raw = _msg_to_text(r3)
            verdict_obj: Dict[str, Any] = {"verdict": "resolved", "line": ""}
            try:
                m = re.search(r"\{[\s\S]+\}", validate_raw)
                if m:
                    parsed = json.loads(m.group(0))
                    if isinstance(parsed, dict):
                        verdict_obj = {
                            "verdict": parsed.get("verdict") or "resolved",
                            "line": (parsed.get("line") or "").strip()[:2000],
                            "resolved_facts": (parsed.get("resolved_facts") or [])[:8],
                            "remaining_gaps": (parsed.get("remaining_gaps") or [])[:8],
                            "next_action": (parsed.get("next_action") or "").strip()[:500],
                        }
            except Exception as exc:  # noqa: BLE001
                raw_lower = (validate_raw or "").lower()
                recovered_verdict = "escalate" if re.search(r'"?verdict"?\s*:\s*"?(?:escalate|escalated)', raw_lower) else "resolved"
                verdict_obj = {
                    "verdict": recovered_verdict,
                    "line": _extract_jsonish_string(validate_raw, "line") or (validate_raw or "").strip()[:500],
                    "resolved_facts": _extract_jsonish_list(validate_raw, "resolved_facts"),
                    "remaining_gaps": _extract_jsonish_list(validate_raw, "remaining_gaps"),
                    "next_action": _extract_jsonish_string(validate_raw, "next_action", 500),
                }
                log.warning(
                    "validate JSON parse failed turn=%s: %s — recovered verdict=%s",
                    req.turn_id, exc, recovered_verdict,
                )
            current_user_facts = _extract_current_user_facts(req.user_message)
            stale_fact_escalation = (
                verdict_obj.get("verdict") == "escalate"
                and _has_current_user_facts(current_user_facts)
                and (
                    _claims_missing_current_user_facts(verdict_obj.get("line", ""))
                    or _claims_missing_current_user_facts(current_challenge_text)
                )
            )
            if stale_fact_escalation:
                log.info(
                    "[room] resolved stale current-fact escalation turn=%s round=%d",
                    req.turn_id,
                    debate_round,
                )
                verdict_obj = {
                    "verdict": "resolved",
                    "line": (
                        "The requested details are present in the current user message; any follow-up "
                        "should validate the remaining business or execution risk, not ask for them again."
                    ),
                    "resolved_facts": ["current user facts acknowledged"],
                    "remaining_gaps": [],
                    "next_action": "",
                }
            v_tokens = max(80, len(verdict_obj.get("line", "")) // 4)
            cost_tokens += v_tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "validate",
                "agent": challenger_reaction["emp"].get("slug"),
                "round": debate_round,
                "verdict": verdict_obj["verdict"],
                "content": verdict_obj["line"],
                "resolved_facts": verdict_obj.get("resolved_facts", []),
                "remaining_gaps": verdict_obj.get("remaining_gaps", []),
                "next_action": verdict_obj.get("next_action", ""),
                "tokens": v_tokens,
            })

            final_verdict = verdict_obj["verdict"]
            open_question = verdict_obj["line"] or current_challenge_text
            if verdict_obj["verdict"] != "escalate":
                break
            # Escalating — feed challenger's new line as next round's challenge
            # and loop. Progress gate: if the challenger just repeats the same
            # point with no new angle, count it; after MAX_NO_PROGRESS such
            # rounds the debate is deadlocked — stop and escalate to a human.
            next_challenge = verdict_obj["line"] or current_challenge_text
            gap_signature = " ".join(str(g) for g in (verdict_obj.get("remaining_gaps") or []) if g)
            if not gap_signature:
                gap_signature = next_challenge
            if last_gap_signature:
                repeats = _gap_repeats(last_gap_signature, gap_signature)
            else:
                repeats = _challenge_repeats(current_challenge_text, gap_signature)
            if repeats:
                no_progress += 1
            else:
                no_progress = 0
            last_gap_signature = gap_signature
            current_challenge_text = next_challenge
            if no_progress >= MAX_NO_PROGRESS:
                log.info("[room] debate deadlocked (no progress x%d) at round %d turn=%s",
                         no_progress, debate_round, req.turn_id)
                break
            debate_round += 1
        except Exception as exc:  # noqa: BLE001
            log.warning("round-%s debate failed: %s", debate_round, exc)
            break

    # ── A2 completion verifier ───────────────────────────────────────
    # Pick the most recent substantive lead-side output for grounding +
    # save eligibility. Order: revise > synth > lead.
    final_text = last_revise_text or synth_text or lead_text or ""
    exit_reason = "fast_decision_consensus" if fast_decision_exit else "full_flow"
    quality_low = not _is_substantive_lead(final_text, bool(memory_context))

    if quality_low and final_text and lead_agent:
        # One-shot rescue retry. Don't loop — bounded cost.
        try:
            rescue_prompt = (
                "You produced no concrete grounded substance in the prior turn.\n"
                f"USER QUESTION: {req.user_message}\n"
                f"Available memories above. Answer DIRECTLY in 3-4 sentences. "
                f"Quote at least one memory title inline. If memory truly silent, "
                f"say 'nothing on file about X yet' in one sentence then give a "
                f"concrete take. NEVER invent owners/dates."
            )
            rescue_reply = await lead_agent(Msg(name="user", content=rescue_prompt, role="user"))
            rescue_text = _msg_to_text(rescue_reply) or ""
            if rescue_text and len(rescue_text) > 80:
                final_text = rescue_text
                quality_low = not _is_substantive_lead(rescue_text, bool(memory_context))
                rescue_tokens = max(120, len(rescue_text) // 4)
                cost_tokens += rescue_tokens
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "line",
                    "agent": lead.get("slug"),
                    "round": debate_round,
                    "kind": "rescue",
                    "content": rescue_text,
                    "tokens": rescue_tokens,
                })
        except Exception as exc:  # noqa: BLE001
            log.warning("rescue retry failed: %s", exc)

    # ── A3 tool-exec proof (measure only, don't block) ───────────────
    if memory_context and final_text and not re.search(r'["“][^"”]{6,}["”]', final_text):
        log.info("low-grounding flag turn=%s — memory_context present but lead cited no title", req.turn_id)

    # ── B2 conclusion gate ──────────────────────────────────────────
    if final_verdict == "escalate":
        # Debate hit MAX_DEBATE_ROUNDS without consensus. Don't fake
        # 'complete' — surface the open question as an action item.
        status = "escalated"
        log.info("[room] debate exhausted %d rounds unresolved turn=%s", debate_round, req.turn_id)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "decision_required",
            "open_question": open_question or req.user_message,
            "raised_by": (challenger_reaction or {}).get("emp", {}).get("slug") if challenger_reaction else None,
            "rounds_run": debate_round,
        })

    # ── A1 decision sink — save iff verdict=resolved OR save-intent
    #     OR template == 'decision' (DACI flow always commits) ─
    save_intent = bool(_SAVE_INTENT_RE.search(req.user_message))
    is_decision_template = room_template == "decision"
    should_save = (
        (final_verdict == "resolved" and not quality_low)
        or save_intent
        or (is_decision_template and not quality_low)
    )
    saved_memory_id: Optional[str] = None
    save_pending = False
    if should_save and final_text:
        trigger = "save-intent" if save_intent else "verdict-resolved"
        save_pending = True
        _schedule_decision_save(
            callback_url=req.callback_url,
            user_id=req.user_id,
            org_id=req.org_id,
            room_id=req.room_id,
            turn_id=req.turn_id,
            user_message=req.user_message,
            decision_text=final_text,
            trigger=trigger,
        )

    # ── A4 trust scoring (display-only, no routing impact yet) ──────
    # Lead: +0.05 on substantive seal; -0.05 on unresolved escalate.
    # Challenger: +0.05 if revise conceded (verdict=resolved came AFTER a
    # real challenge); -0.05 if their challenge was over-stated and lead
    # held ground (we approximate: resolved with no concession keyword =
    # challenge over-stated → mild loss).
    trust_deltas: Dict[str, float] = {}
    try:
        lead_won = (not quality_low) and (
            final_verdict == "resolved" or final_verdict is None or is_decision_template
        )
        lead_delta = 0.05 if lead_won else -0.05
        new_lead = await update_trust(req.org_id, lead["id"], lead_delta, lead_won)
        if new_lead is not None:
            trust_deltas[lead.get("slug")] = new_lead
        if challenger_reaction:
            ch_emp = challenger_reaction["emp"]
            challenger_correct = final_verdict == "escalate"  # lead couldn't refute
            ch_delta = 0.05 if challenger_correct else -0.02
            new_ch = await update_trust(req.org_id, ch_emp["id"], ch_delta, challenger_correct)
            if new_ch is not None:
                trust_deltas[ch_emp.get("slug")] = new_ch
    except Exception as exc:  # noqa: BLE001
        log.warning("trust update failed: %s", exc)

    tool_call_counts: Dict[str, int] = {}
    try:
        for p in participants:
            cache_key = f"{req.room_id}:{p['id']}"
            cached_agent = _ROOM_AGENTS.get(cache_key)
            if cached_agent is not None:
                count = int(getattr(cached_agent, "tool_call_count", 0) or 0)
                tool_call_counts[p.get("slug")] = count
                try:
                    setattr(cached_agent, "tool_call_count", 0)
                except Exception as exc:  # noqa: BLE001
                    log.debug("tool_call_count reset failed slug=%s: %s", p.get("slug"), exc)
    except Exception as exc:  # noqa: BLE001
        log.warning("[room] tool_call_count collection failed: %s", exc)

    # ── Seal ─────────────────────────────────────────────────────────
    _mark("seal_ms")
    log.info(
        "[room] seal turn=%s status=%s template=%s cost=%d quality_low=%s exit=%s tools=%d",
        req.turn_id, status, room_template, cost_tokens, quality_low,
        exit_reason, sum(tool_call_counts.values()),
    )
    report_objections = [
        {
            "content": r.get("content"),
            "agreement": r.get("agreement"),
            "reviewer": (r.get("emp") or {}).get("slug") or r.get("agent"),
        }
        for r in reactions
        if r.get("agreement") == "challenge" or r.get("gap")
    ]
    report_actions = []
    if status == "escalated" and open_question:
        report_actions.append(open_question)
    await _emit_event(req.callback_url, req.turn_id, _build_harness_quality_check(
        room_goal=req.room_goal or "",
        final_text=final_text,
        evidence_count=len(blackboard.get("memory_hits", []) or blackboard.get("memory_ids", []) or []),
        source_count=len(_web_sources_for_turn(req.turn_id)),
        claims_count=1 if lead_text else 0,
        reviews_count=len(reactions),
        votes_count=0,
        web_intel_used="WEB INTEL DOSSIER" in (memory_context or ""),
    ))
    # Phase 5 — recon/verify the result against the lead's done-criterion.
    await _verify_and_emit(
        req, lead, final_text=final_text,
        tool_call_counts=tool_call_counts, blackboard=blackboard,
    )
    await _emit_event(req.callback_url, req.turn_id, _build_final_report(
        user_message=req.user_message,
        final_text=final_text,
        template=room_template,
        room_goal=req.room_goal or "",
        status=status,
        verdict=(final_verdict or ("resolved" if status == "complete" else status)),
        lead=lead,
        action_items=report_actions,
        evidence_ids=blackboard.get("memory_ids", [])[:10],
        evidence=blackboard.get("memory_hits", []),
        sources=_web_sources_for_turn(req.turn_id),
        reviews=report_objections,
        web_intel_used="WEB INTEL DOSSIER" in (memory_context or ""),
    ))
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "seal",
        "cost_tokens": cost_tokens,
        "status": status,
        "duration_ms": int((time.time() - started) * 1000),
        "quality_low": quality_low,
        "saved_memory_id": saved_memory_id,
        "save_pending": save_pending,
        "trust": trust_deltas,
        "template": room_template,
        "exit_reason": exit_reason,
        "blackboard": {
            "hit_count": int(blackboard.get("hit_count", 0) or 0),
            "confidence": float(blackboard.get("confidence", 0) or 0),
            "memory_ids": blackboard.get("memory_ids", [])[:10],
        },
        "timing": timing,
        "tool_call_counts": tool_call_counts,
        "tool_call_total": sum(tool_call_counts.values()),
    })
    _WEB_INTEL_PAYLOADS.pop(req.turn_id, None)
    return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)


async def _resolve_write_policy(req: "RoomTurnRequest") -> str:
    """Phase 4 — pick the write-approval policy for this turn. Explicit
    req.write_policy wins; otherwise gate ("ask") when the room has connectors
    enabled, else "auto" (no side-effectful tools in play)."""
    explicit = (req.write_policy or "").strip().lower()
    if explicit in ("ask", "auto"):
        return explicit
    try:
        conns = await get_room_enabled_connectors(req.room_id, org_id=req.org_id)
    except Exception:  # noqa: BLE001 — never fail a turn over policy resolution
        conns = []
    return "ask" if conns else "auto"


def _goalkeeper_max_rounds() -> int:
    """Phase 6 — hard cap on goalkeeper rounds (1 initial + retries). Small by
    default: only genuinely-incomplete turns loop, and a misconfigured task
    can't loop forever."""
    try:
        return max(1, min(5, int(os.environ.get("HYPER_ROOM_GOALKEEPER_MAX_ROUNDS", "3"))))
    except Exception:  # noqa: BLE001
        return 3


def _goalkeeper_should_continue(verdict: Optional[Dict[str, Any]]) -> bool:
    """Phase 6 — decide whether to run another round. Loop ONLY when the
    done-criterion is unmet AND the gap is re-plannable: the artifact was never
    produced, or claims are ungrounded. A write that is PENDING the user's
    approval is terminal (the work is done — it's the human's turn, not the
    goalkeeper's), as is a "met" verdict or a missing/empty plan."""
    if not isinstance(verdict, dict):
        return False
    if verdict.get("met"):
        return False
    # Awaiting human approval — artifact is done-pending, not the loop's job.
    if verdict.get("pending_writes") and verdict.get("artifact_ok"):
        return False
    # Re-plannable iff the actual output is missing or the claims aren't grounded.
    return (not verdict.get("artifact_ok")) or (not verdict.get("grounded_ok"))


@router.post("/room-turn", response_model=RoomTurnResponse)
async def post_room_turn(
    req: RoomTurnRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> RoomTurnResponse:
    _require_master_key(x_api_key)
    # Phase 4 — arm the write-approval gate in THIS handler's context so every
    # fanned-out agent task (which copies the context) appends to the same
    # pending list. Sync connector tools read the policy at call time.
    policy = await _resolve_write_policy(req)
    begin_turn_write_gate(policy)

    # Phase 6 — goalkeeper loop. Run the full round (plan → simulate → verify);
    # while the verdict is unmet AND the gap is re-plannable, feed the gaps back
    # into the turn message and re-plan, up to a round cap. Same shape as the
    # Claude `/goal` keep-working-toward-the-goal loop.
    max_rounds = _goalkeeper_max_rounds()
    orig_msg = req.user_message
    total_cost = 0
    resp: Optional[RoomTurnResponse] = None
    for rnd in range(1, max_rounds + 1):
        resp = await _orchestrate(req)
        total_cost += int(resp.cost_tokens or 0)
        plan = _PLAN_BY_TURN.get(req.turn_id)
        verdict = plan.get("verification") if isinstance(plan, dict) else None
        if not _goalkeeper_should_continue(verdict) or rnd >= max_rounds:
            break
        gaps = list((verdict or {}).get("gaps") or [])
        gap_str = "; ".join(gaps) or "the result did not meet the done-criterion"
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "goalkeeper_round",
            "round": rnd,
            "next_round": rnd + 1,
            "met": False,
            "gaps": gaps,
        })
        log.info("[goalkeeper] room=%s round=%d unmet → re-plan; gaps=%s",
                 req.room_id, rnd, gap_str)
        # Re-base off the ORIGINAL message (not the prior round's plan-preamble)
        # so preambles don't stack; the planner re-plans against the gaps.
        req.user_message = (
            f"{orig_msg}\n\n[GOALKEEPER round {rnd + 1}] The previous attempt did NOT "
            f"finish. Done criterion: {(verdict or {}).get('done_criterion') or '(see goal)'}. "
            f"Address these gaps and COMPLETE the task this round: {gap_str}."
        )

    if resp is None:  # defensive — loop always runs ≥1
        resp = RoomTurnResponse(ok=False, cost_tokens=0, status="failed")
    resp.cost_tokens = total_cost

    if policy == "ask":
        pending = drain_pending_writes()
        if pending:
            await _register_and_emit_approvals(req, pending)
            # Strip the replay descriptor from the client-facing payload —
            # creds/args stay server-side in _PENDING_APPROVALS.
            resp.pending_approvals = [
                {k: v for k, v in rec.items() if k != "descriptor"}
                for rec in pending
            ]
    # Phase 5 — surface the recon/verify verdict (stashed on the plan).
    _vplan = _PLAN_BY_TURN.get(req.turn_id)
    if isinstance(_vplan, dict) and isinstance(_vplan.get("verification"), dict):
        resp.verification = _vplan["verification"]
    return resp


@router.post("/approve")
async def post_approve(
    body: ApprovalDecisionRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> Dict[str, Any]:
    """Phase 4 — resolve a queued write. "approve" replays the bridge call;
    "deny" drops it. Either way the pending record is removed."""
    _require_master_key(x_api_key)
    rec = _PENDING_APPROVALS.pop(body.approval_id, None)
    if rec is None:
        raise HTTPException(status_code=404, detail="unknown or already-resolved approval_id")
    decision = (body.decision or "").strip().lower()
    if decision not in ("approve", "deny"):
        raise HTTPException(status_code=400, detail="decision must be 'approve' or 'deny'")
    result: Optional[dict] = None
    if decision == "approve":
        try:
            result = execute_pending_write(rec, rec.get("user_id"), rec.get("org_id"))
        except Exception as exc:  # noqa: BLE001
            log.warning("[approval] replay failed id=%s: %s", body.approval_id, exc)
            raise HTTPException(status_code=502, detail=f"write replay failed: {exc}") from exc
    await _emit_event(rec.get("callback_url") or "", rec.get("turn_id") or "", {
        "t": "approval_resolved",
        "approval_id": body.approval_id,
        "decision": decision,
        "label": rec.get("label"),
        "result": result,
    })
    log.info("[approval] id=%s decision=%s label=%s", body.approval_id, decision, rec.get("label"))
    return {"ok": True, "approval_id": body.approval_id, "decision": decision, "result": result}
