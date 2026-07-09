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
You run a CONFIDENCE-DRIVEN plan: hold a hypothesis about the caller, update
your confidence every turn, and CONVERGE — calls must move forward and END,
never loop. Reply ONLY minified JSON:
{"action":"direct|recall","history_turns":N,"directive":"...","goal_state":"...","new_facts":["..."],"phase":"discover|qualify|propose|close|wrapup","confidence":0-100}

action:
- "recall": message needs facts about the company, products, prices, docs,
  or org history — anything you could get wrong without the knowledge base.
  WHEN IN DOUBT → "recall".
- "direct": conversation mechanics — greetings, thanks, confirmations,
  repeats, or things fully answerable from the visible conversation.

history_turns: previous turns the answer needs (2-8).

phase + confidence — the convergence engine:
- confidence = how sure you are of your hypothesis (caller's interest + fit
  for the goal). Update it EVERY turn from what they say and HOW they say it.
- Each phase gets AT MOST 2 questions. Then you MUST advance:
  discover → qualify → propose → close → wrapup. Never move backward.
- confidence >= 70 (interested): stop probing, PROPOSE the concrete next step
  toward the goal (demo, booking, commitment) and drive to close.
- confidence <= 30 OR two short/flat/uninterested replies in a row: the
  hypothesis failed — go straight to wrapup: one-sentence graceful summary,
  thank them, say goodbye. A clean short call beats a dragging one.
- In wrapup the directive must be: deliver closing line, then END the call.

directive: ONE line = tone + the single concrete NEXT MOVE for this phase.
HARD RULES: max ONE question per reply — prefer statements that give value.
Never ask anything already in goal_state/facts. Never repeat a previous move
that didn't land — change angle or advance phase instead.

goal_state: one line of plan progress incl. phase + confidence, e.g.
"qualify(2/2 q used, conf=65): budget=50k ✓, timeline=Sept ✓ → propose demo".
It MUST move every turn; carry known items forward verbatim.

new_facts: 0-3 NEW durable facts the caller just revealed. [] if none."""

_JSON_RE = re.compile(r"\{.*\}", re.S)


async def route(*, persona_name: str, goal: str,
                messages: List[Dict[str, Any]], prev_directive: str = "",
                goal_state: str = "", facts: List[str] | None = None,
                phase: str = "discover", confidence: int = 50) -> Dict[str, Any]:
    """One fast-model call → route + confidence-driven directive + fact extraction."""
    fallback = {"action": "recall", "history_turns": 3, "directive": prev_directive or "",
                "goal_state": goal_state, "new_facts": [],
                "phase": phase, "confidence": confidence}
    if not config.OPENROUTER_API_KEY:
        return fallback

    # Compact last 6 turns — router context stays bounded regardless of call length;
    # long-range memory lives in the session brief (facts + goal_state), not the window.
    recent = [m for m in messages if m.get("role") in ("user", "assistant")][-6:]
    convo = "\n".join(f"{m['role']}: {str(m.get('content', ''))[:200]}" for m in recent)
    user = (
        f"Persona: {persona_name or 'TARA'} | Call goal: {goal or 'assist the caller and advance the persona goal'}\n"
        + f"Current phase: {phase} | Current confidence: {confidence}\n"
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
                    "max_tokens": 512,
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
        phase = out.get("phase") if out.get("phase") in ("discover", "qualify", "propose", "close", "wrapup") else "discover"
        try:
            confidence = min(max(int(out.get("confidence", 50) or 50), 0), 100)
        except (TypeError, ValueError):
            confidence = 50
        ms = round((time.monotonic() - t0) * 1000)
        log.info("router action=%s turns=%d facts+%d ms=%d phase=%s conf=%d goal=%s",
                 action, turns, len(new_facts), ms, phase, confidence, new_goal[:60])
        return {"action": action, "history_turns": turns, "directive": directive,
                "goal_state": new_goal, "new_facts": new_facts,
                "phase": phase, "confidence": confidence, "router_ms": ms}
    except Exception as e:  # noqa: BLE001
        log.warning("router failed (%s) — fallback to recall", e)
        return fallback


_PLAN_SYS = """You are the call planner for TARA, a spoken voice agent. Given the
agent's PERSONA (skill) and the CALL GOAL, plan the strategic opening.
Reply ONLY minified JSON:
{"opening":"...","strategy":"one line: the plan to reach the goal","goal_state":"one line initial goal progress"}

CRITICAL — the AI disclosure has ALREADY been spoken immediately before this
("Hi, this is TARA, an AI assistant calling on behalf of <company>..."). So the
"opening" must NOT reintroduce TARA, NOT repeat the company name, NOT say "hi"
or "hello" again. It is the NEXT sentence: state in one short line why you're
calling and ask the single best FIRST question toward the goal. 1 sentence, at
most 2. Human, not scripted. Never invent facts."""


async def plan_opening(*, persona_prompt: str, goal: str, company: str,
                       language: str) -> dict:
    """One fast-model call at call start → {opening, strategy, goal_state}."""
    fallback = {"opening": "", "strategy": "", "goal_state": f"Objective: {goal}" if goal else ""}
    if not config.OPENROUTER_API_KEY or not goal:
        return fallback
    user = (
        f"Company: {company}\nCall goal: {goal}\nLanguage: respond in {language}\n"
        f"Persona (skill):\n{(persona_prompt or 'You are TARA, a warm professional voice agent.')[:1200]}"
    )
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(
                f"{config.OPENROUTER_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
                         "Content-Type": "application/json"},
                json={
                    "model": config.DIRECT_MODEL,
                    "messages": [{"role": "system", "content": _PLAN_SYS},
                                 {"role": "user", "content": user}],
                    "max_tokens": 512, "temperature": 0.4,
                    "provider": ({"order": config.DIRECT_PROVIDER, "allow_fallbacks": True}
                                 if config.DIRECT_PROVIDER else {"sort": "latency", "allow_fallbacks": True}),
                    **({"reasoning": {"effort": config.DIRECT_REASONING_EFFORT}}
                       if "gpt-oss" in config.DIRECT_MODEL and config.DIRECT_REASONING_EFFORT else {}),
                },
            )
        if r.status_code != 200:
            return fallback
        text = r.json()["choices"][0]["message"]["content"] or ""
        m = _JSON_RE.search(text)
        out = json.loads(m.group(0)) if m else {}
        return {
            "opening": str(out.get("opening") or "")[:400],
            "strategy": str(out.get("strategy") or "")[:300],
            "goal_state": str(out.get("goal_state") or (f"Objective: {goal}" if goal else ""))[:300],
        }
    except Exception as e:  # noqa: BLE001
        log.warning("plan_opening failed: %s", e)
        return fallback


async def answer_direct(*, persona_prompt: str, language: str, directive: str,
                        messages: List[Dict[str, Any]], history_turns: int,
                        goal_state: str = "", facts: List[str] | None = None,
                        usage_out: Dict[str, Any] | None = None):
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
          "acknowledge it instead. Never re-ask a question visible in the conversation. "
          "Ask at most ONE question — and only if [STRATEGY] calls for one; otherwise "
          "make a statement. If [STRATEGY] says wrap up or close: summarize in one "
          "sentence, state the next step, and say goodbye — do not ask anything."
    )
    payload = {
        "model": config.DIRECT_MODEL,
        "messages": [{"role": "system", "content": sys},
                     *[{"role": m["role"], "content": str(m.get("content", ""))[:600]} for m in window]],
        "max_tokens": 220,   # mercury: short = fast; voice wants 1-2 sentences
        "temperature": 0.6,
        "stream": True,
        "stream_options": {"include_usage": True},  # final chunk carries token usage
        # Pin Cerebras when configured (fastest full completion); else latency sort.
        "provider": ({"order": config.DIRECT_PROVIDER, "allow_fallbacks": True}
                     if config.DIRECT_PROVIDER else {"sort": "latency", "allow_fallbacks": True}),
    }
    # gpt-oss models accept reasoning effort — low cuts pre-answer reasoning tokens.
    if "gpt-oss" in config.DIRECT_MODEL and config.DIRECT_REASONING_EFFORT:
        payload["reasoning"] = {"effort": config.DIRECT_REASONING_EFFORT}
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
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if usage_out is not None and obj.get("usage"):
                    u = obj["usage"]
                    usage_out["prompt_tokens"] = u.get("prompt_tokens", 0)
                    usage_out["completion_tokens"] = u.get("completion_tokens", 0)
                try:
                    delta = obj["choices"][0]["delta"].get("content")
                except (KeyError, IndexError):
                    continue
                if delta:
                    yield delta
