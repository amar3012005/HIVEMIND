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
import uuid
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

import httpx
from .ai_gateway import post as gateway_post
from agentscope.agent import ReActAgent
from agentscope.message import Msg
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .agents.agentscope_factory import build_react_agent
from .agents.agentscope_tools import (
    begin_turn_write_gate,
    drain_artifacts,
    drain_pending_writes,
    execute_pending_write,
    queue_email_approval,
    record_artifact,
    register_delegate_to_tool,
    register_load_skill_tool,
    reset_turn_outputs,
    set_approval_rules,
    set_current_turn_id,
    set_turn_provenance,
)
from .bootstrap_client import fetch_bootstrap, report_eval, report_metrics
from .config import get_settings
from .governor import kill_switch_active, kill_switch_reason, outbound_cap, turn_token_cap
from .hyper.execution_profiles import (
    DEFAULT_PROFILE_ID, get_execution_profile, default_execution_profile,
    profile_registry_manifest,
)
from .hyper.model_policy import HYPER_FAST_MODEL, canonical_hyper_model
from .db import (
    get_org_approval_rules,
    get_permanent_lead_id,
    get_permanent_skeptic_id,
    get_room_enabled_connectors,
    get_room_quality_mode,
    get_room_sim_mode,
    get_room_sim_agents,
    get_room_evo_mode,
    get_recent_turn_context,
    get_employee_playbooks_map,
    update_employee_playbook,
    get_room_playbook,
    get_room_journal,
    get_room_instructions,
    get_connected_gmail,
    has_connected_gmail,
    update_room_playbook,
    append_room_journal_entry,
    get_company_name,
    get_room_template,
    get_trust_scores,
    get_turn_seq,
    list_employees_by_ids,
    validate_work_room_execution,
    persist_work_room_progress,
    persist_hyper_turn_outbox_event,
    mark_hyper_turn_outbox_delivered,
    get_work_room_execution_profile,
    persist_work_room_execution_profile,
)
from .hivemind_client import (
    connector_exec_emulated,
    google_exec_emulated,
    list_canon_emulated,
    org_members_emulated,
    recall_emulated,
    runtime_connectors_emulated,
)
from .hyper.engine import (Director, _openrouter_chat, run_director, evo_reflect_and_merge, run_mention_reply,
                           make_journal_entry, _persona_fields, _evo_recall, _needs_reasoning_disabled,
                           _fallback_model_for)

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
    "hivemind_web_crawl",
    "hivemind_seo_audit",
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
# Real incident (2026-08-20): a manual chat follow-up in an already-open room
# hung forever on "selecting lead and reactors" with zero error surfaced. Root
# cause: `_orchestrate` starts with several sequential asyncpg pool.acquire()
# calls (db.py) that carry NO timeout — if the process-wide pool (max_size=8)
# is saturated by other in-flight work, that first DB read blocks
# indefinitely, and nothing upstream of it (the fire-and-forget dispatch in
# control-plane, the goalkeeper's plain `await`) ever times out either. This
# is a generous SAFETY NET, not a new constraint on normal turns — a healthy
# round finishes in seconds to low minutes; this only fires when something is
# truly stuck, and turns it into a real, user-visible terminal state instead
# of infinite silence.
HYPER_ROOM_ROUND_DEADLINE_SECONDS = float(os.environ.get("HYPER_ROOM_ROUND_DEADLINE_SECONDS", "240"))

# Agentic task engine (dual-engine, 2026-08-13): default-off. When on, the
# planner may route a turn to a real multi-step ReAct loop (lead agent +
# delegate_to specialist sub-agents) instead of the fixed plan-once gather→
# debate→synth pipeline. Off means the branch in engine.py never fires
# (agentic_task_hook stays None) — zero behavior change to any existing room.
HYPER_AGENTIC_ENGINE = os.environ.get("HYPER_AGENTIC_ENGINE", "").lower() == "true"
# Separate, higher iteration budget than HYPER_ROOM_AGENT_MAX_ITERS (3) — a
# real multi-step task (discover → act → verify → maybe delegate) needs more
# room than the shared default, which was tuned for the narrow direct-answer
# hook's single-question use.
HYPER_AGENTIC_MAX_ITERS = int(os.environ.get("HYPER_AGENTIC_MAX_ITERS", "18"))
# How many subtasks the lead may delegate to specialist sub-agents in one
# turn — a hard ceiling so a runaway plan can't fan out unbounded real
# sub-agent loops (each one is its own LLM+tool cost).
HYPER_AGENTIC_MAX_DELEGATIONS = int(os.environ.get("HYPER_AGENTIC_MAX_DELEGATIONS", "4"))

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

# Phase 6 fix — goalkeeper seal ordering. The FE's SSE closes ON `seal`, and the
# control-plane marks the turn sealed on the FIRST seal event — so a goalkeeper
# re-round after a per-round seal streamed into a CLOSED pipe (its artifact only
# appeared on refresh) and the second seal was dropped. While a turn_id is in
# _GK_ACTIVE, the single-agent handler STASHES its seal here instead of emitting;
# the goalkeeper emits ONE final seal (total cost + true duration) after the last
# round. Same-process safe (the loop awaits the handler). Bounded.
_GK_ACTIVE: Dict[str, bool] = {}
_SEAL_BY_TURN: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_SEAL_BY_TURN_CAP = 200


def _merge_goalkeeper_seal(previous: Dict[str, Any], current: Dict[str, Any]) -> Dict[str, Any]:
    """Keep the latest lifecycle state with cumulative per-round token evidence."""
    merged = dict(current)
    prior = previous or {}
    merged_tok_by = dict(prior.get("tok_by") or {})
    for bucket, value in (current.get("tok_by") or {}).items():
        merged_tok_by[bucket] = int(merged_tok_by.get(bucket, 0) or 0) + int(value or 0)
    for field in ("cost_tokens", "tokens_in", "tokens_out", "tokens_cached"):
        merged[field] = int(prior.get(field, 0) or 0) + int(current.get(field, 0) or 0)
    merged["tok_by"] = merged_tok_by
    return merged


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
            # Draft content → the FE's in-app Preview/edit/one-click-send popup
            # (no Gmail redirect needed). Bounded; absent for non-email writes.
            "to": rec.get("to"), "subject": rec.get("subject"),
            "body_md": str(rec.get("body_md") or "")[:20000] or None,
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
    prefer_maker: bool = False,
) -> Optional[Dict[str, Any]]:
    """Resolve a fixed per-room lead, or fall back to the first eligible agent.
    prefer_maker (maker kinds — outreach/content/research, or any produce output):
    a MAKER leads, not a Skeptic — a deliverable room needs a writer at the helm,
    not a challenger. Skeptic-lane agents drop to reactor/reviewer only."""
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
    if prefer_maker:
        makers = [p for p in eligible if "skeptic" not in str(p.get("_lane") or p.get("role_archetype") or "").lower()]
        if makers:
            eligible = makers
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
_EXECUTION_IDENTITY_BY_TURN: Dict[str, Dict[str, Any]] = {}


def _get_callback_client() -> httpx.AsyncClient:
    global _CALLBACK_CLIENT
    if _CALLBACK_CLIENT is None:
        _CALLBACK_CLIENT = httpx.AsyncClient(timeout=10.0)
    return _CALLBACK_CLIENT


async def _emit_event(callback_url: str, turn_id: str, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """POST an event back to the control-plane append hook.

    Every event carries a stable delivery id so a response lost after the
    control-plane commit can be retried safely. High-value boundary events are
    retried for a bounded period; dropping a final report or seal leaves a
    completed Room looking permanently busy even though all LLM work finished.
    """
    if not callback_url:
        return None
    settings = get_settings()
    headers = {
        "X-API-Key": settings.hivemind_master_api_key or "",
        "Content-Type": "application/json",
    }
    event.setdefault("event_id", str(uuid.uuid4()))
    identity = _EXECUTION_IDENTITY_BY_TURN.get(turn_id)
    outbox_persisted = bool(identity) and await persist_hyper_turn_outbox_event(turn_id, event)
    body = {"turn_id": turn_id, "event": event}
    if identity:
        body["execution_identity"] = identity
    critical = str(event.get("t") or "") in {
        "final_report", "seal", "connector_logo", "artifact_candidate", "approval_request",
        "approval_required", "campaign_bundle", "campaign_bundle_partial", "runtime_stage_result",
        "room_phase_result", "work_order_result",
    }
    attempts = 6 if critical else 1
    client = _get_callback_client()
    last_error: Optional[BaseException] = None
    for attempt in range(attempts):
        try:
            response = await client.post(callback_url, headers=headers, content=json.dumps(body))
            response.raise_for_status()
            if outbox_persisted:
                await mark_hyper_turn_outbox_delivered(turn_id, str(event["event_id"]))
            try:
                payload = response.json()
                return payload if isinstance(payload, dict) else None
            except Exception:  # noqa: BLE001
                return None
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt + 1 < attempts:
                await asyncio.sleep(min(0.5 * (2 ** attempt), 5.0))
    log.warning(
        "hyper-rooms event delivery exhausted type=%s turn=%s attempts=%d: %s",
        event.get("t"), turn_id, attempts, last_error,
    )
    return None


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


async def _build_lead_task_agent(
    room_id: str,
    lead: Dict[str, Any],
    participants: List[Dict[str, Any]],
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    project_id: Optional[str] = None,
    room_kind: str = "",
) -> ReActAgent:
    """Build the lead's real ReAct agent for the AGENTIC TASK ENGINE
    (dual-engine, 2026-08-13, flag-gated HYPER_AGENTIC_ENGINE) — a genuinely
    autonomous multi-step loop for turns the planner routes with
    execution_engine=="agentic", instead of the fixed plan-once gather→
    debate→synth pipeline every other turn still uses unchanged.

    Same full HIVEMIND toolkit + connector reach as `_build_agent_for_room`,
    PLUS:
      - a real AgentScope `PlanNotebook` (create_plan / update_subtask_state
        / finish_subtask) so the lead can decompose the task instead of
        guessing everything in one shot;
      - a `delegate_to` tool so the lead can hand a bounded subtask to a
        real teammate's OWN agent (their persona, their tools/connectors,
        their own reasoning loop) instead of doing everything alone or
        faking their voice with a single-shot debate-style text call;
      - a `load_skill` tool over the room's OWN domain-pack skill catalog
        (campaign/seo/marketing/outreach/branding/fundraising/research/
        product/design/legal_finance) — the SAME strategy playbooks the
        debate pipeline already uses, loaded on demand mid-task instead of
        dumped upfront. No-op when room_kind has no domain pack.

    Connectors: the room-level toggle is often empty (never set via the FE
    channel-picker for a free-text ask) even when the ORG genuinely has real
    connectors authorized. Union both so the agent sees everything actually
    available and decides for itself what to equip — never assume a fixed
    per-domain toolbelt.

    NOT cached like `_build_agent_for_room` (`_ROOM_AGENTS`) — each agentic
    task run gets a fresh plan notebook; caching would leak one turn's plan/
    subtask state into the next.
    """
    from agentscope.plan import PlanNotebook
    try:
        room_connectors = await get_room_enabled_connectors(room_id, org_id=org_id)
    except Exception:  # noqa: BLE001 — never fail the turn over connectors
        room_connectors = []
    try:
        connector_state = await runtime_connectors_emulated(user_id=user_id, org_id=org_id)
        org_connectors = [str(c).strip().lower() for c in (connector_state.get("connectors") or []) if str(c).strip()]
    except Exception:  # noqa: BLE001
        org_connectors = []
    emp_connectors = list(dict.fromkeys([*room_connectors, *org_connectors]))
    boot = {b["id"]: b for b in await fetch_bootstrap()}
    boot_emp = boot.get(lead["id"], {}) or {}
    api_key = boot_emp.get("api_key") or ""
    merged = {
        **lead,
        "tools": DEFAULT_HYPER_TOOLS + WEB_INTEL_TOOLS,
        "connectors": emp_connectors,
        "max_iters": HYPER_AGENTIC_MAX_ITERS,
        "hyper": boot_emp.get("hyper"),
        "active_prompt_version": boot_emp.get("active_prompt_version"),
    }
    agent = build_react_agent(
        merged, api_key, user_id=user_id, org_id=org_id, project_id=project_id,
        plan_notebook=PlanNotebook(),
    )

    async def _build_sub_agent(target_row: Dict[str, Any]) -> ReActAgent:
        # A delegated specialist runs its own bounded reply with its own
        # persona/tools — reuse the normal per-room CACHED agent rather than
        # building a second plan-notebook lead; a sub-agent answers one
        # subtask, it doesn't need to decompose further itself.
        return await _build_agent_for_room(
            room_id, target_row, user_id=user_id, org_id=org_id, project_id=project_id,
        )

    register_delegate_to_tool(agent.toolkit, participants, _build_sub_agent, HYPER_AGENTIC_MAX_DELEGATIONS)
    register_load_skill_tool(agent.toolkit, room_kind)
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
    # Strip leaked reasoning-model chain-of-thought so the bubble shows only
    # the final humanised persona answer — never the model's private planning
    # ("We need to respond as Theo, concise, 3-5 sentences..."). Two shapes:
    #   • <think>…</think>  — deepseek-r1 / qwen (OpenRouter path)
    #   • Harmony channel markers — gpt-oss analysis channel if reasoning_format
    #     didn't fully suppress it. Keep only the `final` channel payload.
    if "<think" in text.lower():
        text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE).strip()
        # Unclosed <think> (truncated stream) → drop everything up to it.
        text = re.sub(r"^[\s\S]*?<think>[\s\S]*$", "", text, flags=re.IGNORECASE).strip()
    if "<|channel|>" in text or "<|message|>" in text:
        # Prefer the explicit final-channel payload if present.
        m = re.search(r"<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|$)", text)
        if m:
            text = m.group(1).strip()
        else:
            # No final marker — strip the analysis block and any residual markers.
            text = re.sub(r"<\|channel\|>analysis<\|message\|>[\s\S]*?(?=<\||$)", "", text)
            text = re.sub(r"<\|[^>]*\|>", "", text).strip()
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
        "model": canonical_hyper_model(os.environ.get("HYPER_WEB_INTEL_MODEL", HYPER_FAST_MODEL)),
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


def _fmt_block(value: Any, indent: str = "") -> str:
    """Render a strategy value as readable markdown lines (no raw dict/list dumps)."""
    if value in (None, "", [], {}):
        return ""
    if isinstance(value, (list, tuple)):
        out = []
        for item in list(value)[:12]:
            if isinstance(item, dict):
                head = str(item.get("name") or item.get("segment") or item.get("channel")
                           or item.get("competitor") or item.get("motion") or item.get("subject")
                           or item.get("title") or "").strip()
                rest = "; ".join(f"{k}: {v}" for k, v in item.items()
                                 if v not in (None, "", [], {}) and str(v) != head)
                out.append(f"{indent}- **{head}** — {rest}" if head else f"{indent}- {rest}")
            else:
                out.append(f"{indent}- {item}")
        return "\n".join(out)
    if isinstance(value, dict):
        lines = []
        for k, v in list(value.items())[:12]:
            if v in (None, "", [], {}):
                continue
            label = k.replace('_', ' ').title()
            if isinstance(v, (list, tuple, dict)):
                # Nested collections get their own sub-bullets — never a raw repr.
                lines.append(f"{indent}- **{label}**")
                lines.append(_fmt_block(v, indent + "  "))
            else:
                lines.append(f"{indent}- **{label}** — {v}")
        return "\n".join(line for line in lines if line)
    return f"{indent}{value}"


def _keystone_strategy_markdown(data: Dict[str, Any]) -> str:
    """The marketing strategy read as the keystone that drives every downstream motion."""
    sections: List[str] = []
    if data.get("niche_wedge"):
        sections.append(f"**The wedge** — {data['niche_wedge']}")
    if data.get("positioning"):
        sections.append(f"**Positioning** — {data['positioning']}")
    for label, field in (("ICP segments (drives prospect discovery)", "audience"),
                         ("Competitor plan (positioning vs named rivals)", "competitor_plan"),
                         ("Offer framing", "offer_framing"),
                         ("Channel mix (drives the campaign)", "channel_mix")):
        block = _fmt_block(data.get(field))
        if block:
            sections.append(f"### {label}\n{block}")
    motions = data.get("recommended_next_motions")
    if motions:
        sections.append("### Next motions — the executable bridge")
        if isinstance(motions, dict):
            for lane, title in (("outreach_emails", "Outreach emails (drafted per prospect · approval before send)"),
                                ("tara_calls", "TARA calls (proposed per warm prospect · approval before dial)"),
                                ("campaign", "Campaign (awareness motions)")):
                block = _fmt_block(motions.get(lane), indent="  ")
                if block:
                    sections.append(f"**{title}**\n{block}")
            extra = {k: v for k, v in motions.items()
                     if k not in ("outreach_emails", "tara_calls", "campaign") and v not in (None, "", [], {})}
            if extra:
                sections.append(_fmt_block(extra))
        else:
            sections.append(_fmt_block(motions))
    for label, field in (("Expected outcome", "expected_outcome"), ("Risks", "risks"),
                         ("Measures", "measures"), ("Dependencies", "dependencies")):
        block = _fmt_block(data.get(field))
        if block:
            sections.append(f"### {label}\n{block}")
    leftover = {k: v for k, v in data.items() if k not in {
        "niche_wedge", "positioning", "audience", "competitor_plan", "offer_framing",
        "channel_mix", "recommended_next_motions", "expected_outcome", "risks",
        "measures", "dependencies"} and v not in (None, "", [], {})}
    if leftover:
        sections.append("### Also recorded\n" + _fmt_block(leftover))
    return "\n\n".join(sections)


def _runtime_phase_report(*, user_message: str, contract: Dict[str, Any], result: Dict[str, Any],
                          room_goal: str = "", gaps: Optional[List[str]] = None) -> Dict[str, Any]:
    """Readable report for a Runtime-driven (HQ work-order) phase.

    Runtime phases return machine artifacts to Core's predicate engine, but the user
    still needs to SEE what the Room concluded. Render the phase's own summary plus a
    compact, human-readable rendering of each persisted artifact — no second model call,
    nothing invented: every line comes from what the Room already produced.
    """
    artifacts = [a for a in (contract.get("artifacts") or []) if isinstance(a, dict)]
    parts: List[str] = []
    summary = str(contract.get("summary") or "").strip()
    if summary:
        parts.append(summary)
    for artifact in artifacts:
        key = str(artifact.get("key") or "artifact")
        data = artifact.get("data")
        parts.append(f"\n## {key.replace('_', ' ').title()}")
        # The marketing strategy is the KEYSTONE: it drives prospect discovery, outreach
        # email drafts, TARA call proposals and the campaign. Render it in that reading
        # order — wedge first, then who, then who we beat, then how we reach them, then
        # the executable motions — so the operator sees the through-line instead of an
        # alphabet soup of dict keys.
        if key == "marketing_strategy" and isinstance(data, dict):
            parts.append(_keystone_strategy_markdown(data))
            continue
        if isinstance(data, dict):
            for field, value in data.items():
                if value in (None, "", [], {}):
                    continue
                label = str(field).replace("_", " ").title()
                if isinstance(value, (list, tuple)):
                    rendered = "\n".join(
                        f"- {v if not isinstance(v, dict) else '; '.join(f'{k}: {x}' for k, x in v.items())}"
                        for v in value[:12])
                    parts.append(f"**{label}**\n{rendered}")
                elif isinstance(value, dict):
                    rendered = "\n".join(f"- {k}: {v}" for k, v in list(value.items())[:12])
                    parts.append(f"**{label}**\n{rendered}")
                else:
                    parts.append(f"**{label}** — {str(value)[:1200]}")
        elif data:
            parts.append(str(data)[:2000])
    if gaps:
        parts.append("\n## Open gaps\n" + "\n".join(f"- {g}" for g in gaps[:8]))
    body = "\n\n".join(p for p in parts if p).strip() or "The Room returned no readable content for this phase."
    sources = [s for s in (result.get("sources") or []) if isinstance(s, dict)][:8]
    return {
        "t": "final_report",
        "title": str(contract.get("title") or user_message or "Runtime work order")[:200],
        "template": "runtime_phase",
        "status": "complete" if not gaps else "gaps",
        "verdict": None,
        "room_goal": room_goal or "",
        # Field names MUST match _build_final_report exactly — the report card reads
        # `content`. Emitting `markdown` made the card mount with an empty body, which is
        # why a Runtime workload showed no report even though the final_report line WAS
        # emitted and persisted (verified: report_lines=1 on the last runtime turns).
        "content": body,
        "summary": (summary or body)[:4000],
        "weighted_score": None,
        "goal_progress": None,
        "project_memory_hits": 0,
        "project_scoped": False,
        "evidence": [],
        "sources": sources,
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
        # The synthesis is already the polished report. Re-wrapping it with the
        # question, room goal, another "Final report" heading and a second
        # conclusion produced the duplicated brochure visible in the Room.
        # Keep progress/evidence as structured fields and render the report once.
        "content": (final_text or "").strip(),
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
        resp = await gateway_post(client, "https://api.groq.com/openai/v1/chat/completions", headers=headers, json=payload)
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


class _HivemindWebPrimary(Exception):
    """Sentinel: route web-intel to the HIVEMIND path (not an error)."""


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
    # Canonical (owner "no groq" rule, 2026-07-23): HIVEMIND web tools are PRIMARY —
    # the block below runs hivemind_web_search (web_search_emulated) + recall. groq/compound
    # only when HYPER_WEB_INTEL_PROVIDER=groq (reversible). Default = hivemind.
    _use_groq_web = os.environ.get("HYPER_WEB_INTEL_PROVIDER", "hivemind").strip().lower() == "groq"
    try:
        if not _use_groq_web:
            raise _HivemindWebPrimary()
        payload = await _run_groq_compound_web_intel(
            req=req,
            lead=lead,
            blackboard=blackboard,
            memory_context=memory_context,
            room_template=room_template,
        )
    except Exception as groq_exc:  # noqa: BLE001
        if not isinstance(groq_exc, _HivemindWebPrimary):
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




# ─── Pydantic ──────────────────────────────────────────────────────────


class RoomTurnRequest(BaseModel):
    # P1 seam contract: forward-tolerant — silently ignore unknown fields from a newer
    # caller (version skew never 400s), and accept an optional negotiated schema_version.
    model_config = ConfigDict(extra="ignore")
    schema_version: Optional[str] = None
    room_id: str
    turn_id: str
    user_id: str
    org_id: str
    user_message: str = Field(min_length=1, max_length=8000)
    # Campaign callers keep the Room-visible request human-readable. The
    # orchestration contract stays private and is never rendered as a user turn.
    display_message: Optional[str] = Field(default=None, max_length=8000)
    execution_context: Optional[str] = Field(default=None, max_length=16000)
    participant_ids: List[str] = Field(default_factory=list)
    callback_url: Optional[str] = None
    flyby_decision: Optional[str] = None
    flyby_spec: Optional[Dict[str, Any]] = None
    # Project scope: when set, every agent recall/save in this turn is scoped to
    # the project HIVEMIND so the room stays about that project.
    project_id: Optional[str] = None
    room_goal: Optional[str] = None
    # Explicit ownership boundary. Human Work Rooms remain domain-neutral; only
    # Runtime/Company Rooms use the specialist routing selected by a playbook.
    room_mode: Optional[str] = None
    # Typed task context. Campaign callers require this to bypass generic report
    # routing; campaign_id/brief are metadata only and never authorize a write.
    task_tag: Optional[str] = None
    campaign_id: Optional[str] = None
    campaign_brief: Optional[Dict[str, Any]] = None
    # Additional Population-Sim toggle ("on" runs it). Per-turn override; else the room's
    # stored sim_mode is read. Optional so existing callers are unaffected (additive).
    sim_mode: Optional[str] = None
    sim_agents: Optional[int] = None  # population-sim cast size (10-100); per-turn override
    # Self-evolving employees toggle ("on" reflects+injects per-agent playbooks). Per-turn override;
    # else the room's stored evo_mode is read. Optional (existing callers unaffected, additive).
    evo_mode: Optional[str] = None
    # Phase 4 — write-approval policy: "ask" holds side-effectful connector
    # writes for the user's approval; "auto" lets them fire. When unset, the
    # gate defaults to "ask" if the room has connectors enabled, else "auto".
    write_policy: Optional[str] = None
    # Phase-0 eval only: override the agentic orchestrator model for this turn
    # (e.g. "openai/gpt-oss-120b", "llama-3.3-70b-versatile"). Master-key endpoint
    # only; when unset the env default applies. Lets the model battery A/B without
    # restarting the sidecar.
    agentic_model: Optional[str] = None
    # Run-wide output language from the FE navbar i18n toggle (e.g. "de", "fr").
    # When set, the final report is written entirely in this language. Optional.
    language: Optional[str] = None
    # Immutable identity for human Work Room turns. Historical callers remain
    # readable; every new control-plane dispatch supplies this contract.
    execution_identity: Optional[Dict[str, Any]] = None


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
    # Present only for an HQ-delegated Room turn. Ordinary human turns keep the
    # exact historical response shape (unset fields are omitted by callers).
    result: Optional[Dict[str, Any]] = None
    summary: Optional[str] = None
    usage: Optional[Dict[str, int]] = None
    # Runtime audit field. Human Work Rooms may omit it; Runtime-owned turns
    # report how much of the playbook-owned attempt budget was consumed.
    rounds_used: Optional[int] = None


class ApprovalDecisionRequest(BaseModel):
    # P1 seam contract: forward-tolerant — silently ignore unknown fields from a newer
    # caller (version skew never 400s), and accept an optional negotiated schema_version.
    model_config = ConfigDict(extra="ignore")
    schema_version: Optional[str] = None
    approval_id: str
    decision: str  # "approve" | "deny"


# ─── Meeting-template overlays (Phase 4 PR-3) ──────────────────────────
# Eight AI-Company-inspired templates. Each one injects a prompt prelude
# into the lead/synth pipeline so the same orchestrator flow yields
# topic-appropriate behaviour (e.g. retrospective wants "what worked / what
# didn't / actions", standup wants status report, etc.). Phase-machine
# stays the SAME — only the framing differs. Avoids 8 forked orchestrators.


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


# Standing, orthogonal probes for the company brief — recall the org's identity, people,
# customers, and direction so the brief grounds a turn even when the user's query alone
# wouldn't surface them. Fanned out concurrently with the query (query-first, so query hits
# win dedup ties). NOTE: this was previously undefined → _build_company_brief always raised
# NameError → empty brief everywhere; defining it makes the brief actually load.
_COMPANY_BRIEF_PROBES = [
    "company overview — what this organisation does, its products, services, and market",
    "founders, leadership, key people, and team",
    "customers, clients, partners, and target market",
    "goals, strategy, priorities, and current initiatives",
]

# Per-(org, project) TTL cache for the company brief. The brief is STANDING identity
# (who the org is / products / customers / goals) — it changes slowly, but was rebuilt
# via a 5-probe recall fan-out on EVERY turn, sitting on the critical path (up to 8s
# before the director starts). Within the TTL every turn reuses it: latency ~0, recall
# load -5 probes/turn. Query-specific facts still arrive fresh via the gather plan's
# own recalls, so staleness only affects the standing block. Empty briefs (recall
# outage) are never cached — the next turn retries.
_BRIEF_CACHE: Dict[str, tuple] = {}
# Standing identity changes slowly — 30min keeps sporadic rooms warm (was 600s: any
# turn >10min after the last re-paid the 5-probe fan-out).
_BRIEF_TTL_S = max(60, int(os.environ.get("HYPER_BRIEF_TTL_S", "1800") or "1800"))


async def _build_company_brief(query: str, user_id: str, org_id: str,
                               api_key: str = "", max_memories: int = 25,
                               project_id: Optional[str] = None) -> str:
    """Fan out orthogonal recalls (query + company/people/customers/goals),
    dedup by memory id/title, compress to ~25 snippets, return a standing
    COMPANY CONTEXT block. Recalls via master+emulation (recall_emulated) so
    it reaches the org brain even when the rotated lead has no minted key.
    Best-effort: returns '' on any failure so the turn still runs."""
    _ck = f"{org_id}|{project_id or ''}"
    _hit = _BRIEF_CACHE.get(_ck)
    if _hit and (time.time() - _hit[0]) < _BRIEF_TTL_S:
        return _hit[1]
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
    # recall-latency to the pre-round phase, not five. The org-canon lane rides
    # the same gather: tag-filtered PINNED company canon (identity/mission/
    # positioning/ICP/team filed by onboarding) that is GUARANTEED into the
    # brief regardless of vector scores — a dense KB corpus can't bury it.
    probe_results_and_canon = await asyncio.gather(
        list_canon_emulated(user_id=user_id, org_id=org_id, api_key=api_key, limit=8),
        *[_probe(p) for p in probes],
    )
    canon_rows = probe_results_and_canon[0] or []
    probe_results = probe_results_and_canon[1:]
    canon_lines: List[str] = []
    for r in canon_rows:
        mid = str(r.get("id") or r.get("memory_id") or "")
        title = (r.get("title") or "").strip()
        content = (r.get("content") or "").replace("\n", " ").strip()
        if not content:
            continue
        if mid:
            seen_ids.add(mid)
        if title:
            seen_titles.add(title.lower())
        canon_lines.append(f"- {content[:260]}{'…' if len(content) > 260 else ''}")
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
    if not collected and not canon_lines:
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
    if not lines_out and not canon_lines:
        return ""
    log.info("[brief] built company context: %d memories from %d probes + %d canon",
             len(lines_out), len(probes), len(canon_lines))
    _canon_block = (
        "COMPANY CANON — the authoritative identity of this organisation "
        "(mission, positioning, ICP, team), filed at onboarding. This overrides "
        "any conflicting stray fact below:\n" + "\n".join(canon_lines) + "\n\n"
    ) if canon_lines else ""
    _brief = (
        _canon_block +
        "COMPANY CONTEXT — standing facts about this business, its people, "
        "products, customers and goals. Ground every claim in these; this is "
        "WHO and WHAT you are reasoning about:\n"
        + "\n".join(lines_out)
        + "\n"
    )
    _BRIEF_CACHE[_ck] = (time.time(), _brief)
    if len(_BRIEF_CACHE) > 512:  # bound: multi-tenant sidecar, never grow unbounded
        _BRIEF_CACHE.pop(next(iter(_BRIEF_CACHE)), None)
    return _brief


# ─── Main orchestrator ─────────────────────────────────────────────────


# Phase 1 — output types the lead may pick from user intent.
_PLAN_OUTPUTS = {"email", "doc", "sheet", "slack", "ticket", "crm", "decision", "answer"}

# Explicit "send a message" intent — only THESE phrasings justify an `email`
# output. A planning/strategy question that merely names a person does not.
_SEND_INTENT_RE = re.compile(
    r"\b(e-?mail|send|sent|sending|reply|replies|replying|respond|responding|"
    r"forward|cc\b|draft(?:ing)?\s+(?:an?\s+)?(?:e-?mail|mail|message|note|reply)|"
    r"write\s+(?:back|to|an?\s+(?:e-?mail|mail|note|message))|"
    # softer-but-clear outreach phrasings (precision-guarded so nouns don't misfire):
    r"reach(?:ing)?\s+out|follow[\s-]?up\s+with|following\s+up\s+with|get(?:ting)?\s+in\s+touch|"
    r"outreach|cold[\s-]?email|"
    r"shoot\s+(?:an?\s+)?(?:e-?mail|mail|message|note)|"
    r"drop\s+(?:an?\s+)?(?:line|note|message|mail)\s+to|"
    # ping/notify/message/contact only when followed by @ or a Capitalized name/org "
    # (inline case-sensitive (?-i:[A-Z]) so the global IGNORECASE doesn't defeat the guard):
    r"(?:ping|notify|message|contact)\s+(?:@\w+|(?-i:[A-Z]\w*))|"
    r"intro(?:duce)?\b[^.\n]{0,30}?\bto\b)\b",
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


def _apply_outreach_contract(
    verdict: Dict[str, Any], plan: Dict[str, Any], pending: List[Dict[str, Any]],
) -> Dict[str, Any]:
    outreach = plan.get("outreach_request") if isinstance(plan.get("outreach_request"), dict) else None
    if not outreach:
        return verdict
    raw_requested = outreach.get("requested_count")
    requested = (
        max(1, min(50, int(raw_requested)))
        if raw_requested is not None else None
    )
    metrics = plan.get("outreach_metrics") if isinstance(plan.get("outreach_metrics"), dict) else {}
    pending_count = sum(
        1 for item in pending
        if "gmail" in str(item.get("label") or item.get("capability") or "").lower()
    )
    observed = {
        "discover": int(metrics.get("prospects_discovered") or 0),
        "persist": int(metrics.get("prospects_persisted") or 0),
        # A body printed in a report is not a durable email draft or delivery.
        "draft": pending_count,
        # Pending approval proves preparation, never delivery. Delivery requires
        # a durable provider receipt owned by the checkpointed lifecycle.
        "deliver": 0,
        "monitor": 0,
    }
    missing = []
    for phase in ("discover", "persist", "draft", "deliver", "monitor"):
        if outreach.get(phase) is not True:
            continue
        if requested is not None and observed[phase] < requested:
            missing.append(f"outreach lifecycle {phase} incomplete: {observed[phase]}/{requested}")
        elif requested is None and observed[phase] < 1:
            missing.append(f"outreach lifecycle {phase} produced no verified result")
    verdict["outreach_contract"] = outreach
    verdict["outreach_observed"] = observed
    if missing:
        verdict["met"] = False
        verdict["artifact_ok"] = False
        verdict["gaps"] = list(dict.fromkeys([*(verdict.get("gaps") or []), *missing]))[:12]
    return verdict


async def _verify_turn(
    req: "RoomTurnRequest",
    lead: Dict[str, Any],
    *,
    final_text: str,
    tool_call_counts: Optional[Dict[str, int]] = None,
    blackboard: Optional[Dict[str, Any]] = None,
    model: Optional[str] = None,
    company_name: str = "",
    company_context_missing: bool = False,
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
        "source_evidence_count": len((blackboard or {}).get("facts") or []),
        "company_name": company_name or None,
        "company_context_missing": bool(company_context_missing),
        # Keep each authoritative source useful enough to verify product and
        # company claims. The old 200-character slice routinely cut the
        # company brief before its product definitions appeared.
        "gathered_facts": [str(f)[:2000] for f in ((blackboard or {}).get("facts") or [])][:24],
        "final_excerpt": (final_text or "")[:8000],
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
        '  "unsupported_claims": ["<exact unsafe claim or empty>"],\n'
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
        "source evidence and names only real team members — not that every step is already done.\n"
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
        "items are unverified. 'Backing' means an exact `gathered_facts` entry (what the team "
        "actually read this turn from company context, memory, web, or connectors). A count of memory "
        "hits is never evidence, and agent work results or debate assertions are never evidence. A claim backed "
        "by a gathered_fact (e.g. an email body, poem, thread, doc the team read) is GROUNDED even if "
        "it is not a memory_hit — connector reads ARE evidence. DECISION RULE: grounded_ok=TRUE unless "
        "the text states a specific fact AS TRUE that BOTH (a) has NO backing in a "
        "gathered_fact / tool result AND (b) is NOT labeled "
        "UNVERIFIED / unknown / 'not found'. The COUNT of UNVERIFIED-labeled items is IRRELEVANT to "
        "grounded_ok — a deliverable that honestly labels even 20 items UNVERIFIED is grounded_ok=TRUE "
        "(those are completeness gaps → list in gaps + met=false, but NOT grounded_ok=false). When in "
        "doubt and the text honestly flags what it couldn't confirm, grounded_ok=TRUE.\n"
        "- grounded_ok=FALSE on any confident factual assertion that is not supported by EVIDENCE. This includes "
        "guarantees, legal/compliance approval, exclusivity ('only', 'no vendor', 'white space'), market claims, "
        "customer or regulator validation, numerical lifts/targets, named owners/dates, and performance claims. "
        "List every unsafe assertion verbatim in unsupported_claims. A recommendation may propose a validation "
        "step, but must not claim its result.\n"
        "- grounded_ok=FALSE also on a real FABRICATION tell — a confident-as-fact claim with a FAKE "
        "backing: a named source/citation/document/date matching NO memory_hit or tool result (e.g. "
        "'Confluence page X, 23-APR-24', an invented file name); a person/CEO/email asserted as real "
        "without a matching tool/memory result; OR a website / press-release / public-filing citation "
        "when hivemind_web_search was NOT used this turn (if web_search WAS used, a web citation backed "
        "by its result IS grounded). A claim the text marks UNVERIFIED is honest and NEVER lowers "
        "grounded_ok.\n"
        "- COMPANY IDENTITY: when company_name is set, the deliverable must be about THAT company. "
        "If the text asserts facts about the organisation's identity/market/products under a DIFFERENT "
        "organisation name with no backing in gathered_facts, that is a fabrication → grounded_ok=false. "
        "When company_context_missing is true, any confident company-specific claim (its market, its "
        "customers, its positioning) is UNGROUNDED by definition → grounded_ok=false + a gap naming the "
        "missing company context.\n"
        "If nothing is missing, gaps must be []. Output JSON only."
    )
    try:
        verifier_emp = {
            **lead,
            "tools": ["_verify_noop"],   # truthy, matches no real tool → empty toolkit
            "connectors": [],
            "persona": "A neutral evidence verifier. Judge only the supplied contract and evidence; do not role-play.",
            "hyper": None,
            "active_prompt_version": None,
            "max_iters": 1,
        }
        # Put the final grounding/recon JUDGE on the reliable recon model (the
        # caller passes _M_RECON, e.g. deepseek) instead of the room's default —
        # judgment reliability is what this gate is FOR. tool-less → no routing swap.
        if model:
            verifier_emp["model"] = model
            # A namespaced model such as deepseek/... must go to OpenRouter. The
            # previous forced Groq route ignored the model and made verification
            # silently unavailable when Groq billing was restricted.
            verifier_emp["llm_provider"] = "openrouter"
        # This is a model-only judge.  A bootstrap employee API key is a
        # HIVE-MIND tool credential, not an OpenRouter credential; passing it
        # here made AgentScope send that key to the gateway and intermittently
        # fail with "User not found".  An empty tool credential makes the
        # factory use the service's configured OpenRouter/Gateway key instead.
        agent = build_react_agent(
            verifier_emp, "",
            user_id=req.user_id, org_id=req.org_id, project_id=req.project_id,
        )
        reply = await agent(Msg(name="user", content=prompt, role="user"))
    except Exception as exc:  # noqa: BLE001 — preserve the report, but never silently pass quality
        log.warning("[verify] pass failed: %s", exc)
        return {
            "met": False, "artifact_ok": False, "assignments_ok": False,
            "grounded_ok": False, "unsupported_claims": [],
            "gaps": ["quality verification was unavailable; this report requires review before use"],
            "note": f"Quality verification unavailable: {str(exc)[:180]}",
            "produced_artifacts": produced, "pending_writes": [p.get("label") for p in pending],
            "intended_output": plan.get("intended_output"), "done_criterion": plan.get("done_criterion"),
            "verification_available": False,
        }
    obj = _first_json_object(_msg_to_text(reply) or "")
    if not isinstance(obj, dict):
        return {
            "met": False, "artifact_ok": False, "assignments_ok": False,
            "grounded_ok": False, "unsupported_claims": [],
            "gaps": ["quality verification returned no usable verdict; this report requires review before use"],
            "note": "Quality verification returned no usable verdict.",
            "produced_artifacts": produced, "pending_writes": [p.get("label") for p in pending],
            "intended_output": plan.get("intended_output"), "done_criterion": plan.get("done_criterion"),
            "verification_available": False,
        }
    verdict = {
        "met": bool(obj.get("met")),
        "artifact_ok": bool(obj.get("artifact_ok")),
        "assignments_ok": bool(obj.get("assignments_ok")),
        "grounded_ok": bool(obj.get("grounded_ok")),
        "unsupported_claims": [str(item)[:300] for item in (obj.get("unsupported_claims") or []) if str(item).strip()][:10],
        "gaps": [str(g)[:200] for g in (obj.get("gaps") or []) if str(g).strip()][:8],
        "note": str(obj.get("note") or "")[:300],
        "produced_artifacts": produced,
        "pending_writes": [p.get("label") for p in pending],
        "intended_output": plan.get("intended_output"),
        "done_criterion": plan.get("done_criterion"),
        "verification_available": True,
    }
    _apply_outreach_contract(verdict, plan, pending)
    # ── Deterministic company-grounding gate (does NOT trust the LLM verdict) ──
    # A company-scoped turn with NO company context cannot be grounded: the room
    # had nothing real to stand on, so a plausible-sounding deliverable is exactly
    # the failure mode to block. This ONE check stays deterministic because "we
    # have zero context" is a fact, not a judgment call.
    #
    # A second check used to also hard-block on `company_name.lower() not in
    # final_text.lower()` ("identity substitution"). Removed 2026-08-12: verified
    # via a live 5x-repeat probe that it false-positived on drafts that named the
    # company correctly multiple times — the substring check ran against a stale
    # or mismatched text snapshot inside the repair loop, not the version actually
    # judged. The LLM verifier prompt already has an explicit "COMPANY IDENTITY"
    # rule (asserts facts under a DIFFERENT org name → grounded_ok=false) that
    # covers real identity substitution without the snapshot-mismatch failure
    # mode. Judgment calls belong to the judge, not a brittle string check.
    _company_scoped = bool(re.search(r"\b(our|we|us|company)\b", f"{req.room_goal or ''} {req.user_message or ''}", re.I))
    if _company_scoped and company_context_missing:
        verdict["grounded_ok"] = False
        verdict["met"] = False
        verdict["gaps"] = (verdict.get("gaps") or [])[:7] + [
            "company context missing — the room had no company brief/canon, so company-specific claims cannot be grounded"]
        verdict["company_context_missing"] = True
    unsupported_specifics = _unsupported_specific_claims(
        final_text,
        [str(item) for item in ((blackboard or {}).get("facts") or [])],
        req.user_message or "",
    )
    if unsupported_specifics:
        verdict["grounded_ok"] = False
        verdict["met"] = False
        verdict["unsupported_claims"] = list(dict.fromkeys([
            *(verdict.get("unsupported_claims") or []), *unsupported_specifics,
        ]))[:10]
        verdict["gaps"] = list(dict.fromkeys([
            *(verdict.get("gaps") or []),
            "specific numbers or dates appear without matching source evidence",
        ]))[:8]
    # ── Deterministic contact-grounding gate ──
    # Two live incidents (2026-08-13): a debate round invented a named
    # "internal audit" + competitor names, and a work-order worker invented
    # named contacts with fabricated emails, both fixed at their prompt call
    # sites. But that's whack-a-mole — every new LLM call site can leak the
    # same way again. _unsupported_specific_claims above already catches
    # numbers/dates/currency deterministically; it does NOT catch emails or
    # phone numbers, the exact artifact class both incidents fabricated. This
    # closes that gap the same way, independent of which call site produced
    # the text and independent of the LLM verifier's own judgment.
    # The room's own connected sender address is a legitimate sign-off, never
    # a fabrication — allow it explicitly (it lives on `plan`, not the board).
    _contact_evidence = [str(item) for item in ((blackboard or {}).get("facts") or [])]
    if plan.get("sender_email"):
        _contact_evidence.append(str(plan["sender_email"]))
    unsupported_contacts = _unsupported_contact_claims(final_text, _contact_evidence)
    if unsupported_contacts:
        verdict["grounded_ok"] = False
        verdict["met"] = False
        verdict["unsupported_claims"] = list(dict.fromkeys([
            *(verdict.get("unsupported_claims") or []), *unsupported_contacts,
        ]))[:10]
        verdict["gaps"] = list(dict.fromkeys([
            *(verdict.get("gaps") or []),
            "an email address or phone number appears without matching source evidence — likely a fabricated contact",
        ]))[:8]
    return verdict


_SPECIFIC_CLAIM_RE = re.compile(
    r"(?<![\w.])(?:€|\$|£)\s*\d+(?:[.,]\d+)?|"
    r"(?<![\w.])(?:\d+(?:[.,]\d+)?)\s*(?:%|percent|days?|weeks?|months?|years?|"
    r"fte|people|employees?|companies|enterprises|leads?|meetings?|calls?|emails?|posts?|touches?|d|wks?)\b|"
    r"\b(?:art(?:icle)?\.?|section|§)\s*\d+(?:[.\-–]\d+)*\b|"
    r"\b(?:q[1-4]\s*20\d{2}|20\d{2}(?:[-/]\d{1,2}[-/]\d{1,2})?)\b",
    re.IGNORECASE,
)


def _unsupported_specific_claims(final_text: str, evidence: List[str], user_message: str) -> List[str]:
    """Find measurable specifics absent from both the request and source ledger."""
    allowed = re.sub(r"\s+", " ", "\n".join([user_message, *evidence])).casefold()
    unsupported: List[str] = []
    for line in str(final_text or "").splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if not clean:
            continue
        for match in _SPECIFIC_CLAIM_RE.finditer(clean):
            token = re.sub(r"\s+", " ", match.group(0)).casefold()
            if token not in allowed:
                unsupported.append(clean[:300])
                break
    return list(dict.fromkeys(unsupported))[:10]


_CONTACT_CLAIM_RE = re.compile(
    r"[\w.+-]+@[\w-]+\.[\w.-]+|"       # email address
    r"\+[1-9]\d{7,14}",                # E.164-ish phone number
)


def _unsupported_contact_claims(final_text: str, evidence: List[str]) -> List[str]:
    """Find an email/phone asserted in the deliverable that appears in NO
    gathered evidence line. `evidence` here is always the durable-only
    snapshot (RECALL/WEB/CONNECTOR/PROSPECT/COMPANY — WORK_RESULT and debate
    prose are excluded upstream by `_source_evidence_snapshot`), so a
    worker's own hallucinated contact can never "self-ground" against its
    own fabricated blackboard line."""
    allowed = "\n".join(evidence).casefold()
    unsupported: List[str] = []
    for line in str(final_text or "").splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if not clean:
            continue
        for match in _CONTACT_CLAIM_RE.finditer(clean):
            token = match.group(0).casefold()
            if token not in allowed:
                unsupported.append(clean[:300])
                break
    return list(dict.fromkeys(unsupported))[:10]


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
    m = re.search(r"^\s*#+\s+(.+)$", final_text or "", re.MULTILINE) or \
        re.search(r"subject\s*:\s*(.+)", final_text or "", re.IGNORECASE) or \
        re.search(r"title\s*:\s*(.+)", final_text or "", re.IGNORECASE)
    raw = m.group(1).splitlines()[0] if m else (fallback or "Untitled")
    # Strip leaked markdown (#, **, __, _) + any leftover "Subject:/Title:" prefix so the
    # artifact title is clean (was showing "** A Note…").
    raw = re.sub(r"^[#*_\s]+", "", raw)
    raw = re.sub(r"^(subject|title)\s*:\s*", "", raw, flags=re.IGNORECASE)
    raw = raw.replace("**", "").replace("__", "").strip(" *_#")
    return (raw or fallback or "Untitled")[:120]


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
        record_artifact("google-docs", url, title=title, label=f"Open “{title}”", body_md=ctx.get("body") or "")
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
    # Sheet creation failed but the deliverable CONTENT already exists (the synthesis
    # body with its markdown tables is in the room). Deliver inline instead of
    # dead-ending the whole turn over a missing artifact wrapper.
    log.info("[produce] sheet creation failed — delivering content inline (no dead-end)")
    return {"inline": True, "title": title,
            "note": "Google Sheet could not be created — the full table is in the report above"}


def _extract_notion_url(res: Any) -> str:
    """Pull the created-page URL out of an MCP exec result. The hosted Notion MCP
    returns {result:{content:[{type:'text',text:'{"pages":[{"id","url",...}]}'}]}}.
    Falls back to constructing the URL from the page id."""
    try:
        inner = res.get("result") if isinstance(res, dict) and isinstance(res.get("result"), dict) else res
        content = (inner or {}).get("content") if isinstance(inner, dict) else None
        text = ""
        if isinstance(content, list) and content and isinstance(content[0], dict):
            text = content[0].get("text") or ""
        else:
            text = json.dumps(res) if isinstance(res, (dict, list)) else str(res or "")
        m = re.search(r'"(?:public_url|url)"\s*:\s*"(https?://[^"]+)"', text)
        if m:
            return m.group(1)
        m = re.search(r"https?://(?:www\.|app\.)?notion\.(?:so|com)/\S+", text)
        if m:
            return m.group(0).rstrip('".,)')
        m = re.search(r'"id"\s*:\s*"([0-9a-fA-F-]{32,36})"', text)
        if m:
            return f"https://www.notion.so/{m.group(1).replace('-', '')}"
    except Exception:  # noqa: BLE001
        pass
    return ""


@_register_producer("notion")
async def _produce_notion(req: "RoomTurnRequest", plan: Dict[str, Any],
                          step: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Write the deliverable back to Notion as a new page (notion-create-pages via
    the MCP bridge). New-page creation in the user's own workspace — same auto-produce
    policy as docs_create/sheets_create (no HITL; outward SENDS are what HITL gates).
    Honest-skips if Notion isn't connected (the bridge 401s)."""
    body = ctx.get("body") or ""
    title = step.get("title") or _derive_title(plan, body, req.room_goal or "Notion page")
    # Drop a leading title line / '# Heading' so it isn't duplicated under the page title.
    page_body = re.sub(r"^\s*(#\s+.*|(?:title|subject)\s*:.*)$", "", body, count=1,
                       flags=re.IGNORECASE | re.MULTILINE).strip() or body
    res = await connector_exec_emulated(
        "notion", "notion-create-pages",
        {"pages": [{"properties": {"title": title}, "content": page_body}]},
        user_id=req.user_id, org_id=req.org_id)
    url = _extract_notion_url(res)
    if url:
        record_artifact("notion", url, title=title, label=f"Open “{title}” in Notion", body_md=ctx.get("body") or "")
        log.info("[produce] notion page → %s", url)
        return {"url": url, "title": title}
    err = (res or {}).get("error") if isinstance(res, dict) else None
    if err:
        await _surface_produce_error(req, plan, "Notion page", err)
    return {"skipped": "the Notion page could not be created (is Notion connected + the integration shared with a workspace?)"}


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
        # Prefer the enriched PROSPECT rows on the board (real Impressum emails)
        # over a stray address in the body — the synthesis signature often carries
        # the SENDER's own placeholder (e.g. email@ourcompany.com), which must NEVER
        # become the recipient. Own-domain + placeholder local-parts are excluded.
        own = set()
        try:
            for tok in re.findall(r"[\w.+-]+@([\w.-]+\.\w+)", (ctx.get("sender_email") or "")):
                own.add(tok.lower())
        except Exception:  # noqa: BLE001
            pass
        # Own brand from the room's company (done_criterion carries "Company: X").
        _dc = str(plan.get("done_criterion") or "")
        _m = re.search(r"Company:\s*([A-Za-z0-9][\w&.\- ]{1,40})", _dc)
        brand = (_m.group(1).strip().split()[0].lower() if _m else "")
        _PLACEHOLDER_LOCAL = {"email", "your", "yourname", "name", "firstname", "lastname",
                              "recipient", "sender", "me", "user", "you", "prospect"}
        # Rank prospect-board emails first, then body emails.
        board = "\n".join(x for x in (ctx.get("prospect_emails") or []))
        _pool = board + "\n" + " ".join(c.get("contribution", "") for c in (plan.get("execution") or [])) + " " + (ctx.get("body") or "")
        for addr in re.findall(r"[\w.+-]+@[\w.-]+\.\w+", _pool):
            low = addr.lower(); local = low.split("@", 1)[0]; dom = low.split("@", 1)[1]
            if "noreply" in low or "no-reply" in low or "example." in low:
                continue
            if local in _PLACEHOLDER_LOCAL:
                continue
            if dom in own:
                continue
            if brand and len(brand) >= 4 and brand in dom:
                continue
            to = addr
            break
    # No verified recipient → DON'T skip to nothing (which degrades to a generic doc). Still DRAFT
    # the email in the owner's Gmail (empty To) so they review + add recipients + send themselves.
    # Never auto-sends (no approval queued). Honors intended_output=email instead of a report.
    _no_recipient = not to
    # Dependency gate: if an EARLIER step was meant to create the artifact this
    # email links but it was NOT produced, do NOT draft an email with a fabricated
    # link — skip honestly so the seal reports the real blocker.
    if ctx.get("expects_prior_artifact") and not ctx.get("last_artifact_url"):
        return {"skipped": "the file this email was meant to link was never created, so no email was drafted"}
    body = ctx.get("body") or ""
    # Synth appends non-email material (prospect tables, timelines) under this marker —
    # it stays in the room; ONLY the part above it is the email.
    body = re.split(r"^-{3,}\s*SUPPORTING MATERIAL\s*-{3,}\s*$", body,
                    maxsplit=1, flags=re.IGNORECASE | re.MULTILINE)[0].strip() or body
    _subj_m = re.search(r"^\s*subject\s*:\s*(.+)$", body, flags=re.IGNORECASE | re.MULTILINE)
    _subj = (_subj_m.group(1).strip().strip("*") if _subj_m else "")
    if _subj and "supporting material" not in _subj.lower():
        subject = _subj
    else:
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
        # markdown:True → the core bridge converts the agent's markdown into a polished
        # HTML alternative (real bold/tables, mermaid stripped) instead of raw ** | ``` in Gmail.
        "gmail_create_draft", {"to": to, "subject": subject, "body": email_body, "markdown": True},
        user_id=req.user_id, org_id=req.org_id)
    draft_id = ((res or {}).get("result") or res or {}).get("draftId") or (res or {}).get("draftId")
    url = ((res or {}).get("result") or res or {}).get("url") or (res or {}).get("url") or ""
    if draft_id:
        if _no_recipient:
            log.info("[produce] email drafted with NO recipient — review + add recipients in Gmail")
            return {"draft_id": draft_id, "url": url, "to": "", "needs_recipient": True,
                    "note": "Drafted in Gmail with no recipient — no verified contact was found. "
                            "Review it, add recipients, and send from Gmail."}
        queue_email_approval(to, subject, draft_id, url, body_md=email_body)
        log.info("[produce] email draft → %s", to)
        return {"draft_id": draft_id, "url": url, "to": to}
    if isinstance(res, dict) and res.get("error"):
        await _surface_produce_error(req, plan, "Gmail draft", res.get("error"))
    # Draft couldn't be saved. The email TEXT was still written by synth (intended_output=email),
    # so say that honestly rather than implying nothing was produced.
    return {"skipped": ("no verified recipient and the Gmail draft could not be saved — the email text is "
                        "in the answer above; add recipients to send" if _no_recipient
                        else "the Gmail draft could not be created")}


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
    _enabled = plan.get("enabled_connectors")
    for s in steps[:_EXECUTE_MAX_OWNERS]:
        k = s.get("kind")
        if k not in _PRODUCERS:
            if k:
                dropped.append(k)
            continue
        # Capability gate: never keep a connector-backed step whose connector isn't
        # toggled on for the room — calling it would hang on an absent/dead token.
        if not _artifact_connector_enabled(k, _enabled):
            dropped.append(f"{k} (connector not enabled)")
            continue
        if not kept or kept[-1].get("kind") != k:  # dedupe consecutive
            kept.append(s)
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
    # Re-evaluating from scratch: this call's outcome is authoritative. A PRIOR attempt
    # that skipped (e.g. a cold connector-write that failed the first time, then this
    # call succeeds) must NOT leave a stale dead-end that blocks a real deliverable.
    plan.pop("dead_end", None)
    plan.pop("produce_skips", None)
    steps = _derive_artifact_steps(plan, req.user_message or "")
    # A non-terminal doc/sheet step is a prerequisite the terminal step references.
    has_prereq_artifact = any(s.get("kind") in ("doc", "sheet") for s in steps[:-1])
    ctx: Dict[str, Any] = {"body": body, "artifacts": [], "last_artifact_url": None,
                           "expects_prior_artifact": has_prereq_artifact,
                           "sender_email": str(plan.get("sender_email") or "")}
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
    # BUT only when the terminal deliverable's artifact was genuinely NOT produced —
    # a skip AFTER its artifact already exists (a duplicate/retry, or a trailing
    # optional step) must never blank a real, delivered result (e.g. a created
    # Notion page sealing as "blocked").
    terminal_kind = steps[-1].get("kind") if steps else None
    produced_kinds = {a.get("kind") for a in ctx["artifacts"]}
    if last_result.get("skipped") and terminal_kind not in produced_kinds:
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
    company_name: str = "",
    company_context_missing: bool = False,
) -> Optional[Dict[str, Any]]:
    """Run the verify pass, emit a `verify` event, stash the verdict on the
    plan (so the handler/P6 goalkeeper can read it), and return it."""
    # UNIFIED PRODUCE — create the artifact from the agreed synthesis BEFORE we
    # verify against it (single deterministic path: doc/sheet/email).
    await _produce_output(req, final_text)
    verdict = await _verify_turn(
        req, lead, final_text=final_text,
        tool_call_counts=tool_call_counts, blackboard=blackboard, model=model,
        company_name=company_name, company_context_missing=company_context_missing,
    )
    if verdict is None:
        return None
    plan = _PLAN_BY_TURN.get(req.turn_id)
    if isinstance(plan, dict):
        if isinstance(plan.get("artifact_intent"), dict):
            receipt = plan.get("artifact_receipt")
            artifact_ok = bool(isinstance(receipt, dict) and receipt.get("ok") and receipt.get("artifact_id"))
            verdict["artifact_ok"] = artifact_ok
            verdict["met"] = bool(verdict.get("met")) and artifact_ok
            if artifact_ok:
                produced = list(verdict.get("produced_artifacts") or [])
                produced.append(str(receipt.get("artifact_id")))
                verdict["produced_artifacts"] = list(dict.fromkeys(produced))
            else:
                gaps = list(verdict.get("gaps") or [])
                gaps.append("The requested interactive artifact did not pass production rendering checks.")
                verdict["gaps"] = list(dict.fromkeys(gaps))
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
# EVERY assigned owner runs its subtask IN PARALLEL (no sequential threading);
# concurrency is bounded only to avoid Groq 429s. Per-task recon then verifies
# each owner's output before the debate.
# Phase 2 — bounded MULTI-ROUND swarm: debate→revise repeats until a round
# produces no high-confidence challenge (converged) or the cap is hit.


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
    _generic = ("the", "european", "summit", "team", "everyone", "all", "her", "him", "them", "us", "you")
    cands: List[str] = []
    for m in _RECIPIENT_RE.finditer(msg):
        nm = re.sub(r"^(Dr|Mr|Ms|Mrs)\.?\s+", "", m.group(1).strip(), flags=re.IGNORECASE).strip()
        # Drop generic words that capitalize after "to/for" (e.g. "European").
        if nm and nm.lower() not in _generic and nm not in cands:
            cands.append(nm)
    # Also catch "write/tell/draft/message <Name>" — no to/email trigger word, e.g.
    # "write Rama a document" (the original bug: this recipient was never extracted).
    for m in re.finditer(r"\b(?:write|tell|draft|message|ping|notify)\s+([A-Z][a-z]{2,})", msg):
        nm = m.group(1).strip()
        if nm.lower() not in _generic and nm not in cands:
            cands.append(nm)
    seen_names = set()
    for name in cands[:5]:
        if name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        low = name.lower()
        try:
            d = await org_members_emulated(name, user_id=req.user_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            d = {}
        members = (d or {}).get("members") or []
        gmail_c = (d or {}).get("gmail_candidates") or []
        if members and members[0].get("email"):
            resolved.append({"name": name, "email": members[0]["email"], "source": "org"})
            continue
        if gmail_c and gmail_c[0].get("email"):
            resolved.append({"name": name, "email": gmail_c[0]["email"], "source": "gmail"})
            continue
        # Deterministic Gmail fallback: search the owner's mailbox for the name and
        # match an address whose local-part matches it (Rama → ramasantoshi…@…). Runs
        # every email turn, independent of whatever the director happened to gather.
        try:
            gr = await google_exec_emulated("gmail_search", {"query": name, "max": 6},
                                            user_id=req.user_id, org_id=req.org_id)
            addrs = [a.lower() for a in re.findall(r"[\w.+-]+@[\w.-]+\.\w+", json.dumps(gr))]
            pick = next((a for a in addrs
                         if "noreply" not in a and "no-reply" not in a
                         and (a.split("@")[0].startswith(low) or low in a.split("@")[0])), None)
            if pick:
                resolved.append({"name": name, "email": pick, "source": "gmail-search"})
        except Exception:  # noqa: BLE001
            pass
    return resolved










def _quality_models(mode: str) -> tuple:
    """Return the centrally governed model triple for a Room turn.

    HyperAgents uses one approved Gateway model by default for gather, debate,
    and synthesis.  Operators can deliberately override an individual phase,
    but an ordinary ``auto`` or ``best`` Room must never quietly switch to a
    legacy 120B/Haiku path.
    """
    default = canonical_hyper_model(os.environ.get("HYPER_ROOM_MODEL", HYPER_FAST_MODEL))
    best = canonical_hyper_model(os.environ.get("HYPER_MODEL_BEST", default))
    if (mode or "auto").strip().lower() == "best":
        return (best, best, best)
    return (
        canonical_hyper_model(os.environ.get("HYPER_AUTO_GATHER", default)),
        canonical_hyper_model(os.environ.get("HYPER_AUTO_DEBATE", default)),
        canonical_hyper_model(os.environ.get("HYPER_AUTO_SYNTH") or os.environ.get("HYPER_SYNTH_MODEL", default)),
    )


_CAMPAIGN_PRIMARY_ROLES = (
    ("strategist", "Strategist", ("strategist", "researcher", "investigator", "strategy")),
    ("creative_lead", "Builder", ("creative", "content", "builder", "maker", "communicator", "writer")),
    ("critical_reviewer", "Skeptic", ("skeptic", "reviewer", "critic", "risk", "compliance")),
)
_CAMPAIGN_DIRECT_MODEL = "gpt-oss-120b"


def _campaign_result_accepted(result: Any) -> bool:
    """A compiled dashboard is not the same thing as an accepted contract."""
    if not isinstance(result, dict) or not isinstance(result.get("campaign_bundle"), dict):
        return False
    errors = result.get("campaign_bundle_errors")
    return isinstance(errors, list) and not errors


def _campaign_models() -> tuple:
    """Run Campaign judgment on the configured direct Cerebras route.

    The OpenRouter-hosted 20B route repeatedly fell through to slow providers,
    making a bounded campaign slower than the stronger direct model. One model
    also keeps planning, review, compilation, and repair semantically aligned.
    """
    return (
        os.environ.get("HYPER_CAMPAIGN_GATHER_MODEL", _CAMPAIGN_DIRECT_MODEL),
        os.environ.get("HYPER_CAMPAIGN_DEBATE_MODEL", _CAMPAIGN_DIRECT_MODEL),
        os.environ.get("HYPER_CAMPAIGN_SYNTH_MODEL", _CAMPAIGN_DIRECT_MODEL),
    )


def _campaign_employee_text(employee: Dict[str, Any]) -> str:
    values = (
        employee.get("_lane"), employee.get("role_archetype"), employee.get("name"),
        employee.get("slug"), employee.get("title"), employee.get("persona"),
    )
    return " ".join(str(value or "").lower() for value in values)


def _campaign_primary_roster(participants: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Select exactly three distinct Campaign Room employees and bind clear roles."""
    if len(participants) < len(_CAMPAIGN_PRIMARY_ROLES):
        raise ValueError("Campaign Rooms require at least three eligible employees")

    remaining = list(enumerate(participants))
    selected: List[Dict[str, Any]] = []
    for role, lane, terms in _CAMPAIGN_PRIMARY_ROLES:
        ranked = sorted(
            remaining,
            key=lambda item: (
                -sum(4 if term == str(item[1].get("_lane") or "").lower() else 1
                     for term in terms if term in _campaign_employee_text(item[1])),
                item[0],
            ),
        )
        original_index, employee = ranked[0]
        remaining = [item for item in remaining if item[0] != original_index]
        bound = dict(employee)
        bound["_campaign_role"] = role
        bound["_lane"] = lane
        selected.append(bound)
    return selected


def _campaign_debate_rounds(campaign_brief: Optional[Dict[str, Any]]) -> int:
    """Campaigns always need an independent proposal round and a peer challenge round."""
    brief = campaign_brief if isinstance(campaign_brief, dict) else {}
    nested_brief = brief.get("brief") if isinstance(brief.get("brief"), dict) else {}
    conflict_values = (
        brief.get("strategic_conflicts"), brief.get("strategy_conflicts"),
        nested_brief.get("strategic_conflicts"), nested_brief.get("strategy_conflicts"),
    )
    risk_values = (
        brief.get("risks"), brief.get("risk_flags"),
        nested_brief.get("risks"), nested_brief.get("risk_flags"),
        nested_brief.get("prohibited_claims"),
    )

    def _present(value: Any) -> bool:
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, (list, tuple, set, dict)):
            return bool(value)
        return value is not None and bool(value)

    return 3 if any(_present(value) for value in (*conflict_values, *risk_values)) else 2


def _build_campaign_director(
    director_kwargs: Dict[str, Any], campaign_brief: Optional[Dict[str, Any]],
) -> Director:
    """Single construction seam used by runtime and provider-free policy tests."""
    return Director(
        **director_kwargs,
        debate_max_rounds=_campaign_debate_rounds(campaign_brief),
    )


# Each connector-backed artifact kind → the connector id(s) that can produce it. A doc/
# sheet needs the Google bridge (any connected google* shares one token); email needs
# Gmail; notion needs Notion. answer/decision need no connector. Used to gate production:
# the room must NEVER call a connector it hasn't toggled on (it would hang on an absent/
# dead token and block) — if the producing connector is off, deliver the text instead.
_KIND_CONNECTOR: Dict[str, tuple] = {
    "doc": ("google-docs", "google-drive", "google"),
    "sheet": ("google-sheets", "google-drive", "google"),
    "email": ("gmail", "google"),
    "notion": ("notion",),
}


def _artifact_connector_enabled(kind: str, enabled_connectors) -> bool:
    """True if `kind` needs no connector, or its producing connector is toggled on."""
    needed = _KIND_CONNECTOR.get(kind)
    if not needed:
        return True  # answer / decision — text deliverable, no connector required
    en = {str(c).strip().lower().replace("_", "-") for c in (enabled_connectors or [])}
    return any(rc in en for rc in needed)


# Notion write-back: a create/save/publish verb pointed at Notion (within ~40 chars).
# Requiring a WRITE verb keeps read intents — "summarize the Notion pages", "check if
# Notion has X" — out (those stay 'answer'); only a create/save/publish → a Notion page.
_NOTION_WRITE_RE = re.compile(
    r"\b(?:writ\w*|creat\w*|mak\w*|sav\w*|add|adding|post\w*|publish\w*|put|push\w*|log\w*|"
    r"record\w*|draft\w*|append\w*)\b[^.\n]{0,40}?\bnotion\b",
    re.IGNORECASE)


def _derive_intended_output(user_message: str) -> str:
    """Conservatively infer an explicitly requested external output.

    Content nouns such as report, brief, table, and persona describe the answer,
    not a provider write. The adaptive Director owns modern action selection; this
    legacy guard recognizes only destinations the user actually named.
    """
    m = user_message or ""
    if _SEND_INTENT_RE.search(m) or re.search(r"[\w.+-]+@[\w.-]+\.\w+", m):
        return "email"
    # Notion write-back: a create/save/publish intent aimed at Notion → a Notion
    # page. A read intent ("check/search Notion") is NOT a write — it stays answer.
    if _NOTION_WRITE_RE.search(m):
        return "notion"
    if re.search(r"\bgoogle\s+docs?\b", m, re.IGNORECASE):
        return "doc"
    if re.search(r"\bgoogle\s+sheets?\b", m, re.IGNORECASE):
        return "sheet"
    return "answer"


_PROFILE_SELECTION_SCHEMA: Dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "profile_id": {"type": "string", "enum": [p["profile_id"] for p in profile_registry_manifest()]},
        "reason": {"type": "string"},
    },
    "required": ["profile_id", "reason"],
}

_DIRECT_AGENT_ROUTE_SCHEMA: Dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "direct_to_agent": {"type": "boolean"},
        "agent_slug": {"type": ["string", "null"]},
        "reason": {"type": "string"},
    },
    "required": ["direct_to_agent", "agent_slug", "reason"],
}


async def _classify_implicit_direct_route(req: "RoomTurnRequest", participants: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Same decision an explicit @mention already makes deterministically, made
    for a message that never typed the tag. Confirmed live 2026-08-12:
    "@ravi-patel-6 what are our next steps" got a real, fast, in-character
    answer from Ravi alone — the user then asked for the SAME routing
    whenever a question is clearly meant for one specific person, tag or not.

    Conservative by design: this must NOT steal genuinely group-shaped
    questions (open strategy, a decision needing debate, anything asking
    for the team's view) away from the full multi-agent pipeline — those
    need the debate + governance pass this fast-path skips entirely. Only
    route direct when the message unambiguously names or clearly targets
    one participant's specific role/expertise (e.g. "what's Lina's take on
    X", "what should legal review here"). Defaults to NOT routing (False)
    on any ambiguity, and fails to False on any classifier error — a wrong
    "no" costs one extra debate round; a wrong "yes" silently drops
    debate+verification for a question that needed it.
    """
    if len(participants) < 2:
        return None  # nothing to route away from
    roster = [{"slug": p.get("slug"), "name": p.get("name"), "lane": p.get("_lane")} for p in participants]
    system = (
        "Decide whether this message is CLEARLY meant for one specific team member to answer "
        "directly, or whether it's a genuine team question that needs the group's discussion. "
        "Route direct_to_agent=true ONLY when the message unambiguously names a participant "
        "(by name, role, or lane) or asks for THAT ONE person's take/view/status specifically. "
        "Default to direct_to_agent=false for anything open-ended, strategic, a decision, or "
        "asking what 'we' or 'the team' should do — those need real debate, not one voice. "
        "When uncertain, choose false."
    )
    user = json.dumps({
        "user_message": str(req.user_message or "")[:2000],
        "room_goal": str(req.room_goal or "")[:300],
        "participants": roster,
    }, ensure_ascii=False)
    body = {
        "model": os.environ.get("HYPER_DIRECT_ROUTE_MODEL", "openai/gpt-oss-120b"),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.1, "max_tokens": 200,
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "direct_agent_route", "schema": _DIRECT_AGENT_ROUTE_SCHEMA, "strict": True,
        }},
    }
    if _needs_reasoning_disabled(body["model"]):
        body["reasoning"] = {"enabled": False}
    try:
        data = await _openrouter_chat(body, timeout=httpx.Timeout(10.0, connect=5.0))
    except Exception as exc:  # noqa: BLE001
        log.info("[direct-route] classifier unavailable turn=%s: %s", req.turn_id, exc)
        return None
    if data is None:
        _fallback = _fallback_model_for(body["model"])
        if _fallback:
            body["model"] = _fallback
            body.pop("reasoning", None)
            try:
                data = await _openrouter_chat(body, timeout=httpx.Timeout(10.0, connect=5.0))
            except Exception:  # noqa: BLE001
                return None
    try:
        text = (((data or {}).get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001
        return None
    if not parsed.get("direct_to_agent"):
        return None
    slug = str(parsed.get("agent_slug") or "").strip().lower()
    target = next((p for p in participants if str(p.get("slug") or "").lower() == slug), None)
    if not target:
        return None
    return target


async def _select_execution_profile(req: "RoomTurnRequest", conns: List[str]) -> Dict[str, Any]:
    """Choose which existing specialist engine a human Work Room turn runs as.

    A General Work Room's room_kind was frozen to "general" for its entire life —
    resolve_turn_room_kind hard-returns "general" whenever room_mode == "work",
    so a Work Room could never deterministically invoke the Campaign compiler or
    the Outreach lifecycle contract; it could only improvise a report while
    borrowing a method skill for flavor. self.room_kind gates ~40 branches in
    engine.py (domain pack load, outreach_request population, the campaign
    system contract, ...), so this ONE classification, done once per turn,
    reactivates all of that already-working machinery — nothing downstream
    needs to change to reuse it.

    Semantic, not keyword-based: the model reads the raw request the same way a
    human dispatcher would, not a substring match. A message that happens to
    contain the word "lead" must not become Outreach on that basis alone — the
    registry only carries (profile_id, room_kind, allowed_outputs, effect); the
    model never sees provider names, connector implementations, playbook ids,
    or authority state, none of which this decision may touch.

    Fails to general.answer.v1 on ANY error — a broken classifier must degrade
    to the safest, most permissive profile, never block or crash the turn.
    """
    manifest = profile_registry_manifest()
    system = (
        "Classify ONE human work request into exactly one execution profile from the "
        "supplied registry. You are choosing WHAT KIND of specialist work this is, not "
        "which tool, connector, or provider will run it — those are decided later by the "
        "chosen specialist engine. Prefer general.answer.v1 whenever the request is a "
        "question, a direct answer, or does not clearly justify a specialist engine. A "
        "message merely containing a word like 'campaign' or 'lead' is NOT sufficient "
        "grounds on its own — judge the actual intent of the request."
    )
    user = json.dumps({
        "user_message": str(req.user_message or "")[:4000],
        "room_goal": str(req.room_goal or "")[:500],
        "connected_capabilities": list(conns)[:20],
        "profile_registry": manifest,
    }, ensure_ascii=False)
    body = {
        "model": os.environ.get("HYPER_PROFILE_SELECTOR_MODEL", "openai/gpt-oss-120b"),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.1, "max_tokens": 300,
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "execution_profile_selection", "schema": _PROFILE_SELECTION_SCHEMA, "strict": True,
        }},
    }
    if _needs_reasoning_disabled(body["model"]):
        body["reasoning"] = {"enabled": False}
    # Route straight to OpenRouter — no direct api.groq.com attempt. The direct
    # Groq key is confirmed delinquent (billing-dead), so every direct call here
    # was a guaranteed 400 followed by this exact fallback anyway (verified live
    # 2026-08-12: two calls in one turn's log, both 400 then OpenRouter-served).
    # _openrouter_chat's provider pin for openai/gpt-oss-120b includes "Groq" —
    # OpenRouter's own hosted Groq capacity, billed through OpenRouter, unaffected
    # by our dead key — so this still reaches Groq's infra when it's the fastest
    # candidate, just without the wasted direct round-trip.
    data: Optional[Dict[str, Any]] = None
    try:
        data = await _openrouter_chat(body, timeout=httpx.Timeout(15.0, connect=5.0))
    except Exception as exc:  # noqa: BLE001
        log.info("[profile-select] openrouter unavailable turn=%s: %s", req.turn_id, exc)
    if data is None:
        _fallback = _fallback_model_for(body["model"])
        if _fallback:
            log.warning("[profile-select] experimental model %s unavailable turn=%s — falling back to %s",
                        body["model"], req.turn_id, _fallback)
            body["model"] = _fallback
            body.pop("reasoning", None)
            try:
                data = await _openrouter_chat(body, timeout=httpx.Timeout(15.0, connect=5.0))
            except Exception as exc:  # noqa: BLE001
                log.info("[profile-select] fallback model also unavailable turn=%s: %s", req.turn_id, exc)
    profile_id = ""
    reason = ""
    try:
        text = (((data or {}).get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        parsed = json.loads(text)
        profile_id = str(parsed.get("profile_id") or "")
        reason = str(parsed.get("reason") or "")[:500]
    except Exception as exc:  # noqa: BLE001
        log.info("[profile-select] parse failed turn=%s: %s", req.turn_id, exc)
    profile = get_execution_profile(profile_id) or default_execution_profile()
    if profile.id != profile_id:
        reason = reason or "classifier unavailable or returned an unregistered profile — defaulted"
    return {
        "contract": "execution-profile.v1",
        "profile_id": profile.id, "room_kind": profile.room_kind,
        "allowed_outputs": list(profile.allowed_outputs), "effect": profile.effect,
        "required_artifacts": list(profile.required_artifacts),
        "review_policy": profile.review_policy, "reason": reason,
        "selected_at": int(time.time() * 1000),
    }


async def _resolve_work_room_execution_profile(req: "RoomTurnRequest", conns: List[str]) -> Dict[str, Any]:
    """Resume-safe wrapper: read the persisted choice before ever classifying again.

    An LLM call is not guaranteed to repeat its own answer for the same input, so
    "read before select" is what actually makes reselection impossible for a
    resumed/retried/reconnected turn — not merely unlikely.
    """
    existing = await get_work_room_execution_profile(req.turn_id)
    if isinstance(existing, dict) and existing.get("profile_id"):
        return existing
    selected = await _select_execution_profile(req, conns)
    await persist_work_room_execution_profile(req.turn_id, selected)
    # Someone else may have persisted first (concurrent dispatch of the same
    # turn_id) — the write-once guard means our own write was a no-op then, so
    # read back the winner rather than trust the value we just computed.
    winner = await get_work_room_execution_profile(req.turn_id)
    return winner if isinstance(winner, dict) and winner.get("profile_id") else selected


async def _run_direct_answer_agent(
    room_id: str, lead: Dict[str, Any], user_id: str, org_id: str, project_id: Optional[str],
    turn_id: str, user_message: str, board_context: str,
) -> Optional[str]:
    """Invoke the lead's real AgentScope agent to answer directly — LIVE tool
    access (recall, connectors), not limited to whatever gather pre-fetched.
    None on any failure (agent build, invocation, empty reply); Director's
    _try_direct_answer_hook treats None as "fall through to normal synth"."""
    try:
        set_current_turn_id(turn_id)  # real leads-persist tools (save_prospect/places_search) need this
        try:
            set_approval_rules(await get_org_approval_rules(org_id))
        except Exception:  # noqa: BLE001 — a failed rule load must fail open to the normal ask/deny policy
            set_approval_rules(None)
        agent = await _build_agent_for_room(room_id, lead, user_id=user_id, org_id=org_id, project_id=project_id)
        prompt = (
            f"Answer this directly and concisely, in character: {user_message}\n\n"
            f"CONTEXT ALREADY GATHERED THIS TURN (use it; call your own tools for "
            f"anything more you need):\n{board_context}"
        )
        reply = await agent(Msg(name="user", content=prompt, role="user"))
        text = _msg_to_text(reply).strip()
        return text or None
    except Exception as exc:  # noqa: BLE001
        log.warning("[direct-answer] agent invocation failed turn=%s: %s", turn_id, exc)
        return None


async def _run_agentic_task_agent(
    room_id: str, lead: Dict[str, Any], participants: List[Dict[str, Any]],
    user_id: str, org_id: str, project_id: Optional[str],
    turn_id: str, user_message: str, board_context: str,
    room_kind: str = "",
) -> Optional[str]:
    """Invoke the AGENTIC TASK ENGINE (dual-engine, flag-gated
    HYPER_AGENTIC_ENGINE) — the lead's real ReAct agent with a native
    PlanNotebook, a delegate_to tool for handing bounded subtasks to real
    teammate sub-agents, and a load_skill tool over the room's own domain
    playbooks, working the request step by step with LIVE tool access
    instead of a fixed plan-once pipeline.

    None on any failure (agent build, invocation, empty reply); Director's
    _run_agentic_task treats None as 'fall through to the normal pipeline'
    — this engine can only ADD behavior, never break a turn."""
    try:
        set_current_turn_id(turn_id)  # real leads-persist tools (save_prospect/places_search) need this
        try:
            set_approval_rules(await get_org_approval_rules(org_id))
        except Exception:  # noqa: BLE001 — a failed rule load must fail open to the normal ask/deny policy
            set_approval_rules(None)
        agent = await _build_lead_task_agent(
            room_id, lead, participants, user_id=user_id, org_id=org_id, project_id=project_id,
            room_kind=room_kind,
        )
        prompt = (
            f"TASK: {user_message}\n\n"
            "Work this step by step with your real tools — recall, connectors, "
            "load_skill for this domain's own strategy playbooks when you reach the "
            "step they apply to, and delegate_to for handing a bounded subtask to a "
            "real teammate when their specific expertise or tool access genuinely "
            "helps. Use create_plan first if the task has multiple distinct parts, "
            "then work through the subtasks. Decide for yourself which of your "
            "connected tools this task actually needs — do not assume a fixed set. "
            "Finish with the complete, publish-ready deliverable the user asked for — "
            "not a status update on your plan.\n\n"
            f"CONTEXT ALREADY GATHERED THIS TURN (use it; call your own tools for "
            f"anything more you need):\n{board_context}"
        )
        reply = await agent(Msg(name="user", content=prompt, role="user"))
        text = _msg_to_text(reply).strip()
        return text or None
    except Exception as exc:  # noqa: BLE001
        log.warning("[agentic-task] agent invocation failed turn=%s: %s", turn_id, exc)
        return None


# Plain (non-Work-Room) human turns whose answer failed grounding previously
# still shipped the model's original, possibly fabricated draft to the user —
# only an internal `status` was downgraded to "blocked"/"escalated", which the
# user never sees. Work Rooms intentionally keep showing in-progress drafts
# (persist_work_room_progress, "needs_evidence"/"caveated") because partial
# operational progress is real and useful; a plain factual answer that failed
# verification is a different case — an unverified claim must never read as a
# normal completed answer. Pulled out as pure functions so this is directly
# unit-testable without mocking the whole (very large) orchestration function.
def _should_withhold_ungrounded_answer(room_mode: Optional[str], status: str, final_text: str) -> bool:
    return (
        (room_mode or "").strip().lower() != "work"
        and status in ("blocked", "escalated")
        and bool((final_text or "").strip())
    )


def _verification_failure_result(exc: BaseException) -> Dict[str, Any]:
    """A crashed/timed-out verifier is not the same as a verifier that ran
    and passed — this is the fail-safe default recorded when the grounding
    check itself could not execute, so the turn is treated as unverified
    (grounded_ok=False) rather than silently defaulting to "complete"."""
    return {
        "met": False, "grounded_ok": False,
        "gaps": ["Verification could not run for this answer, so it is being treated as unverified rather than accepted silently."],
        "note": f"verifier_error: {exc}",
    }


def _grounding_withheld_text(gaps: Optional[List[str]]) -> str:
    preview = "; ".join(list(gaps or [])[:3]) or "the claim could not be verified against real evidence"
    return (
        "Runtime could not verify this answer against real evidence, so it is "
        f"withholding the draft rather than presenting an unverified claim as fact. "
        f"Gap: {preview}. Ask again with more context, or specify the exact evidence needed."
    )


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
    _work_room_profile: Optional[Dict[str, Any]] = None
    if str(req.room_mode or "").strip().lower() == "work":
        # A human Work Room's specialist engine is chosen ONCE per turn, semantically,
        # by _select_execution_profile — never by keyword match, and never reselected on
        # resume (see _resolve_work_room_execution_profile). Runtime/HQ rooms are
        # UNTOUCHED below: they keep their exact existing playbook-selected identity.
        try:
            _work_room_profile = await _resolve_work_room_execution_profile(req, conns)
        except Exception as exc:  # noqa: BLE001
            log.warning("[profile-select] resolve failed turn=%s, defaulting to general: %s", req.turn_id, exc)
        _room_kind = str((_work_room_profile or {}).get("room_kind") or "general")
        if _work_room_profile:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "profile_selected", "profile_id": _work_room_profile.get("profile_id"),
                "room_kind": _room_kind, "reason": _work_room_profile.get("reason"),
            })
    else:
        from .hyper.skills import resolve_turn_room_kind
        _room_kind = resolve_turn_room_kind(req.room_mode or "", req.task_tag or "", req.room_goal or "", req.user_message or "")
    _m_recon = canonical_hyper_model(
        getattr(req, "agentic_model", None)
        or os.environ.get("HYPER_MODEL_RECON")
        or os.environ.get("HYPER_ROOM_MODEL", HYPER_FAST_MODEL)
    )

    async def _emit(ev: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        return await _emit_event(req.callback_url, req.turn_id, ev)

    # Quality mode → model combo. 'best' = all gpt-oss-120b (max rigor). 'auto' =
    # cheap gather + debate, strong 120b SYNTHESIS (the synth anchors quality; the
    # gather model barely affects the deliverable — proven by the combo A/B). req.
    # agentic_model (eval) overrides all. All models env-tunable.
    _eval_model = getattr(req, "agentic_model", None)
    if _room_kind == "campaign":
        _qmode = "campaign-efficient"
        _dir_m, _per_m, _syn_m = _campaign_models()
    elif _eval_model:
        _qmode, _dir_m, _per_m, _syn_m = "eval", _eval_model, _eval_model, _eval_model
    else:
        try:
            _qmode = await get_room_quality_mode(req.room_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            _qmode = "auto"
        _dir_m, _per_m, _syn_m = _quality_models(_qmode)
    # Population-sim mode (ADDITIONAL, opt-in) — req.sim_mode (eval override) wins, else the
    # room's stored toggle. Defaults to 'off' so the main flow is untouched. Never raises.
    _sim_mode = str(getattr(req, "sim_mode", "") or "").strip().lower()
    if not _sim_mode:
        try:
            _sim_mode = await get_room_sim_mode(req.room_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            _sim_mode = "off"
    _sim_agents = int(getattr(req, "sim_agents", 0) or 0)
    if _sim_mode in ("on", "simulation", "additional", "true", "1", "yes") and not _sim_agents:
        try:
            _sim_agents = await get_room_sim_agents(req.room_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            _sim_agents = 24
    # Self-evolving employees (ADDITIONAL, opt-in) — req.evo_mode (eval override) wins, else the
    # room's stored toggle. When on, load each participant's GLOBAL playbook (lessons across ALL
    # rooms, on digital_employees) for this turn. Never raises (additive, dormant).
    _evo_mode = str(getattr(req, "evo_mode", "") or "").strip().lower()
    if not _evo_mode:
        try:
            _evo_mode = await get_room_evo_mode(req.room_id, org_id=req.org_id)
        except Exception:  # noqa: BLE001
            _evo_mode = "off"
    # Campaign Intelligence is a permanent specialist Room: its employee and
    # method playbooks must keep learning even when an older room row predates
    # the self-evolve toggle. Other Room types retain their explicit setting.
    if _room_kind == "campaign":
        _evo_mode = "on"
    _evo_playbooks: Dict[str, list] = {}
    # Load prior lessons before execution. Completion is not known yet; the
    # post-report reflection below is where truthful completion is enforced.
    if _evo_mode in ("on", "evolve", "true", "1", "yes"):
        try:
            _p_slugs = [str(p.get("slug")) for p in (participants or []) if p.get("slug")]
            _evo_playbooks = await get_employee_playbooks_map(req.org_id, _p_slugs)
        except Exception:  # noqa: BLE001
            _evo_playbooks = {}
    log.info("[single] room=%s quality=%s sim=%s/%d evo=%s/%d models=(%s, %s, %s)",
             req.room_id, _qmode, _sim_mode, _sim_agents, _evo_mode, len(_evo_playbooks),
             _dir_m, _per_m, _syn_m)

    # FIRST PAINT ≤ ~0.3s: a typing note BEFORE the brief build. The cold brief takes up
    # to 8s and the engine's own first typing only fires after it — the room looked dead
    # from send until then.
    try:
        await _emit({"t": "typing", "agent": (lead or {}).get("slug") or "director",
                     "note": f"{(lead or {}).get('name') or 'The lead'} — on it, pulling the company context…"})
    except Exception:  # noqa: BLE001
        pass

    # Org grounding — recall a standing COMPANY CONTEXT (name, products, customers, market) ONCE
    # before the director plans, so its gather-PLAN (recall_queries + web_query) AND the synthesis
    # are specific to THIS company, not a generic industry. Master+emulation recall (no minted key
    # needed — reaches the org brain); bounded + best-effort so it never stalls or sinks the turn.
    _company_brief = ""
    try:
        _company_brief = await asyncio.wait_for(
            _build_company_brief(req.user_message, req.user_id, req.org_id, "", project_id=req.project_id),
            timeout=8.0,
        )
    except Exception as exc:  # noqa: BLE001 — grounding is best-effort, never fatal
        log.warning("[single] company brief failed (non-fatal): %s", exc)
        _company_brief = ""
    if not _company_brief:
        # One retry with a longer window: an empty brief on a company-scoped task
        # now HARD-FAILS verification (grounding gate), so a transient recall miss
        # is worth 12 more seconds — much cheaper than an escalated turn.
        try:
            _company_brief = await asyncio.wait_for(
                _build_company_brief(req.user_message, req.user_id, req.org_id, "", project_id=req.project_id),
                timeout=12.0,
            )
        except Exception:  # noqa: BLE001
            _company_brief = ""
    # Canonical company identity for the verification gate: the onboarded company
    # name + whether the room is flying blind on company context.
    _company_name = ""
    try:
        _company_name = await get_company_name(req.org_id)
    except Exception:  # noqa: BLE001
        _company_name = ""
    _company_ctx_missing = not (_company_brief or "").strip()
    if _company_ctx_missing:
        await _emit({"t": "warning", "code": "company_context_missing",
                     "note": "No company brief/canon could be recalled — company-specific claims will fail verification."})
    log.info("[single] room=%s company_brief=%d chars company=%s ctx_missing=%s",
             req.room_id, len(_company_brief or ""), _company_name or "-", _company_ctx_missing)

    # Globally connected Gmail is available to every Room for this user and
    # organization. Room toggles still govern optional connector reads, but an
    # explicit Gmail action must not disappear because a per-Room switch is off.
    _sender_email = ""
    _gmail_connected = False
    try:
        connector_state = await runtime_connectors_emulated(user_id=req.user_id, org_id=req.org_id)
        selected_connectors = {str(value).lower().replace("_", "-") for value in connector_state.get("connectors", [])}
        _gmail_connected = "gmail" in selected_connectors or "google-mail" in selected_connectors
        if connector_state.get("provider") == "nango":
            _sender_email = await get_connected_gmail(req.user_id, req.org_id)
            _gmail_connected = _gmail_connected or bool(_sender_email) or await has_connected_gmail(req.user_id, req.org_id)
    except Exception:  # noqa: BLE001
        _sender_email = ""
        _gmail_connected = False
    if _gmail_connected and not any(str(conn).lower().replace("_", "-") == "gmail" for conn in conns):
        conns.append("gmail")

    # The Director selects post-output actions from the live capability catalog.
    # Start neutral so room names/goals and language-specific regexes cannot force
    # a tool. The selected action later determines the deliverable format.
    intended_output = "answer"
    # Room-level learned method lessons (skill sequences that worked for this room
    # kind) prime the planner's skill choice. Best-effort — [] pre-migration.
    _room_playbook: list = []
    try:
        _room_playbook = await get_room_playbook(req.room_id, org_id=req.org_id)
    except Exception:  # noqa: BLE001
        _room_playbook = []
    _room_journal: list = []
    try:
        _room_journal = await get_room_journal(req.room_id, req.org_id)
    except Exception:  # noqa: BLE001
        _room_journal = []
    # Owner-set Swarm Instructions — fetched EVERY turn (not from the request
    # payload) so every dispatch path (chat, task, cycle, flyby) obeys them.
    _room_instructions = ""
    try:
        _room_instructions = await get_room_instructions(req.room_id, org_id=req.org_id)
    except Exception:  # noqa: BLE001
        _room_instructions = ""

    # The legacy direct-answer hook builds the stored employee AgentScope
    # persona.  That lets old employee rows select an unrelated provider/model
    # and creates a second answer call after the Director already gathered the
    # required context.  Keep it as an explicit operator opt-in only; normal
    # Room turns remain on the governed Director/Gateway route.
    async def _direct_answer_via_agent(user_message: str, board_context: str) -> Optional[str]:
        return await _run_direct_answer_agent(
            req.room_id, lead, req.user_id, req.org_id, req.project_id, req.turn_id,
            user_message, board_context,
        )

    # Agentic task engine (dual-engine, 2026-08-13) — flag-gated, default off.
    # Only exercised when the planner routes a turn with execution_engine==
    # "agentic" AND this hook is actually wired (HYPER_AGENTIC_ENGINE=true).
    # Off means Director never even sees a non-None hook, so the branch in
    # engine.py's run() cannot fire — zero behavior change to any room until
    # explicitly turned on.
    async def _agentic_task_via_agent(user_message: str, board_context: str) -> Optional[str]:
        return await _run_agentic_task_agent(
            req.room_id, lead, participants, req.user_id, req.org_id, req.project_id, req.turn_id,
            user_message, board_context, room_kind=_room_kind,
        )

    # 1. RUN THE DIRECTOR — gather → debate → synthesis (emits gather/round_start/
    #    react/swarm_verdict/line, the same events the FE already renders).
    try:
        director_kwargs = {
            "user_message": req.user_message,
            "user_id": req.user_id, "org_id": req.org_id, "project_id": req.project_id,
            "participants": participants, "room_template": room_template,
            "room_goal": req.room_goal, "enabled_connectors": conns, "emit": _emit,
            "director_model": _dir_m, "persona_model": _per_m, "synth_model": _syn_m,
            "sim_mode": _sim_mode, "sim_agents": _sim_agents,
            "evo_mode": _evo_mode, "evo_playbooks": _evo_playbooks,
            "company_brief": _company_brief, "intended_output": intended_output,
            "execution_context": req.execution_context or "",
            "room_kind": _room_kind,
            "room_mode": req.room_mode or "runtime",
            "room_playbook": _room_playbook, "room_journal": _room_journal,
            "room_instructions": _room_instructions,
            "sender_email": _sender_email, "out_language": (req.language or ""),
            "campaign_brief": req.campaign_brief,
            "room_id": req.room_id, "turn_id": req.turn_id,
            "direct_answer_hook": (
                _direct_answer_via_agent
                if str(os.environ.get("HYPER_DIRECT_ANSWER_AGENT_ENABLED", "false")).strip().lower()
                in {"1", "true", "yes", "on"}
                else None
            ),
            "agentic_task_hook": _agentic_task_via_agent if HYPER_AGENTIC_ENGINE else None,
        }
        if _room_kind == "campaign":
            result = await _build_campaign_director(director_kwargs, req.campaign_brief).run()
        else:
            result = await run_director(**director_kwargs)
    except Exception as exc:  # noqa: BLE001 — never crash the turn
        log.warning("[single] director failed: %s", exc)
        if _room_kind == "campaign":
            await _emit({
                "t": "campaign_stage",
                "stage": "contract",
                "status": "failed",
                "title": "Campaign contract could not be completed",
                "detail": "The Room stopped before an executable campaign contract was accepted. Retry this campaign to continue safely.",
            })
        await _emit({"t": "seal", "cost_tokens": 0, "status": "failed",
                     "duration_ms": int((time.time() - started) * 1000)})
        return RoomTurnResponse(ok=False, cost_tokens=0, status="failed")

    cost_tokens = int(result.get("cost_tokens") or 0)
    final_text = str(result.get("final_text") or "")
    transcript = result.get("transcript") or []
    gather_count = int(result.get("gather_count") or 0)
    _io = result.get("io") or {}
    _tok_by = result.get("tok_by") or {}
    intended_output = str(result.get("intended_output") or intended_output or "answer")
    post_output_actions = [
        action for action in (result.get("post_output_actions") or [])
        if isinstance(action, dict) and action.get("explicit") is True
    ][:4]

    # Conversational turns are complete when the lead replies. Do not reinterpret
    # a greeting as an operating task by adding a plan, verifier, journal entry,
    # or second brochure-style final report after the chat fast path returns.
    if result.get("turn_mode") == "chat":
        await _emit({
            "t": "seal", "cost_tokens": cost_tokens, "status": "complete",
            "duration_ms": int((time.time() - started) * 1000), "engine": "single",
            "tokens_in": int(_io.get("input", 0) or 0), "tokens_out": int(_io.get("output", 0) or 0),
            "tokens_cached": int(_io.get("cached", 0) or 0),
            "tok_by": {k: int(v) for k, v in _tok_by.items()}, "quality_mode": _qmode,
        })
        return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status="complete")

    # A campaign tool call is a handoff, not a generic Room deliverable. The
    # dedicated Campaign Room now owns research, debate, compilation and its
    # Campaign Board, so stop this originating turn before doc/email production,
    # verification, next-task generation, or a second generalized report.
    if result.get("campaign_handoff") or result.get("campaign_handoff_error"):
        handoff = result.get("campaign_handoff") or {}
        status = "complete" if handoff else "blocked"
        await _emit({
            "t": "plan", "agent": lead.get("slug"), "intended_output": "campaign_handoff",
            "done_criterion": "Create and dispatch one dedicated Campaign Room",
            "steps": ["Campaign toolkit invoked", "Dedicated Campaign Room dispatched"] if handoff else ["Campaign toolkit invoked"],
            "assignments": {(lead.get("name") or lead.get("slug") or "Director"): "Campaign handoff"},
        })
        await _emit({
            "t": "seal", "cost_tokens": cost_tokens, "status": status,
            "duration_ms": int((time.time() - started) * 1000), "engine": "single",
            "tokens_in": int(_io.get("input", 0) or 0), "tokens_out": int(_io.get("output", 0) or 0),
            "tokens_cached": int(_io.get("cached", 0) or 0),
            "tok_by": {k: int(v) for k, v in _tok_by.items()}, "quality_mode": _qmode,
            "campaign_id": handoff.get("campaign_id"), "campaign_room_id": handoff.get("room_id"),
        })
        return RoomTurnResponse(ok=bool(handoff), cost_tokens=cost_tokens, status=status)

    # Coarse Runtime phases use the Room's normal Director and work executor,
    # then return append-only artifacts to the generic Core predicate engine.
    if isinstance(result.get("room_phase_result"), dict):
        contract = result["room_phase_result"]
        gaps = [str(value) for value in (contract.get("gaps") or []) if str(value).strip()]
        verdict = {
            "met": not gaps and bool(contract.get("artifacts")),
            "artifact_ok": bool(contract.get("artifacts")),
            "assignments_ok": bool(result.get("work_results")),
            "grounded_ok": all(bool(item.get("source_refs")) for item in (contract.get("artifacts") or [])),
            "gaps": gaps,
            "note": "Runtime phase artifacts returned for Core validation.",
            "intended_output": "room_phase_result",
        }
        _PLAN_BY_TURN[req.turn_id] = {"verification": verdict, "room_phase_result": contract}
        await _emit({"t": "verify", **verdict})
        # A Runtime-driven phase is still real Room work the user must be able to READ.
        # This branch previously emitted only verify+seal and returned, so an HQ work
        # order produced discussion + "Verified" and no report at all. Emit the same
        # readable final_report the normal Room path emits, built from the phase's own
        # summary/artifacts, before sealing.
        phase = Director._parse_room_phase_envelope(req.execution_context or "") or {}
        lifecycle = phase.get("lifecycle") if isinstance(phase.get("lifecycle"), dict) else {}
        phase_config = lifecycle.get("execution_config") if isinstance(lifecycle.get("execution_config"), dict) else {}
        if phase_config.get("emit_report") is not False:
            await _emit(_runtime_phase_report(
                user_message=req.user_message or "", contract=contract, result=result,
                room_goal=req.room_goal or "", gaps=gaps,
            ))
        await _emit({
            "t": "seal", "cost_tokens": cost_tokens, "status": "complete",
            "duration_ms": int((time.time() - started) * 1000), "engine": "single-room-phase",
            "tokens_in": int(_io.get("input", 0) or 0), "tokens_out": int(_io.get("output", 0) or 0),
            "tokens_cached": int(_io.get("cached", 0) or 0),
        })
        return RoomTurnResponse(
            ok=True,
            cost_tokens=cost_tokens,
            status="complete",
            verification=verdict,
            artifacts=contract.get("artifacts") or [],
            result=contract,
            summary=str(contract.get("summary") or "")[:4000],
            usage={"input_tokens": int(_io.get("input", 0) or 0),
                   "output_tokens": int(_io.get("output", 0) or 0),
                   "cached_tokens": int(_io.get("cached", 0) or 0)},
        )

    # Runtime stages are governed by the generic Core predicate engine. The Room
    # returns evidence-backed artifacts; it does not duplicate transition logic.
    if isinstance(result.get("runtime_stage_result"), dict):
        contract = result["runtime_stage_result"]
        gaps = [str(value) for value in (contract.get("gaps") or []) if str(value).strip()]
        verdict = {
            "met": not gaps and bool(contract.get("artifacts")),
            "artifact_ok": bool(contract.get("artifacts")),
            "assignments_ok": bool(result.get("work_results")),
            "grounded_ok": all(bool(item.get("source_refs")) for item in (contract.get("artifacts") or [])),
            "gaps": gaps,
            "note": "Runtime stage artifacts returned for Core validation.",
            "intended_output": "runtime_stage_result",
        }
        _PLAN_BY_TURN[req.turn_id] = {"verification": verdict, "runtime_stage_result": contract}
        await _emit({"t": "verify", **verdict})
        # Same as the room-phase branch: a Runtime stage is still readable Room work.
        await _emit(_runtime_phase_report(
            user_message=req.user_message or "", contract=contract, result=result,
            room_goal=req.room_goal or "", gaps=gaps,
        ))
        await _emit({
            "t": "seal", "cost_tokens": cost_tokens, "status": "complete",
            "duration_ms": int((time.time() - started) * 1000), "engine": "single-runtime-stage",
            "tokens_in": int(_io.get("input", 0) or 0), "tokens_out": int(_io.get("output", 0) or 0),
            "tokens_cached": int(_io.get("cached", 0) or 0),
        })
        return RoomTurnResponse(
            ok=True,
            cost_tokens=cost_tokens,
            status="complete",
            verification=verdict,
            artifacts=contract.get("artifacts") or [],
            result=contract,
            summary=str(contract.get("summary") or "")[:4000],
        )

    # HQ work orders have their own deterministic, per-subtask governance. They
    # must not enter the human producer/verifier/report path or be reinterpreted
    # from prose. The typed contract is the only completion surface.
    if isinstance(result.get("work_order_result"), dict):
        contract = result["work_order_result"]
        accepted = contract.get("status") == "completed"
        gaps = [str((g or {}).get("why") or (g or {}).get("criterion") or g)
                for g in (contract.get("gaps") or [])]
        verdict = {
            "met": accepted,
            "artifact_ok": accepted,
            "assignments_ok": bool(contract.get("subtasks")),
            "grounded_ok": accepted,
            "gaps": gaps,
            "note": "HQ work-order contract accepted." if accepted else "HQ work-order contract contains explicit gaps.",
            "intended_output": "work_order_result",
            "work_order_result": contract,
        }
        _PLAN_BY_TURN[req.turn_id] = {"verification": verdict, "work_order_result": contract}
        await _emit({"t": "verify", **verdict})
        await _emit({
            "t": "seal", "cost_tokens": cost_tokens,
            "status": "complete" if accepted else "blocked",
            "duration_ms": int((time.time() - started) * 1000), "engine": "single-work-order",
            "tokens_in": int(_io.get("input", 0) or 0), "tokens_out": int(_io.get("output", 0) or 0),
            "tokens_cached": int(_io.get("cached", 0) or 0),
        })
        return RoomTurnResponse(
            ok=accepted,
            cost_tokens=cost_tokens,
            status="complete" if accepted else "blocked",
            verification=verdict,
            result=contract,
            summary=str(contract.get("report_markdown") or "")[:4000],
        )

    # 2. PLAN — build the plan dict the producer + verifier consume. intended_output +
    # the capability gate were already resolved BEFORE the run (so SYNTH wrote the right format).
    done_txt = req.user_message if (req.room_mode or "").strip().lower() == "work" else (req.room_goal or req.user_message)
    contributions = [
        {"owner": x.get("agent"), "subtask": f"debate round {x.get('round')}",
         "contribution": str(x.get("text") or "")}
        for x in transcript if isinstance(x, dict)
    ]
    # Durable worker results are the source of truth for actual assigned work.
    # Debate remains visible and useful, but no longer masquerades as task completion.
    work_contributions = [
        {"owner": item.get("owner") or item.get("owner_slug") or "Agent",
         "subtask": item.get("title") or "Work order",
         "contribution": str(item.get("text") or "")}
        for item in (result.get("work_results") or [])
        if isinstance(item, dict) and item.get("status") == "completed" and str(item.get("text") or "").strip()
    ]
    if work_contributions:
        contributions = [*work_contributions, *contributions]
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
        # Fallback: the director already searched Gmail and found the recipient's
        # address (e.g. "write Rama …" → it searched to:ramasantoshi1206@gmail.com).
        # Match a named recipient (after a write/email/send/to verb) to a gathered
        # address by local-part — so "Rama" resolves instead of blocking. The send
        # still goes through HITL approval, so a wrong guess can't auto-fire.
        if not _vc:
            gathered = [a for a in (result.get("gathered_emails") or []) if "@" in a]
            rec_names = [m.group(1).lower() for m in re.finditer(
                r"\b(?:write|e-?mail|email|send|tell|draft|message|to|for|cc)\s+([A-Z][a-z]{2,})",
                req.user_message or "")]
            pick = None
            for addr in gathered:
                local = addr.split("@")[0].lower()
                if any(n and (local.startswith(n) or n in local) for n in rec_names):
                    pick = addr
                    break
            if pick:
                _vc = [{"name": pick.split("@")[0], "email": pick, "source": "gmail-context"}]
                log.info("[single] recipient resolved from gathered gmail: %s", pick)

    _PLAN_BY_TURN[req.turn_id] = {
        "intended_output": intended_output,
        "artifact_intent": result.get("artifact_intent"),
        "artifact_receipt": result.get("artifact_receipt"),
        "artifact_steps": [
            {"kind": action.get("artifact_kind"), "capability": action.get("capability")}
            for action in post_output_actions
            if action.get("connected") and action.get("artifact_kind")
        ],
        "post_output_actions": post_output_actions,
        "done_criterion": done_txt,
        "assignments": {c["owner"]: c["subtask"] for c in contributions},
        "execution": contributions,
        "work_orders": result.get("work_orders") or [],
        "work_results": result.get("work_results") or [],
        "outreach_request": result.get("outreach_request"),
        "outreach_metrics": result.get("outreach_metrics") or {},
        "verified_contacts": _vc,
        "enabled_connectors": conns,
        "sender_email": _sender_email,
    }

    # 3. PRODUCE (centralized, idempotent).
    try:
        await _produce_output(req, final_text)
    except Exception as exc:  # noqa: BLE001
        log.warning("[single] produce failed: %s", exc)

    # 4. VERIFY + grounding gate (reuse; the inner _produce_output is idempotent — a cold
    #    first produce that skipped is re-attempted here). Pass the gathered facts (recall +
    #    connector/Gmail reads) so the verifier doesn't flag connector-sourced claims.
    if _room_kind == "campaign":
        accepted = _campaign_result_accepted(result)
        campaign_gaps = [str(gap) for gap in (result.get("campaign_bundle_errors") or []) if str(gap).strip()]
        verdict = {
            "met": accepted,
            "artifact_ok": accepted,
            "assignments_ok": bool(contributions),
            "grounded_ok": accepted,
            "gaps": [] if accepted else (campaign_gaps or ["The deterministic Campaign Contract was not accepted."]),
            "note": "Campaign delivery accepted by governance." if accepted else "Campaign governance found unmet deliverables; nothing was approved.",
            "produced_artifacts": [],
            "pending_writes": [],
            "intended_output": "campaign_contract",
            "done_criterion": done_txt,
        }
        _PLAN_BY_TURN[req.turn_id]["verification"] = verdict
        await _emit({"t": "verify", **verdict})
    elif _room_kind == "hq" and isinstance(result.get("growth_plan_contract"), dict):
        contract = result["growth_plan_contract"]
        baseline_ref = str((contract.get("baseline_ref") or {}).get("resource_id") or "")
        delegation = contract.get("delegation") or {}
        hypotheses = contract.get("hypotheses") or []
        accepted = bool(
            contract.get("contract_version") == "growth-plan.v1"
            and baseline_ref
            and (contract.get("constraint") or {}).get("evidence_refs")
            and 1 <= len(hypotheses) <= 3
            and delegation.get("room_tag")
            and delegation.get("objective")
        )
        verdict = {
            "met": accepted,
            "artifact_ok": accepted,
            "assignments_ok": accepted,
            "grounded_ok": accepted,
            "gaps": [] if accepted else ["The deterministic Growth Stage contract was not accepted."],
            "note": "HQ Growth Stage accepted by deterministic governance." if accepted else "HQ Growth Stage governance rejected the contract.",
            "produced_artifacts": [baseline_ref] if baseline_ref else [],
            "pending_writes": [],
            "intended_output": "growth_plan_contract",
            "done_criterion": done_txt,
        }
        _PLAN_BY_TURN[req.turn_id]["verification"] = verdict
        await _emit({"t": "verify", **verdict})
    elif _room_kind == "seo" and result.get("seo_evidence_governed"):
        artifact_id = str(result.get("seo_artifact_id") or "")
        verdict = {
            "met": True,
            "artifact_ok": bool(artifact_id),
            "assignments_ok": bool(contributions),
            "grounded_ok": bool(artifact_id),
            "gaps": [],
            "note": "SEO evidence accepted by deterministic domain governance.",
            "produced_artifacts": [artifact_id] if artifact_id else [],
            "pending_writes": [],
            "intended_output": intended_output,
            "done_criterion": done_txt,
        }
        _PLAN_BY_TURN[req.turn_id]["verification"] = verdict
        await _emit({"t": "verify", **verdict})
    else:
        try:
            if (req.room_mode or "").strip().lower() == "work":
                await persist_work_room_progress(
                    turn_id=req.turn_id,
                    phase="VERIFYING",
                    identity=req.execution_identity or {},
                    candidate={
                        "contract": "work-room-candidate.v1",
                        "content": final_text,
                        "intended_output": intended_output,
                        "created_at": int(time.time() * 1000),
                    },
                )
            # Single governance pass — one judge call decides met/gaps, full stop.
            # This used to cascade into a rewrite pass + a recheck of that rewrite
            # (up to 3 verify-shaped LLM calls, and before an earlier fix, up to 6
            # across two repair rounds). The empirical 12-turn robustness battery
            # showed the extra rounds didn't reliably improve anything — one run's
            # recheck already said grounded_ok=true and a further round still fired
            # anyway. A judge that finds a real gap should SAY SO (the existing
            # completion_caveat/gaps display already does this honestly), not
            # trigger a second LLM rewriting text it never saw the user's actual
            # bar for. `_verify_and_emit` already stores its verdict onto
            # `plan["verification"]` as a side effect — nothing else to do here.
            _quality_board = {"hit_count": gather_count, "facts": result.get("gather_facts") or []}
            await _verify_and_emit(
                req, lead, final_text=final_text, blackboard=_quality_board, model=_m_recon,
                company_name=_company_name, company_context_missing=_company_ctx_missing,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("[single] verify failed: %s", exc)
            # Fail-SAFE, not fail-open: previously, a crashed/timed-out verifier
            # left `_PLAN_BY_TURN[turn]["verification"]` unset, so `_gv` below
            # evaluated as falsy and `status` silently stayed the default
            # "complete" — an unverified, possibly fabricated answer shipped
            # exactly as if grounding had passed. Record a real failure verdict
            # so the existing withhold path (status in blocked/escalated)
            # treats this like any other failed grounding check, without
            # adding any new constraint on the normal, successful case.
            _PLAN_BY_TURN.setdefault(req.turn_id, {})["verification"] = _verification_failure_result(exc)
    # Drain AFTER produce+verify so a deliverable that only succeeded on the verify-side
    # idempotent retry is still counted. Non-destructive snapshots; post_room_turn emits.
    artifacts = drain_artifacts()
    _visual_receipt = result.get("artifact_receipt")
    if isinstance(_visual_receipt, dict) and _visual_receipt.get("ok") and _visual_receipt.get("url"):
        artifacts.append({
            "connector": "hivemind-artifact",
            "artifact_type": _visual_receipt.get("artifact_type") or "interactive_document",
            "medium": _visual_receipt.get("medium") or "html",
            "artifact_id": _visual_receipt.get("artifact_id"),
            "url": _visual_receipt.get("url"),
            "preview_url": _visual_receipt.get("preview_url"),
            "title": _visual_receipt.get("title") or "Interactive artifact",
            "receipt": _visual_receipt.get("receipt") or {},
        })
    pending = drain_pending_writes()
    _vp = _PLAN_BY_TURN.get(req.turn_id) or {}
    _gv = _vp.get("verification") or {}
    status = "complete"
    if result.get("room_kind") == "campaign" and not _campaign_result_accepted(result):
        status = "blocked"
    elif _vp.get("dead_end"):
        status = "blocked"
    elif _gv and not _gv.get("grounded_ok"):
        status = "escalated"
    elif _gv and not _gv.get("met"):
        status = "blocked"
    # Operational profiles (outreach.prepare.v1, campaign.contract.v1, ...) declare
    # required_artifacts and MUST NOT let a prose report substitute for them — that
    # is the whole point of choosing that profile. Without this check, the line
    # below unconditionally forced status="complete" for ANY work-mode turn with
    # non-empty text, silently discarding even the pre-existing campaign-specific
    # "blocked" verdict computed just above (result.get("room_kind") == "campaign"
    # and not _campaign_result_accepted(result)) the moment campaign ran inside a
    # Work Room. general.answer.v1 and every other non-operational profile are
    # completely unaffected — this only tightens profiles that declared artifacts.
    _operational_profile = bool(_work_room_profile) and bool(_work_room_profile.get("required_artifacts"))
    _operational_incomplete = _operational_profile and (
        (result.get("room_kind") == "campaign" and not _campaign_result_accepted(result))
        or bool(_gv and not _gv.get("met"))
    )
    if (req.room_mode or "").strip().lower() == "work" and final_text.strip() and _operational_incomplete:
        # Never silently pass on prose alone, and never strand the turn either —
        # persist a real terminal state naming exactly what's missing.
        status = "blocked"
        await persist_work_room_progress(
            turn_id=req.turn_id,
            phase="RESPONDING",
            identity=req.execution_identity or {},
            candidate={
                "contract": "work-room-candidate.v1",
                "content": final_text,
                "intended_output": intended_output,
                "quality": "needs_evidence",
            },
            verification=_gv if isinstance(_gv, dict) else {},
            terminal_reason="operational_evidence_incomplete",
        )
        await _emit({
            "t": "completion_caveat",
            "status": "needs_evidence",
            "profile_id": _work_room_profile.get("profile_id"),
            "required_artifacts": _work_room_profile.get("required_artifacts"),
            "gaps": list((_gv or {}).get("gaps") or [])[:8],
            "message": f"{_work_room_profile.get('profile_id')} requires persisted "
                       f"{', '.join(_work_room_profile.get('required_artifacts') or [])} — a report alone cannot "
                       "satisfy it. The prepared work and exact gaps are shown; nothing was silently accepted.",
        })
    elif (req.room_mode or "").strip().lower() == "work" and final_text.strip():
        # Human answers degrade honestly instead of disappearing. Runtime and
        # provider effects retain their strict, predicate-owned status above.
        caveated = bool(_gv) and (not _gv.get("met") or not _gv.get("verification_available", True))
        status = "complete"
        await persist_work_room_progress(
            turn_id=req.turn_id,
            phase="RESPONDING",
            identity=req.execution_identity or {},
            candidate={
                "contract": "work-room-candidate.v1",
                "content": final_text,
                "intended_output": intended_output,
                "quality": "caveated" if caveated else "validated",
            },
            verification=_gv if isinstance(_gv, dict) else {},
            terminal_reason="verification_caveat" if caveated else "validated",
        )
        if caveated:
            await _emit({
                "t": "completion_caveat",
                "status": "complete_with_caveats",
                "gaps": list((_gv or {}).get("gaps") or [])[:8],
                "message": "The best grounded result is available; unresolved evidence or verification limits are shown explicitly.",
            })
    elif _should_withhold_ungrounded_answer(req.room_mode, status, final_text):
        final_text = _grounding_withheld_text((_gv or {}).get("gaps"))

    # The single-engine path must emit the same durable report contract as the
    # legacy orchestrator. CampaignOperatingReport uses this event as its render
    # boundary and enriches it with the separately emitted campaign_bundle. A
    # missing final_report left accepted plans hidden behind raw debate bubbles.
    campaign_bundle = result.get("campaign_bundle") if isinstance(result.get("campaign_bundle"), dict) else {}
    action_items = [
        action.get("title") or action.get("id")
        for action in (campaign_bundle.get("actions") or [])
        if isinstance(action, dict) and (action.get("title") or action.get("id"))
    ]
    await _emit(_build_final_report(
        user_message=req.user_message,
        final_text=final_text,
        template=room_template,
        room_goal=req.room_goal,
        status=status,
        lead=lead,
        action_items=action_items,
    ))

    # Persist compact episodic continuity for every run after the final report exists.
    # This never blocks sealing and is distinct from room/employee operating playbooks.
    if _room_kind != "campaign":
        try:
            _journal_entry = await make_journal_entry(
                req.user_message, final_text, transcript=transcript, participants=participants,
                turn_id=req.turn_id, status=status,
                verdict=_gv if isinstance(_gv, dict) else None,
            )
            if _journal_entry:
                _journal_ok = await append_room_journal_entry(
                    req.room_id, req.org_id, _journal_entry,
                )
                if _journal_ok:
                    await _emit({"t": "room_journal", "entry": _journal_entry})
        except Exception as exc:  # noqa: BLE001
            log.warning("[single] room journal failed (non-fatal): %s", exc)

    # Self-evolving (Loop 1) reflection + write-back. Runs BEFORE the seal so the FE (SSE closes on
    # seal) gets a live self_evolve event. Scores each employee's contribution vs the turn's REAL
    # outcome, then persists to the GLOBAL playbook (digital_employees) — learning compounds across
    # ALL rooms. Best-effort + org-scoped; any failure never blocks the seal.
    if status == "complete" and _evo_mode in ("on", "evolve", "true", "1", "yes"):
        try:
            _outcome = {
                "verdict": _gv if isinstance(_gv, dict) else {},
                "status": status,
                "pending_writes": bool(pending),
                "user_signal": (str(getattr(req, "user_signal", "") or "").strip() or None),
            }
            _merged, _room_lessons = await evo_reflect_and_merge(
                evo_playbooks=_evo_playbooks, transcript=transcript, participants=participants,
                final_text=final_text, outcome=_outcome, reflect_model=None,
                skills_used=list(result.get("skills_used") or []),
                room_kind=str(result.get("room_kind") or ""),
                room_playbook=_room_playbook,
            )
            # ROOM-level method lessons (which skill sequences worked for this room
            # kind) persist on the room itself and prime the next turn's planner.
            if isinstance(_room_lessons, list) and _room_lessons:
                _rok = await update_room_playbook(req.room_id, req.org_id, _room_lessons)
                log.info("[single] room=%s room_playbook persisted=%s lessons=%d",
                         req.room_id, _rok, len(_room_lessons))
            if isinstance(_merged, dict) and _merged:
                _oks = [await update_employee_playbook(req.org_id, str(_slug), _lessons)
                        for _slug, _lessons in _merged.items()]
                ok = any(_oks)
                _names = {str(p.get("slug")): (p.get("name") or p.get("slug")) for p in (participants or [])}
                _evo_emp = []
                for _slug, _lessons in _merged.items():
                    _added = max(0, len(_lessons) - len(_evo_playbooks.get(_slug, [])))
                    _evo_emp.append({"slug": _slug, "name": _names.get(str(_slug), _slug),
                                     "added": _added, "total": len(_lessons)})
                _evo_added_total = sum(e["added"] for e in _evo_emp)
                if ok and _evo_added_total > 0:
                    await _emit({"t": "self_evolve", "employees": _evo_emp,
                                 "added": _evo_added_total, "playbooks": _merged})
                log.info("[single] room=%s evo reflected+persisted=%s employees=%d added=%d status=%s",
                         req.room_id, ok, len(_merged), _evo_added_total, status)
        except Exception as exc:  # noqa: BLE001 — learning must never fail the turn
            log.warning("[single] evo reflection/persist failed (non-fatal): %s", exc)

    # ── Next-task guidance: distill 2-3 clickable follow-up tasks from the
    # sealed report so the user always knows the next move (one click = a new
    # auto-run turn in this room). One cheap 120b call (Cerebras pin), wrapped —
    # a failure never delays the seal.
    if status == "complete" and _room_kind != "campaign" and (final_text or "").strip():
        try:
            _nt_body = {"model": "openai/gpt-oss-120b", "temperature": 0.4, "max_tokens": 400,
                        "response_format": {"type": "json_object"},
                        "messages": [
                            {"role": "system", "content":
                             'From this team report, propose the 2-3 most valuable FOLLOW-UP tasks the user should run next '
                             '(concrete, doable by AI agents with memory + web + email — e.g. "Find 10 prospect firms matching our ICP and fetch contact info", '
                             '"Draft the 3-touch email sequence to the shortlist"). Ground them in the report\'s own gaps/next-steps. '
                             'JSON only: {"tasks":[{"title":"<imperative, <=9 words>","detail":"<1 sentence scope>","tag":"RESEARCH|OUTREACH|MARKETING|STRATEGY"}]}'},
                            {"role": "user", "content": f"ROOM GOAL: {req.room_goal or ''}\n\nREPORT:\n{(final_text or '')[:5000]}"},
                        ]}
            _nt = await _openrouter_chat(_nt_body, timeout=httpx.Timeout(12.0, connect=5.0))
            _nt_content = ((((_nt or {}).get("choices") or [{}])[0]).get("message") or {}).get("content") or "{}"
            _nt_tasks = (json.loads(_nt_content) or {}).get("tasks")
            _nt_tasks = [t for t in (_nt_tasks or []) if isinstance(t, dict) and str(t.get("title", "")).strip()][:3]
            if _nt_tasks:
                await _emit({"t": "next_tasks", "tasks": [
                    {"title": str(t["title"])[:80], "detail": str(t.get("detail", ""))[:220],
                     "tag": str(t.get("tag", "RESEARCH")).upper()[:12]} for t in _nt_tasks]})
        except Exception as exc:  # noqa: BLE001
            log.info("[single] next-task suggestion skipped: %s", exc)

    _seal_ev = {"t": "seal", "cost_tokens": cost_tokens, "status": status,
                "duration_ms": int((time.time() - started) * 1000), "engine": "single",
                "tokens_in": int(_io.get("input", 0) or 0),
                "tokens_out": int(_io.get("output", 0) or 0),
                "tokens_cached": int(_io.get("cached", 0) or 0),
                "tok_by": {k: int(v) for k, v in _tok_by.items()},
                "quality_mode": _qmode,
                # Previously invisible to core — status alone doesn't say WHY a
                # turn was downgraded. Carrying the raw verdict lets core (or any
                # future defense-in-depth check on the seal path) see grounded_ok/
                # met/gaps without re-deriving them.
                "verification": _gv if isinstance(_gv, dict) else {}}
    if _GK_ACTIVE.get(req.turn_id):
        # Goalkeeper owns the seal: stash this round's payload; the loop emits ONE
        # final seal after the last round so the FE stream stays open across re-rounds.
        # Preserve cumulative accounting instead of overwriting prior-round usage.
        _SEAL_BY_TURN[req.turn_id] = _merge_goalkeeper_seal(
            _SEAL_BY_TURN.get(req.turn_id) or {}, _seal_ev,
        )
        while len(_SEAL_BY_TURN) > _SEAL_BY_TURN_CAP:
            _SEAL_BY_TURN.popitem(last=False)
    else:
        await _emit(_seal_ev)
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

    from .hyper.skills import resolve_turn_room_kind
    _room_kind = resolve_turn_room_kind(req.room_mode or "", req.task_tag or "", req.room_goal or "", req.user_message or "")
    if _room_kind == "campaign":
        try:
            participants = _campaign_primary_roster(participants)
        except ValueError as exc:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "error", "code": "campaign_team_required", "message": str(exc),
            })
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "seal", "cost_tokens": 0, "status": "failed",
            })
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
    # Maker kinds (outreach/content/research) + produce outputs → a MAKER leads,
    # not a Skeptic, so a deliverable room writes instead of convening a tribunal.
    try:
        from .hyper.rooms import lead_shape_for
        _rk = _room_kind
        _io = _derive_intended_output(req.user_message or "")
        _prefer_maker = lead_shape_for(_rk, _io) == "maker"
    except Exception:  # noqa: BLE001
        _prefer_maker = False
    lead = forced or _pick_lead_fixed(participants, permanent_lead_id, permanent_skeptic_id, prefer_maker=_prefer_maker)
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

    # ── Single executor — the Groq native-tool-calling director is the ONLY path.
    #    Room template + skeptic + trust above are display metadata on the router
    #    event; the multi-round debate now happens INSIDE the director's `debate`
    #    tool (independent persona sub-calls), not a separate swarm pipeline.
    try:
        _ag_conns = await get_room_enabled_connectors(req.room_id, org_id=req.org_id)
    except Exception:  # noqa: BLE001
        _ag_conns = []
    # ── @MENTION FAST-PATH — "@maya do X" tags ONE employee: she answers directly,
    #    in character, with her global playbook + the org brief + a fresh recall.
    #    No director, no debate, no produce — a direct exchange with that employee
    #    (the room sees it; nothing is journalised/reflected — single voice, no verify).
    _mm = re.match(r"^\s*@([A-Za-z0-9_-]{2,32})\b", req.user_message or "")
    if _mm:
        _tag = _mm.group(1).lower()
        def _first_name(p: Dict[str, Any]) -> str:
            # A blank/missing name → "".split() is [] → [0] IndexError crashed the turn.
            parts = str(p.get("name", "") or "").split()
            return parts[0].lower() if parts else ""
        _target = next((p for p in participants
                        if str(p.get("slug", "") or "").lower() == _tag
                        or _first_name(p) == _tag), None)
        if _target is not None:
            return await _run_mention_turn(req, _target, started)
    else:
        # No explicit @tag — but the SAME direct-answer routing an explicit
        # mention already gets deterministically. Confirmed live 2026-08-12:
        # "@ravi-patel-6 what are our next steps" got a fast, correct,
        # in-character answer; the ask was to route the same way even without
        # typing the tag, when the message is clearly meant for one person.
        try:
            _implicit_target = await _classify_implicit_direct_route(req, participants)
        except Exception as exc:  # noqa: BLE001
            log.warning("[direct-route] classification failed (non-fatal) turn=%s: %s", req.turn_id, exc)
            _implicit_target = None
        if _implicit_target is not None:
            return await _run_mention_turn(req, _implicit_target, started)

    # The room executor: a single Groq native-tool-calling director. Everything above
    # this line (tenant scope, participant resolution, router/template/skeptic/trust) is
    # shared. The legacy AgentScope swarm orchestrator was removed — git history + the
    # box api_hyper_rooms.py.pre-single backup are the rollback; this is the only path.
    return await _orchestrate_single_agent(req, participants, lead, _ag_conns, started, room_template)


async def _run_mention_turn(req: "RoomTurnRequest", emp: Dict[str, Any], started: float) -> RoomTurnResponse:
    """Direct single-employee turn for an @mention. Grounding: cached company brief +
    the employee's GLOBAL learned playbook (lexical top-k on the message) + one recall
    + the room's own journal continuity. One LLM call, events typing → line → seal (the
    same contract the FE renders). Read-only: no artifact produce, no approval gate —
    but the answer IS written back to room_journal (see the end of this function), same
    as every full Director turn. Before that fix (2026-08-12), a tagged reply was
    invisible to every later turn's continuity — a real decision (e.g. "next steps for
    the MOU with Pablo") made here simply never existed for the room to recall."""
    async def _emit(ev: Dict[str, Any]) -> None:
        await _emit_event(req.callback_url, req.turn_id, ev)

    name, lane, sysp = _persona_fields(emp)
    slug = emp.get("slug") or emp.get("id")
    msg = re.sub(r"^\s*@[A-Za-z0-9_-]{2,32}\b[,:]?\s*", "", req.user_message or "").strip() or req.user_message
    await _emit({"t": "typing", "agent": slug, "note": f"{name} — on it…"})

    brief, facts, lessons = "", [], []
    try:
        brief = await asyncio.wait_for(
            _build_company_brief(msg, req.user_id, req.org_id, "", project_id=req.project_id), timeout=8.0)
    except Exception:  # noqa: BLE001
        brief = ""
    try:
        resp = await recall_emulated(msg, user_id=req.user_id, org_id=req.org_id,
                                     api_key="", max_memories=6, project_id=req.project_id)
        rows = resp.get("memories") or resp.get("combined") or []
        facts = [f"- {str(r.get('content') or r.get('summary') or '')[:300]}" for r in rows[:6]
                 if (r.get("content") or r.get("summary"))]
        if facts:
            await _emit({"t": "gather", "sources": ["hivemind"], "memory_hits": len(facts), "query": msg[:160]})
    except Exception:  # noqa: BLE001
        facts = []
    try:
        _pb = await get_employee_playbooks_map(req.org_id, [str(slug)])
        lessons = _evo_recall(_pb.get(str(slug), []), f"{req.room_goal or ''} {msg}")
    except Exception:  # noqa: BLE001
        lessons = []

    sys_parts = [f"You are {name}, a {lane} on this team. {sysp}".strip(),
                 "The user tagged YOU directly in the room — answer them yourself, in character, "
                 "concise and concrete. Ground every specific in the context; never invent facts; "
                 "flag anything unverifiable as UNVERIFIED. No process narration."]
    if brief:
        sys_parts.append(brief[:1500])
    if lessons:
        sys_parts.append("YOUR LEARNED LESSONS (apply them):\n" + "\n".join(f"- {l}" for l in lessons))
    # Event-driven room memory: the last few sealed turns (who asked what, which agent
    # answered what) — read from the turn rows themselves. Without this, "@maya do you
    # agree with jonah?" fails: Jonah's answer lives in the PRIOR turn's events, and the
    # mention prompt never saw it (live-observed miss).
    history = []
    try:
        recent = await get_recent_turn_context(req.room_id, org_id=req.org_id, limit=4)
        for h in recent:
            history.append(f"USER asked: {h['user_message'][:220]}")
            history.append(f"{(h.get('agent') or 'team').upper()} answered: {h['answer'][:700]}")
    except Exception:  # noqa: BLE001
        history = []
    journal_rows = []
    try:
        journal = await get_room_journal(req.room_id, req.org_id)
        for entry in journal:
            journal_rows.append(f"- Asked: {entry.get('asked', '')} | Learned: {entry.get('swarm_summary', '')}")
    except Exception:  # noqa: BLE001
        journal_rows = []
    user_parts = []
    if journal_rows:
        user_parts.append("ROOM JOURNAL — this room's real prior decisions. If asked what the room "
                          "already learned/decided, answer FROM this directly:\n" + "\n".join(journal_rows)[:2500])
    if history:
        user_parts.append("RECENT ROOM DISCUSSION (oldest first — this is what your team already said; "
                          "when asked about a teammate's position, it is HERE):\n" + "\n".join(history)[:3000])
    if facts:
        user_parts.append("RELEVANT COMPANY FACTS:\n" + "\n".join(facts))
    user_parts.append(f"MESSAGE TO YOU: {msg}")

    content, usage = await run_mention_reply(
        [{"role": "system", "content": "\n\n".join(sys_parts)},
         {"role": "user", "content": "\n\n".join(user_parts)}])
    if not content:
        content = f"({name} could not reply this turn — the model was unreachable. Please retry.)"
    tokens = int((usage or {}).get("total", 0))
    await _emit({"t": "line", "agent": slug, "kind": "lead", "content": content})
    await _emit({"t": "seal", "cost_tokens": tokens, "status": "complete",
                 "duration_ms": int((time.time() - started) * 1000), "engine": "mention",
                 "tokens_in": int((usage or {}).get("in", 0)),
                 "tokens_out": int((usage or {}).get("out", 0)),
                 "tokens_cached": int((usage or {}).get("cached", 0))})
    log.info("[mention] room=%s agent=%s tokens=%d", req.room_id, slug, tokens)
    # Same continuity write-back every full Director turn gets — a tagged reply is a
    # real room decision too, and must exist for the next turn's journal to cite.
    try:
        _journal_entry = await make_journal_entry(
            req.user_message, content, transcript=[{"agent": name, "text": content}],
            participants=[{"slug": slug, "name": name}], turn_id=req.turn_id, status="complete",
        )
        if _journal_entry:
            _journal_ok = await append_room_journal_entry(req.room_id, req.org_id, _journal_entry)
            if _journal_ok:
                await _emit({"t": "room_journal", "entry": _journal_entry})
    except Exception as exc:  # noqa: BLE001
        log.warning("[mention] room journal failed (non-fatal): %s", exc)
    return RoomTurnResponse(ok=True, cost_tokens=tokens, status="complete")

async def _resolve_write_policy(req: "RoomTurnRequest") -> str:
    """Phase 4 — pick the write-approval policy for this turn. Explicit
    req.write_policy wins; otherwise gate ("ask") when the room has connectors
    enabled, else "auto" (no side-effectful tools in play)."""
    explicit = (req.write_policy or "").strip().lower()
    if explicit in ("deny", "ask", "auto", "authorized"):
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


def _execution_attempt_budget(execution_context: str) -> tuple[Optional[int], Optional[int]]:
    """Return the playbook attempt budget from either current or legacy envelopes."""
    try:
        envelope = json.loads(str(execution_context or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None, None
    if not isinstance(envelope, dict):
        return None, None
    lifecycle = envelope.get("lifecycle") if isinstance(envelope.get("lifecycle"), dict) else {}
    retry = lifecycle.get("retry_policy") or envelope.get("retry_policy") or {}
    attempt = envelope.get("attempt", lifecycle.get("attempt", retry.get("stage_attempt") if isinstance(retry, dict) else None))
    maximum = envelope.get("max_attempts", retry.get("max_stage_attempts") if isinstance(retry, dict) else None)
    try:
        return max(1, int(attempt)), max(1, int(maximum))
    except (TypeError, ValueError):
        return None, None


def _goalkeeper_rounds_for_room(room_kind: str, *, work_order: bool = False,
                                execution_context: str = "") -> int:
    """Campaign contracts own their repair pass; other Rooms use the goalkeeper."""
    attempt, maximum = _execution_attempt_budget(execution_context)
    if work_order and attempt is not None and maximum is not None:
        return max(1, maximum - attempt)
    return 1 if work_order or str(room_kind or "").strip().lower() == "campaign" else _goalkeeper_max_rounds()


def _goalkeeper_rounds_for_turn(room_kind: str, room_mode: str, *, work_order: bool = False,
                                execution_context: str = "") -> int:
    """Human turns repair their candidate locally; they never replay the full Room."""
    if str(room_mode or "").strip().lower() == "work":
        return 1
    return _goalkeeper_rounds_for_room(
        room_kind, work_order=work_order, execution_context=execution_context,
    )


def _execution_retry_owner(execution_context: str) -> str:
    """Read retry ownership from the private execution envelope.

    Runtime playbooks own semantic retries. Human Work Rooms omit this field and
    retain their adaptive goalkeeper. Legacy envelopes remain readable while old
    in-flight turns drain, but new behavior does not depend on string matching.
    """
    try:
        envelope = json.loads(str(execution_context or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return ""
    if not isinstance(envelope, dict):
        return ""
    lifecycle = envelope.get("lifecycle") if isinstance(envelope.get("lifecycle"), dict) else {}
    policy = lifecycle.get("retry_policy") or envelope.get("retry_policy") or {}
    if isinstance(policy, dict):
        return str(policy.get("owner") or "").strip().lower()
    return ""


def _is_hq_work_order_context(execution_context: str) -> bool:
    """Compatibility classification for already-persisted pre-policy envelopes."""
    if _execution_retry_owner(execution_context) == "playbook":
        return True
    try:
        envelope = json.loads(str(execution_context or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    contract = str(envelope.get("contract") or "") if isinstance(envelope, dict) else ""
    return contract.startswith(("hq-work-order.v", "runtime-stage.v", "room-phase.v"))


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
    # Grounding and report-shape failures receive one local edit + verification
    # pass. Replaying discovery, debate, work orders, and synthesis after that
    # duplicates the whole Room and can multiply token use without adding new
    # evidence. Surface the exact remaining review gap instead.
    if verdict.get("repair_attempted"):
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


class PrewarmRequest(BaseModel):
    room_id: str = ""
    user_id: str
    org_id: str
    project_id: Optional[str] = None
    goal: str = ""
    connectors: List[str] = []


_PREWARM_GUARD: Dict[str, float] = {}  # org|room → last prewarm ts (throttle repeated opens)


@router.post("/prewarm")
async def post_prewarm(
    body: PrewarmRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> Dict[str, Any]:
    """Room-open prewarm — fire-and-forget from the control-plane when a user OPENS a
    room, so by the time they type their first message the caches are hot: the company
    brief (5-probe recall, ~5s cold) and every non-Google connector inspect (~20-30s
    cold MCP spin-up, the dominant initial-latency source). Returns 202-style instantly;
    the warm work runs as a background task. Throttled per (org, room) so FE re-opens /
    refreshes don't stampede the bridge."""
    _require_master_key(x_api_key)
    key = f"{body.org_id}|{body.room_id}"
    now = time.time()
    if now - _PREWARM_GUARD.get(key, 0.0) < 300:
        return {"ok": True, "skipped": "recently prewarmed"}
    _PREWARM_GUARD[key] = now
    if len(_PREWARM_GUARD) > 1024:
        _PREWARM_GUARD.pop(next(iter(_PREWARM_GUARD)), None)

    async def _warm() -> None:
        try:
            await _build_company_brief(body.goal or "", body.user_id, body.org_id, "",
                                       project_id=body.project_id)
        except Exception as exc:  # noqa: BLE001 — prewarm must never surface
            log.info("[prewarm] brief warm failed (non-fatal): %s", exc)
        try:
            from .hyper.engine import _inspect_connector_tools, _norm_connector, _GOOGLE_READ_TOOLS
            need = [n for n in dict.fromkeys(_norm_connector(c) for c in (body.connectors or []))
                    if n not in _GOOGLE_READ_TOOLS]
            if need:
                await asyncio.gather(
                    *[_inspect_connector_tools(n, user_id=body.user_id, org_id=body.org_id) for n in need],
                    return_exceptions=True)
            log.info("[prewarm] room=%s brief+%d connector inspects warm", body.room_id, len(need))
        except Exception as exc:  # noqa: BLE001
            log.info("[prewarm] inspect warm failed (non-fatal): %s", exc)

    asyncio.create_task(_warm())
    return {"ok": True}


@router.post("/room-turn", response_model=RoomTurnResponse)
async def post_room_turn(
    req: RoomTurnRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> RoomTurnResponse:
    _require_master_key(x_api_key)
    if str(req.room_mode or "").strip().lower() == "work":
        identity = req.execution_identity or {}
        if identity:
            if identity.get("contract") != "work-room-execution.v1":
                raise HTTPException(status_code=409, detail="unsupported_work_room_execution_contract")
            try:
                await validate_work_room_execution(identity)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            _EXECUTION_IDENTITY_BY_TURN[req.turn_id] = dict(identity)
            await persist_work_room_progress(
                turn_id=req.turn_id, phase="ACCEPTED", identity=identity,
            )
    # P2 Governor — master kill switch (all orgs, no DB write). Refuse instantly: no LLM
    # spend, no debate, no outbound. Emit a seal so the FE stream closes cleanly.
    if kill_switch_active():
        log.warning("[governor] kill switch ON — refusing room turn %s", req.turn_id)
        if req.callback_url:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "line", "agent": "system", "kind": "disabled", "content": kill_switch_reason()})
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "seal", "status": "disabled", "cost_tokens": 0})
        _EXECUTION_IDENTITY_BY_TURN.pop(req.turn_id, None)
        return RoomTurnResponse(ok=False, cost_tokens=0, status="disabled")
    # Phase 4 — arm the write-approval gate in THIS handler's context so every
    # fanned-out agent task (which copies the context) appends to the same
    # pending list. Sync connector tools read the policy at call time.
    policy = await _resolve_write_policy(req)
    begin_turn_write_gate(policy)
    # P0 — arm per-turn provenance so any fact an agent saves this turn is stamped
    # with its origin (turn/room/org) for the company-brain audit trail.
    set_turn_provenance(turn_id=req.turn_id, room_id=req.room_id, org_id=req.org_id,
                        callback_url=req.callback_url)

    # Phase 6 — goalkeeper loop. Run the full round (plan → simulate → verify);
    # while the verdict is unmet AND the gap is re-plannable, feed the gaps back
    # into the turn message and re-plan, up to a round cap. Same shape as the
    # Claude `/goal` keep-working-toward-the-goal loop.
    from .hyper.skills import resolve_turn_room_kind
    room_kind = resolve_turn_room_kind(req.room_mode or "", req.task_tag or "", req.room_goal or "", req.user_message or "")
    # Campaign Intelligence already performs its own compile/validate/repair pass.
    # Re-running the general goalkeeper duplicates research, debate and synthesis,
    # burns tokens, and can replace a nearly-complete campaign with a later draft.
    # Every other specialist Room keeps its independent goalkeeper policy.
    is_work_order = _is_hq_work_order_context(req.execution_context)
    max_rounds = _goalkeeper_rounds_for_turn(
        room_kind, req.room_mode or "", work_order=is_work_order,
        execution_context=req.execution_context or "")
    orig_msg = req.user_message
    total_cost = 0
    resp: Optional[RoomTurnResponse] = None
    # Seal ordering: while the goalkeeper owns this turn, per-round seals are stashed
    # (not emitted) so the FE stream stays open across re-rounds; ONE final seal — with
    # the TOTAL cost and TRUE duration — goes out after the last round, in `finally`
    # so it can never be lost to an exception between rounds.
    _GK_ACTIVE[req.turn_id] = True
    _gk_started = time.time()
    rnd = 0
    try:
        for rnd in range(1, max_rounds + 1):
            try:
                resp = await asyncio.wait_for(_orchestrate(req), timeout=HYPER_ROOM_ROUND_DEADLINE_SECONDS)
            except asyncio.TimeoutError:
                log.error("[goalkeeper] round=%d exceeded %.0fs deadline (turn=%s) — sealing deadline_exceeded instead of hanging",
                          rnd, HYPER_ROOM_ROUND_DEADLINE_SECONDS, req.turn_id)
                # `_orchestrate` never finished, so it never stashed a seal onto
                # `_SEAL_BY_TURN` — without emitting one here directly, the FE
                # (which only stops polling/rendering on a genuine status change)
                # would stay on "selecting lead and reactors" forever even though
                # the backend gave up. This is the actual fix for the reported
                # hang, not just bookkeeping.
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "line", "agent": "system", "kind": "timeout",
                    "content": "This round took too long to respond and was stopped. "
                               "Please try asking again.",
                })
                await _emit_event(req.callback_url, req.turn_id, {
                    "t": "seal", "status": "deadline_exceeded", "cost_tokens": total_cost,
                    "duration_ms": int((time.time() - _gk_started) * 1000),
                })
                resp = RoomTurnResponse(ok=False, cost_tokens=total_cost, status="deadline_exceeded")
                return resp
            total_cost += int(resp.cost_tokens or 0)
            # P2 Governor — per-turn token ceiling across goalkeeper rounds. Stop a runaway
            # re-plan loop from burning budget; seal the turn cost_capped. 0 = unlimited.
            _tcap = turn_token_cap()
            if _tcap and total_cost >= _tcap:
                log.warning("[governor] turn=%s cost_capped: %d tokens ≥ cap %d — stopping",
                            req.turn_id, total_cost, _tcap)
                resp.status = "cost_capped"
                break
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
            # Re-rounds close GAPS — they never re-simulate the stakeholder population
            # (the sim's report doesn't change; it cost 11-31s per round for nothing).
            req.sim_mode = "off"
    except Exception:
        _EXECUTION_IDENTITY_BY_TURN.pop(req.turn_id, None)
        raise
    finally:
        _GK_ACTIVE.pop(req.turn_id, None)
    # The turn's ONE seal — held past the approvals/artifacts drain below and emitted
    # right before return, so the FE stream (which CLOSES on seal) has already received
    # every approval card + connector_logo button. (First fix emitted it here in the
    # loop's finally — the artifact drain runs after the loop, so connector_logo still
    # landed post-seal into a closed pipe. Verified ordering: ... → connector_logo → seal.)
    _final_seal = _SEAL_BY_TURN.pop(req.turn_id, None)

    if resp is None:  # defensive — loop always runs ≥1
        resp = RoomTurnResponse(ok=False, cost_tokens=0, status="failed")
    resp.cost_tokens = total_cost
    if is_work_order:
        resp.rounds_used = max(1, rnd)

    # Always surface queued approvals — outward SENDS (gmail send/reply, trash)
    # are force-queued regardless of policy, so they must appear even under
    # "auto". docs/sheets never queue (no HITL), so this only carries real sends.
    pending = drain_pending_writes()
    # P2 Governor — outbound cap: one turn cannot fan out more than N outward sends
    # (emails etc.). Excess is dropped + logged; the rest stay HITL-approved. 0 = unlimited.
    _ocap = outbound_cap()
    if _ocap and pending and len(pending) > _ocap:
        log.warning("[governor] turn=%s outbound %d > cap %d — dropping %d excess send(s)",
                    req.turn_id, len(pending), _ocap, len(pending) - _ocap)
        pending = pending[:_ocap]
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
                # Textual content (bounded) → in-app FE Preview popup for ANY
                # textual artifact (email/doc/notion) without leaving the room.
                "body_md": str(art.get("body_md") or "")[:20000] or None,
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
    # LAST event, always: the goalkeeper-held seal (total cost, true duration across
    # all rounds). Everything the FE must render live — approval cards, artifact
    # buttons, the dead-end line — has been emitted above. _emit_event is non-fatal.
    if _final_seal:
        _final_seal["cost_tokens"] = total_cost
        _final_seal["duration_ms"] = int((time.time() - _gk_started) * 1000)
        if rnd > 1:
            _final_seal["gk_rounds"] = rnd
        if resp.status and str(resp.status) != str(_final_seal.get("status")):
            _final_seal["status"] = resp.status  # dead-end downgrade (blocked) wins
        await _emit_event(req.callback_url, req.turn_id, _final_seal)
    _EXECUTION_IDENTITY_BY_TURN.pop(req.turn_id, None)
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
