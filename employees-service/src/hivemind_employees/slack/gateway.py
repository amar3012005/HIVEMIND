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
from ..bootstrap_client import fetch_bootstrap, report_sidecar_status
from ..sessions import load_thread, save_thread
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
        self.workspace_bot_tokens: Dict[str, str] = {}          # team_id → xoxb

    async def start(self):
        """Initial boot — fetch employees, set up workspaces + assistants."""
        await self.reconcile()

    async def reconcile(self):
        """Diff DB + bootstrap snapshot vs in-memory; add/remove
        workspaces + assistants. Reports each new agent's status
        back to control-plane so the dashboard badge flips."""
        # Pull authoritative snapshot from control-plane (decrypted keys
        # + bot tokens). Falls back to env vars on outage.
        snapshot = {b["id"]: b for b in await fetch_bootstrap()}
        rows = await db_module.list_running_employees()
        seen_emp_ids = set()
        seen_ws_ids = set()

        for emp in rows:
            seen_emp_ids.add(emp["id"])
            wsid = emp.get("slack_team_id")
            boot = snapshot.get(emp["id"], {})

            if wsid:
                seen_ws_ids.add(wsid)
                # Cache bot token from snapshot for this workspace
                if boot.get("slack_bot_token") and wsid not in self.workspace_bot_tokens:
                    self.workspace_bot_tokens[wsid] = boot["slack_bot_token"]

            # New employee → build Assistant + wire route
            if emp["id"] not in self.employees:
                api_key = boot.get("api_key") or self._resolve_api_key_env(emp["id"])
                if not api_key:
                    log.warning("employee %s: no API key (bootstrap empty and env unset) — skip",
                                emp["slug"])
                    await report_sidecar_status(emp["id"], "error", "missing API key")
                    continue
                try:
                    self.assistants[emp["id"]] = build_assistant(emp, api_key)
                    self.api_keys[emp["id"]] = api_key
                    self.employees[emp["id"]] = emp
                    log.info("loaded employee %s", emp["slug"])
                    await report_sidecar_status(emp["id"], "running")
                except Exception as e:
                    log.warning("failed building assistant for %s: %s", emp["slug"], e)
                    await report_sidecar_status(emp["id"], "error", str(e)[:200])
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
                bot = self.workspace_bot_tokens.get(wsid) or self._resolve_bot_token_env(wsid)
                app_t = self._resolve_app_token_env(wsid)
                if not bot:
                    log.warning("workspace %s: no bot token (bootstrap empty, env SLACK_BOT_TOKEN_%s unset) — skip",
                                wsid, wsid)
                    continue
                if not app_t:
                    # Bolt allows POST-only mode without Socket Mode, but we need
                    # WS for inbound. Skip if missing.
                    log.warning("workspace %s: no SLACK_APP_TOKEN_%s — Socket Mode disabled",
                                wsid, wsid)
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
            self.workspace_bot_tokens.pop(stale_ws, None)

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
        log.info("routing event to %s in #%s thread=%s", emp["slug"], channel, thread_ts)

        # Restore thread history from Redis so the agent has context
        # across multiple @mentions in the same Slack thread.
        prior = await load_thread(emp["id"], channel, thread_ts)

        # Run sync Assistant.chat in a thread executor (slackagents is sync)
        try:
            reply_text = await asyncio.to_thread(
                self._call_assistant, assistant, text, channel, prior,
            )
        except Exception as e:
            log.exception("assistant chat failed for %s: %s", emp["slug"], e)
            reply_text = None

        # Persist updated message stack regardless of reply outcome —
        # next inbound on this thread will resume cleanly.
        try:
            await save_thread(emp["id"], channel, thread_ts, list(assistant.messages))
        except Exception as e:
            log.warning("session save failed for %s: %s", emp["slug"], e)

        if not reply_text:
            return

        # Post reply via HIVEMIND core action gateway (policy + audit + ingest)
        api_key = self.api_keys.get(emp["id"])
        if not api_key:
            log.warning("no API key for %s — cannot post reply", emp["slug"])
            return
        # Per-employee identity override — one shared Slack app posts as N
        # employees by passing username + icon to chat.postMessage (requires
        # chat:write.customize scope on the app). Fields originate from the
        # bootstrap snapshot; bot row falls back to .name + a default emoji.
        username = emp.get("slack_display_name") or emp.get("name")
        icon_url = emp.get("avatar_url") or emp.get("slack_avatar_url")
        icon_emoji = emp.get("slack_avatar_emoji") or (None if icon_url else ":robot_face:")
        await self._post_via_core(
            api_key, channel, reply_text, thread_ts,
            username=username, icon_url=icon_url, icon_emoji=icon_emoji,
        )

    def _call_assistant(
        self,
        assistant,
        text: str,
        channel: str,
        prior_messages: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Sync wrapper — runs in thread.
        Restores prior thread context if provided, else resets to fresh
        [system_prompt] so threads don't bleed into each other when one
        Assistant instance serves multiple Slack threads."""
        try:
            if prior_messages:
                assistant.messages = list(prior_messages)
            else:
                # Fresh thread — reseed with just the system prompt
                # (system_prompt is held by Executor.__init__ as messages[0]).
                assistant.messages = [{"role": "system", "content": assistant.system_prompt}]
            return assistant.chat(text)
        except Exception as e:
            log.exception("assistant.chat raised: %s", e)
            return f"(internal error: {e})"

    async def _post_via_core(
        self,
        api_key: str,
        channel: str,
        text: str,
        thread_ts: Optional[str],
        username: Optional[str] = None,
        icon_url: Optional[str] = None,
        icon_emoji: Optional[str] = None,
    ):
        core_url = os.environ.get("HIVEMIND_CORE_URL", "http://hm-core:3000")
        payload: Dict[str, Any] = {"channel": channel, "text": text, "thread_ts": thread_ts}
        if username:
            payload["username"] = username
        if icon_url:
            payload["icon_url"] = icon_url
        if icon_emoji:
            payload["icon_emoji"] = icon_emoji
        async with httpx.AsyncClient(base_url=core_url, timeout=30.0) as c:
            try:
                r = await c.post(
                    "/api/employees/slack-action",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={"action_type": "slack_post", "payload": payload},
                )
                if r.status_code >= 400:
                    log.warning("core slack-action %d: %s", r.status_code, r.text[:200])
            except Exception as e:
                log.warning("core slack-action failed: %s", e)

    # ── Credential resolution ────────────────────────────────────
    # Phase 2.4: bot tokens + employee API keys come from /v1/employees/bootstrap.
    # Env vars below remain as fallback when control-plane is unreachable.
    @staticmethod
    def _resolve_api_key_env(employee_id: str) -> Optional[str]:
        return os.environ.get(f"HIVEMIND_EMP_KEY_{employee_id}")

    @staticmethod
    def _resolve_bot_token_env(slack_team_id: str) -> Optional[str]:
        return os.environ.get(f"SLACK_BOT_TOKEN_{slack_team_id}")

    @staticmethod
    def _resolve_app_token_env(slack_team_id: str) -> Optional[str]:
        return os.environ.get(f"SLACK_APP_TOKEN_{slack_team_id}")
