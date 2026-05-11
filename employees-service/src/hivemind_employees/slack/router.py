"""Event → employee routing.

Multiple Digital Employees can live in the same Slack workspace, each
allowed in a different subset of channels. The router decides which
employee (if any) should handle an inbound event.
"""
from __future__ import annotations

import logging
import re
from typing import Optional, List, Dict, Any

log = logging.getLogger(__name__)


MENTION_RE = re.compile(r"<@([A-Z0-9]+)>")


def find_mentions(text: str) -> List[str]:
    return MENTION_RE.findall(text or "")


def route_event(event: Dict[str, Any], employees: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Pick the employee that should handle this Slack event.

    Priority:
    1. If event has app_mention → match by slack_bot_user_id == mentioned user
    2. If channel in employee.slack_channels_allowed → first match
    3. None — silently drop

    employees is the list of in-memory employee dicts from the gateway pool,
    filtered to those whose slack_team_id == event.team_id already.
    """
    channel = event.get("channel") or (event.get("item") or {}).get("channel")
    text = event.get("text") or ""

    # Path A: explicit @mention
    mentioned = set(find_mentions(text))
    if mentioned:
        for emp in employees:
            bot_uid = emp.get("slack_bot_user_id")
            if bot_uid and bot_uid in mentioned:
                return emp

    # Path B: channel allowlist
    if channel:
        for emp in employees:
            allowed = emp.get("slack_channels_allowed") or []
            if allowed and channel in allowed:
                return emp

    # Path C: DM events without mentions — assign to first employee in workspace
    if event.get("channel_type") == "im" and employees:
        return employees[0]

    return None
