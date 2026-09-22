"""Source-backed AgentScope team/template acceptance canary.

This deliberately exercises the native ``AgentCreate`` object rather than
reimplementing a second team runner.  It verifies that the runtime registered
the configured templates through AgentScope's ``custom_subagent_templates``
hook, that the leader-facing schema exposes the routing enum, and that the
roles remain differentiated by permission and prompt contract.
"""
from __future__ import annotations

import asyncio
import sys


def main() -> int:
    sys.path.insert(0, "/app")
    import app  # noqa: WPS433 - the canary must inspect the runtime wiring
    from agentscope.app._tool import AgentCreate, TeamCreate, TeamDelete, TeamSay
    from agentscope.app.message_bus import InMemoryMessageBus
    from agentscope.app.message_bus._keys import MessageBusKeys
    from agentscope.app.storage import (
        AgentData,
        AgentRecord,
        SessionConfig,
        SessionRecord,
    )

    templates = {template.type: template for template in app._SUBAGENT_TEMPLATES}
    expected = {"researcher", "writer", "analyst", "reviewer"}
    if set(templates) != expected:
        raise AssertionError(f"unexpected templates: {sorted(templates)}")

    tool = AgentCreate(
        storage=None,
        message_bus=None,
        workspace_manager=None,
        user_id="canary-user",
        session_id="canary-session",
        agent_id="canary-agent",
        sub_agent_templates=templates,
    )
    schema = tool.input_schema["properties"].get("subagent_type")
    if schema is None or set(schema.get("enum", [])) != expected | {"default"}:
        raise AssertionError(f"AgentCreate schema lost template enum: {schema}")

    if templates["researcher"].permission_context.mode.value != "explore":
        raise AssertionError("researcher must be read-only EXPLORE")
    if templates["analyst"].permission_context.mode.value != "explore":
        raise AssertionError("analyst must be read-only EXPLORE")
    if templates["writer"].permission_context.mode.value == "explore":
        raise AssertionError("writer must retain mutating/default permission mode")

    prompts = {name: template.system_prompt_template for name, template in templates.items()}
    if len(set(prompts.values())) != len(prompts):
        raise AssertionError("team templates collapsed to one prompt")
    for name, prompt in prompts.items():
        if "{member_name}" not in prompt or "{team_name}" not in prompt:
            raise AssertionError(f"{name} prompt is not a native AgentScope template")

    # The remaining team controls are native AgentScope tools.  Their presence
    # here prevents a HIVE-side substitute from silently becoming the runner.
    if not TeamCreate.name or not TeamSay.name:
        raise AssertionError("native team tools are unavailable")

    # Run the native TeamCreate -> AgentCreate path with a tiny in-memory
    # storage double.  This exercises AgentScope's actual team mutations and
    # inbox delivery without invoking a model or a second HIVE runner.
    user_id, agent_id, session_id = "canary-user", "leader-agent", "leader-session"
    leader = AgentRecord(
        user_id=user_id,
        data=AgentData(name="leader", context_config=templates["writer"].context_config, react_config=templates["writer"].react_config),
    )
    leader.id = agent_id
    leader_session = SessionRecord(
        user_id=user_id,
        agent_id=agent_id,
        id=session_id,
        config=SessionConfig(workspace_id="canary-workspace"),
    )

    class StorageDouble:
        def __init__(self):
            self.agents = {(user_id, agent_id): leader}
            self.sessions = {session_id: leader_session}
            self.teams = {}

        async def get_session(self, _user, _agent, sid):
            return self.sessions.get(sid)

        async def get_team(self, _user, team_id):
            return self.teams.get(team_id)

        async def upsert_team(self, _user, team):
            self.teams[team.id] = team

        async def set_session_team_id(self, _user, sid, team_id):
            self.sessions[sid].team_id = team_id

        async def get_agent(self, owner, aid):
            return self.agents.get((owner, aid))

        async def list_sessions(self, owner, aid):
            return [
                session
                for session in self.sessions.values()
                if session.user_id == owner and session.agent_id == aid
            ]

        async def upsert_agent(self, _user, agent):
            self.agents[(agent.user_id, agent.id)] = agent

        async def upsert_session(self, *, user_id, agent_id, config, state, origin):
            session = SessionRecord(
                user_id=user_id,
                agent_id=agent_id,
                config=config,
                state=state,
                origin=origin,
            )
            self.sessions[session.id] = session
            return session

        async def delete_session(self, owner, aid, sid):
            session = self.sessions.get(sid)
            if session is None:
                return False
            if session.user_id != owner or session.agent_id != aid:
                return False
            del self.sessions[sid]
            return True

        async def delete_agent(self, owner, aid):
            existed = self.agents.pop((owner, aid), None) is not None
            return existed

        async def list_schedules(self, _owner):
            return []

        async def delete_schedule(self, _owner, _schedule_id):
            return True

        async def delete_team(self, owner, team_id):
            team = self.teams.pop(team_id, None)
            if team is None:
                return False
            leader_session = self.sessions.get(team.session_id)
            if leader_session is not None:
                leader_session.team_id = None
            return True

    storage = StorageDouble()
    bus = InMemoryMessageBus()
    create = TeamCreate(storage, bus, None, user_id, session_id, agent_id)
    created = asyncio.run(create(name="evidence-team", description="Canary team"))
    if "created" not in str(created.content[0].text):
        raise AssertionError(f"native TeamCreate failed: {created}")
    spawn = AgentCreate(
        storage,
        bus,
        None,
        user_id,
        session_id,
        agent_id,
        sub_agent_templates=templates,
    )
    spawned = asyncio.run(
        spawn(
            name="researcher-1",
            description="Investigate the canary",
            prompt="Return one evidence-backed finding.",
            subagent_type="researcher",
        ),
    )
    if spawned.state.value == "error":
        raise AssertionError(f"native AgentCreate failed: {spawned}")
    workers = [a for (owner, _), a in storage.agents.items() if owner == user_id and a.id != agent_id]
    if len(workers) != 1 or "read-only" not in workers[0].data.system_prompt:
        raise AssertionError("researcher worker was not created with its differentiated prompt")
    worker_session = next(
        (session for session in storage.sessions.values() if session.agent_id == workers[0].id),
        None,
    )
    if worker_session is None or not awaitable_queue_has(bus, MessageBusKeys.inbox(worker_session.id)):
        raise AssertionError("AgentCreate did not deliver the native team message")

    # Exercise native TeamSay against the just-created roster.  The initial
    # AgentCreate prompt remains in the worker inbox and this second delivery
    # must be addressed by the worker's display name, not an HIVE-side id.
    say = TeamSay(storage, bus, None, user_id, session_id, agent_id)
    said = asyncio.run(say("Send one durable status update.", to="researcher-1"))
    if said.state.value == "error" or "Delivered to 1" not in said.content[0].text:
        raise AssertionError(f"native TeamSay failed: {said}")
    if len(bus._queues.get(MessageBusKeys.inbox(worker_session.id), [])) < 2:
        raise AssertionError("TeamSay did not append to the worker inbox")

    # Dissolve through AgentScope's native TeamDelete cascade.  This proves
    # created workers/sessions are removed while the leader survives and is
    # detached from the team.
    delete = TeamDelete(storage, bus, None, user_id, session_id, agent_id)
    deleted = asyncio.run(delete())
    if deleted.state.value == "error" or "dissolved" not in deleted.content[0].text:
        raise AssertionError(f"native TeamDelete failed: {deleted}")
    if storage.teams or workers[0].id in {aid for (_owner, aid) in storage.agents}:
        raise AssertionError("TeamDelete left durable team/worker records")
    if worker_session.id in storage.sessions or storage.sessions[session_id].team_id is not None:
        raise AssertionError("TeamDelete did not preserve/detach the leader correctly")
    if MessageBusKeys.inbox(worker_session.id) in bus._queues:
        raise AssertionError("TeamDelete did not purge the worker inbox")

    print(
        "team-templates-canary-ok "
        f"templates={','.join(sorted(templates))} "
        "subagent_types=5 differentiated_prompts=4 "
        "readonly=researcher,analyst native_run=team_create+agent_create+say+delete",
    )
    return 0


def awaitable_queue_has(bus, key: str) -> bool:
    """Synchronous inspection helper for the in-memory bus canary."""
    return bool(bus._queues.get(key))


if __name__ == "__main__":
    raise SystemExit(main())
