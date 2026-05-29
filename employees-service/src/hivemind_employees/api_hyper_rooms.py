"""Hyper Agents — Rooms orchestrator.

Slack/WhatsApp-style multi-agent workspace running Cognitive Swarm
Intelligence on the HIVEMIND substrate. Called by the control-plane's
POST /v1/hyper-rooms/:id/turns; this endpoint runs the actual debate:

    1. Router picks a Lead (closest CSI lane to the user_message)
    2. Lead generates full response (reuses build_react_agent, so the
       MCP tools — hivemind_recall, hivemind_web_research, etc — are
       all available).
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
from typing import Any, Dict, List, Optional, Set

import httpx
from agentscope.agent import ReActAgent
from agentscope.message import Msg
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .agents.agentscope_factory import build_react_agent
from .bootstrap_client import fetch_bootstrap
from .config import get_settings
from .db import (
    get_permanent_skeptic_id,
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
# + time travel; web is gated by prompt ("only when info isn't here").
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
    "hivemind_web_search",
    "hivemind_web_research",
]

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

# ─── A1 decision sink — explicit save-intent regex ───
_SAVE_INTENT_RE = re.compile(
    r"\b(save (this|that|it)|remember (this|that)|log (this|that)|"
    r"write (this|that) (down|to memory)|capture this)\b",
    re.IGNORECASE,
)

# Decision-template flag — set via room metadata later. For now: any
# turn that closes with verdict=resolved OR explicit save-intent.


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
) -> ReActAgent:
    """Cache one agent per (room, employee) so memory carries across turns.

    Overrides the employee's `tools` list with the full HIVEMIND toolset
    (read paths + save + time-travel + web) so swarm agents have the
    same reach as the MCP-driven Talk-to-HIVE assistant.
    """
    key = f"{room_id}:{emp['id']}"
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
            "tools": DEFAULT_HYPER_TOOLS,
            "hyper": boot_emp.get("hyper"),
            "active_prompt_version": boot_emp.get("active_prompt_version"),
        }
        agent = build_react_agent(merged, "", user_id=user_id, org_id=org_id)
        _ROOM_AGENTS[key] = agent
        return agent
    merged = {
        **emp,
        # Force the full hyper toolkit regardless of what's stored on the
        # employee row — gives every swarm participant equal reach.
        "tools": DEFAULT_HYPER_TOOLS,
        "hyper": boot_emp.get("hyper"),
        "active_prompt_version": boot_emp.get("active_prompt_version"),
    }
    agent = build_react_agent(merged, api_key, user_id=user_id, org_id=org_id)
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
  "line": "..."   // ONE sentence, max ~25 words, Slack tone
}

Hard rules:
- ONE sentence, ~25 words max. Conversational, 'we / our' voice, no headers, no bullets.
- The line must be a CONCRETE point, fact, risk, or counter — NOT a suggestion to do
  something later. BANNED: "let's recall", "we should consider", "let's clarify",
  "let's also look at", "we need to check". If all you have is a process suggestion,
  stay silent: {"react": false}.
- Cite concrete evidence when challenging — name the memory or person.
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
) -> Dict[str, Any]:
    """Returns a dict like
        {"react": bool, "agreement": str|None, "confidence": float, "line": str}
    """
    bias = " (Your lane is opposing the Lead's — speak up if you have a real challenge.)" if is_opposing else ""
    prompt = (
        f"{REACTOR_INSTRUCTIONS}\n"
        f"User asked: {user_message}\n\n"
        f"Lead ({lead_name}, lane {reactor_lane}'s opposite={is_opposing}) said:\n"
        f"{lead_line}\n\n"
        f"Your lane: {reactor_lane}.{bias}\n"
        f"Reply with the JSON now."
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


class RoomTurnResponse(BaseModel):
    ok: bool
    cost_tokens: int
    status: str


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
        "  4. silent: if memory thin, hivemind_web_research(focused query)\n"
        "  5. write with at least 2 cited memory_ids + 1 fact from web if used\n"
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


HYPER_ROOM_MAX_TOOL_CALLS = int(os.environ.get("HYPER_ROOM_MAX_TOOL_CALLS", "80"))

# Wall-clock budget for a whole swarm turn. The 1.5s/agent stagger repeats
# per round (R1/R2/R3/R5-vote); under a 429 storm the per-call retries stack
# on top, so a turn can run for minutes and blow past the control-plane's SSE
# turn timeout — the user sees a half-streamed turn that never seals. Keep
# this a few seconds under the control-plane timeout so the seal wins the race.
HYPER_ROOM_MAX_WALL_SECONDS = float(os.environ.get("HYPER_ROOM_MAX_WALL_SECONDS", "150"))


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

Your task: synthesise the final answer for the user.
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
                               api_key: str = "", max_memories: int = 25) -> str:
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
                                         api_key=api_key, max_memories=8)
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
                              cost_tokens_initial: int, started: float) -> "RoomTurnResponse":
    """Fixed R1-R5 phase machine. Returns RoomTurnResponse."""
    cost_tokens = cost_tokens_initial
    tool_call_counts: Dict[str, int] = {}
    evidence_pool: Set[str] = set()

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
            agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id)
            prompt = R1_HYPOTHESIS_PROMPT.format(
                persona_name=emp.get("name", emp.get("slug")),
                lane=emp["_lane"],
                lane_playbook=LANE_PLAYBOOKS.get(emp["_lane"], ""),
                candidate_memories=memory_context or "(no pre-fetched memories)",
                user_message=req.user_message,
            )
            reply = await agent(Msg(name="user", content=prompt, role="user"))
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
        await asyncio.sleep(1.5 * idx)
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
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_start", "round": 2, "label": "Peer Cross-Exam",
        "task": "Each agent reviews 2 OTHER hypotheses with corroborating or contradicting evidence.",
    })
    hyp_table = "\n".join(
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
            agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id)
            prompt = R2_PEER_REVIEW_PROMPT.format(
                persona_name=emp.get("name", emp.get("slug")),
                lane=emp["_lane"],
                hypotheses_table=hyp_table,
                target_ids=", ".join(target_ids),
            )
            reply = await agent(Msg(name="user", content=prompt, role="user"))
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
                # Older prompts emitted "support"; map it to "agree" so the
                # debate/R3 accountability and downstream "== challenge" checks
                # see a consistent vocabulary.
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
        await asyncio.sleep(1.5 * idx)
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
            "round": 2,
        })
    log.info("[swarm] R2 done turn=%s reviews=%d capped=%s", req.turn_id, len(peer_reviews), cost_cap_hit)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_end", "round": 2, "reviews_count": len(peer_reviews),
    })

    # ─── R3 — Deep Chain-of-Thought ────────────────────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_start", "round": 3, "label": "Deep Chain-of-Thought",
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
            agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id)
            prompt = R3_DEEP_DIVE_PROMPT.format(
                persona_name=emp.get("name", emp.get("slug")),
                lane=emp["_lane"],
                your_hypothesis=own["hypothesis"],
                your_reviews=reviews_text,
                lane_playbook=LANE_PLAYBOOKS.get(emp["_lane"], ""),
            )
            reply = await agent(Msg(name="user", content=prompt, role="user"))
            text = _msg_to_text(reply)
            m = re.search(r"\{[\s\S]+\}", text)
            parsed = json.loads(m.group(0)) if m else None
            if not isinstance(parsed, dict) or not parsed.get("refined_hypothesis"):
                return None
            ev_ids = [str(x) for x in (parsed.get("evidence_memory_ids") or []) if x]
            for e in ev_ids:
                evidence_pool.add(e)
            steps = [str(s)[:300] for s in (parsed.get("chain_of_thought") or [])][:8]
            refined = {
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
            return refined
        except Exception as exc:
            log.warning("[swarm] R3 %s failed: %s", emp.get("slug"), exc)
            return None

    async def _staggered_r3(emp, idx):
        await asyncio.sleep(1.5 * idx)
        return await _run_r3(emp)
    if not cost_cap_hit and _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
        cost_cap_hit = True
        log.warning("[swarm] cost cap hit before R3 turn=%s total=%d cap=%d",
                    req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "cost_cap_hit", "total": _turn_tool_total(),
            "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": 3,
        })
    elif not cost_cap_hit and await _deadline_hit(3):
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
            "round": 3,
        })
    log.info("[swarm] R3 done turn=%s refined=%d capped=%s", req.turn_id, len(refined), cost_cap_hit)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_end", "round": 3, "refined_count": len(refined),
    })

    # ─── R4 — Skeptic Unorthodox Challenge ─────────────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_start", "round": 4, "label": "Skeptic Unorthodox Challenge",
        "task": "Permanent Skeptic surfaces hidden assumptions + unorthodox alternatives.",
    })
    skeptic_output: Dict[str, Any] = {"challenges": [], "unorthodox_alternatives": [], "hidden_assumptions": []}
    if not cost_cap_hit and _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
        cost_cap_hit = True
        log.warning("[swarm] cost cap hit before R4 turn=%s total=%d cap=%d",
                    req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "cost_cap_hit", "total": _turn_tool_total(),
            "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": 4,
        })
    elif not cost_cap_hit and await _deadline_hit(4):
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
            "round": 4,
        })
    log.info("[swarm] R4 done turn=%s challenges=%d unorthodox=%d capped=%s",
             req.turn_id, len(skeptic_output["challenges"]),
             len(skeptic_output["unorthodox_alternatives"]), cost_cap_hit)
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_end", "round": 4,
        "challenges_count": len(skeptic_output["challenges"]),
        "unorthodox_count": len(skeptic_output["unorthodox_alternatives"]),
    })

    # ─── R5 Step A — Convergence Vote (parallel) ───────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "round_start", "round": 5, "label": "Convergence Vote + Synthesis",
        "task": "Everyone votes on refined hypotheses or unorthodox alternatives. Lead synthesises.",
    })
    # If R3 was skipped (cost-capped before refinement) `refined` is empty.
    # Voting on "(no refined hypotheses)" makes every agent emit "none" /
    # hallucinated ids and the winning synthesis references hypotheses that
    # were never surfaced. Fall back to the R1 hypotheses so there is always
    # a real, voteable table with valid ids.
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
    skeptic_output_str = json.dumps(skeptic_output, indent=2)[:3000]
    voters = list(participants)  # everyone votes

    async def _run_vote(emp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            agent = await _build_agent_for_room(req.room_id, emp, user_id=req.user_id, org_id=req.org_id)
            prompt = R5_VOTE_PROMPT.format(
                persona_name=emp.get("name", emp.get("slug")),
                lane=emp["_lane"],
                refined_hypotheses_table=refined_table_str,
                skeptic_output=skeptic_output_str,
            )
            reply = await agent(Msg(name="user", content=prompt, role="user"))
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
        await asyncio.sleep(1.5 * idx)
        return await _run_vote(emp)
    if not cost_cap_hit and _turn_tool_total() >= HYPER_ROOM_MAX_TOOL_CALLS:
        cost_cap_hit = True
        log.warning("[swarm] cost cap hit before R5 vote turn=%s total=%d cap=%d",
                    req.turn_id, _turn_tool_total(), HYPER_ROOM_MAX_TOOL_CALLS)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "cost_cap_hit", "total": _turn_tool_total(),
            "cap": HYPER_ROOM_MAX_TOOL_CALLS, "skipped_from_round": 5,
        })
    elif not cost_cap_hit and await _deadline_hit(5):
        cost_cap_hit = True
    votes: List[Dict[str, Any]] = []
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
            "round": 5,
        })

    consensus = _consensus_verdict(votes, trust_by_slug)

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
            lead_agent = await _build_agent_for_room(req.room_id, lead, user_id=req.user_id, org_id=req.org_id)
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
            )
            synth_reply = await lead_agent(Msg(name="user", content=synth_prompt, role="user"))
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
    return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)


# ─── Main orchestrator ─────────────────────────────────────────────────


async def _orchestrate(req: RoomTurnRequest) -> RoomTurnResponse:
    """Run one room turn. Emits JSONL events to the control-plane along
    the way, returns the final cost + status.
    """
    started = time.time()
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
    raw_seq = await get_turn_seq(req.turn_id, org_id=req.org_id)
    if raw_seq is None:
        # No seq available (missing row / NULL / pre-migration column / DB
        # error). Falling back to a fixed 0 would freeze rotation onto the
        # alphabetically-first lead forever. Derive a deterministic-but-
        # varying ordinal from the turn id so rotation still cycles, and
        # surface the degraded path so it's observable.
        seq = (int(hashlib.sha1(req.turn_id.encode("utf-8")).hexdigest(), 16) % 997) + 1
        log.warning("[hyper] get_turn_seq returned None for turn=%s — using hashed ordinal %d",
                    req.turn_id, seq)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "warning", "code": "turn_seq_unavailable", "fallback_seq": seq,
        })
    else:
        seq = raw_seq
    permanent_skeptic_id = await get_permanent_skeptic_id(req.room_id, org_id=req.org_id)
    # Lead: @mention override wins; otherwise rotate by seq, excluding a
    # locked permanent skeptic so the skeptic is never auto-elected lead.
    lead = forced or _pick_lead_rotating(
        participants, req.user_message, seq, permanent_skeptic_id,
    )
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

    await _emit_event(req.callback_url, req.turn_id, {
        "t": "router",
        "lead": lead.get("slug"),
        "reactors": [r.get("slug") for r in reactors],
        "lanes": {p.get("slug"): p["_lane"] for p in participants},
        "template": room_template,
        "trust": trust_by_slug,
        "skeptic": skeptic.get("slug") if skeptic else None,
        "turn_seq": seq,
    })

    # ── Swarm template — branch into R1-R5 phase machine ──────────────
    if room_template == "swarm":
        # Best-effort pre-fetch memory context for R1 (shared across all agents).
        # Recall via master+emulation (req.user_id/org_id) so it reaches the
        # org brain regardless of whether bootstrap minted a lead key.
        memory_context_swarm = ""
        try:
            boot_map = {b["id"]: b for b in await fetch_bootstrap()}
            lead_api_key = (boot_map.get(lead["id"], {}) or {}).get("api_key", "") or ""
            company_brief = await _build_company_brief(
                req.user_message, req.user_id, req.org_id, lead_api_key)
            recall_resp = await recall_emulated(
                req.user_message, user_id=req.user_id, org_id=req.org_id,
                api_key=lead_api_key, max_memories=6)
            rows = recall_resp.get("memories") or recall_resp.get("combined") or []
            rows = [r for r in rows if float(r.get("score", 0)) >= 0.45]
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
            memory_context_swarm = (company_brief + candidate_block).strip()
            if memory_context_swarm:
                memory_context_swarm += "\n"
        except Exception as exc:  # noqa: BLE001
            log.warning("[swarm] pre-fetch failed: %s", exc)
        return await _orchestrate_swarm(
            req, participants, lead, skeptic,
            memory_context_swarm, room_template,
            cost_tokens, started,
        )

    # ── Pre-fetch HIVEMIND context (grounded RAG) ───────────────────
    # Don't rely on the agent's tool calls — Groq/llama function-call
    # reliability varies. Pull recall results server-side and inject
    # them into the lead prompt so the agent ALWAYS sees relevant
    # memories without needing to emit a tool call first.
    memory_context = ""
    try:
        boot_map = {b["id"]: b for b in await fetch_bootstrap()}
        lead_api_key = (boot_map.get(lead["id"], {}) or {}).get("api_key", "") or ""
        # Broad standing brief first (who/what/why), then the query-specific
        # candidate memories on top. Recall via master+emulation so it reaches
        # the org brain regardless of whether bootstrap minted a lead key.
        company_brief = await _build_company_brief(
            req.user_message, req.user_id, req.org_id, lead_api_key)
        recall_resp = await recall_emulated(
            req.user_message, user_id=req.user_id, org_id=req.org_id,
            api_key=lead_api_key, max_memories=6)
        rows = recall_resp.get("memories") or recall_resp.get("combined") or []
        # Drop low-relevance hits so a single dominant memory (long
        # AUDIT memo etc.) doesn't crowd out diverse signal.
        MIN_SCORE = 0.45
        rows = [r for r in rows if float(r.get("score", 0)) >= MIN_SCORE]
        candidate_block = ""
        if rows:
            lines_out = []
            for r in rows[:5]:
                title = (r.get("title") or "").strip()
                content = (r.get("content") or "").replace("\n", " ").strip()
                if not content:
                    continue
                # Shorter snippet — was 1200, now 300. Lead can ask
                # for full memory via recall tool if needed.
                snippet = content[:300] + ("…" if len(content) > 300 else "")
                prefix = f'"{title}" — ' if title else ""
                lines_out.append(f"- {prefix}{snippet}")
            if lines_out:
                candidate_block = (
                    "CANDIDATE MEMORIES (most relevant to the user's question):\n"
                    + "\n".join(lines_out)
                    + "\n"
                )
        memory_context = (company_brief + candidate_block).strip()
        if memory_context:
            memory_context += "\n"
    except Exception as exc:  # noqa: BLE001
        log.warning("hyper-rooms pre-fetch recall failed: %s", exc)

    # ── Lead generates full response ─────────────────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "typing", "agent": lead.get("slug"), "kind": "lead",
    })
    lead_text = ""
    lead_agent = None
    lead_prompt = ""
    try:
        lead_agent = await _build_agent_for_room(req.room_id, lead, user_id=req.user_id, org_id=req.org_id)
        # Provide CSI persona framing in the user-prompt wrapper so we
        # don't have to mutate the agent's underlying system prompt.
        # Chat-tone constraints — this is a Slack-style room, NOT a memo.
        if memory_context:
            grounding = (
                "GROUNDING — you ALREADY have the relevant memories above.\n"
                "- Answer NOW directly from them. Do NOT announce, narrate, or plan tool calls.\n"
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
                "tokens": r_tokens,
            }
            reactions.append({**event, "emp": r_emp})
            await _emit_event(req.callback_url, req.turn_id, event)


    # ── Synthesis round (always when reactors spoke) ────────────────
    # Reactors emit suggestion lines ("we should recall X", "what's the next
    # step"). Without a closer, the turn ends on those suggestions — the
    # user sees prompts to do work, not the work itself. Synthesis lets the
    # lead absorb the reactor lines + actually exercise tools (recall /
    # traverse) and produce one final actionable bubble.
    synth_text = ""
    if reactions:
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
                + (memory_context + "\n" if memory_context else "")
                + f"USER'S ORIGINAL QUESTION:\n\"{req.user_message}\"\n\n"
                f"YOUR EARLIER LEAD LINE:\n\"{lead_text}\"\n\n"
                f"REACTOR LINES:\n{reactor_summary}\n\n"
                f"INTEGRATE the reactor signal into your answer to the user — do NOT pivot to a "
                f"project plan with owners/dates unless the user asked for one.\n"
                f"  • If a reactor surfaced a NEW fact from memory → fold it in and cite the title.\n"
                f"  • If a reactor challenged a claim → defend with a memory hit, or concede.\n"
                f"  • If a reactor's point is outside scope of the user's question → ignore it.\n"
                f"  • Need more grounding? Call hivemind_recall / traverse_graph silently first.\n\n"
                f"OUTPUT: 3-5 short sentences. Stay on the user's question. Chat tone, 'we / our'.\n"
                f"Quote memory titles inline. NEVER invent owners, dates, or deadlines. No 'happy to "
                f"help' fluff.\n"
                + (f"\nTEMPLATE-SPECIFIC OUTPUT REQUIREMENT ({room_template}):\n"
                   f"{get_template_overlay(room_template).get('synth_hint', '')}\n"
                   if get_template_overlay(room_template).get('synth_hint') else "")
            )
            synth_reply = await lead_agent(Msg(name="user", content=synth_prompt, role="user"))
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
                "tokens": r_tokens,
            }
            reactions.append({**event, "emp": r_emp})
            await _emit_event(req.callback_url, req.turn_id, event)

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

    while challenger_reaction and debate_round <= MAX_DEBATE_ROUNDS:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "typing", "agent": lead.get("slug"), "kind": "revise",
        })
        try:
            revise_prompt = (
                f"[CSI revision pass round {debate_round} — HIVEMIND employee. Lane: {lead['_lane']}.]\n"
                f"USER'S ORIGINAL QUESTION: \"{req.user_message}\"\n"
                f"{challenger_reaction['emp'].get('name')} ({challenger_reaction['emp']['_lane']}) pushed back:\n"
                f"\"{current_challenge_text}\"\n\n"
                f"Reconsider. If right, concede + revise. If standing by, defend with a memory "
                f"hit — quote the title. No invented owners / dates. Stay on the user's question. "
                f"2-4 sentences, chat tone, 'we / our'."
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
                f"{lead.get('name')} responded to your challenge:\n"
                f"\"{revise_text}\"\n\n"
                f"Did the lead resolve your concern with concrete memory evidence, or is the gap "
                f"still real?\n"
                f"Reply in STRICT JSON:\n"
                f'{{"verdict": "resolved" | "escalate", "line": "1-2 sentences (cite a memory if escalating)"}}'
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
                        }
            except Exception as exc:  # noqa: BLE001
                log.warning("validate JSON parse failed turn=%s: %s — defaulting to resolved",
                            req.turn_id, exc)
            v_tokens = max(80, len(verdict_obj.get("line", "")) // 4)
            cost_tokens += v_tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "validate",
                "agent": challenger_reaction["emp"].get("slug"),
                "round": debate_round,
                "verdict": verdict_obj["verdict"],
                "content": verdict_obj["line"],
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
            if _challenge_repeats(current_challenge_text, next_challenge):
                no_progress += 1
            else:
                no_progress = 0
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
    if should_save and final_text:
        trigger = "save-intent" if save_intent else "verdict-resolved"
        saved_memory_id = await _save_room_decision(
            user_id=req.user_id,
            org_id=req.org_id,
            room_id=req.room_id,
            turn_id=req.turn_id,
            user_message=req.user_message,
            decision_text=final_text,
            trigger=trigger,
        )
        if saved_memory_id:
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "decision_saved",
                "memory_id": saved_memory_id,
                "trigger": trigger,
            })

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
    log.info(
        "[room] seal turn=%s status=%s template=%s cost=%d quality_low=%s",
        req.turn_id, status, room_template, cost_tokens, quality_low,
    )
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "seal",
        "cost_tokens": cost_tokens,
        "status": status,
        "duration_ms": int((time.time() - started) * 1000),
        "quality_low": quality_low,
        "saved_memory_id": saved_memory_id,
        "trust": trust_deltas,
        "template": room_template,
    })
    return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)


@router.post("/room-turn", response_model=RoomTurnResponse)
async def post_room_turn(
    req: RoomTurnRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> RoomTurnResponse:
    _require_master_key(x_api_key)
    return await _orchestrate(req)
