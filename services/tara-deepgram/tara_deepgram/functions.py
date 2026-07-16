"""
Client-side function calling for the Deepgram Voice Agent.

Definitions go into Settings.agent.think.functions (no endpoint = client_side);
Deepgram emits FunctionCallRequest, we execute here and reply FunctionCallResponse.
Every invocation is appended to the per-call JSONL event log (leads, callbacks,
opt-outs are the campaign's primary output).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, Coroutine, Dict

from .tara_stream import stream_tara

log = logging.getLogger("tara_dg.functions")

FUNCTION_DEFS: list[dict] = [
    {
        "name": "search_memory",
        "description": (
            "Search the company's HIVEMIND knowledge base for specific facts, "
            "product details, pricing, or history when the caller asks something "
            "you are not certain about. Always prefer this over guessing."
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "What to look up"}},
            "required": ["query"],
        },
    },
    {
        "name": "log_lead",
        "description": (
            "Record the caller as a lead when they express interest. Call this as "
            "soon as interest is clear, before ending the call."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "interest_level": {"type": "string", "enum": ["hot", "warm", "cold"]},
                "notes": {"type": "string", "description": "Key points from the conversation"},
            },
            "required": ["interest_level", "notes"],
        },
    },
    {
        "name": "schedule_callback",
        "description": "Schedule a callback when the caller asks to be contacted later.",
        "parameters": {
            "type": "object",
            "properties": {
                "when": {"type": "string", "description": "Requested time, e.g. 'tomorrow 14:00'"},
                "reason": {"type": "string"},
            },
            "required": ["when"],
        },
    },
    {
        "name": "mark_do_not_call",
        "description": (
            "The caller objects to being called or asks not to be contacted again. "
            "Call this IMMEDIATELY, apologize, then call end_call."
        ),
        "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}},
    },
    {
        "name": "get_conversation_history",
        "description": (
            "Retrieve earlier turns of THIS phone call when the caller refers to "
            "something said before that you can no longer see."
        ),
        "parameters": {
            "type": "object",
            "properties": {"turns_behind": {"type": "integer",
                                            "description": "How many turns back to retrieve (1-20)"}},
            "required": ["turns_behind"],
        },
    },
    {
        "name": "end_call",
        "description": "End the phone call after saying goodbye, or when the conversation is complete.",
        "parameters": {
            "type": "object",
            "properties": {
                "disposition": {
                    "type": "string",
                    "enum": ["completed", "declined", "callback", "not_interested", "opt_out"],
                },
                "summary": {"type": "string", "description": "One-sentence outcome"},
            },
            "required": ["disposition"],
        },
    },
]


class FunctionExecutor:
    """Executes client-side functions for one call; logs everything."""

    def __init__(self, *, session_id: str, user_id: str | None, org_id: str | None,
                 language: str, event_logger: Callable[[str, dict], None],
                 request_hangup: Callable[[], Coroutine[Any, Any, None]],
                 get_history: Callable[[int], str] | None = None):
        self.session_id = session_id
        self.user_id = user_id
        self.org_id = org_id
        self.language = language
        self._log_event = event_logger
        self._request_hangup = request_hangup
        self._get_history = get_history
        self.hangup_requested = False

    async def execute(self, name: str, arguments: str) -> str:
        try:
            args: Dict[str, Any] = json.loads(arguments or "{}")
        except json.JSONDecodeError:
            args = {}
        self._log_event("function_call", {"name": name, "args": args})

        if name == "search_memory":
            full = ""
            async for evt in stream_tara(
                query=args.get("query", ""), session_id=self.session_id,
                user_id=self.user_id, org_id=self.org_id,
                language=self.language, mode="external",
            ):
                if evt["type"] == "token":
                    full += evt["text"]
                elif evt["type"] == "final" and evt.get("full_text"):
                    full = evt["full_text"]
            return full or "No relevant information found."

        if name == "get_conversation_history":
            n = min(max(int(args.get("turns_behind", 5) or 5), 1), 20)
            if self._get_history:
                return self._get_history(n) or "No earlier turns recorded."
            return "History unavailable."

        if name in ("log_lead", "schedule_callback", "mark_do_not_call"):
            # Durable record = the JSONL event log (campaign engine collects it).
            return json.dumps({"ok": True, "recorded": name})

        if name == "end_call":
            self.hangup_requested = True
            self._log_event("disposition", {
                "disposition": args.get("disposition", "completed"),
                "summary": args.get("summary", ""),
            })
            await self._request_hangup()
            return json.dumps({"ok": True})

        log.warning("unknown function %s", name)
        return json.dumps({"ok": False, "error": f"unknown function {name}"})
