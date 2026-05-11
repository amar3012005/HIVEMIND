"""SlackGateway — one Socket Mode Bolt app per Slack workspace.

Multi-tenant: a single service process owns N workspace connections,
each forwarding inbound events to the correct Digital Employee via
the router. Outbound Slack actions ALWAYS go through HIVEMIND core
(/api/employees/slack-action) — never directly via this gateway's
bolt apps. That keeps policy + audit + memory ingest centralized.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Dict, List, Optional, Any

import httpx
from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler

from .. import db as db_module
from ..redis_client import dedup_event
from ..agents.factory import build_assistant
from .router import route_event

log = logging.getLogger(__name__)


class WorkspaceConnection:
    """Bolt app + socket handler for one Slack workspace."""

    def __init__(self, slack_team_id: str, bot_token: str, app_token: str):
        self.slack_team_id = slack_team_id
        self.bot_token = bot_token
        self.app_token = app_token
        self.app = AsyncApp(token=bot_token)
        self.handler: Optional[AsyncSocketModeHandler] = None
        self.task: Optional[asyncio.Task] = None

    async def start(self):
        self.handler = AsyncSocketModeHandler(self.app, self.app_token)
        self.task = asyncio.create_task(self.handler.start_async())
        log.info("workspace %s socket-mode started", self.slack_team_id)

    async def stop(self):
        if self.handler:
            try:
                await self.handler.close_async()
            except Exception:
                pass
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except Exception:
                pass


class SlackGateway:
    """Owns the workspace pool + employee → Assistant pool.

    Responsibilities:
      - On boot / reconcile: load employees + their slack workspace tokens
      - Create one WorkspaceConnection per unique slack_team_id
      - Build per-employee Assistant instances
      - Wire bolt event handlers to call assistant.chat() (in a thread)
      - Post replies via HIVEMIND core /api/employees/slack-action
    """

    def __init__(self):
        self.workspaces: Dict[str, WorkspaceConnection] = {}   # slack_team_id → conn
        self.employees: Dict[str, Dict[str, Any]] = {}          # employee_id → row
        self.assistants: Dict[str, Any] = {}                    # employee_id → Assistant
        self.api_keys: Dict[str, str] = {}                      # employee_id → raw key

    async def start(self):
        """Initial boot — fetch employees, set up workspaces + assistants."""
        await self.reconcile()

    async def reconcile(self):
        """Diff DB state vs in-memory; add/remove workspaces + assistants."""
        rows = await db_module.list_running_employees()
        seen_emp_ids = set()
        seen_ws_ids = set()

        # Group employees by workspace
        for emp in rows:
            seen_emp_ids.add(emp["id"])
            wsid = emp.get("slack_team_id")
            if wsid:
                seen_ws_ids.add(wsid)

            # New employee → build Assistant + wire route
            if emp["id"] not in self.employees:
                api_key = self._resolve_api_key_env(emp["id"])
                if not api_key:
                    log.warning("employee %s: no API key env (HIVEMIND_EMP_KEY_%s) — skip",
                                emp["slug"], emp["id"])
                    continue
                try:
                    self.assistants[emp["id"]] = build_assistant(emp, api_key)
                    self.api_keys[emp["id"]] = api_key
                    self.employees[emp["id"]] = emp
                    log.info("loaded employee %s", emp["slug"])
                except Exception as e:
                    log.warning("failed building assistant for %s: %s", emp["slug"], e)
            else:
                self.employees[emp["id"]] = emp  # refresh row

        # Remove employees no longer in DB
        for stale in set(self.employees.keys()) - seen_emp_ids:
            self.employees.pop(stale, None)
            self.assistants.pop(stale, None)
            self.api_keys.pop(stale, None)
            log.info("dropped employee %s", stale)

        # Ensure WorkspaceConnections exist for every seen workspace
        for wsid in seen_ws_ids:
            if wsid not in self.workspaces:
                bot, app_t = self._resolve_workspace_tokens(wsid)
                if not bot or not app_t:
                    log.warning("workspace %s: missing SLACK_BOT_TOKEN_%s or SLACK_APP_TOKEN_%s env — skip",
                                wsid, wsid, wsid)
                    continue
                try:
                    conn = WorkspaceConnection(wsid, bot, app_t)
                    self._wire_handlers(conn)
                    await conn.start()
                    self.workspaces[wsid] = conn
                except Exception as e:
                    log.warning("failed starting workspace %s: %s", wsid, e)

        # Tear down workspaces no longer needed
        for stale_ws in set(self.workspaces.keys()) - seen_ws_ids:
            log.info("stopping workspace %s (no live employees)", stale_ws)
            await self.workspaces[stale_ws].stop()
            self.workspaces.pop(stale_ws, None)

    async def stop(self):
        for conn in list(self.workspaces.values()):
            await conn.stop()
        self.workspaces.clear()

    # ── Handler wiring ───────────────────────────────────────────
    def _wire_handlers(self, conn: WorkspaceConnection):
        app = conn.app
        wsid = conn.slack_team_id

        @app.event("app_mention")
        async def on_mention(event, body, say):
            await self._handle_inbound(wsid, event, body)

        @app.event("message")
        async def on_message(event, body, say):
            # Skip bot echoes
            if event.get("bot_id") or event.get("subtype") == "bot_message":
                return
            await self._handle_inbound(wsid, event, body)

    async def _handle_inbound(self, wsid: str, event: Dict[str, Any], body: Dict[str, Any]):
        event_id = body.get("event_id") or f"{wsid}-{event.get('ts')}-{event.get('channel')}"
        try:
            already = await dedup_event(event_id)
            if already:
                log.debug("dedup skip: %s", event_id)
                return
        except Exception as e:
            log.warning("dedup failed for %s: %s", event_id, e)

        # Filter employees to this workspace
        ws_employees = [e for e in self.employees.values() if e.get("slack_team_id") == wsid]
        emp = route_event(event, ws_employees)
        if not emp:
            log.debug("no route for event in %s channel=%s", wsid, event.get("channel"))
            return

        assistant = self.assistants.get(emp["id"])
        if not assistant:
            log.warning("no Assistant for employee %s", emp["slug"])
            return

        text = event.get("text") or ""
        channel = event.get("channel")
        thread_ts = event.get("thread_ts") or event.get("ts")
        log.info("routing event to %s in #%s", emp["slug"], channel)

        # Run sync Assistant.chat in a thread executor (slackagents is sync)
        try:
            reply_text = await asyncio.to_thread(self._call_assistant, assistant, text, channel)
        except Exception as e:
            log.exception("assistant chat failed for %s: %s", emp["slug"], e)
            reply_text = None

        if not reply_text:
            return

        # Post reply via HIVEMIND core action gateway (policy + audit + ingest)
        api_key = self.api_keys.get(emp["id"])
        if not api_key:
            log.warning("no API key for %s — cannot post reply", emp["slug"])
            return
        await self._post_via_core(api_key, channel, reply_text, thread_ts)

    def _call_assistant(self, assistant, text: str, channel: str) -> str:
        """Sync wrapper — runs in thread."""
        try:
            return assistant.chat(text)
        except Exception as e:
            log.exception("assistant.chat raised: %s", e)
            return f"(internal error: {e})"

    async def _post_via_core(self, api_key: str, channel: str, text: str, thread_ts: Optional[str]):
        core_url = os.environ.get("HIVEMIND_CORE_URL", "http://hm-core:3000")
        async with httpx.AsyncClient(base_url=core_url, timeout=30.0) as c:
            try:
                r = await c.post(
                    "/api/employees/slack-action",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "action_type": "slack_post",
                        "payload": {"channel": channel, "text": text, "thread_ts": thread_ts},
                    },
                )
                if r.status_code >= 400:
                    log.warning("core slack-action %d: %s", r.status_code, r.text[:200])
            except Exception as e:
                log.warning("core slack-action failed: %s", e)

    # ── Credential resolution ────────────────────────────────────
    @staticmethod
    def _resolve_api_key_env(employee_id: str) -> Optional[str]:
        """Look up HIVEMIND_EMP_KEY_<id> env var. Phase 2.4 will replace
        with a control-plane fetch endpoint."""
        return os.environ.get(f"HIVEMIND_EMP_KEY_{employee_id}")

    @staticmethod
    def _resolve_workspace_tokens(slack_team_id: str) -> tuple[Optional[str], Optional[str]]:
        """Look up SLACK_BOT_TOKEN_<team_id> + SLACK_APP_TOKEN_<team_id>.
        Phase 2.4 will resolve from platform_integrations via core.
        For now this is the simplest secret-injection path."""
        bot = os.environ.get(f"SLACK_BOT_TOKEN_{slack_team_id}")
        app = os.environ.get(f"SLACK_APP_TOKEN_{slack_team_id}")
        return bot, app
