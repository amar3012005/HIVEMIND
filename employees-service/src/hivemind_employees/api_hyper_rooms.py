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
import json
import logging
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
from .db import list_running_employees

log = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/hyper", tags=["hyper-rooms"])


# ─── Budget constants ────────────────────────────────────────────────
# User requested unlimited — using very large caps as a runaway safety
# net only. Effectively no per-line constraint at typical LLM context
# windows (128k Groq / 200k Anthropic).

LEAD_MAX_TOKENS = 100_000
REACTOR_MAX_TOKENS = 100_000
REVISE_MAX_TOKENS = 100_000
TURN_COST_CAP = 10_000_000  # 10M = effectively unlimited per turn
MAX_REACTORS = 2
ROUND_2_CHALLENGE_THRESHOLD = 0.7

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


def _score_lane_against_message(lane: str, message: str) -> int:
    """Crude scorer — how well a lane matches the user message keywords."""
    lo = message.lower()
    return sum(1 for h in ROLE_LANE_HINTS.get(lane, []) if h in lo)


def _pick_lead(participants: List[Dict[str, Any]], user_message: str) -> Dict[str, Any]:
    """Pick the highest-scoring participant; deterministic tie-break by slug."""
    if not participants:
        raise ValueError("no participants")
    scored = [
        (p, _score_lane_against_message(p["_lane"], user_message), p.get("slug", ""))
        for p in participants
    ]
    scored.sort(key=lambda t: (-t[1], t[2]))
    return scored[0][0]


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


async def _build_agent_for_room(room_id: str, emp: Dict[str, Any]) -> ReActAgent:
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
    if not api_key:
        raise HTTPException(412, f"employee {emp.get('slug')} has no bootstrap api_key")
    merged = {
        **emp,
        # Force the full hyper toolkit regardless of what's stored on the
        # employee row — gives every swarm participant equal reach.
        "tools": DEFAULT_HYPER_TOOLS,
        "hyper": boot_emp.get("hyper"),
        "active_prompt_version": boot_emp.get("active_prompt_version"),
    }
    agent = build_react_agent(merged, api_key)
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
        return "\n".join(p for p in parts if p).strip()
    return (content or "").strip()


# ─── Reactor "quiet-check" — cheap JSON pass ───────────────────────────

REACTOR_INSTRUCTIONS = """\
You are participating in a Slack-style workspace chat alongside other expert
agents. The Lead just answered the user. Decide if YOU — given your role and
expertise — would speak up. Default to silence unless you add real value.

Reply in STRICT JSON ONLY (no preamble, no code fence):
{
  "react": true | false,         // true if you would speak up
  "agreement": "agree" | "extend" | "challenge",  // omit if react=false
  "confidence": 0.0 - 1.0,        // your confidence in the position
  "line": "..."                   // ONE sentence, max ~25 words, Slack tone
}

Hard rules:
- ONE sentence. Conversational, lowercase first word OK, no headers, no bullets.
- "challenge" only if you have a substantive counterpoint or risk.
- "extend" if you concretely build on the Lead's point.
- "agree" only if you add a real +1 (skip if you'd just say 'I agree').
- Match your role's voice — Skeptic challenges, Researcher cites data,
  Builder asks "how", Communicator translates, Strategist re-frames.
- If silent, return {"react": false} and nothing else.
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
            "line": line[:600],
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


# ─── Main orchestrator ─────────────────────────────────────────────────


async def _orchestrate(req: RoomTurnRequest) -> RoomTurnResponse:
    """Run one room turn. Emits JSONL events to the control-plane along
    the way, returns the final cost + status.
    """
    started = time.time()
    cost_tokens = 0
    status = "complete"

    # Look up participating employees (running set)
    running = {r["id"]: r for r in await list_running_employees()}
    participants: List[Dict[str, Any]] = []
    for pid in req.participant_ids:
        emp = running.get(pid)
        if not emp:
            continue
        emp["_lane"] = derive_lane(emp)
        participants.append(emp)

    if not participants:
        await _emit_event(
            req.callback_url, req.turn_id,
            {"t": "error", "message": "No running employees in room"},
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
    lead = forced or _pick_lead(participants, req.user_message)
    reactors = _pick_reactors(participants, lead)

    await _emit_event(req.callback_url, req.turn_id, {
        "t": "router",
        "lead": lead.get("slug"),
        "reactors": [r.get("slug") for r in reactors],
        "lanes": {p.get("slug"): p["_lane"] for p in participants},
    })

    # ── Lead generates full response ─────────────────────────────────
    await _emit_event(req.callback_url, req.turn_id, {
        "t": "typing", "agent": lead.get("slug"), "kind": "lead",
    })
    lead_text = ""
    try:
        lead_agent = await _build_agent_for_room(req.room_id, lead)
        # Provide CSI persona framing in the user-prompt wrapper so we
        # don't have to mutate the agent's underlying system prompt.
        # Chat-tone constraints — this is a Slack-style room, NOT a memo.
        lead_prompt = (
            f"[CSI swarm — your lane: {lead['_lane']}. You're the LEAD this turn.]\n\n"
            f"GROUND YOUR ANSWER IN HIVEMIND FIRST:\n"
            f"- Call hivemind_recall (or hivemind_query_with_ai for multi-hop) BEFORE you answer if the user is asking about facts, preferences, projects, decisions, or history.\n"
            f"- Use hivemind_list_memories / hivemind_traverse_graph to pull connected context when the topic is a known entity.\n"
            f"- Call hivemind_web_search or hivemind_web_research ONLY when the answer is clearly not in HIVEMIND (e.g. live news, current pricing, public companies you haven't tracked).\n"
            f"- Save durable conclusions with hivemind_save_memory at the end of your turn when warranted.\n\n"
            f"WRITE LIKE A CHAT MESSAGE:\n"
            f"- Maximum 3-4 short sentences, OR a brief structured answer if the user asks for a plan/list.\n"
            f"- First person, conversational, no formal opener.\n"
            f"- Bullets only if the user asked for a list; max 5 items.\n"
            f"- No 'Next steps:' boilerplate or 'How would you like to proceed?' closers.\n"
            f"- Skip preamble — substance in sentence one.\n\n"
            f"User said:\n{req.user_message}"
        )
        reply = await lead_agent(Msg(name="user", content=lead_prompt, role="user"))
        lead_text = _msg_to_text(reply) or "(no response)"
    except Exception as exc:  # noqa: BLE001
        log.exception("lead failure: %s", exc)
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "error", "agent": lead.get("slug"), "message": str(exc), "retryable": True,
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

    if cost_tokens >= TURN_COST_CAP:
        status = "cost_capped"
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "seal", "cost_tokens": cost_tokens, "status": status,
        })
        return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)

    # ── Reactors (parallel) ──────────────────────────────────────────
    reaction_tasks = []
    for r in reactors:
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "typing", "agent": r.get("slug"), "kind": "react",
        })
        agent = await _build_agent_for_room(req.room_id, r)
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

    if cost_tokens >= TURN_COST_CAP:
        status = "cost_capped"
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "seal", "cost_tokens": cost_tokens, "status": status,
        })
        return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)

    # ── Round 2 (only if challenger > 0.7) ───────────────────────────
    challenger_reaction = next(
        (r for r in reactions if r["agreement"] == "challenge" and r.get("confidence", 0) >= ROUND_2_CHALLENGE_THRESHOLD),
        None,
    )

    if challenger_reaction:
        # Lead revises
        await _emit_event(req.callback_url, req.turn_id, {
            "t": "typing", "agent": lead.get("slug"), "kind": "revise",
        })
        try:
            revise_prompt = (
                f"[CSI revision pass — your lane: {lead['_lane']}.]\n"
                f"{challenger_reaction['emp'].get('name')} ({challenger_reaction['emp']['_lane']}) challenged you:\n"
                f"\"{challenger_reaction['content']}\"\n\n"
                f"Re-examine your earlier answer. Acknowledge the challenge concretely. Adjust your position if warranted; "
                f"defend it with evidence if not. Keep it brief — 2-4 sentences."
            )
            reply2 = await lead_agent(Msg(name="user", content=revise_prompt, role="user"))
            revise_text = _msg_to_text(reply2) or "(no revision)"
            revise_tokens = max(150, len(revise_text) // 4)
            cost_tokens += revise_tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "revise",
                "agent": lead.get("slug"),
                "round": 2,
                "content": revise_text,
                "tokens": revise_tokens,
            })

            # Challenger validates or escalates once
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "typing", "agent": challenger_reaction["emp"].get("slug"), "kind": "validate",
            })
            ch_agent = await _build_agent_for_room(req.room_id, challenger_reaction["emp"])
            validate_prompt = (
                f"[CSI validation pass — your lane: {challenger_reaction['emp']['_lane']}.]\n"
                f"{lead.get('name')} responded to your challenge:\n"
                f"\"{revise_text}\"\n\n"
                f"Reply in STRICT JSON:\n"
                f'{{"verdict": "resolved" | "escalate", "line": "1-2 sentences"}}'
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
                            "line": (parsed.get("line") or "").strip()[:500],
                        }
            except Exception:  # noqa: BLE001
                pass
            v_tokens = max(80, len(verdict_obj.get("line", "")) // 4)
            cost_tokens += v_tokens
            await _emit_event(req.callback_url, req.turn_id, {
                "t": "validate",
                "agent": challenger_reaction["emp"].get("slug"),
                "round": 2,
                "verdict": verdict_obj["verdict"],
                "content": verdict_obj["line"],
                "tokens": v_tokens,
            })
        except Exception as exc:  # noqa: BLE001
            log.warning("round-2 failed: %s", exc)

    # ── Seal ─────────────────────────────────────────────────────────
    if cost_tokens >= TURN_COST_CAP:
        status = "cost_capped"

    await _emit_event(req.callback_url, req.turn_id, {
        "t": "seal",
        "cost_tokens": cost_tokens,
        "status": status,
        "duration_ms": int((time.time() - started) * 1000),
    })

    return RoomTurnResponse(ok=True, cost_tokens=cost_tokens, status=status)


@router.post("/room-turn", response_model=RoomTurnResponse)
async def post_room_turn(
    req: RoomTurnRequest,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> RoomTurnResponse:
    _require_master_key(x_api_key)
    return await _orchestrate(req)
