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
from .hyper.engine import run_director

log = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/hyper", tags=["hyper-rooms"])


# ─── Budget constants ────────────────────────────────────────────────
# Token caps removed — agents use full model context. The runtime
# bounds are the model's own context window (Groq llama ~128k, Claude
# ~200k). No per-line or per-turn truncation here.

MAX_REACTORS = 2

# Full toolkit for hyper-room agents — all HIVEMIND read paths + save
# + time travel. Web access is reserved for one dedicated web-intel worker
# inside the room orchestrator, not every employee.
DEFAULT_HYPER_TOOLS = [
    "hivemind_recall",
    "hivemind_list_memories",
    "hivemind_get_memory",
    "hivemind_traverse_graph",
    # query_with_ai removed: room agents use `recall` for context (query_with_ai
    # hit a dead /api/query endpoint and is the wrong tool for in-room gathering).
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


def get_template_overlay(template: str) -> Dict[str, str]:
    return TEMPLATE_OVERLAYS.get(template, TEMPLATE_OVERLAYS.get("debate", {}))


def _is_deep_sim_prompt(user_message: str) -> bool:
    msg = (user_message or "").lower()
    triggers = (
        "simulate", "simulation", "real life", "real-life", "long simulation",
        "2-5 years", "2 to 5 years", "long term", "future scenario",
        "all perspectives", "like mirofish", "mirofish",
    )
    return any(t in msg for t in triggers)


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
    model: Optional[str] = None,
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
        '  "met": <true when the deliverable SUBSTANTIVELY satisfies the user request — see the met rule (honest UNVERIFIED items do NOT block it)>,\n'
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
        "- A WRITE that is PENDING APPROVAL counts as done-pending → artifact_ok=true.\n"
        "- met RULE (do NOT over-demand): met=true when the deliverable SUBSTANTIVELY satisfies the "
        "user's ACTUAL request — i.e. grounded_ok=true AND artifact_ok=true AND assignments_ok=true "
        "AND there is no BLOCKING gap. A BLOCKING gap is: a fabrication/invented fact, a MISSING "
        "required artifact, or content the user EXPLICITLY demanded that is absent. UNVERIFIED items "
        "and 'could be more complete / more sources / exhaustive' are COMPLETENESS gaps — list them "
        "in gaps but they DO NOT block met, UNLESS the user's request explicitly required exhaustive / "
        "ALL / complete / verbatim coverage. Honest UNVERIFIED labeling is a met-PASS, not a fail. Do "
        "NOT set met=false merely because gaps is non-empty — only a BLOCKING gap makes met=false.\n"
        "- assignments_ok=true when assignments_executed covers the assigned owners (each ran their "
        "slice in the EXECUTE phase this turn) AND the final text reflects that work. Do NOT require "
        "more than the plan assigned.\n"
        "- grounded_ok is a FABRICATION check ONLY — it does NOT measure completeness or HOW MANY "
        "items are unverified. DECISION RULE: grounded_ok=TRUE unless the text states a specific fact "
        "AS TRUE that BOTH (a) has NO backing in a memory_hit / tool result AND (b) is NOT labeled "
        "UNVERIFIED / unknown / 'not found'. The COUNT of UNVERIFIED-labeled items is IRRELEVANT to "
        "grounded_ok — a deliverable that honestly labels even 20 items UNVERIFIED is grounded_ok=TRUE "
        "(those are completeness gaps → list in gaps + met=false, but NOT grounded_ok=false). When in "
        "doubt and the text honestly flags what it couldn't confirm, grounded_ok=TRUE.\n"
        "- grounded_ok=FALSE only on a real FABRICATION tell — a confident-as-fact claim with a FAKE "
        "backing: a named source/citation/document/date matching NO memory_hit or tool result (e.g. "
        "'Confluence page X, 23-APR-24', an invented file name); a person/CEO/email asserted as real "
        "without a matching tool/memory result; OR a website / press-release / public-filing citation "
        "when hivemind_web_search was NOT used this turn (if web_search WAS used, a web citation backed "
        "by its result IS grounded). A claim the text marks UNVERIFIED is honest and NEVER lowers "
        "grounded_ok.\n"
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
        # Put the final grounding/recon JUDGE on the reliable recon model (the
        # caller passes _M_RECON, e.g. deepseek) instead of the room's default —
        # judgment reliability is what this gate is FOR. tool-less → no routing swap.
        if model:
            verifier_emp["model"] = model
            verifier_emp["llm_provider"] = "groq"
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
# ANY Google Docs/Drive/Sheets URL — when a real artifact was produced this turn,
# every such link in the email body is rewritten to the REAL one (the model often
# invents a plausible-looking doc id like /d/1aBcDeFg… that the placeholder regex
# can't catch). Prevents emailing a fabricated link.
_GDOCS_URL_RE = re.compile(r"https?://(?:docs|drive|sheets)\.google\.com/\S+", re.IGNORECASE)


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
    # Thread the REAL upstream artifact URL in; strip/replace any fabricated link.
    url_prior = ctx.get("last_artifact_url")
    if url_prior:
        # Rewrite EVERY Google docs/drive/sheets link (incl. a model-fabricated id)
        # + any placeholder token to the REAL produced URL.
        email_body = _GDOCS_URL_RE.sub(url_prior, email_body)
        email_body = _PLACEHOLDER_URL_RE.sub(url_prior, email_body)
        if url_prior not in email_body:
            email_body = f"{email_body}\n\nLink: {url_prior}"
    else:
        # No real artifact this turn → strip BOTH placeholder tokens AND any
        # fabricated Google link so we never send a fake doc URL.
        email_body = _PLACEHOLDER_URL_RE.sub("", email_body)
        email_body = _GDOCS_URL_RE.sub("", email_body).strip()
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
# "create/build/compile a doc|sheet" — the artifact is something to PRODUCE (then,
# with a send intent, email it). Catches "create a dedicated doc … and send as an
# email" which the 'via a doc' vehicle regex misses. Non-greedy, within one clause.
_DOC_CREATE_RE = re.compile(
    r"\b(?:creat|writ|mak|build|prepar|compil|draft|generat|assembl)\w*\b[^.]{0,40}?"
    r"\b(?:dedicated\s+|new\s+|single\s+|one\s+|comprehensive\s+|detailed\s+)*"
    r"(doc|document|report|brief|memo|overview|catalog\w*|one[\s-]?pager)\b", re.IGNORECASE)
_SHEET_CREATE_RE = re.compile(
    r"\b(?:creat|writ|mak|build|prepar|compil|draft|generat|assembl)\w*\b[^.]{0,40}?"
    r"\b(?:dedicated\s+|new\s+|single\s+)*(sheet|spreadsheet|tracker|table)\b", re.IGNORECASE)
# Planner-invented governance noise the user did not ask for — dropped from the
# subtask list unless the user's own message raised it. Send-approval is the
# write-gate's job, NOT an owner subtask.
_NOISE_SUBTASK_RE = re.compile(
    r"\b(complianc|consent|gdpr|opt[\s-]?in|unsubscrib|sign[\s-]?off|signature|legal\s+review|"
    r"policy\s+review|data[\s-]?protection|approve\s+(?:the\s+)?(?:email|draft|message))\w*", re.IGNORECASE)


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
        msg = user_msg or ""
        # Chain detection is keyed on the USER's intent, NOT the planner's single
        # intended_output pick: "write a mail to X through a sheet" is often
        # classified intended_output=sheet, which would drop the email. If the
        # message carries a SEND intent (mail/send/reply or a literal address) AND
        # names a sheet/doc vehicle, build the dependent chain [vehicle, email]
        # regardless of `out`.
        has_send = bool(_SEND_INTENT_RE.search(msg)) or bool(re.search(r"[\w.+-]+@[\w.-]+\.\w+", msg))
        # vehicle = an artifact the email should reference: either phrased as a
        # delivery vehicle ("via a sheet") OR explicitly created ("create a doc …").
        vehicle = ("sheet" if (_SHEET_VEHICLE_RE.search(msg) or _SHEET_CREATE_RE.search(msg))
                   else ("doc" if (_DOC_VEHICLE_RE.search(msg) or _DOC_CREATE_RE.search(msg)) else None))
        if vehicle and (has_send or out == "email"):
            steps = [{"kind": vehicle}, {"kind": "email"}]
        else:
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
    model: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Run the verify pass, emit a `verify` event, stash the verdict on the
    plan (so the handler/P6 goalkeeper can read it), and return it."""
    # UNIFIED PRODUCE — create the artifact from the agreed synthesis BEFORE we
    # verify against it (single deterministic path: doc/sheet/email).
    await _produce_output(req, final_text)
    verdict = await _verify_turn(
        req, lead, final_text=final_text,
        tool_call_counts=tool_call_counts, blackboard=blackboard, model=model,
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


# Cap on how many assigned owners actually execute their slice in the EXECUTE
# phase (cost/latency bound — one LLM call each, sequential for handoff).
# Cap on owners that EXECUTE with tools. Lower than before because each is now a
# bounded ReAct loop with real recall/connector calls (token-heavier) — turn-1 of
# the Solvis transcript hit a 429 with 5 tool-less narrators; tool-grounded costs
# more, so cap tighter + stagger.
_EXECUTE_MAX_OWNERS = int(os.environ.get("HYPER_ROOM_EXECUTE_MAX_OWNERS", "8"))
_EXECUTE_MAX_ITERS = int(os.environ.get("HYPER_ROOM_EXECUTE_MAX_ITERS", "4"))
# EVERY assigned owner runs its subtask IN PARALLEL (no sequential threading);
# concurrency is bounded only to avoid Groq 429s. Per-task recon then verifies
# each owner's output before the debate.
_EXECUTE_CONCURRENCY = max(1, int(os.environ.get("HYPER_ROOM_EXECUTE_CONCURRENCY", "5")))
# Phase 2 — bounded MULTI-ROUND swarm: debate→revise repeats until a round
# produces no high-confidence challenge (converged) or the cap is hit.
_SWARM_MAX_ROUNDS = max(1, min(5, int(os.environ.get("HYPER_SWARM_MAX_ROUNDS", "3"))))
_SWARM_CHALLENGE_CONF = float(os.environ.get("HYPER_SWARM_CHALLENGE_CONF", "0.5") or "0.5")


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


async def _recon_tasks(req: "RoomTurnRequest", contributions: List[Dict[str, Any]],
                       reviewer: "ReActAgent") -> Dict[int, Dict[str, Any]]:
    """Per-task recon — a tool-less reviewer checks EACH owner's gathered output
    against its subtask: grounded + on-task, not empty / a mere description / a
    fabrication. Returns {index: {ok: bool, gap: str}}. Best-effort; the caller
    guards. This is the 'recon on tasks' gate before the team debates."""
    items = "\n\n".join(
        f"[{i}] {c.get('owner')} — SUBTASK: {c.get('subtask')}\nGATHERED:\n{(c.get('text') or '')[:700]}"
        for i, c in enumerate(contributions))
    prompt = (
        f"USER TASK: {req.user_message}\n\nReview each teammate's gathered output below. For EACH "
        "index decide ok=true if it addresses its SUBTASK with concrete GROUNDED facts (real "
        "content — not empty, not merely a description of what they did, not fabricated). Set "
        "ok=false with a one-line `gap` if it is empty, off-task, or ungrounded.\n\n" + items +
        '\n\nReply STRICT JSON only: {"verdicts":[{"i":<index>,"ok":<bool>,"gap":"<gap or empty>"}]}')
    txt = await _agent_reply_resilient(reviewer, prompt)
    obj = _first_json_object(txt) or {}
    out: Dict[int, Dict[str, Any]] = {}
    for v in (obj.get("verdicts") or []):
        if isinstance(v, dict) and isinstance(v.get("i"), int):
            out[v["i"]] = {"ok": bool(v.get("ok")), "gap": str(v.get("gap") or "")}
    return out


async def _orchestrate_agentic(
    req: "RoomTurnRequest",
    participants: List[Dict[str, Any]],
    lead: Dict[str, Any],
    enabled_connectors: List[str],
    started: float,
    room_template: str = "debate",
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
    # Room TEMPLATE shapes behavior: lead_hint frames how the team approaches the
    # task; synth_hint sets the OUTPUT structure (debate vs DACI-decision vs
    # lean-coffee vs council-vote vs retrospective vs standup vs review). Applied
    # to the draft + the deliverable spec so the room type is real, not cosmetic.
    _overlay = get_template_overlay(room_template)
    _lead_hint = (_overlay.get("lead_hint") or "").strip()
    _synth_hint = (_overlay.get("synth_hint") or "").strip()
    boot = {b["id"]: b for b in await fetch_bootstrap()}

    # Default = llama-3.3-70b-versatile: Phase-0 eval (docs/.../2026-06-20-phase0-
    # model-eval-result.md) showed it matches gpt-oss-120b on action/artifact quality
    # while ~40% faster + ~45% cheaper per turn with ~0 tool-call failures (gpt-oss's
    # harmony/400 leaks are the patchwork tax). Override per-turn via req.agentic_model
    # or globally via HYPER_AGENTIC_MODEL.
    _agentic_model = getattr(req, "agentic_model", None) or os.environ.get("HYPER_AGENTIC_MODEL", "openai/gpt-oss-20b")

    # PER-PHASE model policy — match the model to the call's job (see the call-type
    # map). req.agentic_model (eval) forces ONE model for ALL phases; else each
    # phase uses HYPER_MODEL_<PHASE> or the default. Routing (agentscope_factory)
    # sends gpt-oss/llama → Groq direct, deepseek/* → OpenRouter.
    #   plan    : structured decompose (fast, clean JSON)     → gpt-oss-120b (Groq)
    #   execute : TOOL-CALLING owner gather (high volume)     → gpt-oss-20b  (Groq, reliable tools)
    #   reactor : tool-less debate react (highest volume)     → llama-3.1-8b-instant (Groq, cheap+fast)
    #   synth   : prose deliverable (few calls)               → gpt-oss-120b (Groq)
    #   recon   : task/grounding JUDGE (reliability-critical) → deepseek-v4-flash (OpenRouter)
    def _model_for(phase: str, default: str) -> str:
        return (getattr(req, "agentic_model", None)
                or os.environ.get(f"HYPER_MODEL_{phase.upper()}") or default)
    _M_PLAN = _model_for("plan", "openai/gpt-oss-120b")
    _M_EXECUTE = _model_for("execute", "openai/gpt-oss-20b")
    _M_REACTOR = _model_for("reactor", "llama-3.1-8b-instant")
    _M_SYNTH = _model_for("synth", "openai/gpt-oss-120b")
    _M_RECON = _model_for("recon", "deepseek/deepseek-v4-flash")

    def _mk(emp: Dict[str, Any], iters: int, toolless: bool = False, searcher: bool = False,
            model: Optional[str] = None) -> ReActAgent:
        # Agents are READ/REASON only — recall + read tools (DEFAULT_HYPER_TOOLS).
        # NO connector WRITE tools (docs_create/gmail_send): gpt-oss owners kept
        # calling them with placeholder args → google/exec 400s + no artifact. The
        # single reliable producer (_produce_output via google_exec_emulated) does
        # ALL connector writes from the clean synth content.
        # searcher=True (OWNERS): + hivemind_web_search so an owner can pull EXTERNAL
        # facts its subtask needs when HIVEMIND (the company brain) doesn't have them.
        # (Connector context-search lands in Phase 3 via the unified read/act registry.)
        # toolless=True for reactors: they react to the draft from context and must
        # return clean JSON — with tools, gpt-oss wraps the JSON in a fake `JSON`
        # tool call → 400. A tool-less agent returns the JSON as text (reliable).
        be = boot.get(emp.get("id"), {}) or {}
        if toolless:
            _tools = ["_react_noop"]
        elif searcher:
            _tools = DEFAULT_HYPER_TOOLS + ["hivemind_web_search"]
        else:
            _tools = DEFAULT_HYPER_TOOLS
        merged = {
            **emp, "tools": _tools,
            # searcher OWNERS get the room's connectors as READ-ONLY groups (gmail
            # search/read; docs/sheets skipped — they're producers). No write tools →
            # no spurious approvals from the small owner model. Reactors/plan/lead: none.
            "connectors": (conns if searcher else []),
            "connectors_read_only": searcher,
            "llm_provider": "groq", "model": (model or _agentic_model),
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
    #    not call a tool". JSON-content + _first_json_object pattern mirrors the
    #    Groq-reliable approach used here.
    #    The DECOMPOSITION + output-type are the model's (agent-driven).
    plan_agent = _mk(lead, 8, model=_M_PLAN)
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
    subtasks_raw = [str(s) for s in (plan_obj.get("subtasks") or []) if str(s).strip()]
    # Deterministic guard: the planner keeps inventing compliance / consent / GDPR /
    # opt-in / sign-off / "approve the draft" subtasks the user never asked for (the
    # model ignores the prompt rule). Drop them UNLESS the user actually mentioned
    # compliance/consent. Send-approval is handled by the write-gate, not an owner.
    if not _NOISE_SUBTASK_RE.search(req.user_message or ""):
        _filtered = [s for s in subtasks_raw if not _NOISE_SUBTASK_RE.search(s)]
        if _filtered:  # never strip to empty
            subtasks_raw = _filtered
    subtasks_raw = subtasks_raw[:_EXECUTE_MAX_OWNERS]
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

    # ── ASSIGN — EVERY participant gets a subtask. Planner subtasks map to owners;
    #    any teammate the planner left out (or if it emitted none) still gets a
    #    gather subtask for the user's task. No agent sits idle.
    assignments: List[Dict[str, Any]] = []
    _seen: set = set()
    for idx, line in enumerate(subtasks_raw):
        owner = _owner_for(line, idx)
        assignments.append({"owner": owner, "task": (line.split("—", 1)[1].strip() if "—" in line else line)})
        _seen.add(owner.get("slug"))
    for p in participants:
        if p.get("slug") not in _seen:
            assignments.append({"owner": p, "task":
                f"From your area of expertise, gather and verify the specific facts the room needs to answer: {req.user_message}"})
            _seen.add(p.get("slug"))
    assignments = assignments[:_EXECUTE_MAX_OWNERS]

    _gather_instructions = (
        "HIVEMIND is the COMPANY BRAIN — search it FIRST and as many times as your subtask needs "
        "(NOT once): `recall` per fact/topic, `org_directory` for a person/email, `traverse_graph` "
        "to follow a thread. When the room has connectors enabled, use their READ tools for live "
        "company data: Gmail → gmail_search/gmail_get/gmail_get_thread; Docs/Drive → drive_search "
        "then docs_get; Sheets → sheets_get. Only if a needed fact is genuinely EXTERNAL "
        "(public/industry info the company wouldn't store) call `hivemind_web_search`. The room "
        "produces the final artifact ONCE from the whole team's work — your job is to GATHER the "
        "real content + facts, not to create or send anything. Ground every specific in a tool "
        "result; mark anything you genuinely can't find as UNVERIFIED (never invent). Report the "
        "ACTUAL CONTENT you gathered (real facts/list/text — not a description of what you did)."
    )

    # 2. EXECUTE — ALL owners run their subtask IN PARALLEL (bounded concurrency for
    #    anti-429). No sequential prior-threading: each independently mines HIVEMIND
    #    + connectors + web and dumps grounded content; the team debates the union.
    _exec_sem = asyncio.Semaphore(_EXECUTE_CONCURRENCY)

    async def _run_owner(owner: Dict[str, Any], task: str, idx: int) -> Optional[Dict[str, Any]]:
        slug = owner.get("slug") or str(idx)
        try:
            async with _exec_sem:
                await asyncio.sleep(0.12 * (idx % _EXECUTE_CONCURRENCY))  # stagger anti-429
                agent = _mk(owner, _EXECUTE_MAX_ITERS, searcher=True, model=_M_EXECUTE)
                text = await _agent_reply_resilient(agent, f"{gathered_block}Your SUBTASK: {task}\n\n{_gather_instructions}")
        except Exception as exc:  # noqa: BLE001
            log.warning("[agentic] owner %s failed: %s", slug, exc)
            return None
        return {"owner": owner.get("name") or slug, "slug": slug, "subtask": task, "text": text} if text else None

    contributions: List[Dict[str, Any]] = []
    if assignments:
        for c in await asyncio.gather(*[_run_owner(a["owner"], a["task"], i) for i, a in enumerate(assignments)]):
            if c:
                contributions.append(c)
                cost_tokens += max(60, len(c["text"]) // 4)
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "execute", "owner": c["slug"], "name": c["owner"],
                    "subtask": c["subtask"][:300], "contribution": c["text"][:700]})
        log.info("[agentic] execute room=%s owners=%d (parallel)", req.room_id, len(contributions))

    # 3. RECON-ON-TASKS — verify EACH owner's output addresses its subtask with
    #    grounded facts; re-run the gapped ones ONCE (in parallel) with the gap fed
    #    back, BEFORE the team debates. A thin/empty/fabricated contribution is
    #    caught here, not carried into the synthesis.
    if contributions:
        try:
            _verdicts = await _recon_tasks(req, contributions, _mk(lead, 1, toolless=True, model=_M_RECON))
            _redo = [i for i, c in enumerate(contributions)
                     if _verdicts.get(i) and not _verdicts[i]["ok"] and _verdicts[i]["gap"]]
            for i in _redo:
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "recon", "owner": contributions[i]["slug"], "ok": False,
                    "gap": _verdicts[i]["gap"][:200]})

            async def _redo_owner(i: int) -> Optional[Dict[str, Any]]:
                c = contributions[i]
                owner = next((p for p in participants if p.get("slug") == c["slug"]), participants[i % len(participants)])
                # SHARED-BLACKBOARD (partial): the re-running owner now SEES what the
                # other owners already gathered (trimmed) — so it builds on peers'
                # facts + fills the gap instead of re-fetching what's already on the
                # board. (Parallel owners can't see each other live; this 2nd pass can.)
                _peers = "\n".join(f"- {x['owner']}: {(x.get('text') or '')[:300]}"
                                   for j, x in enumerate(contributions) if j != i)[:2000]
                try:
                    async with _exec_sem:
                        agent = _mk(owner, _EXECUTE_MAX_ITERS, searcher=True, model=_M_EXECUTE)
                        txt = await _agent_reply_resilient(agent, (
                            f"{gathered_block}Your SUBTASK: {c['subtask']}\n\n"
                            f"Already on the room's board (teammates — do NOT re-fetch these):\n{_peers}\n\n"
                            f"Your earlier attempt had a GAP: {_verdicts[i]['gap']}\nClose ONLY that gap with "
                            f"grounded facts (use the board above for anything already found). {_gather_instructions}"))
                    return {"i": i, "text": txt} if txt else None
                except Exception as exc:  # noqa: BLE001
                    log.warning("[agentic] recon-redo %s failed: %s", c["slug"], exc)
                    return None
            if _redo:
                for r in await asyncio.gather(*[_redo_owner(i) for i in _redo]):
                    if r:
                        contributions[r["i"]]["text"] = r["text"]
                        cost_tokens += max(60, len(r["text"]) // 4)
                        await _emit_event(req.callback_url, req.turn_id, {
                            "t": "execute", "owner": contributions[r["i"]]["slug"], "name": contributions[r["i"]]["owner"],
                            "subtask": contributions[r["i"]]["subtask"][:300], "contribution": r["text"][:700], "reconned": True})
                log.info("[agentic] task-recon room=%s reran=%d/%d", req.room_id, len(_redo), len(contributions))
        except Exception as exc:  # noqa: BLE001 — recon best-effort, never fail the turn
            log.warning("[agentic] task-recon failed: %s", exc)

    exec_block = "\n\n".join(f"▸ {c['owner']} — {c['subtask']}:\n{c['text']}" for c in contributions) or "(no subtasks executed)"
    _deliver_spec = (
        "Output ONLY the deliverable content, ready to publish — NO process narration, NO placeholders. "
        "doc → begin with '# <a specific descriptive Title>' (NOT the room goal) then the FULL markdown "
        "document; sheet → markdown TABLE (header, '|---|', data rows); email → 'Subject: …' then the "
        "body; answer → the direct grounded answer. Use ONLY facts the team grounded; flag any "
        "UNVERIFIED item inline; never fabricate. Do NOT invent consent / policy / GDPR / approval "
        "gates the user did not ask for — the user's request IS the authorization; just produce it."
        # Room-template OUTPUT shape (e.g. DACI 'DECISION:' line, retrospective
        # WORKED/DIDN'T/CHANGE, lean-coffee per-topic + 'Carry forward', council
        # APPROVED/CONDITIONAL/REJECTED, standup YESTERDAY/TODAY/BLOCKERS).
        + (f" TEMPLATE OUTPUT RULE: {_synth_hint}" if _synth_hint else "")
    )
    # Room-template framing for how the lead approaches the task (debate / decision
    # / brainstorm / council / lean_coffee / retrospective / standup / review).
    _mode_pre = f"{_lead_hint}\n\n" if _lead_hint else ""

    # 3. DRAFT — a FRESH lead agent writes the deliverable. Must be separate from
    #    plan_agent: that one was told "reply STRICT JSON" and its memory keeps it
    #    in JSON mode → the draft (and the produced doc) would be the plan JSON blob,
    #    not the prose deliverable. Fresh agent = clean prose.
    lead_agent = _mk(lead, 6, model=_M_SYNTH)
    draft = await _agent_reply_resilient(lead_agent, (
        f"{_mode_pre}{gathered_block}USER TASK: {req.user_message}\n\n"
        f"Team gathered (grounded):\n{exec_block}\n\n"
        f"Write a first-pass FINAL DELIVERABLE (intended output '{intended_output}'). {_deliver_spec}"))
    cost_tokens += max(80, len(draft) // 4)
    if draft:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "line", "agent": lead.get("slug"), "kind": "lead", "content": draft})

    # 3b/3c. SWARM — bounded MULTI-ROUND debate→revise until convergence. Each
    #     round the reactors (skeptic lane opposes) challenge/support/extend the
    #     CURRENT draft via _run_reactor (peer-review broadcast in a MsgHub); if any
    #     high-confidence challenge stands, the lead REVISES and the next round
    #     re-examines the revision. The loop stops when a round raises no
    #     high-confidence challenge (converged) or the round cap is hit. This is the
    #     MiroFish multi-agent simulation — real R1-Rn convergence, not one pass.
    #     Reuses _run_reactor + the react/revise events the FE already renders;
    #     adds round / round_start / swarm_verdict markers (extra fields are
    #     ignored by older FE).
    lead_name = lead.get("name") or lead.get("slug") or "Lead"
    reactors = [p for p in participants if (p.get("slug") or "") != (lead.get("slug") or "")][:3]
    final_text = draft
    converged = False
    # Convergence by NOVELTY: skeptics keep re-raising the SAME unverifiable gap
    # (e.g. "still no 2026 margins") every round → that's not progress, it's the
    # same known gap. Track challenge "signatures" (significant-word sets); a round
    # that raises no NOVEL challenge (≥60% token overlap with a prior one) converges
    # — the open issues are already on the record. Stops burning rounds 2-3.
    _seen_sigs: List[set] = []

    def _novel_challenge(line: str) -> bool:
        w = {t for t in re.sub(r"[^a-z0-9 ]", " ", (line or "").lower()).split() if len(t) > 4}
        if not w:
            return False
        for s in _seen_sigs:
            inter = len(w & s)
            if inter and inter / max(1, min(len(w), len(s))) >= 0.6:
                return False
        _seen_sigs.append(w)
        return True

    if draft and reactors:
        ragents = [_mk(p, 6, toolless=True, model=_M_REACTOR) for p in reactors]  # tool-less → clean react JSON
        for rnd in range(1, _SWARM_MAX_ROUNDS + 1):
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "round_start", "round": rnd, "max_rounds": _SWARM_MAX_ROUNDS})
            challenges: List[Dict[str, Any]] = []
            async with MsgHub(participants=ragents):
                for p, ra in zip(reactors, ragents):
                    lane = p.get("_lane") or p.get("role_archetype") or "Communicator"
                    is_opp = "skeptic" in str(lane).lower() or "skeptic" in str(p.get("role_archetype") or "").lower()
                    rr = await _run_reactor(ra, req.user_message, final_text, lead_name, str(lane),
                                            is_opp, blackboard_context=gathered_block)
                    cost_tokens += 60
                    if rr.get("react"):
                        await _emit_event(req.callback_url, req.turn_id, {
                            "t": "react", "round": rnd, "agent": p.get("slug"),
                            "agreement": rr.get("agreement"), "line": rr.get("line"),
                            "confidence": rr.get("confidence"), "gap": rr.get("gap"),
                        })
                        if rr.get("agreement") == "challenge" and float(rr.get("confidence") or 0) >= _SWARM_CHALLENGE_CONF:
                            challenges.append(rr)
            new_challenges = [c for c in challenges if _novel_challenge(c.get("line", ""))]
            log.info("[swarm] room=%s round=%d/%d challenges=%d novel=%d",
                     req.room_id, rnd, _SWARM_MAX_ROUNDS, len(challenges), len(new_challenges))
            if not challenges:
                converged = True
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "swarm_verdict", "round": rnd, "converged": True})
                break
            if not new_challenges:
                # Only repeats of already-recorded gaps → no progress; converge.
                converged = True
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "swarm_verdict", "round": rnd, "converged": True, "reason": "no new challenges"})
                break
            challenges = new_challenges  # revise against the FRESH issues only
            # REVISE addressing THIS round's challenges; next round re-examines it.
            ch_block = "\n".join(f"- ({c.get('agreement')}, {c.get('confidence')}) {c.get('line')}"
                                 + (f" [gap: {c.get('gap')}]" if c.get("gap") else "") for c in challenges)
            final_text = await _agent_reply_resilient(lead_agent, (
                f"{_mode_pre}{gathered_block}USER TASK: {req.user_message}\n\n"
                f"Your draft:\n{final_text}\n\nThe team CHALLENGED it (round {rnd}):\n{ch_block}\n\n"
                f"REVISE the deliverable to address every challenge with grounded evidence (or honestly "
                f"flag what can't be resolved). {_deliver_spec}")) or final_text
            cost_tokens += max(80, len(final_text) // 4)
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "line", "round": rnd, "agent": lead.get("slug"), "kind": "revise", "content": final_text})
        if not converged:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "swarm_verdict", "converged": False, "rounds": _SWARM_MAX_ROUNDS,
                "note": "round cap reached with open challenges"})
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
        await _verify_and_emit(req, lead, final_text=final_text,
                               blackboard={"hit_count": len(contributions)}, model=_M_RECON)
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


def _hyper_engine() -> str:
    """Which room executor runs the turn. 'single' = the Groq native-tool-calling
    director (default); 'swarm' = the legacy AgentScope multi-agent pipeline
    (kept callable for rollback / A-B until cutover)."""
    return (os.environ.get("HYPER_ENGINE", "single") or "single").strip().lower()


def _derive_intended_output(user_message: str) -> str:
    """Deterministic intent → output kind (same guards the agentic planner applies).
    Drives the centralized producer; the director writes the actual content."""
    m = user_message or ""
    if _SEND_INTENT_RE.search(m) or re.search(r"[\w.+-]+@[\w.-]+\.\w+", m):
        return "email"
    if re.search(r"\b(spreadsheet|tracker|inventory|catalogue|catalog|sheet|table)\b", m, re.IGNORECASE):
        return "sheet"
    if re.search(r"\b(create|writ\w*|draft|build|make|generat\w*|compil\w*|prepare|document|report|doc)\b",
                 m, re.IGNORECASE):
        return "doc"
    return "answer"


async def _orchestrate_single_agent(
    req: "RoomTurnRequest",
    participants: List[Dict[str, Any]],
    lead: Dict[str, Any],
    enabled_connectors: List[str],
    started: float,
    room_template: str = "debate",
) -> RoomTurnResponse:
    """Single-director executor (HYPER_ENGINE=single). The Groq native-tool-calling
    director gathers (recall/connectors) + debates (the room's personas) + writes the
    synthesis; the EXISTING centralized producer + verify + approval-drain + seal turn
    it into the real artifact. Same FE event contract + tenant scope as the legacy
    swarm — only the executor changes. Reuses _produce_output / _verify_and_emit /
    _register_and_emit_approvals so dead-end, recipient resolution and HITL are intact."""
    conns = [str(c) for c in (enabled_connectors or [])]
    _m_recon = (getattr(req, "agentic_model", None)
                or os.environ.get("HYPER_MODEL_RECON") or "deepseek/deepseek-v4-flash")

    async def _emit(ev: Dict[str, Any]) -> None:
        await _emit_event(req.callback_url, req.turn_id, ev)

    # 1. RUN THE DIRECTOR — gather → debate → synthesis (emits gather/round_start/
    #    react/swarm_verdict/line, the same events the FE already renders).
    try:
        result = await run_director(
            user_message=req.user_message,
            user_id=req.user_id, org_id=req.org_id, project_id=req.project_id,
            participants=participants, room_template=room_template,
            room_goal=req.room_goal, enabled_connectors=conns, emit=_emit,
            director_model=getattr(req, "agentic_model", None),
        )
    except Exception as exc:  # noqa: BLE001 — never crash the turn
        log.warning("[single] director failed: %s", exc)
        await _emit({"t": "seal", "cost_tokens": 0, "status": "failed",
                     "duration_ms": int((time.time() - started) * 1000)})
        return RoomTurnResponse(ok=False, cost_tokens=0, status="failed")

    cost_tokens = int(result.get("cost_tokens") or 0)
    final_text = str(result.get("final_text") or "")
    transcript = result.get("transcript") or []
    gather_count = int(result.get("gather_count") or 0)

    # 2. PLAN — derive output kind + a plan dict the producer + verifier consume.
    intended_output = _derive_intended_output(req.user_message)
    done_txt = req.room_goal or req.user_message
    contributions = [
        {"owner": x.get("agent"), "subtask": f"debate round {x.get('round')}",
         "contribution": str(x.get("text") or "")}
        for x in transcript if isinstance(x, dict)
    ]
    if not contributions:
        contributions = [{"owner": lead.get("name") or lead.get("slug"),
                          "subtask": (req.user_message or "")[:200], "contribution": final_text}]
    await _emit({"t": "plan", "agent": lead.get("slug"), "intended_output": intended_output,
                 "done_criterion": done_txt, "steps": [c["subtask"] for c in contributions],
                 "assignments": {c["owner"]: c["subtask"] for c in contributions}})

    _vc: List[Dict[str, Any]] = []
    if intended_output == "email":
        try:
            _vc = await _resolve_recipients(req, req.user_message)
        except Exception as exc:  # noqa: BLE001
            log.warning("[single] resolve recipients failed: %s", exc)

    _PLAN_BY_TURN[req.turn_id] = {
        "intended_output": intended_output,
        "done_criterion": done_txt,
        "assignments": {c["owner"]: c["subtask"] for c in contributions},
        "execution": contributions,
        "verified_contacts": _vc,
    }

    # 3. PRODUCE (centralized, idempotent) → connector_logo + approval cards.
    try:
        await _produce_output(req, final_text)
    except Exception as exc:  # noqa: BLE001
        log.warning("[single] produce failed: %s", exc)
    artifacts = drain_artifacts()
    for art in artifacts:
        if art.get("url"):
            await _emit({"t": "connector_logo", "connector": art.get("connector"),
                         "url": art.get("url"), "title": art.get("title"),
                         "label": art.get("label") or "Open"})
    pending = drain_pending_writes()
    if pending:
        await _register_and_emit_approvals(req, pending)

    # 4. VERIFY + grounding gate (reuse; the inner _produce_output is idempotent).
    try:
        await _verify_and_emit(req, lead, final_text=final_text,
                               blackboard={"hit_count": gather_count}, model=_m_recon)
    except Exception as exc:  # noqa: BLE001
        log.warning("[single] verify failed: %s", exc)
    _vp = _PLAN_BY_TURN.get(req.turn_id) or {}
    _gv = _vp.get("verification") or {}
    status = "complete"
    if _vp.get("dead_end"):
        status = "blocked"
    elif _gv and not _gv.get("grounded_ok"):
        status = "escalated"

    await _emit({"t": "seal", "cost_tokens": cost_tokens, "status": status,
                 "duration_ms": int((time.time() - started) * 1000), "engine": "single"})
    resp = RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)
    if pending:
        resp.pending_approvals = [{k: v for k, v in r.items() if k != "descriptor"} for r in pending]
    if artifacts:
        resp.artifacts = [a for a in artifacts if a.get("url")]
    if isinstance(_gv, dict) and _gv:
        resp.verification = _gv
    log.info("[single] room=%s out=%s artifacts=%d status=%s cost=%d gather=%d tools=%d",
             req.room_id, intended_output, len(artifacts), status, cost_tokens, gather_count,
             int(result.get("tool_calls") or 0))
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

    # ── Single orchestrator — the agentic spine is the ONLY path. The
    #    deterministic plan/gather/execute/template pipeline was deleted (it was
    #    dead behind this once-conditional return). Room template + skeptic + trust
    #    above are display metadata on the router event; multi-round swarm behavior
    #    lives INSIDE _orchestrate_agentic (Phase 2 makes its debate truly R1-Rn).
    try:
        _ag_conns = await get_room_enabled_connectors(req.room_id, org_id=req.org_id)
    except Exception:  # noqa: BLE001
        _ag_conns = []
    # Executor swap point: 'single' = Groq native-tool-calling director (default),
    # 'swarm' = legacy AgentScope pipeline (rollback). Everything above this line
    # (tenant scope, participants, router/template/skeptic) is shared + unchanged.
    if _hyper_engine() == "single":
        return await _orchestrate_single_agent(req, participants, lead, _ag_conns, started, room_template)
    return await _orchestrate_agentic(req, participants, lead, _ag_conns, started, room_template)

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
