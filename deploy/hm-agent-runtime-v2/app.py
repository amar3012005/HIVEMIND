# -*- coding: utf-8 -*-
"""hm-agent-runtime-v2 — Phase 1 Agent Service.

ONE async Agent Service process hosting many concurrent sessions.

Phase 1 topology (see README.md):

    VPS
    ├── hm-core          (identity / org / policy / billing — NOT wired yet)
    ├── Postgres         (hm-core's, untouched by this service)
    ├── Redis            (hm-core's)
    └── hm-agent-runtime-v2
        ├── redis          <- AgentScope's OWN storage + message bus
        └── Agent Service  <- this file, single process

Design rules applied here
-------------------------
1. **Single process.** `enable_scheduler=True` and `enable_channel_worker=True`
   are correct for exactly one replica. When you scale to N workers, exactly one
   process keeps each True and the rest set them False. Getting this wrong makes
   a cron fire once per replica and makes bots double-post.
2. **Redis message bus even in Phase 1.** The bus is the delivery channel for
   scheduled fires, team messages, and background-tool results. Using it now
   means Phase 2 scaling is a config change, not a rewrite.
3. **AgentScope state is isolated.** Its storage lives in its own Redis, never in
   hm-core's Postgres. It does not know what a WorkRun is; hm-core does not know
   what a session is beyond the id it stores.
4. **`download_secret` is set from env.** Left default it is per-process, which
   silently breaks file downloads the moment a second replica exists.
5. **Auth is still the `X-User-ID` placeholder.** This is a DEV-ONLY stance.
   `app.dependency_overrides[...]` is the single place to wire hm-core identity.
   See the TODO block near the bottom.
"""

from __future__ import annotations

import logging
import os
import sys

import uvicorn
from fastapi import Depends, HTTPException, status
from fastapi.middleware import Middleware
from fastapi.middleware.cors import CORSMiddleware

from agentscope.agent import Agent
from agentscope.app import SubAgentTemplate, create_app
import hive_access_policy
import hive_toolkit_groups
import model_capabilities
from agentscope.app.hub import ClawSkillHub, GitHubMCPHub
from agentscope.app.message_bus import RedisMessageBus
from agentscope.app.storage import RedisStorage
from agentscope.app.workspace_manager import IsolationPolicy, LocalWorkspaceManager
from agentscope.permission import PermissionContext, PermissionMode

# Cloudflare AI Gateway: same gateway hm-core uses, OpenRouter BYOK route.
# See cloudflare_gateway.py for the verified request shape.
import cloudflare_gateway as gateway
import hm_auth
import hm_bridge
import extra_agent_tools
from gateway_credential import CloudflareGatewayOpenAICredential

# --------------------------------------------------------------------------
# Configuration (env-driven so the same image runs anywhere)
# --------------------------------------------------------------------------

REDIS_HOST = os.getenv("AGENTSCOPE_REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("AGENTSCOPE_REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("AGENTSCOPE_REDIS_DB", "0"))

WORKSPACES_DIR = os.getenv("AGENTSCOPE_WORKSPACES", "/data/workspaces")

# Required in production. A dev fallback is provided ONLY so a first local boot
# works; it is logged loudly below.
DOWNLOAD_SECRET = os.getenv("AGENTSCOPE_DOWNLOAD_SECRET", "")
_DEV_DOWNLOAD_SECRET = "dev-only-insecure-download-secret"

# Exactly one replica may hold these. Phase 1 is that one replica.
ENABLE_SCHEDULER = os.getenv("AGENTSCOPE_ENABLE_SCHEDULER", "1") == "1"
ENABLE_CHANNEL_WORKER = os.getenv("AGENTSCOPE_ENABLE_CHANNEL_WORKER", "1") == "1"

# Hubs are off by default in Phase 1: the public registries are an outbound
# dependency we do not need to boot, and an unreachable registry should not be
# able to make startup noisy. Flip to "1" when you want the MCP/Skill pages.
ENABLE_HUBS = os.getenv("AGENTSCOPE_ENABLE_HUBS", "0") == "1"


def _log(msg: str) -> None:
    print(f"[hm-agent-runtime-v2] {msg}", flush=True)


# AgentScope logs through the stdlib `logging` module, and its own logger is not
# attached to a handler by default — so a failed chat run reports only the
# generic "The request to the model was rejected as invalid." to the client while
# the real traceback goes nowhere. Attaching a handler makes the underlying
# exception visible, which is the difference between a 5-minute and a 2-hour
# diagnosis. Set AGENTSCOPE_LOG_LEVEL=DEBUG for full request detail.
logging.basicConfig(
    level=os.getenv("AGENTSCOPE_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
    force=True,
)


if not DOWNLOAD_SECRET:
    DOWNLOAD_SECRET = _DEV_DOWNLOAD_SECRET
    _log(
        "WARNING: AGENTSCOPE_DOWNLOAD_SECRET is not set; using the insecure dev "
        "default. Set it before running more than one replica or exposing this "
        "service outside localhost.",
    )

# --------------------------------------------------------------------------
# Storage + bus — AgentScope's state, isolated from hm-core
# --------------------------------------------------------------------------

storage = RedisStorage(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)

message_bus = RedisMessageBus(host=REDIS_HOST, port=REDIS_PORT)

# --------------------------------------------------------------------------
# Workspace — backend is a configuration choice, not a code change.
# --------------------------------------------------------------------------
# Phase 1 used LocalWorkspaceManager, which means this container IS the sandbox:
# all workspaces share one filesystem namespace, so it is single-tenant only.
# workspace_backend.py selects local / bubblewrap / docker / apple / e2b /
# daytona / opensandbox / k8s from AGENTSCOPE_WORKSPACE_BACKEND, so moving to a
# real per-workspace boundary is an env change. Nothing else in this file
# changes.
import workspace_backend

workspace_manager = workspace_backend.build_workspace_manager(WORKSPACES_DIR)

# --------------------------------------------------------------------------
# Employee roles — sub-agent templates
# --------------------------------------------------------------------------
# NOTE: the parameter is `custom_subagent_templates`. The public docs call it
# `sub_agent_templates`, which does NOT exist and is silently swallowed by
# create_app(**kwargs) — templates would never register and every worker would
# fall back to one undifferentiated default. Verify the live tool schema after
# boot: AgentCreate must expose a `subagent_type` parameter.

_SUBAGENT_TEMPLATES = [
    SubAgentTemplate(
        type="researcher",
        description=(
            "Read-only agents specialised in investigation. They can read files "
            "and gather information but cannot modify, create, or delete "
            "anything. Use this type for research, fact-finding, and analysis "
            "where no changes should be made."
        ),
        system_prompt_template="""You are {member_name}, a researcher in team \
'{team_name}' led by {leader_name}.

Team purpose: {team_description}

Your role: {member_description}

## Responsibilities
- Complete the investigation tasks assigned by the team leader.
- You are read-only: you may inspect and read, but you must never modify, \
create, or delete anything.
- Separate source-backed findings from hypotheses. Never invent facts.

## Reporting
- Always report back to {leader_name} using the TeamSay tool, whether the task \
succeeds or fails.
- Keep private reasoning private; share only conclusions and evidence.

Note: `TeamSay` is your ONLY channel to {leader_name}. Anything not sent \
through it is invisible to the team.""",
        permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
    ),
    SubAgentTemplate(
        type="writer",
        description=(
            "Full-access agents that turn researched material into finished "
            "deliverables. Use this type when the task is to produce an "
            "artifact, document, or written output."
        ),
        system_prompt_template="""You are {member_name}, a writer in team \
'{team_name}' led by {leader_name}.

Team purpose: {team_description}

Your role: {member_description}

## Responsibilities
- Produce the deliverable the team leader asked for.
- Build only on material that was actually provided or found; do not invent \
sources, figures, or quotes.

## Reporting
- Report completion to {leader_name} with TeamSay.

Note: `TeamSay` is your ONLY channel to {leader_name}.""",
        permission_context=PermissionContext(),  # default: full access
    ),
    SubAgentTemplate(
        type="analyst",
        description=(
            "Read-only agents specialised in interpretation. They read what "
            "was gathered and turn it into structured judgement — scoring, "
            "comparison, qualification against criteria. Use this type when "
            "raw findings exist and the question is what they mean."
        ),
        system_prompt_template="""You are {member_name}, an analyst in team \
'{team_name}' led by {leader_name}.

Team purpose: {team_description}

Your role: {member_description}

## Responsibilities
- Apply the criteria the team leader gave you to the material provided.
- You are read-only: you may inspect and read, but you must never modify, \
create, or delete anything.
- Every judgement must cite the specific finding it rests on. A score with no \
evidence behind it is a guess, and a guess presented as an analysis is worse \
than no analysis.

## Reporting
- Always report back to {leader_name} using the TeamSay tool, whether the task \
succeeds or fails.
- State your criteria, your verdict per item, and the evidence for each.

Note: `TeamSay` is your ONLY channel to {leader_name}. Anything not sent \
through it is invisible to the team.""",
        permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
    ),
    SubAgentTemplate(
        type="reviewer",
        description=(
            "Read-only agents that adversarially check finished work before it "
            "is accepted. They look for unsupported claims, missing evidence, "
            "and criteria that were not actually met. Use this type as the last "
            "step before a deliverable is reported as done."
        ),
        system_prompt_template="""You are {member_name}, a reviewer in team \
'{team_name}' led by {leader_name}.

Team purpose: {team_description}

Your role: {member_description}

## Responsibilities
- Try to falsify the work you are given. Your job is to find what is wrong \
with it, not to confirm it is fine.
- You are read-only: you may inspect and read, but you must never modify, \
create, or delete anything.
- For every claim, ask: what evidence supports this, and does that evidence \
actually exist? A claim whose evidence cannot be located is a defect.
- Report defects plainly. A review that finds nothing is only useful if you \
actually looked.

## Reporting
- Always report back to {leader_name} using the TeamSay tool, whether the task \
succeeds or fails.
- Report each defect with the claim, the problem, and what would fix it.

Note: `TeamSay` is your ONLY channel to {leader_name}. Anything not sent \
through it is invisible to the team.""",
        permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
    ),
]

# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

def _install_model_reject_logger() -> None:
    """Log the real provider 400 body. Subclass hooks miss some model classes."""
    try:
        from agentscope.model._openai_chat._model import OpenAIChatModel
    except Exception as exc:  # noqa: BLE001
        _log(f"could not wrap OpenAIChatModel: {exc}")
        return
    orig = OpenAIChatModel._call_api

    async def _logged(self, model_name, messages, tools=None, tool_choice=None, **generate_kwargs):
        generate_kwargs["parallel_tool_calls"] = False
        generate_kwargs.pop("audio", None)
        generate_kwargs.pop("modalities", None)
        try:
            self.parameters.parallel_tool_calls = False
        except Exception:
            pass
        names = []
        for item in tools or []:
            if isinstance(item, dict):
                fn = item.get("function") or item
                names.append(fn.get("name") if isinstance(fn, dict) else str(fn)[:40])
        _log(f"model_call model={model_name} tools={len(tools or [])} names={names[:30]}")
        try:
            return await orig(
                self, model_name, messages, tools=tools, tool_choice=tool_choice, **generate_kwargs,
            )
        except BaseException as exc:
            body = getattr(exc, "body", None)
            text = None
            try:
                text = getattr(getattr(exc, "response", None), "text", None)
            except Exception:
                text = None
            _log(f"MODEL_REJECTED model={model_name} err={exc!r} body={body} text={str(text)[:2000]}")
            raise

    OpenAIChatModel._call_api = _logged


_install_model_reject_logger()
hive_toolkit_groups.patch_get_toolkit()


app = create_app(
    storage=storage,
    message_bus=message_bus,
    workspace_manager=workspace_manager,
    # Phase 1: single process owns the timers and the channel connections.
    enable_scheduler=ENABLE_SCHEDULER,
    enable_channel_worker=ENABLE_CHANNEL_WORKER,
    # Employee roles. Verified against source (see skills/agentscope-agent-team).
    custom_subagent_templates=_SUBAGENT_TEMPLATES,
    # HIVE-MIND capabilities as agent tools. This is the ONLY supported
    # injection point — a second context-injection path would race with
    # InboxMiddleware, which is the sole owner of hint injection. The factory
    # runs once per agent assembly and receives the resolved principal, so every
    # tool call is scoped by hm-core rather than by anything the model controls.
    extra_agent_tools=extra_agent_tools.hivemind_tools,
    resource_access_policy=hive_access_policy.HiveMindResourceAccessPolicy(),
    # Cloudflare AI Gateway credential type — routes provider calls through the
    # same gateway as hm-core. Registered unconditionally so the type is always
    # selectable; when the gateway env vars are absent the class falls back to
    # direct routing rather than failing.
    extra_credentials=[CloudflareGatewayOpenAICredential],
    # File-download tokens survive a restart / a second replica.
    download_secret=DOWNLOAD_SECRET,
    # Hubs: opt-in (see ENABLE_HUBS above).
    mcp_hubs=[GitHubMCPHub()] if ENABLE_HUBS else None,
    skill_hubs=[ClawSkillHub(api_token=os.getenv("CLAWHUB_API_TOKEN"))]
    if ENABLE_HUBS
    else None,
    title="HIVEMIND Agent Runtime v2",
    # CORS is permissive for local development. Tighten before exposing this
    # beyond 127.0.0.1.
    extra_middlewares=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        ),
    ],
)

# --------------------------------------------------------------------------
# Web UI — a single static page served from the same origin as the API.
# --------------------------------------------------------------------------
# AgentScope ships no bundled UI (it is API-only), so this serves a minimal
# chat console at `/`. Same-origin means no CORS preflight and no separate
# host to tunnel — one Cloudflare tunnel exposes both the UI and the API.
#
# The page is a thin client over the documented flow:
#   POST /credential/ -> POST /agent/ -> POST /sessions/ -> SSE stream -> POST /chat/
# It carries the X-User-ID header itself, so it works against the current
# placeholder auth. When Phase 5 replaces that with hm-core identity, the page
# swaps the header for a bearer token and nothing else changes.
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.isdir(_STATIC_DIR):
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    @app.get("/", include_in_schema=False)
    async def _ui_index() -> FileResponse:
        return FileResponse(os.path.join(_STATIC_DIR, "index.html"))

    app.mount("/ui", StaticFiles(directory=_STATIC_DIR, html=True), name="ui")
    _log(f"web UI mounted at / (static dir: {_STATIC_DIR})")
else:
    _log(f"web UI not mounted: {_STATIC_DIR} does not exist")


# --------------------------------------------------------------------------
# Diagnostics: surface the real cause of a failed reply.
# --------------------------------------------------------------------------
# AgentScope reports a failed run to the client as a generic, localized message
# ("The request to the model was rejected as invalid.") and deliberately does not
# leak provider detail. That is right for a UI, but it means a misconfiguration
# is undiagnosable from the outside: the client sees a category, not a cause.
#
# This wraps the internal classifier so the underlying exception is logged
# server-side while the client-facing message stays unchanged. Enable with
# AGENTSCOPE_LOG_LEVEL=DEBUG (or leave on; it only fires on failures).
if os.getenv("AGENTSCOPE_LOG_LEVEL", "").upper() == "DEBUG":
    try:
        from agentscope.app._service import _chat as _ascope_chat
        from agentscope.app._service import _errors as _ascope_errors

        _orig_classify = _ascope_errors._classify_error

        def _classify_error_verbose(e):  # type: ignore[no-untyped-def]
            import traceback as _tb

            _log(f"reply failed: {type(e).__name__}: {e}")
            for attr in ("__cause__", "__context__"):
                inner = getattr(e, attr, None)
                if inner is not None:
                    _log(f"  {attr}: {type(inner).__name__}: {inner}")
            _log("  traceback:\n" + "".join(_tb.format_exception(e))[:4000])
            return _orig_classify(e)

        # Patch BOTH bindings. `_chat.py` does `from ._errors import
        # _classify_error`, which binds the function object at import time — so
        # replacing the attribute on `_errors` alone has no effect on the call
        # site. This is the whole reason the first attempt logged nothing.
        _ascope_errors._classify_error = _classify_error_verbose
        _ascope_chat._classify_error = _classify_error_verbose
        _log("verbose error diagnostics enabled (AGENTSCOPE_LOG_LEVEL=DEBUG)")
    except Exception as exc:  # noqa: BLE001 - diagnostics must never break boot
        _log(f"could not enable verbose error diagnostics: {exc}")


# --------------------------------------------------------------------------
# Auth — hm-core identity replaces the X-User-ID placeholder.
# --------------------------------------------------------------------------
# `get_current_user_id` is the single dependency every route resolves the caller
# through, so overriding it authenticates the whole service at once. The
# returned `user_id` is the tenant boundary for every resource AgentScope
# stores (agents, credentials, sessions, schedules).
#
# See hm_auth.py for the accepted credential shapes. In short:
#   - hm-core control plane -> X-API-Key (master) + X-HM-User-Id / X-HM-Org-Id
#   - browser / external    -> Authorization: Bearer <token>, verified by hm-core
#   - X-User-ID             -> only when AGENTSCOPE_ALLOW_DEV_AUTH=1 (local dev)
from fastapi import Header, HTTPException, status

from agentscope.app.deps import get_current_user_id as _default_user_dep


async def get_current_user_id(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None, alias="X-User-ID"),
    x_hm_user_id: str | None = Header(default=None, alias="X-HM-User-Id"),
) -> str:
    """Resolve the caller to hm-core's canonical user id.

    `X-HM-User-Id` is the header hm-core's `buildInternalHeaders()` emits
    alongside the master key, so the control plane needs no new client code.
    """
    try:
        principal = await hm_auth.resolve_principal(
            api_key=x_api_key,
            authorization=authorization,
            legacy_user_id=x_hm_user_id or x_user_id,
        )
    except hm_auth.AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return principal.user_id


app.dependency_overrides[_default_user_dep] = get_current_user_id
_log(f"auth: {hm_auth.describe()}")


# --------------------------------------------------------------------------
# Liveness probe — deliberately unauthenticated.
# --------------------------------------------------------------------------
# AgentScope's `/health` resolves the caller through `get_current_user_id`, so
# once auth is wired it correctly returns 401 without credentials. That is right
# for an operator endpoint (it enumerates component topology), but wrong for a
# container liveness probe, which must answer without a credential or the
# orchestrator kills a healthy container.
#
# `/livez` reports only "the process is up and serving" — no component detail,
# nothing an unauthenticated caller can learn from.
@app.get("/livez", include_in_schema=False)
async def _livez() -> dict:
    return {"status": "ok"}


# --------------------------------------------------------------------------
# hm-core bridge — WorkRun → session mapping + event forwarding.
# --------------------------------------------------------------------------
# hm-core creates a WorkRun, then calls POST /workrun/ here with the resolved
# principal. We create the AgentScope session, persist the reverse index, and
# (when forwarding is on) start tailing the session's SSE stream so every event
# reaches hm-core's own event bus.
#
# The routes are additive: the native AgentScope surface is untouched, so the
# web UI and any direct API client keep working.
import redis.asyncio as aioredis

from hm_bridge import EventForwarder, WorkRunBinding, WorkRunStore
_redis_client = aioredis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    db=REDIS_DB,
    decode_responses=True,
)
_workrun_store = WorkRunStore(_redis_client)
_forwarders: dict[str, EventForwarder] = {}


# --------------------------------------------------------------------------
# WorkRun helpers
# --------------------------------------------------------------------------
# These three functions are the whole translation layer between hm-core's
# vocabulary and AgentScope's. Keeping them together makes the seam auditable:
# everything hm-core-specific about a run is in this block, and everything
# AgentScope-specific is a call into the framework.

# The default model for a WorkRun when hm-core did not name one. Resolved from
# env so the same image runs against a different provider without a code change.
_DEFAULT_WORKRUN_MODEL = os.getenv(
    "AGENTSCOPE_WORKRUN_MODEL",
    "deepseek/deepseek-v4-flash-0731",
)

# InjectionConfig.inject_runtime_state stays the Agent constructor default
# (True). Manual compression tool is decided by model_capabilities, not the FE.
_HYPERAGENT_CONTEXT = model_capabilities.context_config_for(_DEFAULT_WORKRUN_MODEL)
_HYPERAGENT_REACT = model_capabilities.react_config_for(_DEFAULT_WORKRUN_MODEL)


async def _resolve_agent(
    *,
    user_id: str,
    agent_ref: str,
    hyperagent_slug: str | None,
    goal: str,
) -> str:
    """Resolve hm-core's employee reference to an AgentScope agent record id.

    hm-core sends the employee's id or slug. AgentScope keys agents by its own
    record id, so the reference is translated here. A slug that already has an
    agent record is reused — an employee is one agent across every run, which is
    what makes its sessions comparable and its workspace shareable.

    When no record exists, one is created from the persona. hm-core remains the
    authority on *which* employee; this only mints the runtime-side identity.
    """
    from agentscope.app._router._agent import create_agent as _create_agent
    from agentscope.app._router._schema._agent import CreateAgentRequest

    # Reuse an existing record for this employee. The agent name is the slug so
    # the mapping is stable and inspectable rather than a random id.
    # v3: do not reuse agents minted with compression_tool / custom ContextConfig
    # — those records made DeepSeek reject every request as invalid_request.
    name = f"{hyperagent_slug or 'workrun-default'}-g0"
    existing = await app.state.storage.list_agents(user_id)
    for record in existing or []:
        if getattr(record.data, "name", None) == name:
            return record.id

    created = await _create_agent(
        body=CreateAgentRequest(
            name=name,
            system_prompt=_build_agent_system_prompt(hyperagent_slug),
        ),
        user_id=user_id,
        storage=app.state.storage,
    )
    _log(f"created agent record {created.agent_id} for employee {name!r}")
    return created.agent_id


async def _ensure_phase1_agent_config(user_id: str, record) -> None:
    """Keep Task/injection defaults; never leave compression_tool on.

    DeepSeek via the gateway rejects the native compress tool as an invalid
    request. Existing agent records that were patched on earlier this session
    must be turned back off.
    """
    data = record.data
    ctx = getattr(data, "context_config", None)
    dirty = False
    if getattr(ctx, "compression_tool_enabled", False):
        if ctx is not None and hasattr(ctx, "model_copy"):
            data.context_config = ctx.model_copy(update={"compression_tool_enabled": False})
        else:
            data.context_config = _HYPERAGENT_CONTEXT
        dirty = True
    if getattr(data, "react_config", None) is None:
        data.react_config = _HYPERAGENT_REACT
        dirty = True
    if dirty:
        await app.state.storage.upsert_agent(user_id, record)
        _log(f"phase1: compression_tool OFF on agent {record.id}")


def _build_agent_system_prompt(hyperagent_slug: str | None) -> str:
    """The employee's system prompt.

    Deliberately thin. The persona, the playbook, and the company context are
    all *data* the run supplies — hard-coding domain knowledge here would put
    it in the engine, which the GENERALITY CONTRACT forbids. This prompt states
    the operating rules that hold for every employee, and nothing about any
    particular business.
    """
    role = f"You are the {hyperagent_slug} employee." if hyperagent_slug else "You are a digital employee."
    return f"""{role}

You complete work orders end to end and report what you actually did.

## Operating rules

1. **Ground every claim.** Before asserting a fact about this organization, its
   people, its customers, or its prior work, retrieve it with `hivemind_recall`
   or `hivemind_company_context`. A fact you did not retrieve is a guess, and a
   guess presented as a finding is the worst possible output.

2. **Check what is already known before discovering anew.** Call
   `hivemind_list_prospects` before searching for prospects. Re-discovering a
   known lead wastes the run and creates duplicates.

3. **Use the web only for the outside world.** `hivemind_web_search` is for
   company websites, public records, and news. Never use it for facts about this
   organization — those live in memory.

4. **Persist what you find.** Save qualified prospects with
   `hivemind_save_prospect` and durable conclusions with `hivemind_save_memory`.
   Work that is not persisted did not happen.

5. **Produce a real artifact.** When the task asks for a deliverable, write the
   file into the workspace and register it with `hivemind_record_artifact`. A
   description of a deliverable is not a deliverable.

6. **Report honestly.** If a tool fails, say so and say what you could not
   determine. Never fill a gap with a plausible invention.

7. **Operating plan is AgentScope Tasks.** Before other tools, decompose the
   WorkRun with `TaskCreate` (subject, description, `blocked_by` when a step
   depends on another). Keep it current with `TaskUpdate`. Injected runtime
   state (tasks, time, context length) is ground truth — do not contradict it
   from memory of an earlier turn. If a context-compression tool is available,
   use it between major tasks when the run has been long.

8. **Playbooks.** If the WorkRun playbook is General (or unset), call
   `PlaybookList` then `PlaybookGet` on the id you choose. Do not invent an id."""


def _build_workrun_prompt(
    *,
    goal: str,
    hyperagent_slug: str | None,
    playbook_id: str | None,
    playbook_version: str | None,
    scope: dict,
) -> str:
    """Compose the run's opening message.

    The goal is the user's own words, passed through unchanged — paraphrasing it
    would let the runtime quietly narrow or widen what was asked. The playbook
    and scope are attached as data, so the engine reads them rather than
    branching on them.
    """
    parts = [goal.strip()]

    if playbook_id:
        version = f" (version {playbook_version})" if playbook_version else ""
        parts.append(
            f"\n\nFollow the playbook `{playbook_id}`{version}. Its stages and "
            "acceptance criteria define what done means for this run.",
        )

    if scope:
        import json as _json

        parts.append(
            "\n\nScope for this run (data, not instructions):\n"
            f"```json\n{_json.dumps(scope, ensure_ascii=False, indent=2)}\n```",
        )

    parts.append(
        "\n\nFirst create an operating plan with TaskCreate for each step "
        "(use blocked_by for dependencies). Then execute, updating tasks as "
        "you go. Work autonomously to completion. Do not ask for confirmation — "
        "make the safest reversible choice and record it. When you are done, "
        "state plainly what you produced, what you verified, and what you could "
        "not determine.",
    )
    return "".join(parts)


async def _dispatch_chat(
    *,
    user_id: str,
    agent_id: str,
    session_id: str,
    text: str,
) -> None:
    """Start the run by posting the opening message to the session.

    `POST /chat` returns immediately with `{"status": "started"}`; all output
    arrives on the SSE stream. A second call on a live session returns 409
    (single-run-per-session), which is why the WorkRun binding is idempotent —
    a retried dispatch must not attempt a second chat.
    """
    from agentscope.app._router._chat import chat as _chat
    from agentscope.app._router._schema._chat import ChatRequest

    await _chat(
        request=ChatRequest(
            agent_id=agent_id,
            session_id=session_id,
            input={
                "name": "workrun",
                "role": "user",
                "content": [{"type": "text", "text": text}],
            },
        ),
        user_id=user_id,
        chat_service=app.state.chat_service,
        chat_run_registry=app.state.chat_run_registry,
        message_bus=app.state.message_bus,
    )


async def _ensure_gateway_chat_model_config(user_id: str) -> dict:
    """Bind every WorkRun session to the gateway DeepSeek model.

    CreateAgentRequest has no chat model. Sessions without chat_model_config
    call nothing valid and AgentScope reports invalid_request in ~80ms.
    """
    from agentscope.app._router._credential import create_credential as _create_credential
    from agentscope.app._router._schema._credential import CreateCredentialRequest

    cred_id = None
    records = await app.state.storage.list_credentials(user_id)
    for rec in records or []:
        data = getattr(rec, "data", rec)
        typ = data.get("type") if isinstance(data, dict) else getattr(data, "type", None)
        if typ == "cloudflare_gateway_credential":
            cred_id = getattr(rec, "id", None) or getattr(rec, "credential_id", None)
            break
    if not cred_id:
        created = await _create_credential(
            body=CreateCredentialRequest(
                data={
                    "type": "cloudflare_gateway_credential",
                    "name": "workrun-gateway",
                    "api_key": "gateway-managed",
                },
            ),
            user_id=user_id,
            storage=app.state.storage,
        )
        cred_id = created.credential_id
        _log(f"minted gateway credential {cred_id} for user {user_id}")
    model = os.getenv("AGENTSCOPE_WORKRUN_MODEL", _DEFAULT_WORKRUN_MODEL)
    return {
        "type": "cloudflare_gateway_credential",
        "credential_id": cred_id,
        "model": model,
        "parameters": {"parallel_tool_calls": False},
    }


@app.post("/workrun/", tags=["workrun"], include_in_schema=True)
async def create_workrun_session(
    body: dict,
    user_id: str = Depends(get_current_user_id),
) -> dict:
    """Bind a hm-core WorkRun to a new AgentScope session and start it.

    Body:
        workrun_id   (str, required)  hm-core's WorkRun id
        agent_id     (str, required)  the employee's id or slug
        turn_id      (str, required)  hm-core's HyperTurn id — the execution id
        room_id      (str, required)  hm-core's HyperRoom id
        goal         (str, required)  what the run must accomplish
        org_id       (str, optional)  carried for forwarding
        hyperagent_slug (str, opt)    the persona to run as
        playbook_id  (str, optional)  the playbook to follow
        scope        (obj, optional)  company/project/filter scope
        workspace_id (str, optional)  reuse an existing workspace
        chat_model_config (obj, opt)  model + credential

    `turn_id` and `room_id` are required because hm-core's inbound sink
    re-derives the execution identity from the persisted HyperTurn row and
    answers 409 on any mismatch. A WorkRun maps to one HyperTurn, not a room.

    Returns the session id, which hm-core stores on the WorkRun.
    """
    workrun_id = body.get("workrun_id")
    agent_id = body.get("agent_id")
    turn_id = body.get("turn_id")
    room_id = body.get("room_id")
    goal = body.get("goal")
    missing = [
        k
        for k, v in (
            ("workrun_id", workrun_id),
            ("agent_id", agent_id),
            ("turn_id", turn_id),
            ("room_id", room_id),
            ("goal", goal),
        )
        if not v
    ]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"missing required field(s): {', '.join(missing)}",
        )

    existing = await _workrun_store.get(workrun_id)
    if existing is not None:
        # Idempotent: a retried hm-core call returns the same session rather
        # than creating a second one. A retry must never start a second run —
        # the goal would execute twice and produce duplicate artifacts.
        return {
            "workrun_id": workrun_id,
            "session_id": existing.session_id,
            "agent_id": existing.agent_id,
            "workspace_id": existing.workspace_id,
            "created": False,
        }

    # ── Resolve the AgentScope agent record ──
    # hm-core sends the employee's id or slug. AgentScope keys agents by its own
    # record id, so the mapping is resolved here and cached on the binding.
    # hm-core remains the authority on *which* employee; this only translates
    # the identity into the runtime's own vocabulary.
    resolved_agent_id = await _resolve_agent(
        user_id=user_id,
        agent_ref=str(agent_id),
        hyperagent_slug=body.get("hyperagent_slug"),
        goal=str(goal),
    )

    session_body: dict = {"agent_id": resolved_agent_id}
    for key in ("workspace_id", "name", "chat_model_config"):
        if body.get(key) is not None:
            session_body[key] = body[key]
    if session_body.get("chat_model_config") is None:
        session_body["chat_model_config"] = await _ensure_gateway_chat_model_config(user_id)

    # One workspace per WorkRun, named for the run.
    #
    # `per_session` isolation would mint a random UUID, which is correct but
    # anonymous: an operator looking at a sandbox cannot tell which run it
    # belongs to, and a later WorkRun cannot deliberately reuse or deliberately
    # avoid it. Naming it `workrun:<uuid>` makes the isolation boundary legible
    # and makes the id stable across a retry of the same run.
    #
    # An explicit id from the caller wins — hm-core may have already bound a
    # workspace to this run and be asking the runtime to reuse it.
    if session_body.get("workspace_id") is None:
        session_body["workspace_id"] = f"workrun:{workrun_id}"

    # Reuse AgentScope's own create_session route handler rather than
    # reimplementing it: that keeps every invariant (agent visibility check,
    # credential existence, workspace minting under the isolation policy) in
    # one place. We resolve its dependencies from app.state exactly as FastAPI
    # would, then call it directly.
    from agentscope.app._router._session import create_session as _create_session
    from agentscope.app._router._schema._session import CreateSessionRequest

    created = await _create_session(
        body=CreateSessionRequest(**session_body),
        user_id=user_id,
        storage=app.state.storage,
        workspace_manager=app.state.workspace_manager,
        access=app.state.resource_access_service,
    )
    session_id = created.session_id

    # Read back the minted workspace id — hm-core stores it so a later WorkRun
    # can reuse the same workspace.
    workspace_id = session_body.get("workspace_id")
    if workspace_id is None:
        record = await app.state.storage.get_session(user_id, resolved_agent_id, session_id)
        if record is not None and getattr(record, "config", None) is not None:
            workspace_id = record.config.workspace_id

    binding = WorkRunBinding(
        workrun_id=workrun_id,
        user_id=user_id,
        org_id=body.get("org_id"),
        agent_id=resolved_agent_id,
        session_id=session_id,
        turn_id=turn_id,
        room_id=room_id,
        workspace_id=workspace_id,
    )
    await _workrun_store.put(binding)

    # ── Start forwarding BEFORE dispatching ──
    # The stream replays buffered history to a late joiner, so ordering is not
    # strictly required — but starting first means the very first event is
    # forwarded live rather than replayed, which keeps the progress log's
    # timestamps honest.
    if hm_bridge.FORWARD_ENABLED and hm_bridge.HM_CORE_URL:
        forwarder = EventForwarder(
            binding=binding,
            master_key=hm_auth._master_key(),
        )
        stream_url = (
            f"http://127.0.0.1:8000/sessions/{session_id}/stream"
            f"?agent_id={resolved_agent_id}"
        )
        forwarder.start(stream_url, user_id)
        _forwarders[workrun_id] = forwarder

    # ── Dispatch the goal ──
    # POST /chat returns immediately; all output arrives on the SSE stream the
    # forwarder is already tailing. This is the step that actually starts the
    # work — without it the session exists but nothing runs.
    prompt = _build_workrun_prompt(
        goal=str(goal),
        hyperagent_slug=body.get("hyperagent_slug"),
        playbook_id=body.get("playbook_id"),
        playbook_version=body.get("playbook_version"),
        scope=body.get("scope") if isinstance(body.get("scope"), dict) else {},
    )
    try:
        await _dispatch_chat(
            user_id=user_id,
            agent_id=resolved_agent_id,
            session_id=session_id,
            text=prompt,
        )
    except Exception as exc:  # noqa: BLE001 - report, do not leave a silent dead run
        _log(f"workrun {workrun_id}: chat dispatch failed: {exc}")
        fwd = _forwarders.pop(workrun_id, None)
        if fwd is not None:
            await fwd.stop()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"session created but the run could not be started: {exc}",
        ) from exc

    _log(f"workrun {workrun_id} -> session {session_id} (agent {resolved_agent_id})")
    return {
        "workrun_id": workrun_id,
        "session_id": session_id,
        "agent_id": resolved_agent_id,
        "turn_id": turn_id,
        "room_id": room_id,
        "workspace_id": workspace_id,
        "created": True,
    }


@app.get("/workrun/{workrun_id}", tags=["workrun"])
async def get_workrun(
    workrun_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict:
    """Look up the session bound to a WorkRun."""
    binding = await _workrun_store.get(workrun_id)
    if binding is None or binding.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    fwd = _forwarders.get(workrun_id)
    return {
        "workrun_id": binding.workrun_id,
        "session_id": binding.session_id,
        "agent_id": binding.agent_id,
        "turn_id": binding.turn_id,
        "room_id": binding.room_id,
        "workspace_id": binding.workspace_id,
        "forwarding": fwd.stats if fwd else None,
    }


@app.delete("/workrun/{workrun_id}", tags=["workrun"])
async def delete_workrun(
    workrun_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict:
    """Unbind a WorkRun and stop its forwarder."""
    binding = await _workrun_store.get(workrun_id)
    if binding is None or binding.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    fwd = _forwarders.pop(workrun_id, None)
    if fwd is not None:
        await fwd.stop()
    await _workrun_store.delete(workrun_id)
    return {"workrun_id": workrun_id, "deleted": True}


_log(f"hm-core bridge: {hm_bridge.describe()}")


if __name__ == "__main__":
    # Every model call in this deployment goes through the gateway.
    _log(f"cloudflare-ai-gateway: {gateway.describe()}")
    _log(
        f"starting: redis={REDIS_HOST}:{REDIS_PORT}/{REDIS_DB} "
        f"workspaces={WORKSPACES_DIR} scheduler={ENABLE_SCHEDULER} "
        f"channels={ENABLE_CHANNEL_WORKER} hubs={ENABLE_HUBS} "
        f"roles={[t.type for t in _SUBAGENT_TEMPLATES]}",
    )
    # No --reload: hot reload forces a SelectorEventLoop, which cannot spawn the
    # subprocesses the builtin tools rely on.
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
