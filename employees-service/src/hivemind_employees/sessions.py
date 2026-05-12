"""Thread-context persistence for SlackAgents Assistant.

The vanilla slackagents.Assistant resets messages to [system_prompt]
on every .chat() call → bot has amnesia between @mentions in the same
thread. SlackAgents' own SlackAssistant fixes this but also posts to
Slack directly via WebClient (bypasses our policy/audit/memory gate),
so we can't adopt it wholesale.

Workaround: keep using vanilla Assistant but persist its .messages
to Redis keyed by (employee_id, channel_id, thread_ts). Restore on
inbound, save after reply. Same UX as SlackAssistant; outbound still
flows through HIVEMIND core action gateway.

TTL: 7 days. Conversations older than that lose context — fine for
Slack-thread interactivity.
"""
from __future__ import annotations

import json
import logging
from typing import List, Dict, Optional

from .redis_client import init_redis

log = logging.getLogger(__name__)

TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days
MAX_MESSAGES = 40  # cap context to prevent runaway token cost


def _key(employee_id: str, channel_id: str, thread_ts: str) -> str:
    return f"emp:session:{employee_id}:{channel_id}:{thread_ts}"


async def load_thread(employee_id: str, channel_id: str, thread_ts: str) -> Optional[List[Dict]]:
    """Return the persisted message list for this thread, or None if
    no prior context exists."""
    try:
        r = await init_redis()
        raw = await r.get(_key(employee_id, channel_id, thread_ts))
        if not raw:
            return None
        return json.loads(raw)
    except Exception as e:
        log.warning("session load failed: %s", e)
        return None


async def save_thread(
    employee_id: str,
    channel_id: str,
    thread_ts: str,
    messages: List[Dict],
) -> None:
    """Persist the in-memory message list back to Redis. Truncated to
    MAX_MESSAGES so context doesn't grow without bound."""
    try:
        r = await init_redis()
        if len(messages) > MAX_MESSAGES:
            # Keep system prompt (idx 0) + last N-1 turns
            head = messages[:1]
            tail = messages[-(MAX_MESSAGES - 1):]
            messages = head + tail
        await r.set(
            _key(employee_id, channel_id, thread_ts),
            json.dumps(messages, default=str),
            ex=TTL_SECONDS,
        )
    except Exception as e:
        log.warning("session save failed: %s", e)


async def drop_thread(employee_id: str, channel_id: str, thread_ts: str) -> None:
    """Forget a thread (admin action / employee archive cleanup)."""
    try:
        r = await init_redis()
        await r.delete(_key(employee_id, channel_id, thread_ts))
    except Exception as e:
        log.warning("session drop failed: %s", e)
