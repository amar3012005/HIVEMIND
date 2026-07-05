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

_ROUTER_SYS = """You are the turn-strategist for TARA, a spoken voice agent.
Decide how to answer the user's LAST message. Reply with ONLY minified JSON:
{"action":"direct|recall","history_turns":N,"directive":"one short strategic line"}

action rules:
- "recall": the message asks about facts, people, products, prices, company info,
  documents, history of the org, or anything you could get wrong without the
  knowledge base. WHEN IN DOUBT → "recall".
- "direct": pure conversation mechanics — greetings, thanks, confirmations,
  small talk, asking the user to repeat, simple arithmetic, or rephrasing
  something already said in the visible conversation.

history_turns: how many previous turns the answer needs (0-8). 1 for standalone,
more when the user refers back ("as I said", pronouns, follow-ups).

directive: ONE line steering the next reply in persona — tone + move
(e.g. "warm; answer plainly then ask which product line they mean").
No markdown, no extra keys."""

_JSON_RE = re.compile(r"\{.*\}", re.S)


async def route(*, persona_name: str, goal: str,
                messages: List[Dict[str, Any]], prev_directive: str = "") -> Dict[str, Any]:
    """One fast-model call → routing decision + strategic directive."""
    fallback = {"action": "recall", "history_turns": 2, "directive": prev_directive or ""}
    if not config.OPENROUTER_API_KEY:
        return fallback

    # Compact last 4 turns — router context stays tiny regardless of call length.
    recent = [m for m in messages if m.get("role") in ("user", "assistant")][-4:]
    convo = "\n".join(f"{m['role']}: {str(m.get('content', ''))[:200]}" for m in recent)
    user = (
        f"Persona: {persona_name or 'TARA'} | Call goal: {goal or 'assist the caller'}\n"
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
                    "max_tokens": 200,
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
        turns = min(max(int(out.get("history_turns", 2) or 2), 0), 8)
        directive = str(out.get("directive") or "")[:300]
        ms = round((time.monotonic() - t0) * 1000)
        log.info("router action=%s turns=%d ms=%d", action, turns, ms)
        return {"action": action, "history_turns": turns, "directive": directive, "router_ms": ms}
    except Exception as e:  # noqa: BLE001
        log.warning("router failed (%s) — fallback to recall", e)
        return fallback


async def answer_direct(*, persona_prompt: str, language: str, directive: str,
                        messages: List[Dict[str, Any]], history_turns: int):
    """Local persona answer (no recall, no core): async generator of text chunks."""
    convo = [m for m in messages if m.get("role") in ("user", "assistant")]
    window = convo[-(max(history_turns, 0) * 2 + 1):] if history_turns >= 0 else convo[-1:]
    sys = (
        f"[LANGUAGE] Respond ONLY in {language}.\n\n"
        + (persona_prompt or "You are TARA, a warm professional voice agent.")
        + "\n\n[VOICE] Spoken reply: 1-2 short natural sentences, no lists, no markdown."
        + (f"\n[STRATEGY] {directive}" if directive else "")
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
