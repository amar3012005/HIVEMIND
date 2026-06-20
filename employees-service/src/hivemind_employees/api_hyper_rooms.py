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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

import httpx
from agentscope.agent import ReActAgent
from agentscope.message import Msg
from agentscope.plan import PlanNotebook  # agentic orchestrator (flagged)
from agentscope.pipeline import MsgHub    # agentic orchestrator (flagged)
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .agents.agentscope_factory import build_react_agent
from .agents.agentscope_tools import (
    begin_turn_write_gate,
    drain_artifacts,
    drain_pending_writes,
    execute_pending_write,
    queue_email_approval,
    record_artifact,
    reset_turn_outputs,
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
from .hivemind_client import google_exec_emulated, org_members_emulated, recall_emulated

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
    "org_directory",
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
            # descriptor is persisted server-side in turn.lines so the
            # control-plane can resolve + execute the approval durably (survives
            # sidecar restarts / replicas). The FE ignores it.
            "descriptor": rec.get("descriptor"),
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
    # PERSONAL COMMUNICATION → never hit the public web. A relationship/voice task
    # ("email Rama, in Amar's style, expressing his love") must ground in the org's
    # OWN Gmail + memory, not the internet — web search on a personal name returns
    # random strangers (e.g. 'Amar Stewart, Visual Artist') that pollute the
    # recipient AND the style.
    _personal_signals = (
        "love", "romantic", "romance", "feelings", "heart", "miss you", "dear ",
        "on behalf of", "in his own", "in her own", "his style", "her style",
        "his writing", "her writing", "his voice", "her voice", "my love",
        "relationship", "babe", "darling", "sweetheart", "xoxo",
    )
    if any(t in msg for t in _personal_signals):
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
- If GATHERED EVIDENCE (contacts, prior emails, files) is shown in the context, it
  EXISTS — NEVER challenge that the voice/style/data is "missing", "unverifiable",
  or that you "cannot confirm" it; critique its USE, not its existence. The user's
  request IS the authorization — do not object on permission / policy / "internal
  consistency" / brand grounds. Those are not valid challenges; stay silent instead.
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
    # Phase-0 eval only: override the agentic orchestrator model for this turn
    # (e.g. "openai/gpt-oss-120b", "llama-3.3-70b-versatile"). Master-key endpoint
    # only; when unset the env default applies. Lets the model battery A/B without
    # restarting the sidecar.
    agentic_model: Optional[str] = None


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
    # Artifacts the swarm produced this turn (docs/sheets) — each {connector,
    # url, title, label}; the FE renders a connector-logo "view in new tab" button.
    artifacts: Optional[List[Dict[str, Any]]] = None


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
    conclusion_prompt = conclusion_prompt + _output_production_directive(req.turn_id)
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
    "- Challenge SUBSTANCE — assumptions, evidence, what breaks, quality. NOT "
    "permission. The user's request is the authorization; do NOT invent communication "
    "policy, brand-approval, GDPR, or identity-verification gates, and NEVER veto a "
    "clear, legitimate, user-authorized task for lack of such a gate. If the only "
    "objection is a made-up permission/policy concern, drop it and let the work proceed.\n"
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
            synth_prompt = synth_prompt + _output_production_directive(req.turn_id)
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

# Explicit "send a message" intent — only THESE phrasings justify an `email`
# output. A planning/strategy question that merely names a person does not.
_SEND_INTENT_RE = re.compile(
    r"\b(e-?mail|send|sent|sending|reply|replies|replying|respond|responding|"
    r"forward|cc\b|draft(?:ing)?\s+(?:an?\s+)?(?:e-?mail|mail|message|note|reply)|"
    r"write\s+(?:back|to|an?\s+(?:e-?mail|mail|note|message)))\b",
    re.IGNORECASE,
)


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
        'Intent → output examples: "email/send/reply to them"→email, "message/ping in slack"→slack, '
        '"write a report/brief"→doc, "build a tracker/table"→sheet, "should we…/which option"→decision, '
        'a plain question→answer.\n'
        'CRITICAL — a PLANNING / STRATEGY / ADVICE question ("what should be the plan", "how should we '
        'approach", "what\'s our strategy/next move", "what should we do about X with <person>") is '
        '"decision" or "answer" — NOT email. Naming a person does NOT make it an email. Choose '
        '"email" ONLY when the user explicitly asks to email / send / reply / draft a message to '
        'someone. Only assign agents that are on the team.\n'
        f'CAPABILITIES (what this room can PRODUCE): {", ".join(producible_kinds())} (plus reading '
        'HIVEMIND memory + the enabled connectors). done_criterion must only assert end-states '
        'reachable with THESE — there is no file-sharing/permissions tool, so never make '
        '"shared with <person>" or "permissions set" part of done_criterion; note any unsupported '
        'ask as a limitation instead. Output JSON only.'
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
    # Deterministic intent guard (independent of the LLM): a question that names a
    # person but carries NO explicit send/email/reply verb and NO literal address
    # is NOT an email task — it's an answer. Stops planning/strategy prompts
    # ("what should be the plan with Ethan…") from becoming an undeliverable email
    # that escalates on a missing recipient.
    if out == "email" and not _SEND_INTENT_RE.search(req.user_message or "") \
            and not re.search(r"[\w.+-]+@[\w.-]+\.\w+", req.user_message or ""):
        out = "answer"
    valid_names = {(p.get("slug") or "") for p in participants} | {(p.get("name") or "") for p in participants}
    raw_assign = plan.get("assignments") if isinstance(plan.get("assignments"), dict) else {}
    assignments = {str(k): str(v)[:400] for k, v in raw_assign.items() if str(k) in valid_names}
    done_criterion = str(plan.get("done_criterion") or "")[:500]
    # An outward email is NEVER "sent" within the turn — it is saved as a draft and
    # surfaced for the user's approval. Override any "sent / in Sent folder" wording
    # so the team doesn't hallucinate completion (and the verifier judges honestly).
    if out == "email":
        done_criterion = (
            "A complete, correctly-addressed email is drafted (saved as a Gmail draft) "
            "and surfaced for the user's one-click approval. It is NOT sent until the "
            "user approves — do not claim it was sent or is in the Sent folder."
        )
    return {
        "intended_output": out,
        "done_criterion": done_criterion,
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
    # Produced artifacts = doc/sheet URLs the swarm actually created this turn
    # (from the artifact recorder, plus any URL echoed in the final text). The
    # verifier MUST see these or it falsely reports "Doc not produced".
    produced = sorted(set(
        _ARTIFACT_URL_RE.findall(final_text or "")
        + [a.get("url") for a in drain_artifacts() if a.get("url")]
    ))
    evidence = {
        "intended_output": plan.get("intended_output"),
        "done_criterion": plan.get("done_criterion"),
        "assignments": list((plan.get("assignments") or {}).keys()),
        "assignments_executed": [c.get("owner") for c in (plan.get("execution") or [])],
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
        '  "artifact_ok": <the intended output was actually produced or is queued for approval — see the strict rule below>,\n'
        '  "assignments_ok": <the assigned sub-tasks appear covered by the result>,\n'
        '  "grounded_ok": <specific factual claims are backed by tools/memory, not invented>,\n'
        '  "gaps": ["<concrete missing/unverified item>", "..."],\n'
        '  "note": "<one sentence>"\n'
        '}\n'
        "Rules:\n"
        "- FIRST, branch on intended_output. If it is \"answer\" or \"decision\", the DELIVERABLE IS "
        "THE TEXT itself — there is NO external artifact to produce. Set artifact_ok=true whenever "
        "final_excerpt contains a substantive, on-topic answer/recommendation (steps, reasoning, a "
        "clear position). Do NOT require produced_artifacts / a write / a doc / an email for these — "
        "demanding one is a verifier error. For answer/decision, proposed next-steps and suggested "
        "owners are RECOMMENDATIONS, not claims-of-fact: do NOT mark them ungrounded merely because "
        "they haven't happened yet. grounded_ok here means the RECOMMENDATION rests on the gathered "
        "evidence and names only real team members — not that every step is already done.\n"
        "- For a PRODUCED output (email/doc/sheet/slack/ticket/crm), artifact_ok is true ONLY with "
        "OBJECTIVE evidence it was produced or queued: produced_artifacts is non-empty, OR "
        "writes_pending_approval lists a write matching the intended_output, OR tools_used shows the "
        "relevant WRITE tool fired (e.g. gmail_send for an email, docs_create for a doc). Content "
        "merely drafted, quoted, or described in the discussion does NOT count — e.g. a fully "
        "written-out email body with no actual send/draft is artifact_ok=false. When artifact_ok is "
        "false, say so in gaps.\n"
        "- A WRITE that is PENDING APPROVAL counts as done-pending → artifact_ok=true. BUT met=true "
        "ONLY if grounded_ok is also true AND gaps is empty. A queued draft that asserts UNGROUNDED "
        "or INVENTED facts (names, roles, commitments, numbers not backed by memory/tools), or that "
        "omits required content, is NOT done — set met=false and list the offending claim(s) in gaps "
        "so it is reworked BEFORE the user approves it. Do not pass a known-flawed draft.\n"
        "- assignments_ok=true when assignments_executed covers the assigned owners (each ran their "
        "slice in the EXECUTE phase this turn) AND the final text reflects that work. Do NOT require "
        "more than the plan assigned.\n"
        "- grounded_ok=false if the result asserts specific facts with memory_hits=0 and no tools "
        "used, or invents a person/role/commitment that the gathered evidence does not support.\n"
        "- grounded_ok=false on ANY of these fabrication tells (be strict — this prevents shipping "
        "misinformation): a named source/citation/document/date that does not correspond to a real "
        "memory_hit or tool result (e.g. 'Confluence page X, 23-APR-24', 'investor-relations release', "
        "an invented file name); a person/CEO/email address asserted without a matching tool/memory "
        "result; OR a website / press release / LinkedIn / public-filing citation when no web tool was "
        "used (the room has NO web access — any such citation is fabricated). A claim marked UNVERIFIED "
        "in the text is honest and does NOT lower grounded_ok; a confident claim with a fake backing does.\n"
        "If nothing is missing, gaps must be []. Output JSON only."
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


def _md_table_to_rows(text: str) -> List[List[str]]:
    """Parse the first markdown table in `text` into rows (skips the |---| rule)."""
    rows: List[List[str]] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not (s.startswith("|") and s.endswith("|")):
            if rows:
                break  # table block ended
            continue
        if re.match(r"^\|[\s:|-]+\|$", s):
            continue  # separator
        rows.append([c.strip() for c in s.strip("|").split("|")])
    return rows


def _derive_title(plan: Dict[str, Any], final_text: str, fallback: str) -> str:
    m = re.search(r"^\s*#\s+(.+)$", final_text or "", re.MULTILINE) or \
        re.search(r"subject\s*:\s*(.+)", final_text or "", re.IGNORECASE) or \
        re.search(r"title\s*:\s*(.+)", final_text or "", re.IGNORECASE)
    if m:
        return m.group(1).splitlines()[0].strip()[:120]
    return (fallback or "Untitled")[:120]


async def _surface_produce_error(req: "RoomTurnRequest", plan: Dict[str, Any],
                                 what: str, raw_error: Any) -> None:
    """The connector write failed (e.g. Google 403 insufficient scopes). Surface a
    clear, actionable message + stash it on the plan so the verifier/FE report the
    real blocker (re-authorize the connector) instead of a silent no-artifact +
    opaque escalation. A scope error is NOT retryable — don't thrash on it."""
    err = str(raw_error or "")
    low = err.lower()
    if "insufficient authentication scopes" in low or "permission_denied" in low or "403" in low:
        msg = (f"Could not create the {what}: the Google connector is authorized read-only "
               f"(insufficient scopes). Re-authorize Google with Docs/Gmail write access, then retry.")
    else:
        msg = f"Could not create the {what}: {err[:160]}"
    plan["artifact_error"] = msg
    log.warning("[produce] %s failed: %s", what, err[:200])
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "warning", "code": "artifact_production_failed", "message": msg,
    })


# ── Producer registry ─────────────────────────────────────────────────────
# kind → async producer(req, plan, step, ctx) -> dict. The produce loop is
# TOOL-AGNOSTIC: a new connector registers a producer here and the spine
# (plan → gather → debate → produce → verify → persist) never changes — the
# toolkit grows horizontally. A producer does its connector write + records the
# artifact / queues approval, and returns {"url","title"} on success,
# {"skipped": <why>} when a prerequisite is missing (→ honest dead-end, NEVER a
# fabricated draft), or {} for a no-op.
_Producer = Callable[["RoomTurnRequest", Dict[str, Any], Dict[str, Any], Dict[str, Any]], Awaitable[Dict[str, Any]]]
_PRODUCERS: Dict[str, _Producer] = {}


def _register_producer(kind: str) -> Callable[[_Producer], _Producer]:
    def _deco(fn: _Producer) -> _Producer:
        _PRODUCERS[kind] = fn
        return fn
    return _deco


def producible_kinds() -> List[str]:
    """Artifact kinds the connected toolset can actually produce (capability set).
    The capability-aware planner is told this so it never sets a done-criterion the
    toolset can't reach."""
    return sorted(_PRODUCERS.keys())


@_register_producer("answer")
@_register_producer("decision")
async def _produce_answer(req: "RoomTurnRequest", plan: Dict[str, Any],
                          step: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    return {}  # the synthesis text IS the deliverable — nothing to create


@_register_producer("doc")
async def _produce_doc(req: "RoomTurnRequest", plan: Dict[str, Any],
                       step: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    body = ctx.get("body") or ""
    title = step.get("title") or _derive_title(plan, body, req.room_goal or "Document")
    res = await google_exec_emulated(
        "docs_create", {"title": title, "content": body}, user_id=req.user_id, org_id=req.org_id)
    url = ((res or {}).get("result") or res or {}).get("url") or (res or {}).get("url")
    if url:
        record_artifact("google-docs", url, title=title, label=f"Open “{title}”")
        log.info("[produce] doc → %s", url)
        return {"url": url, "title": title}
    if isinstance(res, dict) and res.get("error"):
        await _surface_produce_error(req, plan, "Google Doc", res.get("error"))
    return {"skipped": "the Google Doc could not be created"}


@_register_producer("sheet")
async def _produce_sheet(req: "RoomTurnRequest", plan: Dict[str, Any],
                         step: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    body = ctx.get("body") or ""
    title = step.get("title") or _derive_title(plan, body, req.room_goal or "Spreadsheet")
    rows = _md_table_to_rows(body)
    res = await google_exec_emulated(
        "sheets_create", {"title": title, "rows": rows}, user_id=req.user_id, org_id=req.org_id)
    url = ((res or {}).get("result") or res or {}).get("url") or (res or {}).get("url")
    if url:
        record_artifact("google-sheets", url, title=title, label=f"Open “{title}”")
        log.info("[produce] sheet (%d rows) → %s", len(rows), url)
        return {"url": url, "title": title}
    if isinstance(res, dict) and res.get("error"):
        await _surface_produce_error(req, plan, "Google Sheet", res.get("error"))
    return {"skipped": "the Google Sheet could not be created"}


# Fabricated placeholder links agents emit when they couldn't get a real URL —
# stripped/replaced before a draft is queued so we never send an UNVERIFIED link.
_PLACEHOLDER_URL_RE = re.compile(
    r"https?://\S*?(?:UNVERIFIED|PLACEHOLDER|EXAMPLE|TODO|XXXX|SHEET_ID|DOC_ID|YOUR_)\S*",
    re.IGNORECASE)


@_register_producer("email")
async def _produce_email(req: "RoomTurnRequest", plan: Dict[str, Any],
                         step: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    contacts = plan.get("verified_contacts") or []
    to = (contacts[0].get("email") if contacts else "") or ""
    # Agent-driven recipient fallback: an owner may have RECALLED the contact from
    # HIVEMIND during EXECUTE — scan the executed work + synthesis for a real email.
    if not to:
        _pool = " ".join(c.get("contribution", "") for c in (plan.get("execution") or [])) + " " + (ctx.get("body") or "")
        for addr in re.findall(r"[\w.+-]+@[\w.-]+\.\w+", _pool):
            low = addr.lower()
            if "noreply" in low or "no-reply" in low or "example." in low:
                continue
            to = addr
            break
    if not to:
        log.info("[produce] email skipped — no recipient")
        return {"skipped": "no verified recipient (org directory / Gmail / HIVEMIND recall all empty)"}
    # Dependency gate: if an EARLIER step was meant to create the artifact this
    # email links but it was NOT produced, do NOT draft an email with a fabricated
    # link — skip honestly so the seal reports the real blocker.
    if ctx.get("expects_prior_artifact") and not ctx.get("last_artifact_url"):
        return {"skipped": "the file this email was meant to link was never created, so no email was drafted"}
    body = ctx.get("body") or ""
    subject = step.get("title") or _derive_title(plan, body, req.room_goal or "A message")
    email_body = re.sub(r"^\s*(subject|title)\s*:.*$", "", body, count=1,
                        flags=re.IGNORECASE | re.MULTILINE).strip() or body
    # Thread the REAL upstream artifact URL in; strip any fabricated placeholder.
    url_prior = ctx.get("last_artifact_url")
    if url_prior:
        email_body = _PLACEHOLDER_URL_RE.sub(url_prior, email_body)
        if url_prior not in email_body:
            email_body = f"{email_body}\n\nLink: {url_prior}"
    else:
        email_body = _PLACEHOLDER_URL_RE.sub("", email_body).strip()
    res = await google_exec_emulated(
        "gmail_create_draft", {"to": to, "subject": subject, "body": email_body},
        user_id=req.user_id, org_id=req.org_id)
    draft_id = ((res or {}).get("result") or res or {}).get("draftId") or (res or {}).get("draftId")
    url = ((res or {}).get("result") or res or {}).get("url") or (res or {}).get("url") or ""
    if draft_id:
        queue_email_approval(to, subject, draft_id, url)
        log.info("[produce] email draft → %s", to)
        return {"draft_id": draft_id, "url": url, "to": to}
    if isinstance(res, dict) and res.get("error"):
        await _surface_produce_error(req, plan, "Gmail draft", res.get("error"))
    return {"skipped": "the Gmail draft could not be created"}


# "deliver X through/via/in a sheet|doc" → the artifact is a PREREQUISITE the
# terminal deliverable (the email) references. Deterministic — no planner trust.
_SHEET_VEHICLE_RE = re.compile(
    r"\b(?:through|via|in|using|with|into|on|as)\s+(?:an?\s+|the\s+)?(?:google\s+|new\s+|shared\s+)*"
    r"(sheet|spreadsheet|tracker|table)\b", re.IGNORECASE)
_DOC_VEHICLE_RE = re.compile(
    r"\b(?:through|via|in|using|with|into|as)\s+(?:an?\s+|the\s+)?(?:google\s+|new\s+|shared\s+)*"
    r"(doc|document|report|brief|memo)\b", re.IGNORECASE)


def _derive_artifact_steps(plan: Dict[str, Any], user_msg: str) -> List[Dict[str, Any]]:
    """Ordered artifact steps the producer executes. Backward-compatible: explicit
    plan['artifact_steps'] wins; else ONE step from intended_output. Deterministic
    enrichment: 'email … through a sheet/doc' → [{sheet|doc}, {email}] so a dependent
    chain is built (the email references the real URL) WITHOUT trusting the planner.
    Capability guard: drop steps whose kind has no registered producer (records the
    dropped capability for the limitation note)."""
    raw = plan.get("artifact_steps")
    steps: List[Dict[str, Any]] = []
    if isinstance(raw, list) and raw:
        for s in raw:
            if isinstance(s, dict) and s.get("kind"):
                steps.append({**s, "kind": str(s["kind"]).strip().lower()})
            elif isinstance(s, str) and s.strip():
                steps.append({"kind": s.strip().lower()})
    else:
        out = str(plan.get("intended_output") or "answer").strip().lower()
        if out == "email":
            if _SHEET_VEHICLE_RE.search(user_msg or ""):
                steps.append({"kind": "sheet"})
            elif _DOC_VEHICLE_RE.search(user_msg or ""):
                steps.append({"kind": "doc"})
        steps.append({"kind": out})
    kept: List[Dict[str, Any]] = []
    dropped: List[str] = []
    for s in steps[:_EXECUTE_MAX_OWNERS]:
        k = s.get("kind")
        if k in _PRODUCERS:
            if not kept or kept[-1].get("kind") != k:  # dedupe consecutive
                kept.append(s)
        elif k:
            dropped.append(k)
    if dropped:
        plan["dropped_capabilities"] = sorted(set(dropped))
    return kept or [{"kind": "answer"}]


def _dead_end_message(plan: Dict[str, Any]) -> str:
    """Truthful, human stop message: what was created (if anything), what's not
    possible with the connected tools, and what was searched — never a fabrication."""
    de = plan.get("dead_end") or {}
    parts: List[str] = [f"I couldn't fully finish this: {de.get('reason') or 'the task could not be completed'}."]
    partial = [a for a in (de.get("partial") or []) if a.get("url")]
    if partial:
        parts.append("What I did create: " + ", ".join(f"{a.get('kind')} — {a.get('url')}" for a in partial) + ".")
    dropped = de.get("dropped_capabilities") or []
    if dropped:
        parts.append(f"Not possible with the connected tools: {', '.join(dropped)}.")
    hits = int((plan.get("verification") or {}).get("memory_hits") or plan.get("hit_count") or 0)
    parts.append(
        "I searched HIVEMIND memory and the connected sources"
        + (f" ({hits} relevant memories found)" if hits else " and found nothing relevant")
        + ", and did not invent any details to fill the gap.")
    return " ".join(parts)


async def _produce_output(req: "RoomTurnRequest", final_text: str) -> None:
    """UNIFIED PRODUCE phase — the SINGLE place a turn's artifacts are created.
    Deterministic, post-consensus, idempotent. Iterates the plan's ORDERED artifact
    steps through the producer registry, threading each step's output forward so a
    later step references an earlier artifact (the email body gets the REAL sheet
    URL). A step whose prerequisite is missing is SKIPPED honestly (never a
    fabricated draft) and, if it was the terminal deliverable, recorded as a
    dead-end the seal reports. Agents write the *content* in synthesis; this turns
    it into the real artifacts."""
    plan = _PLAN_BY_TURN.get(req.turn_id)
    if not isinstance(plan, dict):
        return
    body = (final_text or "").strip()
    if not body:
        return
    if drain_artifacts() or drain_pending_writes():
        return  # already produced (idempotent)
    steps = _derive_artifact_steps(plan, req.user_message or "")
    # A non-terminal doc/sheet step is a prerequisite the terminal step references.
    has_prereq_artifact = any(s.get("kind") in ("doc", "sheet") for s in steps[:-1])
    ctx: Dict[str, Any] = {"body": body, "artifacts": [], "last_artifact_url": None,
                           "expects_prior_artifact": has_prereq_artifact}
    skips: List[str] = []
    last_result: Dict[str, Any] = {}
    try:
        for step in steps:
            producer = _PRODUCERS.get(step.get("kind"))
            if producer is None:
                continue
            out = await producer(req, plan, step, ctx) or {}
            last_result = out
            if out.get("skipped"):
                skips.append(out["skipped"])
                continue
            if out.get("url"):
                ctx["artifacts"].append({"kind": step.get("kind"), "url": out["url"], "title": out.get("title")})
                if step.get("kind") in ("doc", "sheet"):
                    ctx["last_artifact_url"] = out["url"]
    except Exception as exc:  # noqa: BLE001 — never fail a turn over production
        log.warning("[produce] failed: %s", exc)
    # Honest dead-end: the TERMINAL deliverable could not be produced (missing
    # prerequisite / recipient / data). The seal reports what was searched + why.
    if last_result.get("skipped"):
        plan["dead_end"] = {
            "reason": last_result["skipped"],
            "skips": skips,
            "partial": ctx["artifacts"],
            "dropped_capabilities": plan.get("dropped_capabilities") or [],
        }
    elif skips:
        plan["produce_skips"] = skips


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
    # UNIFIED PRODUCE — create the artifact from the agreed synthesis BEFORE we
    # verify against it (single deterministic path: doc/sheet/email).
    await _produce_output(req, final_text)
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


# Dedicated doc-authoring guide injected into the LLM at production time — the
# "rendering skill" for the agents (they're AgentScope LLMs, not Claude, so this
# is the functional equivalent of a skill: a structured authoring contract). It
# teaches the markdown the in-tool renderer understands + a quality bar, so the
# produced Google Doc is well-structured and uses DRAWN tables where they help.
_DOC_AUTHORING_GUIDE = (
    "  • Open with '# <Title>' then a one-paragraph executive summary.\n"
    "  • Use '## <Section>' for each major section, '### ' for sub-sections.\n"
    "  • **Bold** key terms, names, figures, and decisions.\n"
    "  • Use '- ' bullets for lists and '1. ' for ordered steps/timelines.\n"
    "  • For ANY numeric, comparative, schedule, cost, or option data, USE A "
    "TABLE — it is drawn as a real Google Docs table. Markdown table syntax:\n"
    "        | Column A | Column B | Column C |\n"
    "        |---|---|---|\n"
    "        | val | val | val |\n"
    "    (first row = header, then a '|---|' rule line, then data rows). Prefer a "
    "table over prose whenever you'd otherwise list figures inline.\n"
    "  • Be specific and grounded: real numbers/dates from recall, not placeholders. "
    "If a figure is uncertain, give the range and add a short 'Gaps to confirm' section.\n"
    "  • End with a concrete next-step checklist."
)


# Recipient-name patterns: "to Ceyda", "email Rama", "cc Maya", "for Dr. Park".
# Trigger words are case-insensitive (inline (?i:...)), but the NAME capture is
# case-SENSITIVE — a global re.IGNORECASE makes [A-Z] match "to"/"for", so the
# regex captured "to Rama" instead of "Rama" and resolution failed.
_RECIPIENT_RE = re.compile(
    r"\b(?i:to|cc|for|e-?mail|email|mail|message|send(?:\s+(?:this|it|a\s+mail|an?\s+email))?\s+to)\s+"
    r"((?:Dr\.?\s+|Mr\.?\s+|Ms\.?\s+|Mrs\.?\s+)?[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)"
)


async def _fetch_correspondence(req: "RoomTurnRequest", name: str, email: str) -> List[Dict[str, Any]]:
    """Pull a few prior emails involving a contact (by name/email) so the agents
    can MATCH the real voice/style/patterns and ground facts — instead of writing
    a generic template. Best-effort; returns [] if Gmail isn't connected."""
    who = (name or email or "").strip()
    if not who:
        return []
    # Pull the SENDER'S OWN past emails to this person — `from:me` is the user's
    # authentic voice — and EXCLUDE drafts/trash so we don't echo the room's own
    # AI-generated drafts (the "verify its own draft" bug). Fall back to a plain
    # search only if there's no sent history.
    out: List[Dict[str, Any]] = []
    for q in (f"from:me {who} -in:drafts -in:trash", f"{who} -in:drafts -in:trash"):
        res = await google_exec_emulated(
            "gmail_search", {"query": q, "max": 10}, user_id=req.user_id, org_id=req.org_id)
        msgs = (res or {}).get("messages") or []
        excerpts: List[Dict[str, Any]] = []
        for m in msgs:
            mid = m.get("id")
            if not mid:
                continue
            full = await google_exec_emulated(
                "gmail_get", {"id": mid}, user_id=req.user_id, org_id=req.org_id)
            body = ((full or {}).get("body") or m.get("snippet") or "").strip()
            subject = (full or {}).get("subject") or m.get("subject") or ""
            # Skip the room's own AI drafts that may already sit in the mailbox.
            if not body or any(p in subject.lower() for p in ("a quiet love", "you light up my world")):
                continue
            excerpts.append({
                "from": (full or {}).get("from") or m.get("from") or "",
                "subject": subject,
                "body": body[:700],
            })
            if len(excerpts) >= 3:
                break
        if excerpts:
            out = excerpts
            break
    return out


_STYLE_SIGNALS = (
    "style", "voice", "patterns", "previous", "past", "in his", "in her",
    "like he", "like she", "tone", "follow", "his writing", "her writing",
)


def _gather_query(msg: str) -> str:
    """Concise search query from the user message — drop the command verbs so the
    connector search hits the subject, not 'write/draft/email'."""
    cleaned = re.sub(
        r"\b(write|draft|compose|create|make|send|email|e-?mail|mail|prepare|another|please|the|a|an|to|for|about|on|behalf|of)\b",
        " ", msg or "", flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", cleaned).strip()[:80]


async def _gather_evidence(
    req: "RoomTurnRequest", plan: Dict[str, Any], clean_msg: str,
    enabled_connectors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """GATHER phase — pull read-only evidence from ALL enabled connectors the team
    reasons OVER, before it acts. (1) Resolve named people → REAL contacts (org +
    Gmail). (2) Prior correspondence for voice/style. (3) Search Google Drive
    (docs/sheets/slides) when those connectors are enabled. (4) [MCP search — next].
    HIVEMIND recall + web are gathered elsewhere. Stashes the pack on the plan and
    emits a `gather` event."""
    out = plan.get("intended_output")
    msg = clean_msg or ""
    conns = [str(c) for c in (enabled_connectors or [])]
    sources = ["hivemind"]
    contacts: List[Dict[str, Any]] = []
    correspondence: List[Dict[str, Any]] = []
    connector_hits: List[Dict[str, Any]] = []

    q = _gather_query(msg)
    # Seed evidence from EVERY enabled source in PARALLEL (MiroFish-style "gather
    # all info first"), regardless of output type — not gmail-only. Three
    # independent reads fan out at once: (1) resolve named people → real contacts,
    # (2) a TOPICAL gmail sweep (mail searched for subject-matter, not just a
    # person's voice), (3) a Drive (docs/sheets/slides) sweep. HIVEMIND recall +
    # web are gathered elsewhere. [MCP connectors plug in here the moment a room
    # enables one — none do today; all enabled connectors are Google-native.]
    want_contacts = out in ("email", "slack") or bool(_RECIPIENT_RE.search(msg))

    async def _do_contacts() -> List[Dict[str, Any]]:
        return await _resolve_recipients(req, msg) if want_contacts else []

    async def _do_gmail() -> Optional[Dict[str, Any]]:
        if "gmail" not in conns or not q:
            return None
        return await google_exec_emulated(
            "gmail_search", {"query": q, "max": 6}, user_id=req.user_id, org_id=req.org_id)

    async def _do_drive() -> Optional[Dict[str, Any]]:
        if not any(c in conns for c in ("google_docs", "google_sheets")) or not q:
            return None
        return await google_exec_emulated(
            "drive_search", {"query": q, "max": 6}, user_id=req.user_id, org_id=req.org_id)

    contacts_r, gmail_r, drive_r = await asyncio.gather(
        _do_contacts(), _do_gmail(), _do_drive(), return_exceptions=True)

    if isinstance(contacts_r, list) and contacts_r:
        contacts = contacts_r
        sources.append("org_directory")
    # Topical mail hits — subject-matter evidence, distinct from voice samples.
    if isinstance(gmail_r, dict) and gmail_r.get("messages"):
        for m in gmail_r["messages"][:6]:
            connector_hits.append({
                "connector": "gmail", "kind": "email",
                "title": m.get("subject") or (m.get("snippet") or "")[:80],
                "url": (f"https://mail.google.com/mail/u/0/#all/{m.get('threadId')}"
                        if m.get("threadId") else ""),
                "snippet": (m.get("snippet") or "")[:200],
            })
        sources.append("gmail")
    if isinstance(drive_r, dict) and drive_r.get("files"):
        for f in drive_r["files"]:
            connector_hits.append({"connector": f"google-{f.get('type','file')}",
                                   "title": f.get("name"), "url": f.get("url"), "kind": f.get("type")})
        sources.append("google_drive")

    # Prior correspondence for VOICE/style — needs a resolved person, so it runs
    # after contact resolution (it depends on the result above).
    target = contacts[0] if contacts else {}
    style_signal = any(t in msg.lower() for t in _STYLE_SIGNALS)
    if ("gmail" in conns) and (out == "email" or style_signal) and (target.get("name") or target.get("email")):
        correspondence = await _fetch_correspondence(
            req, target.get("name", ""), target.get("email", ""))
        if correspondence and "gmail" not in sources:
            sources.append("gmail")

    # Recipient-gap fallback: an email with NO resolvable recipient (none in
    # org/Gmail, none typed literally) must NOT loop or escalate — demote to a
    # grounded ANSWER that delivers the plan and asks for the address. (Was: the
    # skeptic escalated "the recipient is missing" for 4 rounds, producing
    # nothing.) The intent guard in _plan_turn catches most; this catches the
    # case where a send-verb WAS present but the named person didn't resolve.
    if out == "email" and not contacts:
        plan["intended_output"] = "answer"
        plan["output_demoted"] = "email→answer: no recipient resolved (none in org/Gmail, none typed)"
        out = "answer"

    plan["verified_contacts"] = contacts          # consumed by production directives
    plan["correspondence"] = correspondence
    plan["connector_hits"] = connector_hits
    plan["evidence"] = {"contacts": contacts, "correspondence": correspondence,
                        "connector_hits": connector_hits, "sources": sources}
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "gather",
        "sources": sources,
        "contacts": len(contacts),
        "correspondence": len(correspondence),
        "connector_hits": connector_hits[:8],
    })
    log.info("[gather] room=%s sources=%s contacts=%d corr=%d drive=%d",
             req.room_id, ",".join(sources), len(contacts), len(correspondence), len(connector_hits))
    return plan["evidence"]


async def _recon_pre(req: "RoomTurnRequest", plan: Dict[str, Any], clean_msg: str) -> Dict[str, Any]:
    """RECON-PRE phase — verify the gathered evidence is SUFFICIENT to produce the
    output BEFORE the team writes it. Flags gaps (e.g. no verified recipient, no
    voice samples for a style task) so the production step resolves/flags them
    instead of fabricating. Deterministic + fast. Emits a `recon_pre` event and
    stashes plan['evidence_gaps']."""
    out = plan.get("intended_output")
    ev = plan.get("evidence") or {}
    contacts = ev.get("contacts") or []
    correspondence = ev.get("correspondence") or []
    style_signal = any(t in (clean_msg or "").lower() for t in _STYLE_SIGNALS)
    missing: List[str] = []
    if out in ("email", "slack") and not contacts:
        missing.append("a verified recipient address — resolve via org_directory (org + Gmail) or ask the user; do NOT guess one")
    if (out == "email" or style_signal) and not correspondence:
        missing.append("the sender's prior messages to match their real voice — read them via gmail_search/gmail_get before writing")
    verdict = {"sufficient": not missing, "missing": missing}
    plan["evidence_gaps"] = missing
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "recon_pre", "sufficient": verdict["sufficient"], "missing": missing,
    })
    log.info("[recon-pre] room=%s sufficient=%s gaps=%d", req.room_id, verdict["sufficient"], len(missing))
    return verdict


# Cap on how many assigned owners actually execute their slice in the EXECUTE
# phase (cost/latency bound — one LLM call each, sequential for handoff).
# Cap on owners that EXECUTE with tools. Lower than before because each is now a
# bounded ReAct loop with real recall/connector calls (token-heavier) — turn-1 of
# the Solvis transcript hit a 429 with 5 tool-less narrators; tool-grounded costs
# more, so cap tighter + stagger.
_EXECUTE_MAX_OWNERS = int(os.environ.get("HYPER_ROOM_EXECUTE_MAX_OWNERS", "4"))
_EXECUTE_MAX_ITERS = int(os.environ.get("HYPER_ROOM_EXECUTE_MAX_ITERS", "4"))


async def _execute_assignments(
    req: "RoomTurnRequest", plan: Dict[str, Any],
    participants: List[Dict[str, Any]],
    enabled_connectors: Optional[List[str]] = None,
) -> None:
    """EXECUTE phase — make the plan REAL, irrespective of room type. Walk the
    lead's per-owner assignments and have EACH owner agent (in persona) actually
    DO their slice WITH ITS TOOLS — recall HIVEMIND + use the room's connectors to
    GATHER and GROUND, building on the prior owners (sequential handoff = the deep,
    phased interaction). Each runs a BOUNDED ReAct loop (max_iters≈4) so it really
    queries instead of narrating from imagination (the fabrication failure). Stashes
    plan['execution'] and emits one `execute` event per owner.

    Tool-GROUNDED (not tool-less) is the whole point: a tool-less owner invents
    specs/CEOs/addresses; a tool-equipped owner recalls the real fact or honestly
    reports UNVERIFIED. The team's template then integrates/challenges this real
    work. Runs for ANY template, BEFORE the template dispatch."""
    assignments = plan.get("assignments") or {}
    if not assignments:
        return
    conns = [str(c) for c in (enabled_connectors or [])]
    by_name: Dict[str, Dict[str, Any]] = {}
    for p in participants:
        for k in (p.get("slug"), p.get("name")):
            if k:
                by_name[str(k)] = p
    try:
        boot = {b["id"]: b for b in await fetch_bootstrap()}
    except Exception:  # noqa: BLE001
        boot = {}
    out = plan.get("intended_output")
    hits = plan.get("connector_hits") or []
    corr = plan.get("correspondence") or []
    ev_parts: List[str] = []
    if hits:
        ev_parts.append("Gathered files:\n" + "\n".join(
            f"  - [{h.get('kind','file')}] {h.get('title')} — {h.get('url')}" for h in hits[:6]))
    if corr:
        ev_parts.append(f"{len(corr)} prior emails were fetched (voice/facts evidence).")
    ev_block = "\n".join(ev_parts) or "(broad recall + connectors were already swept this turn — reason over them.)"
    contributions: List[Dict[str, Any]] = []
    for owner, subtask in list(assignments.items())[:_EXECUTE_MAX_OWNERS]:
        emp = by_name.get(str(owner))
        if not emp:
            continue
        boot_emp = boot.get(emp.get("id"), {}) or {}
        prior = ("\n\n".join(f"{c['owner']} — {c['subtask']}:\n{c['contribution']}"
                             for c in contributions) or "(you are first — set the foundation.)")
        prompt = (
            f"Room goal: {req.room_goal or '(none)'}\n"
            f"User request: {req.user_message}\n"
            f"Target output for the team: {out}\n\n"
            f"GATHERED EVIDENCE (reason over it; do not claim it is missing):\n{ev_block}\n\n"
            f"TEAMMATES' WORK SO FAR (build ON it, don't repeat it):\n{prior}\n\n"
            f"YOUR ASSIGNED PART: {subtask}\n\n"
            "DO the work — don't narrate a plan. USE YOUR AVAILABLE TOOLS to ground it: your "
            "memory-recall tool for any fact/number/name/spec, and your connector tools "
            "(Gmail / Docs / Sheets search) for documents or addresses. Call the tools by the "
            "exact names in your tool list. Work toward your slice until you have a grounded result.\n"
            "If your part needs a PERSON — a recipient, a CEO, a stakeholder, their email or "
            "identity — RECALL HIVEMIND for them BY NAME first (the contact may live in a past "
            "email, a doc, or a note). Search memory before ever concluding it's unavailable; only "
            "say a contact is missing AFTER recall genuinely returns nothing. When you find a real "
            "email/contact, state it explicitly so the team can use it.\n"
            "STRICT GROUNDING — this is enforced downstream:\n"
            "  • Every specific claim (number, spec, name, date, email, citation) MUST come "
            "from a recall hit or a tool result. After each, cite it inline like "
            "`[src: <memory title or tool>]`.\n"
            "  • If recall/tools do NOT return a fact, write `UNVERIFIED` — do NOT invent it, "
            "do NOT fabricate a source, date, or document name.\n"
            "  • You have NO web access — never cite a website, press release, or LinkedIn.\n"
            "Deliver your concrete grounded contribution in 4–8 sentences."
        )
        exec_emp = {
            **emp,
            # Real tools (recall + the room's connectors) so the owner actually
            # gathers/grounds — the fix for "agents don't execute, they fabricate".
            "tools": DEFAULT_HYPER_TOOLS,
            "connectors": conns,
            "hyper": boot_emp.get("hyper"),
            "active_prompt_version": boot_emp.get("active_prompt_version"),
            "max_iters": _EXECUTE_MAX_ITERS,
        }
        try:
            # Anti-429 stagger — tool-grounded owners are token-heavy (turn-1 hit
            # the TPM limit); space them out.
            if contributions:
                await asyncio.sleep(0.3)
            agent = build_react_agent(
                exec_emp, boot_emp.get("api_key") or "",
                user_id=req.user_id, org_id=req.org_id, project_id=req.project_id,
            )
            reply = await agent(Msg(name="user", content=prompt, role="user"))
            text = (_msg_to_text(reply) or "").strip()
        except Exception as exc:  # noqa: BLE001 — never fail a turn over execution
            # gpt-oss intermittently leaks the harmony channel marker into the tool
            # NAME (`recall<|channel|>commentary`) → Groq 400 tool_use_failed. It's
            # flaky, so ONE retry with an explicit name-discipline hint usually
            # recovers (and the agent's memory carries its progress so far).
            es = str(exc)
            if "tool_use_failed" in es or "not in request.tools" in es or "tool call validation" in es.lower():
                try:
                    reply = await agent(Msg(
                        name="user",
                        content=("Your last tool call was malformed — the tool NAME contained extra "
                                 "characters. Call tools using ONLY their exact registered name "
                                 "(e.g. `recall`, `org_directory`) with no suffix, channel marker, "
                                 "or '<|...|>'. Retry and finish your assigned part."),
                        role="user"))
                    text = (_msg_to_text(reply) or "").strip()
                except Exception as exc2:  # noqa: BLE001
                    log.warning("[execute] owner=%s failed after retry: %s", owner, exc2)
                    continue
            else:
                log.warning("[execute] owner=%s failed: %s", owner, exc)
                continue
        if not text:
            continue
        contributions.append({"owner": str(owner), "subtask": str(subtask)[:300],
                              "contribution": text[:1200]})
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "execute",
            "owner": emp.get("slug") or str(owner),
            "name": emp.get("name") or str(owner),
            "subtask": str(subtask)[:300],
            "contribution": text[:700],
        })
    plan["execution"] = contributions
    log.info("[execute] room=%s owners=%d", req.room_id, len(contributions))


async def _resolve_recipients(req: "RoomTurnRequest", message: str = "") -> List[Dict[str, Any]]:
    """Extract recipient names from the turn and resolve each to a REAL email via
    the org directory (which also checks Gmail). Returns [{name, email, source}].
    Hands the agents verified addresses so they never fabricate one. `message`
    should be the CLEAN user request (no injected preambles)."""
    msg = message or req.user_message or ""
    resolved: List[Dict[str, Any]] = []
    # An email address the user typed LITERALLY is trusted as-is — the explicit
    # address IS the authorization, so it needs no org/Gmail lookup and must
    # never be rejected. (Without this, "send to <new address>" yields no
    # verified recipient → the producer skips → the goalkeeper reworks to the
    # cap and never drafts. The user-given address is ground truth.)
    for addr in re.findall(r"[\w.+-]+@[\w.-]+\.\w+", msg):
        low = addr.lower()
        if "noreply" in low or "no-reply" in low:
            continue
        if not any(r["email"].lower() == low for r in resolved):
            resolved.append({"name": addr.split("@")[0], "email": addr, "source": "explicit"})
    cands: List[str] = []
    for m in _RECIPIENT_RE.finditer(msg):
        nm = re.sub(r"^(Dr|Mr|Ms|Mrs)\.?\s+", "", m.group(1).strip(), flags=re.IGNORECASE).strip()
        # Drop generic words that capitalize after "to/for" (e.g. "European").
        if nm and nm.lower() not in ("the", "european", "summit", "team", "everyone", "all") and nm not in cands:
            cands.append(nm)
    seen_names = set()
    for name in cands[:5]:
        if name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        try:
            d = await org_members_emulated(name, user_id=req.user_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            continue
        members = (d or {}).get("members") or []
        gmail_c = (d or {}).get("gmail_candidates") or []
        if members and members[0].get("email"):
            resolved.append({"name": name, "email": members[0]["email"], "source": "org"})
        elif gmail_c and gmail_c[0].get("email"):
            resolved.append({"name": name, "email": gmail_c[0]["email"], "source": "gmail"})
    return resolved


def _output_production_directive(turn_id: str) -> str:
    """CONTENT directive for the synthesis. The agents do NOT call connector tools
    to produce the artifact — they write the deliverable AS their synthesis text,
    and the room's single PRODUCE step (_produce_output) turns it into the real
    Google Doc / Sheet / email draft. This keeps ONE deterministic produce path."""
    plan = _PLAN_BY_TURN.get(turn_id)
    if not isinstance(plan, dict):
        return ""
    out = plan.get("intended_output")
    _gaps = plan.get("evidence_gaps") or []
    _gap_prefix = (
        ("\n\n⚠ EVIDENCE GAPS (resolve these in your synthesis, or flag them — do NOT "
         "fabricate to fill them):\n" + "\n".join(f"  - {g}" for g in _gaps))
        if _gaps else ""
    )
    _no_tools = ("\nDo NOT call any connector tool to send/create the artifact — just "
                 "WRITE the content; the room produces and surfaces it for you.")
    if out == "doc":
        return (
            _gap_prefix +
            "\n\n── WRITE THE DELIVERABLE (the room will produce it) ──\n"
            "Write the COMPLETE document AS your synthesis, in MARKDOWN — it renders into a "
            "polished Google Doc (real headings, bold, lists, DRAWN tables):\n" + _DOC_AUTHORING_GUIDE +
            "\nFull substance grounded in recalled facts, not a summary." + _no_tools
        )
    if out == "sheet":
        return (
            _gap_prefix +
            "\n\n── WRITE THE DELIVERABLE (the room will produce it) ──\n"
            "Present the data AS your synthesis in a MARKDOWN TABLE — first row = headers, "
            "then a '|---|' rule, then data rows (real numbers from recall):\n"
            "    | Year | ARR (€) | Customers |\n    |---|---|---|\n    | 2026 | 120000 | 3 |\n"
            "The room builds the Google Sheet from your table." + _no_tools
        )
    if out == "email":
        contacts = plan.get("verified_contacts") or []
        if contacts:
            contact_block = (
                "\nRECIPIENT (the room sends to this VERIFIED address — do not guess another):\n"
                + "\n".join(f"  - {c['name']} → {c['email']}" for c in contacts) + "\n"
            )
        else:
            contact_block = ("\n(No recipient pre-resolved — if you name one, the room resolves it "
                             "via org_directory/Gmail; never invent an address.)\n")
        corr = plan.get("correspondence") or []
        if corr:
            style_block = (
                "\nPRIOR EMAILS — the REAL voice & facts. MATCH this tone/phrasing/patterns:\n"
                + "\n---\n".join(f"From {c.get('from','')} | {c.get('subject','')}\n{c.get('body','')}" for c in corr)
                + "\nWrite in THIS voice, not a generic template.\n"
            )
        else:
            style_block = "\n(Match the sender's real voice from recalled mail; no generic template.)\n"
        return (
            _gap_prefix +
            "\n\n── WRITE THE DELIVERABLE (the room will produce it) ──\n"
            "Write the final email AS your synthesis: a 'Subject: ...' line then the body.\n"
            "VOICE/STYLE: " + style_block +
            "RECIPIENT: " + contact_block +
            "Sign with your name + YOUR organisation/brand only — never invent personal "
            "addresses for yourself or colleagues. The room saves it as a Gmail DRAFT to the "
            "verified recipient and surfaces it for the user's one-click approval — it is NOT "
            "sent until they approve, so don't claim it was sent." + _no_tools
        )
    if out == "answer" and plan.get("output_demoted"):
        # Was an email but no recipient resolved → answer that delivers the plan
        # AND asks for the address. Never escalate over the missing recipient.
        return (
            _gap_prefix +
            "\n\n── DELIVER THE ANSWER ──\n"
            "Give the COMPLETE plan/recommendation grounded in the gathered evidence — concrete steps "
            "and a realistic sequence; reference real team members by their role where an owner makes "
            "sense, but do NOT fabricate commitments, dates, or facts not in the evidence. This is NOT "
            "an email (no recipient could be resolved). Close with ONE "
            "short line offering to draft the email once the user shares the recipient's address. Do NOT "
            "treat the missing address as a blocker, and do NOT escalate over it." + _no_tools
        )
    return ""


class _AgenticPlan(BaseModel):
    """FLAT plan the lead emits via structured output. Flat on purpose — gpt-oss
    handles a list[str] in one forced generate_response, but chokes on the nested
    PlanNotebook create_plan schema. We build/drive the plan in Python from this."""
    goal: str = Field(description="One line: what the team must accomplish.")
    done_criterion: str = Field(description="One line: how we know it's fully done.")
    subtasks: list[str] = Field(
        description="2-5 items, each 'Owner Name — concrete tool-doable action', "
                    "e.g. 'Lina Park — recall the recipient email from HIVEMIND'.")


def _agentic_enabled() -> bool:
    """Flag — the AgentScope structured-plan + MsgHub agentic orchestrator. ON by
    default (the visioned swarm loop: guaranteed gather → decompose → per-owner
    tool-grounded execution → synthesize → verify → persist). Set
    HYPER_AGENTIC_ORCHESTRATOR=off to fall back to the deterministic pipeline."""
    return os.environ.get("HYPER_AGENTIC_ORCHESTRATOR", "on").lower() not in ("0", "false", "no", "off")


async def _agent_reply_resilient(agent, content: str) -> str:
    """Invoke an agent once, with a single retry on gpt-oss's flaky harmony
    tool-name leak (`recall<|channel|>commentary` → Groq 400). Returns its text."""
    try:
        r = await agent(Msg(name="user", content=content, role="user"))
        return (_msg_to_text(r) or "").strip()
    except Exception as exc:  # noqa: BLE001
        es = str(exc)
        if "tool_use_failed" in es or "not in request.tools" in es or "tool call validation" in es.lower():
            try:
                r = await agent(Msg(
                    name="user",
                    content=("Your last tool call was malformed (extra characters in the tool NAME). "
                             "Call tools using ONLY their exact registered name, no suffix/channel "
                             "marker. Retry and finish."),
                    role="user"))
                return (_msg_to_text(r) or "").strip()
            except Exception as exc2:  # noqa: BLE001
                log.warning("[agentic] agent failed after retry: %s", exc2)
                return ""
        log.warning("[agentic] agent failed: %s", exc)
        return ""


async def _orchestrate_agentic(
    req: "RoomTurnRequest",
    participants: List[Dict[str, Any]],
    lead: Dict[str, Any],
    enabled_connectors: List[str],
    started: float,
) -> RoomTurnResponse:
    """Agentic orchestrator (flagged) — AgentScope PlanNotebook + MsgHub.

    The lead decomposes the task into SubTasks via `create_plan`; each owner runs
    its OWN ReAct loop with real tools (personified recall + connectors) to finish
    its SubTask; MsgHub broadcasts each result to peers; the lead synthesizes. No
    deterministic intent/produce/resolve branches — agents accomplish the task
    through their own tool calls. Reuses the grounding gate + verify + produce +
    approval drain + seal. Works for ANY task shape (nothing is task-coded)."""
    cost_tokens = 0
    conns = [str(c) for c in (enabled_connectors or [])]
    boot = {b["id"]: b for b in await fetch_bootstrap()}

    # gpt-oss-120b drives nested tool schemas + structured output far more
    # reliably than 20b (the 400s/harmony leaks were a 20b-capability ceiling).
    # Phase-0 eval may override per-turn (req.agentic_model) to A/B models.
    _agentic_model = getattr(req, "agentic_model", None) or os.environ.get("HYPER_AGENTIC_MODEL", "openai/gpt-oss-120b")

    def _mk(emp: Dict[str, Any], iters: int, toolless: bool = False) -> ReActAgent:
        # Agents are READ/REASON only — recall + read tools (DEFAULT_HYPER_TOOLS).
        # NO connector WRITE tools (docs_create/gmail_send): gpt-oss owners kept
        # calling them with placeholder args → google/exec 400s + no artifact. The
        # single reliable producer (_produce_output via google_exec_emulated) does
        # ALL connector writes from the clean synth content.
        # toolless=True for reactors: they react to the draft from context and must
        # return clean JSON — with tools, gpt-oss wraps the JSON in a fake `JSON`
        # tool call → 400. A tool-less agent returns the JSON as text (reliable).
        be = boot.get(emp.get("id"), {}) or {}
        merged = {
            **emp, "tools": (["_react_noop"] if toolless else DEFAULT_HYPER_TOOLS), "connectors": [],
            "llm_provider": "groq", "model": _agentic_model,
            "hyper": be.get("hyper"), "active_prompt_version": be.get("active_prompt_version"),
            "max_iters": (1 if toolless else iters),
        }
        return build_react_agent(
            merged, be.get("api_key") or "", user_id=req.user_id, org_id=req.org_id,
            project_id=req.project_id)

    roster = ", ".join(f"{p.get('name') or p.get('slug')}" for p in participants)

    # 0. GATHER — a GUARANTEED recall sweep so the team always has the org's facts
    #    (don't depend on each owner choosing to recall → the CEO-not-found
    #    variance). Robust gather/recon: the org brain is queried up front and the
    #    facts are injected into every agent's context.
    gathered_block = ""
    try:
        rc = await recall_emulated(req.user_message, user_id=req.user_id, org_id=req.org_id,
                                   project_id=req.project_id, max_memories=10)
        _mems = []
        if isinstance(rc, dict):
            _mems = rc.get("memories") or rc.get("results") or rc.get("context") or []
        _glines = []
        for m in (_mems if isinstance(_mems, list) else [])[:8]:
            if isinstance(m, dict):
                t = str(m.get("title") or m.get("name") or "")
                c = str(m.get("content") or m.get("summary") or m.get("text") or "")[:220]
                if t or c:
                    _glines.append(f"- {t}: {c}".strip(" -:"))
            elif isinstance(m, str):
                _glines.append(f"- {m[:220]}")
        if _glines:
            gathered_block = ("KNOWN FROM HIVEMIND MEMORY (ground your work in these real facts; "
                              "cite them; do NOT contradict or fabricate around them):\n"
                              + "\n".join(_glines) + "\n\n")
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "gather", "sources": ["hivemind"], "contacts": 0, "correspondence": 0,
            "connector_hits": [], "memory_hits": len(_glines),
        })
        log.info("[agentic] gather room=%s mem_hits=%d", req.room_id, len(_glines))
    except Exception as exc:  # noqa: BLE001
        log.warning("[agentic] gather failed: %s", exc)

    # 1. LEAD decomposes — asks for JSON, we parse it. gpt-oss on Groq emits the
    #    plan as clean JSON CONTENT (not a tool call), so AgentScope's
    #    structured_model (which forces a generate_response tool) 400s with "did
    #    not call a tool". The deterministic _plan_turn already uses this
    #    JSON-content + _first_json_object pattern reliably on Groq — mirror it.
    #    The DECOMPOSITION + output-type are the model's (agent-driven).
    plan_agent = _mk(lead, 8)
    plan_prompt = (
        f"You lead this room. Team: {roster}. Connectors: {', '.join(conns) or 'none'}.\n"
        f"{gathered_block}"
        f"USER TASK: {req.user_message}\n\n"
        "Reply with STRICT JSON only (no prose, no markdown):\n"
        '{\n'
        '  "intended_output": one of ["doc","sheet","email","answer"],\n'
        '  "done_criterion": "<one sentence: how we know it is fully, functionally done>",\n'
        '  "subtasks": ["<Owner Name — concrete tool-doable action>", ...]\n'
        '}\n'
        "2–5 subtasks; each starts with a real teammate then ' — ' then an action doable with "
        "tools (recall HIVEMIND, search Gmail/Docs). Pick intended_output from the user's intent: "
        "'create/write a doc/report'→doc, 'tracker/table'→sheet, 'email/send to X'→email, a "
        "question→answer. Do NOT add consent / policy / GDPR / approval subtasks the user did not "
        "ask for — the user's request IS the authorization; plan only the real work.\n"
        f"CAPABILITIES (what this room can actually PRODUCE): {', '.join(producible_kinds())} "
        "(plus reading HIVEMIND memory + the enabled connectors). The done_criterion must only "
        "assert end-states reachable with THESE — e.g. there is no file-sharing / permissions tool, "
        "so do NOT make 'shared with <person>' or 'permissions set' part of done_criterion; if the "
        "user asked for something unsupported, plan the part you CAN do and let the deliverable note "
        "the rest as a limitation."
    )
    plan_text = await _agent_reply_resilient(plan_agent, plan_prompt)
    cost_tokens += max(80, len(plan_text) // 4)
    plan_obj = _first_json_object(plan_text) or {}
    subtasks_raw = [str(s) for s in (plan_obj.get("subtasks") or []) if str(s).strip()][:_EXECUTE_MAX_OWNERS]
    done_txt = str(plan_obj.get("done_criterion") or "")
    intended_output = str(plan_obj.get("intended_output") or "answer").strip().lower()
    if intended_output not in ("doc", "sheet", "email", "answer"):
        intended_output = "answer"
    # Conservative intent guard (mirror the deterministic path): a planning/
    # strategy/"what should be" question is an ANSWER, not an artifact — don't
    # over-classify it to doc/email (which then needs a connector write + OAuth).
    # Only keep doc/sheet/email when the user EXPLICITLY asked to create/send one.
    _umsg = req.user_message or ""
    if intended_output == "email" and not _SEND_INTENT_RE.search(_umsg) \
            and not re.search(r"[\w.+-]+@[\w.-]+\.\w+", _umsg):
        intended_output = "answer"
    if intended_output in ("doc", "sheet") and not re.search(
            r"\b(create|writ|draft|build|make|generat|compil|prepare|doc|document|report|sheet|spreadsheet|table|catalog|catalogue|inventory)\w*", _umsg, re.IGNORECASE):
        intended_output = "answer"
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "plan", "agent": lead.get("slug"), "intended_output": intended_output,
        "done_criterion": done_txt, "steps": subtasks_raw,
        "assignments": {s: s for s in subtasks_raw},
    })
    log.info("[agentic] plan room=%s out=%s subtasks=%d", req.room_id, intended_output, len(subtasks_raw))

    def _owner_for(line: str, idx: int) -> Dict[str, Any]:
        low = (line or "").lower()
        for p in participants:
            nm = (p.get("name") or p.get("slug") or "").lower()
            if nm and nm.split()[0] in low:
                return p
        return participants[idx % len(participants)]

    # 2. OWNERS execute their subtask with single-arg tools (recall + connectors —
    #    reliable on gpt-oss), in a MsgHub so each result is observed by peers.
    owner_agents: Dict[str, ReActAgent] = {}
    contributions: List[Dict[str, Any]] = []
    if subtasks_raw:
        async with MsgHub(participants=[]) as hub:
            for idx, line in enumerate(subtasks_raw):
                owner = _owner_for(line, idx)
                slug = owner.get("slug") or str(idx)
                if slug not in owner_agents:
                    owner_agents[slug] = _mk(owner, _EXECUTE_MAX_ITERS)
                    try:
                        hub.add(owner_agents[slug])
                    except Exception:  # noqa: BLE001
                        pass
                task = line.split("—", 1)[1].strip() if "—" in line else line
                prior = "\n".join(f"- {c['owner']}: {c['text'][:200]}" for c in contributions) or "(first)"
                task_prompt = (
                    f"{gathered_block}"
                    f"Your SUBTASK: {task}\nTeammates so far:\n{prior}\n\n"
                    "GATHER from HIVEMIND with your tools — call `recall` (and `org_directory` for a "
                    "person/email) by name for any fact/person/contact your subtask needs; it may be in "
                    "a past email/doc/note. The room produces the final artifact ONCE from the whole "
                    "team's work — your job is to GATHER the real content + facts, not to create it. "
                    "Ground every specific in a tool result; mark anything you genuinely can't find as "
                    "UNVERIFIED (never invent). Report the ACTUAL CONTENT you gathered (the real "
                    "facts/list/text — not a description of what you did) so the room can use it directly."
                )
                if contributions:
                    await asyncio.sleep(0.3)  # anti-429
                text = await _agent_reply_resilient(owner_agents[slug], task_prompt)
                cost_tokens += max(60, len(text) // 4)
                if text:
                    contributions.append({"owner": owner.get("name") or slug, "subtask": task, "text": text})
                    await _emit_event(req.callback_url, req.turn_id, {
                        "t": "execute", "owner": slug, "name": owner.get("name") or slug,
                        "subtask": task[:300], "contribution": text[:700],
                    })

    exec_block = "\n\n".join(f"▸ {c['owner']} — {c['subtask']}:\n{c['text']}" for c in contributions) or "(no subtasks executed)"
    _deliver_spec = (
        "Output ONLY the deliverable content, ready to publish — NO process narration, NO placeholders. "
        "doc → begin with '# <a specific descriptive Title>' (NOT the room goal) then the FULL markdown "
        "document; sheet → markdown TABLE (header, '|---|', data rows); email → 'Subject: …' then the "
        "body; answer → the direct grounded answer. Use ONLY facts the team grounded; flag any "
        "UNVERIFIED item inline; never fabricate. Do NOT invent consent / policy / GDPR / approval "
        "gates the user did not ask for — the user's request IS the authorization; just produce it."
    )

    # 3. DRAFT — a FRESH lead agent writes the deliverable. Must be separate from
    #    plan_agent: that one was told "reply STRICT JSON" and its memory keeps it
    #    in JSON mode → the draft (and the produced doc) would be the plan JSON blob,
    #    not the prose deliverable. Fresh agent = clean prose.
    lead_agent = _mk(lead, 6)
    draft = await _agent_reply_resilient(lead_agent, (
        f"{gathered_block}USER TASK: {req.user_message}\n\n"
        f"Team gathered (grounded):\n{exec_block}\n\n"
        f"Write a first-pass FINAL DELIVERABLE (intended output '{intended_output}'). {_deliver_spec}"))
    cost_tokens += max(80, len(draft) // 4)
    if draft:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "line", "agent": lead.get("slug"), "kind": "lead", "content": draft})

    # 3b. SIMULATE — the swarm pressure-tests the draft: each reactor challenges /
    #     supports / extends (skeptic lane opposes), peer-review broadcast via the
    #     MsgHub. This is the MiroFish multi-agent simulation (debate + skepticism
    #     + support), reusing _run_reactor + the react/peer_review events the FE
    #     already renders.
    lead_name = lead.get("name") or lead.get("slug") or "Lead"
    reactors = [p for p in participants if (p.get("slug") or "") != (lead.get("slug") or "")][:3]
    challenges: List[Dict[str, Any]] = []
    if draft and reactors:
        ragents = [_mk(p, 6, toolless=True) for p in reactors]  # tool-less → clean react JSON
        async with MsgHub(participants=ragents):
            for p, ra in zip(reactors, ragents):
                lane = p.get("_lane") or p.get("role_archetype") or "Communicator"
                is_opp = "skeptic" in str(lane).lower() or "skeptic" in str(p.get("role_archetype") or "").lower()
                rr = await _run_reactor(ra, req.user_message, draft, lead_name, str(lane),
                                        is_opp, blackboard_context=gathered_block)
                cost_tokens += 60
                if rr.get("react"):
                    await _emit_event(req.callback_url, req.turn_id, {
                        "t": "react", "agent": p.get("slug"), "agreement": rr.get("agreement"),
                        "line": rr.get("line"), "confidence": rr.get("confidence"), "gap": rr.get("gap"),
                    })
                    if rr.get("agreement") == "challenge" and float(rr.get("confidence") or 0) >= 0.5:
                        challenges.append(rr)

    # 3c. REVISE — if the skeptic/peers raised real challenges, the lead revises to
    #     address them (one bounded round). Convergence, not one-shot.
    final_text = draft
    if challenges:
        ch_block = "\n".join(f"- ({c.get('agreement')}, {c.get('confidence')}) {c.get('line')}"
                             + (f" [gap: {c.get('gap')}]" if c.get("gap") else "") for c in challenges)
        final_text = await _agent_reply_resilient(lead_agent, (
            f"{gathered_block}USER TASK: {req.user_message}\n\n"
            f"Your draft:\n{draft}\n\nThe team CHALLENGED it:\n{ch_block}\n\n"
            f"REVISE the deliverable to address every challenge with grounded evidence (or honestly "
            f"flag what can't be resolved). {_deliver_spec}")) or draft
        cost_tokens += max(80, len(final_text) // 4)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "line", "agent": lead.get("slug"), "kind": "revise", "content": final_text})
    if final_text:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "line", "agent": lead.get("slug"), "kind": "synthesis", "content": final_text})

    # Resolve the recipient for an email (trusts a literal address the user typed,
    # else org_directory/Gmail/HIVEMIND) so the producer has a verified 'to'.
    _vc: List[Dict[str, Any]] = []
    if intended_output == "email":
        try:
            _vc = await _resolve_recipients(req, req.user_message)
        except Exception as exc:  # noqa: BLE001
            log.warning("[agentic] resolve recipients failed: %s", exc)
    # Stash the plan for produce + verify.
    _PLAN_BY_TURN[req.turn_id] = {
        "intended_output": intended_output, "done_criterion": done_txt or req.user_message,
        "assignments": {c["owner"]: c["subtask"] for c in contributions},
        "execution": [{"owner": c["owner"], "subtask": c["subtask"], "contribution": c["text"]} for c in contributions],
        "verified_contacts": _vc,
    }

    # 4. PRODUCE FIRST — turn the synth content into the REAL artifact (doc/sheet/
    #    email draft) via the single reliable producer. MUST run BEFORE verify so
    #    the verifier sees produced_artifacts (else artifact_ok is always false).
    try:
        await _produce_output(req, final_text)
    except Exception as exc:  # noqa: BLE001
        log.warning("[agentic] produce failed: %s", exc)
    artifacts = drain_artifacts()
    for art in artifacts:
        if art.get("url"):
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "connector_logo", "connector": art.get("connector"),
                "url": art.get("url"), "title": art.get("title"), "label": art.get("label") or "Open",
            })
    pending = drain_pending_writes()
    if pending:
        await _register_and_emit_approvals(req, pending)

    # 5. VERIFY + GROUNDING GATE — now the verifier sees the produced artifact.
    try:
        await _verify_and_emit(req, lead, final_text=final_text, blackboard={"hit_count": len(contributions)})
    except Exception as exc:  # noqa: BLE001
        log.warning("[agentic] verify failed: %s", exc)
    _vp = _PLAN_BY_TURN.get(req.turn_id) or {}
    _gv = _vp.get("verification") or {}
    status = "complete"
    if _vp.get("dead_end"):
        status = "blocked"  # un-reachable goal — surfaced honestly by post_room_turn
    elif _gv and not _gv.get("grounded_ok"):
        status = "escalated"

    await _emit_event(req.callback_url, req.turn_id, {
        "t": "seal", "cost_tokens": cost_tokens, "status": status,
        "duration_ms": int((time.time() - started) * 1000), "agentic": True,
    })
    resp = RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)
    if pending:
        resp.pending_approvals = [{k: v for k, v in r.items() if k != "descriptor"} for r in pending]
    if artifacts:
        resp.artifacts = [a for a in artifacts if a.get("url")]
    if isinstance(_gv, dict) and _gv:
        resp.verification = _gv
    log.info("[agentic] room=%s out=%s subtasks=%d artifacts=%d status=%s cost=%d",
             req.room_id, intended_output, len(subtasks_raw), len(artifacts), status, cost_tokens)
    return resp


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

    # ── Org identity grounding (kills the "we work for Solvis" hallucination) ──
    # The agents are the digital workforce of THIS org. Names that appear in
    # memory/email as clients/partners/projects (e.g. Solvis) are NOT their
    # employer. Inject before planning so the planner + every agent are anchored.
    try:
        _org_dir = await org_members_emulated(
            "", user_id=req.user_id, org_id=req.org_id)
        _org_name = (_org_dir or {}).get("org_name") or ""
    except Exception:  # noqa: BLE001
        _org_name = ""
    _identity = (
        f"[YOUR ORGANISATION{(' — ' + _org_name) if _org_name else ''}]\n"
        "For BUSINESS / EXTERNAL communications you are the digital workforce of THIS "
        "organisation: represent its own company/brand, and use the org's REAL people, "
        "roles, and contacts from memory. Other company names in memory/email (clients, "
        "partners, portfolio, e.g. Solvis) are NOT your employer — never sign as them.\n"
        "BUT follow the USER'S EXPLICIT INSTRUCTION first. If the user asks you to write AS "
        "or ON BEHALF OF a specific person (e.g. a founder's personal or romantic message), "
        "do EXACTLY that and sign as that person — this is authorized; do NOT impose brand "
        "identity, and do NOT block it on 'communication policy', 'brand', or 'identity "
        "verification'.\n"
        "AUTHORIZATION: the user's request IS the authorization. Do NOT invent approval, "
        "policy, GDPR, or identity-verification gates that the user did not state, and never "
        "refuse a clear, legitimate, user-authorized task for lack of such a gate. Help "
        "complete it.\n\n"
    )
    # ── Agentic orchestrator (flagged) — AgentScope PlanNotebook + MsgHub.
    #    Replaces the deterministic plan/gather/execute/produce phases with an
    #    agent-driven loop. OFF by default; runs only when the flag is set so the
    #    live deterministic path is untouched until this reaches parity.
    if _agentic_enabled():
        try:
            _ag_conns = await get_room_enabled_connectors(req.room_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            _ag_conns = []
        return await _orchestrate_agentic(req, participants, lead, _ag_conns, started)

    # Keep the CLEAN user request (pre-preamble) for recipient/name extraction —
    # the identity preamble contains words like 'for BUSINESS' that would pollute
    # the name regex and push the real recipient past the cap.
    _clean_user_request = req.user_message
    req.user_message = f"{_identity}{req.user_message}"

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
        # ── GATHER phase ── one connector-inclusive evidence step the team
        # reasons OVER (replaces the old email-only recipient/correspondence
        # bolt-on; generalizes to any output). HIVEMIND recall + web are gathered
        # elsewhere (blackboard / web worker); this adds connector evidence.
        try:
            await _gather_evidence(req, _plan, _clean_user_request, _plan_conns)
        except Exception as exc:  # noqa: BLE001 — never fail a turn over gathering
            log.warning("[gather] failed: %s", exc)
        # ── RECON-PRE phase ── verify the evidence is sufficient BEFORE writing;
        # surfaces gaps the production step must resolve/flag (not fabricate).
        try:
            await _recon_pre(req, _plan, _clean_user_request)
        except Exception as exc:  # noqa: BLE001
            log.warning("[recon-pre] failed: %s", exc)
        # ── EXECUTE phase ── make the plan REAL for ANY room type: each assigned
        # owner does their slice in persona, building on the prior owners (phased,
        # deep interaction) BEFORE the template runs. Without this the lead writes
        # a solo plan and the turn seals in one pass; with it the debate/swarm
        # integrates genuine per-owner work.
        try:
            await _execute_assignments(req, _plan, participants, _plan_conns)
        except Exception as exc:  # noqa: BLE001 — never fail a turn over execution
            log.warning("[execute] failed: %s", exc)
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
        _hits = _plan.get("connector_hits") or []
        _hits_line = ""
        if _hits:
            _hits_line = "Relevant connector files found (read with their tools if useful):\n" + "\n".join(
                f"  - [{h.get('kind','file')}] {h.get('title')} — {h.get('url')}" for h in _hits[:6])
        # GATHERED EVIDENCE in the SHARED context so EVERY agent (incl. the
        # skeptic) sees it — otherwise the skeptic keeps objecting "we can't
        # confirm the voice/style" when the prior emails were already fetched.
        _ev_contacts = _plan.get("verified_contacts") or []
        _ev_corr = _plan.get("correspondence") or []
        _evidence_lines = []
        if _ev_contacts:
            _evidence_lines.append("Verified contacts: " + "; ".join(
                f"{c.get('name')} <{c.get('email')}>" for c in _ev_contacts))
        if _ev_corr:
            _evidence_lines.append(
                f"Sender's {len(_ev_corr)} prior emails were fetched — THIS is the voice/style "
                "evidence (do NOT claim it is missing or unverifiable):\n"
                + "\n".join(f"  • {c.get('subject','')}: {c.get('body','')[:220]}" for c in _ev_corr))
        _evidence_block = (
            "GATHERED EVIDENCE (already pulled this turn — reason OVER it; do not ask for it "
            "again or object that it is missing):\n" + "\n".join(_evidence_lines)
        ) if _evidence_lines else ""
        # EXECUTED WORK — each owner already did their slice (EXECUTE phase). Fold
        # it into the shared context so the team integrates/challenges REAL output
        # instead of re-deriving a plan from scratch and sealing in one pass.
        _exec = _plan.get("execution") or []
        _exec_block = ""
        if _exec:
            _exec_block = (
                "WORK ALREADY DONE THIS TURN (each owner executed their assigned part — "
                "integrate, cross-check, and challenge the SUBSTANCE; build the final output "
                "ON this, do not restate the plan):\n"
                + "\n".join(f"  ▸ {c['owner']} — {c['subtask']}:\n    {c['contribution']}" for c in _exec)
            )
        _preamble_parts = [
            f"[TEAM PLAN — set by {lead.get('name') or lead.get('slug')}]",
            f"Target output: {_plan['intended_output']}.",
            f"Done when: {_plan['done_criterion']}." if _plan.get("done_criterion") else "",
            f"Plan: {_steps_str}." if _steps_str else "",
            (f"Assignments:\n{_assign_lines}" if _assign_lines else ""),
            _hits_line,
            _evidence_block,
            _exec_block,
            (
                "Each of you: do YOUR assigned part using your tools (activate the "
                "connector group first if needed), build on each other with healthy "
                "skepticism and peer-review, and drive together to the target output. "
                "The gathered evidence above is real — challenge SUBSTANCE, not whether the "
                "evidence exists. Do not stop at discussion — produce the actual output."
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
            synth_prompt = synth_prompt + _output_production_directive(req.turn_id)
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

    # Collect per-agent tool-call counts (the verifier reads this to judge whether
    # claims were tool-grounded). Computed here — BEFORE the grounding gate's
    # verify — and resets each agent's counter.
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

    # ── GROUNDING GATE ── verify BEFORE the save/seal decision. A turn whose
    # claims aren't grounded in memory/tools must NEVER be saved (it would poison
    # future recall) nor sealed RESOLVED (the user would ship fabrication). Run
    # the recon verdict here, and if grounded_ok is false, flip to escalate +
    # quality_low and prepend an UNVERIFIED banner so only honest, grounded
    # content surfaces. (Solvis transcript: fake CEO "Schröder", fake specs, fake
    # doc link all sealed RESOLVED — this stops that class entirely.)
    try:
        await _verify_and_emit(
            req, lead, final_text=final_text,
            tool_call_counts=tool_call_counts, blackboard=blackboard,
        )
        _verified = True
    except Exception as exc:  # noqa: BLE001 — never fail a turn over verification
        log.warning("[verify] pre-seal failed: %s", exc)
        _verified = False
    _gverdict = (_PLAN_BY_TURN.get(req.turn_id) or {}).get("verification") or {}
    if _gverdict and not _gverdict.get("grounded_ok"):
        quality_low = True
        final_verdict = "escalate"
        _gg = "; ".join(_gverdict.get("gaps") or []) or "key claims could not be grounded in HIVEMIND memory or connector results"
        final_text = (
            "⚠ UNVERIFIED — the team could not ground the following in memory or tools, "
            f"so they are NOT confirmed (do not act on them as fact): {_gg}\n\n"
            + (final_text or "")
        )
        log.info("[grounding-gate] room=%s BLOCKED — grounded_ok=false, not saved/not RESOLVED",
                 req.room_id)

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
    # Phase 5 — recon/verify already ran in the GROUNDING GATE above (before the
    # save/seal decision) so fabrication can't be persisted or sealed RESOLVED.
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
    # A write awaiting approval is terminal ONLY when the draft is also sound —
    # produced AND grounded. If recon flagged the draft as ungrounded or
    # incomplete, a pending approval is NOT a free pass: rework it first so the
    # user approves a CORRECT draft, not a flawed one. (Claude `/goal` keeps
    # working toward the goal — it doesn't surface a known-bad result.)
    if verdict.get("pending_writes") and verdict.get("artifact_ok") and verdict.get("grounded_ok"):
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
        # Terminal-honest: an un-fixable gap (the toolset can't reach the goal, or
        # the source data genuinely doesn't exist) is NOT re-plannable — re-running
        # would only re-discover the same wall and burn rounds. Stop and let the
        # honest dead-end surface, rather than loop to the cap emitting placeholders.
        if isinstance(plan, dict) and plan.get("dead_end"):
            log.info("[goalkeeper] room=%s dead-end (un-fixable) → stop honestly", req.room_id)
            break
        # Recon-driven rework: a produced deliverable is NOT an automatic stop.
        # Loop only stops when the verdict is met (or a pending draft is both
        # produced AND grounded), or the round cap is hit. A recon-rejected
        # draft (ungrounded / incomplete) gets reworked — we don't surface a
        # known-bad result. Same shape as Claude `/goal`: keep going to success.
        if not _goalkeeper_should_continue(verdict) or rnd >= max_rounds:
            break
        # Discard the rejected round's draft/artifacts so the rework round
        # produces a FRESH deliverable (else `_produce_output`'s idempotency
        # guard would short-circuit on the stale draft).
        reset_turn_outputs()
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

    # Always surface queued approvals — outward SENDS (gmail send/reply, trash)
    # are force-queued regardless of policy, so they must appear even under
    # "auto". docs/sheets never queue (no HITL), so this only carries real sends.
    pending = drain_pending_writes()
    if pending:
        await _register_and_emit_approvals(req, pending)
        # Strip the replay descriptor from the client-facing payload —
        # creds/args stay server-side in _PENDING_APPROVALS.
        resp.pending_approvals = [
            {k: v for k, v in rec.items() if k != "descriptor"}
            for rec in pending
        ]
    # Surface produced artifacts (docs/sheets) as connector_logo "view in new
    # tab" buttons in the FE — produced post-consensus, no HITL.
    artifacts = drain_artifacts()
    if artifacts:
        # Keep the LAST artifact per connector — the final refined deliverable,
        # not the intermediate drafts (defensive against parallel races).
        by_conn: Dict[str, Dict[str, Any]] = {}
        for a in artifacts:
            if a.get("url"):
                by_conn[str(a.get("connector"))] = a
        final_artifacts = list(by_conn.values())
        for art in final_artifacts:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "connector_logo",
                "connector": art.get("connector"),
                "url": art.get("url"),
                "title": art.get("title"),
                "label": art.get("label") or "Open",
            })
        resp.artifacts = final_artifacts
        log.info("[artifacts] room=%s produced=%d", req.room_id, len(final_artifacts))

    # Phase 5 — surface the recon/verify verdict (stashed on the plan).
    _vplan = _PLAN_BY_TURN.get(req.turn_id)
    if isinstance(_vplan, dict) and isinstance(_vplan.get("verification"), dict):
        resp.verification = _vplan["verification"]
    # Honest dead-end — the goal was un-reachable with the connected toolset /
    # available data. Surface WHY (so the user sees a truthful stop, not a looping
    # spinner or a placeholder draft) and mark the turn blocked.
    if isinstance(_vplan, dict) and _vplan.get("dead_end"):
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "line", "agent": "system", "kind": "dead_end",
            "content": _dead_end_message(_vplan),
        })
        resp.status = "blocked"
        log.info("[dead-end] room=%s blocked honestly: %s",
                 req.room_id, (_vplan.get("dead_end") or {}).get("reason"))
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
