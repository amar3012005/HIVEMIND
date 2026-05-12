"""SlackStreamer — milestone-only Slack thread updates for a TeamRoom run.

Subscribes to TeamRoom via its `on_event` hook. For each significant
WorkerMessage we POST one card to the originating Slack thread via the
existing HIVEMIND core `/api/employees/slack-action` endpoint (so the
policy gate + per-employee identity override already in production
keep working).

Filtering rules (kept aggressive to avoid bot-spam):
  - `system`        → post only phase-boundary lines ("Team forming",
                       "Round N begin", "Gate satisfied", "Final answer")
  - `claim`         → post one card per claim (with proposer name+emoji)
  - `review`        → post only when verdict in {contradicts}
  - `revision`      → post one card (revision is a meaningful event)
  - `synthesis`     → post final card
  - `chat`          → NEVER post (investigate findings are private)

Identity:
  Each card uses the originating employee's slack_display_name +
  slack_avatar_emoji where available; TeamRoom system cards use the
  shared DAVINCI AI default identity.

Failure mode:
  Posts are fire-and-forget via asyncio.create_task. HTTP / Slack errors
  are logged and swallowed — they MUST NOT break the phase machine.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from .worker import WorkerMessage

log = logging.getLogger(__name__)

# Kinds we post for; anything else dropped.
_POSTABLE_KINDS = {"claim", "review", "revision", "synthesis", "system"}
# system content prefixes we actually relay (others are debug noise).
_RELAY_SYSTEM_PREFIXES = (
    "Task opened:",
    "=== Round",
    "Gate satisfied",
)


class SlackStreamer:
    """One streamer per TeamRoom run. Owns its own httpx.AsyncClient
    for the duration of the run; close() releases it."""

    def __init__(
        self,
        *,
        channel: str,
        thread_ts: Optional[str],
        api_key: str,
        team_api_emoji: str = ":busts_in_silhouette:",
        team_display_name: str = "DAVINCI Team",
        identity_lookup: Optional[Dict[str, Dict[str, Any]]] = None,
        core_url: Optional[str] = None,
        dry_run: bool = False,
    ):
        """
        Args:
            channel: Slack channel ID where the originating thread lives.
            thread_ts: Slack thread root timestamp. None posts top-level.
            api_key: HIVEMIND API key used to call /api/employees/slack-action.
                Should be a "team coordinator" key with slack:act scope;
                falling back to any roster employee key also works.
            team_api_emoji: Avatar emoji for system / TeamRoom cards.
            team_display_name: Display name override for system cards.
            identity_lookup: {employee_id: {name, slack_display_name,
                slack_avatar_emoji, avatar_url}} so per-card identity
                can override DAVINCI AI's default app identity.
            core_url: Override HIVEMIND core base URL (defaults to
                HIVEMIND_CORE_URL env).
            dry_run: If True, log card payloads instead of POSTing.
                Useful for offline smoke runs.
        """
        if not channel:
            raise ValueError("SlackStreamer requires channel")
        self.channel = channel
        self.thread_ts = thread_ts
        self.api_key = api_key
        self.team_api_emoji = team_api_emoji
        self.team_display_name = team_display_name
        self.identity_lookup = identity_lookup or {}
        self.core_url = core_url or os.environ.get("HIVEMIND_CORE_URL", "http://hm-core:3000")
        self.dry_run = dry_run

        self._client: Optional[httpx.AsyncClient] = None
        self._pending: List[asyncio.Task] = []

    # ── Lifecycle ────────────────────────────────────────────────
    async def __aenter__(self) -> "SlackStreamer":
        if not self.dry_run:
            self._client = httpx.AsyncClient(base_url=self.core_url, timeout=30.0)
        return self

    async def __aexit__(self, *_: Any) -> None:
        # Drain in-flight posts so they don't get cancelled when the
        # event loop tears down the TeamRoom run.
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── Subscriber hook (sync — fires async post in background) ──
    def on_event(self, msg: WorkerMessage) -> None:
        if not self._should_relay(msg):
            return
        # Schedule a non-blocking post. We're inside the TeamRoom's
        # event loop because _publish() awaits the hook synchronously
        # — but create_task lets us return immediately so the phase
        # machine keeps progressing.
        try:
            task = asyncio.create_task(self._post_card(msg))
            self._pending.append(task)
            task.add_done_callback(self._reap)
        except RuntimeError:
            # No running loop (called outside an async context). Just
            # log and skip — the in-memory transcript is still intact.
            log.warning("SlackStreamer.on_event called outside event loop")

    def _reap(self, task: asyncio.Task) -> None:
        try:
            self._pending.remove(task)
        except ValueError:
            pass

    # ── Filtering ────────────────────────────────────────────────
    @staticmethod
    def _should_relay(msg: WorkerMessage) -> bool:
        if msg.kind not in _POSTABLE_KINDS:
            return False
        if msg.kind == "system":
            return any((msg.content or "").startswith(p) for p in _RELAY_SYSTEM_PREFIXES)
        if msg.kind == "review":
            # Only surface contradiction reviews to keep noise down;
            # supports/needs_revision still drive the phase machine but
            # don't deserve a card.
            return msg.metadata.get("verdict") == "contradicts"
        return True

    # ── Card rendering + posting ─────────────────────────────────
    async def _post_card(self, msg: WorkerMessage) -> None:
        text = self._render_card(msg)
        identity = self._identity_for(msg)
        payload: Dict[str, Any] = {
            "channel": self.channel,
            "text": text,
            "thread_ts": self.thread_ts,
        }
        if identity.get("username"):
            payload["username"] = identity["username"]
        if identity.get("icon_url"):
            payload["icon_url"] = identity["icon_url"]
        if identity.get("icon_emoji"):
            payload["icon_emoji"] = identity["icon_emoji"]

        if self.dry_run or self._client is None:
            log.info("SlackStreamer dry-run card: %s", payload)
            return
        try:
            r = await self._client.post(
                "/api/employees/slack-action",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"action_type": "slack_post", "payload": payload},
            )
            if r.status_code >= 400:
                log.warning("SlackStreamer card POST %d: %s", r.status_code, r.text[:200])
        except Exception as exc:
            log.warning("SlackStreamer card POST failed: %s", exc)

    def _identity_for(self, msg: WorkerMessage) -> Dict[str, Any]:
        if msg.sender_id == "system":
            return {"username": self.team_display_name, "icon_emoji": self.team_api_emoji}
        info = self.identity_lookup.get(msg.sender_id) or {}
        return {
            "username": info.get("slack_display_name") or info.get("name") or msg.sender_name,
            "icon_url": info.get("avatar_url"),
            "icon_emoji": info.get("slack_avatar_emoji") or ":robot_face:",
        }

    def _render_card(self, msg: WorkerMessage) -> str:
        content = (msg.content or "").strip()
        if msg.kind == "system":
            if content.startswith("Task opened"):
                return f":busts_in_silhouette: *Team forming.* {content[len('Task opened:'):].strip()}"
            if content.startswith("=== Round"):
                return f":hourglass_flowing_sand: {content.replace('===', '').strip()}"
            if content.startswith("Gate satisfied"):
                return f":white_check_mark: {content}"
            return f":speech_balloon: {content}"
        if msg.kind == "claim":
            return f":memo: *{msg.sender_name}* proposed:\n>{content}"
        if msg.kind == "review":
            verdict = msg.metadata.get("verdict", "?")
            return (
                f":warning: *{msg.sender_name}* flagged a contradiction "
                f"(verdict: `{verdict}`):\n>{content}"
            )
        if msg.kind == "revision":
            return f":arrows_counterclockwise: *{msg.sender_name}* revised their claim:\n>{content}"
        if msg.kind == "synthesis":
            return f":dart: *Team consensus* ({msg.sender_name}):\n{content}"
        return f"{msg.sender_name}: {content}"
