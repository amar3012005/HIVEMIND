"""
Strategic turn router — one tiny fast-model call per turn replaces both the
per-turn recall (when unneeded) and the accumulating clinical-reasoning loop.

Input:  persona hint + last few turns (Deepgram already sends the full
        conversation each turn — history is free, never re-fetched).
Output: JSON {action, history_turns, directive}
  action="direct"  → answer locally with persona + last N turns; no core
                     round-trip, no memory copied into the prompt (~600ms).
  action="recall"  → HIVEMIND /api/tara/stream with skip_clinical=true +
                     voice_directive (memory only when needed, loop dead).
  history_turns    → the "conversation history tool": how many turns back the
                     answering prompt needs (sliced from Deepgram's messages).
  directive        → ONE strategic line (tone/next move) — the whole clinical
                     layer distilled to a sentence, refreshed every turn for
                     ~150 output tokens instead of ~800 accumulating ones.

Router failure → safe fallback: action=recall (full grounded path).
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List

import httpx

from . import config

log = logging.getLogger("tara_dg.router")

_ROUTER_SYS = """You are the turn-strategist for TARA, a spoken voice agent on a live call.
Your job every turn: (1) route the answer, (2) DRIVE the call toward its goal,
(3) keep a running memory of important facts. Reply ONLY minified JSON:
{"action":"direct|recall","history_turns":N,"directive":"...","goal_state":"...","new_facts":["..."]}

action:
- "recall": message needs facts about the company, people, products, prices,
  documents, or org history — anything you could get wrong without the
  knowledge base. WHEN IN DOUBT → "recall".
- "direct": conversation mechanics — greetings, thanks, confirmations, small
  talk, repeats, or things fully answerable from the visible conversation.

history_turns: previous turns the answer needs (2-8). Minimum 2; more when the
user refers back (pronouns, "as I said", follow-ups).

directive: ONE line = tone + the concrete NEXT MOVE toward the goal.
HARD RULES: never ask for anything already known (in goal_state or facts) —
that is the worst failure. Name the ONE genuinely missing item, or if nothing
is missing, direct the close (summarize + next step). Never repeat the
previous directive's move — if it didn't land, try a DIFFERENT angle.

goal_state: one line of goal progress. It MUST change when the user gives new
information — mark items as known with their value, mark finished stages DONE
(e.g. "qualify: budget=1-2M ✓, timeline=ASAP ✓, decision-maker=unknown ← next").
Carry known items forward verbatim; never drop established progress.

new_facts: 0-3 NEW durable facts the user just revealed (name, role, company,
constraints, preferences, commitments). Only genuinely new ones. [] if none."""

_JSON_RE = re.compile(r"\{.*\}", re.S)


async def route(*, persona_name: str, goal: str,
                messages: List[Dict[str, Any]], prev_directive: str = "",
                goal_state: str = "", facts: List[str] | None = None) -> Dict[str, Any]:
    """One fast-model call → route + goal-directed directive + fact extraction."""
    fallback = {"action": "recall", "history_turns": 3, "directive": prev_directive or "",
                "goal_state": goal_state, "new_facts": []}
    if not config.OPENROUTER_API_KEY:
        return fallback

    # Compact last 6 turns — router context stays bounded regardless of call length;
    # long-range memory lives in the session brief (facts + goal_state), not the window.
    recent = [m for m in messages if m.get("role") in ("user", "assistant")][-6:]
    convo = "\n".join(f"{m['role']}: {str(m.get('content', ''))[:200]}" for m in recent)
    user = (
        f"Persona: {persona_name or 'TARA'} | Call goal: {goal or 'assist the caller and advance the persona goal'}\n"
        + (f"Goal state so far: {goal_state}\n" if goal_state else "")
        + (f"Known facts: {'; '.join(facts)}\n" if facts else "")
        + (f"Previous directive: {prev_directive}\n" if prev_directive else "")
        + f"Conversation (last turns):\n{convo}"
    )

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(
                f"{config.OPENROUTER_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
                         "Content-Type": "application/json"},
                json={
                    "model": config.ROUTER_MODEL,
                    "messages": [{"role": "system", "content": _ROUTER_SYS},
                                 {"role": "user", "content": user}],
                    "max_tokens": 300,
                    "temperature": 0.2,
                    "provider": {"sort": "latency", "allow_fallbacks": True},
                },
            )
        if r.status_code != 200:
            log.warning("router http %s: %s", r.status_code, r.text[:150])
            return fallback
        text = r.json()["choices"][0]["message"]["content"] or ""
        m = _JSON_RE.search(text)
        out = json.loads(m.group(0)) if m else {}
        action = out.get("action") if out.get("action") in ("direct", "recall") else "recall"
        turns = min(max(int(out.get("history_turns", 3) or 3), 2), 8)
        directive = str(out.get("directive") or "")[:300]
        new_goal = str(out.get("goal_state") or goal_state or "")[:300]
        new_facts = [str(f)[:160] for f in (out.get("new_facts") or []) if f][:3]
        ms = round((time.monotonic() - t0) * 1000)
        log.info("router action=%s turns=%d facts+%d ms=%d goal=%s",
                 action, turns, len(new_facts), ms, new_goal[:60])
        return {"action": action, "history_turns": turns, "directive": directive,
                "goal_state": new_goal, "new_facts": new_facts, "router_ms": ms}
    except Exception as e:  # noqa: BLE001
        log.warning("router failed (%s) — fallback to recall", e)
        return fallback


async def answer_direct(*, persona_prompt: str, language: str, directive: str,
                        messages: List[Dict[str, Any]], history_turns: int,
                        goal_state: str = "", facts: List[str] | None = None):
    """Local persona answer (no recall, no core): async generator of text chunks."""
    convo = [m for m in messages if m.get("role") in ("user", "assistant")]
    # Floor of 3 turns so pronouns/follow-ups always have context even when the
    # router under-estimates; long-range memory rides the [REMEMBER] brief.
    window = convo[-(max(history_turns, 3) * 2 + 1):]
    sys = (
        f"[LANGUAGE] Respond ONLY in {language}.\n\n"
        + (persona_prompt or "You are TARA, a warm professional voice agent.")
        + "\n\n[VOICE] Spoken reply: 1-2 short natural sentences, no lists, no markdown."
        + (f"\n[REMEMBER] Facts from this call: {'; '.join(facts)}" if facts else "")
        + (f"\n[GOAL] {goal_state}" if goal_state else "")
        + (f"\n[STRATEGY] {directive}" if directive else "")
        + "\n[NEVER] Never ask for anything already in [REMEMBER] or [GOAL] — "
          "acknowledge it instead. Never re-ask a question visible in the conversation."
    )
    payload = {
        "model": config.DIRECT_MODEL,
        "messages": [{"role": "system", "content": sys},
                     *[{"role": m["role"], "content": str(m.get("content", ""))[:600]} for m in window]],
        "max_tokens": 150,
        "temperature": 0.6,
        "stream": True,
        "provider": {"sort": "latency", "allow_fallbacks": True},
    }
    async with httpx.AsyncClient(timeout=30) as c:
        async with c.stream(
            "POST", f"{config.OPENROUTER_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
                     "Content-Type": "application/json"},
            json=payload,
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")[:200]
                raise RuntimeError(f"direct answer http {resp.status_code}: {body}")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    return
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta
