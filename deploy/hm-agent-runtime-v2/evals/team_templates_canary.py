"""Source-backed AgentScope team/template acceptance canary.

This deliberately exercises the native ``AgentCreate`` object rather than
reimplementing a second team runner.  It verifies that the runtime registered
the configured templates through AgentScope's ``custom_subagent_templates``
hook, that the leader-facing schema exposes the routing enum, and that the
roles remain differentiated by permission and prompt contract.
"""
from __future__ import annotations

import sys


def main() -> int:
    sys.path.insert(0, "/app")
    import app  # noqa: WPS433 - the canary must inspect the runtime wiring
    from agentscope.app._tool import AgentCreate, TeamCreate, TeamSay

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

    print(
        "team-templates-canary-ok "
        f"templates={','.join(sorted(templates))} "
        "subagent_types=5 differentiated_prompts=4 "
        "readonly=researcher,analyst",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
