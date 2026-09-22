import asyncio
import unittest
from types import SimpleNamespace
from pathlib import Path

from agentscope.message import TextBlock
from agentscope.tool import TaskCreate, TaskUpdate, Toolkit, ToolChunk
from agentscope.workspace import LocalWorkspace
from hive_toolkit_groups import (
    TEAM_TOOL_NAMES,
    extra_groups_for,
    partition_hive_tools,
    separate_native_tool_groups,
)
from extra_agent_tools import hivemind_tools


class HiveToolkitGroupsTests(unittest.TestCase):
    def test_only_playbook_tools_remain_in_basic_group(self):
        tools = [
            SimpleNamespace(name="PlaybookList"),
            SimpleNamespace(name="PlaybookGet"),
            SimpleNamespace(name="hivemind_company_context"),
            SimpleNamespace(name="hivemind_people"),
            SimpleNamespace(name="hivemind_projects"),
            SimpleNamespace(name="hivemind_web_search"),
            SimpleNamespace(name="hivemind_composio_execute"),
        ]
        groups = partition_hive_tools(tools)
        self.assertEqual([tool.name for tool in groups["basic"]], ["PlaybookList", "PlaybookGet"])
        self.assertEqual(
            [tool.name for tool in groups["hivemind"]],
            ["hivemind_company_context", "hivemind_people", "hivemind_projects"],
        )
        self.assertEqual([tool.name for tool in groups["web_research"]], ["hivemind_web_search"])
        self.assertEqual([tool.name for tool in groups["connected_apps"]], ["hivemind_composio_execute"])

    def test_extra_groups_keep_non_basic_schemas_out_of_the_initial_tools(self):
        tools = [
            SimpleNamespace(name="PlaybookList"),
            SimpleNamespace(name="PlaybookGet"),
            SimpleNamespace(name="hivemind_company_context"),
            SimpleNamespace(name="hivemind_web_search"),
            SimpleNamespace(name="hivemind_composio_tools"),
        ]
        basic, groups = extra_groups_for(tools)
        self.assertEqual([tool.name for tool in basic], ["PlaybookList", "PlaybookGet"])
        self.assertEqual([group.name for group in groups], ["hivemind", "web_research", "connected_apps"])

    def test_unknown_extra_is_an_explicit_runtime_extension_group(self):
        basic, groups = extra_groups_for([SimpleNamespace(name="custom_runtime_tool")])
        self.assertEqual(basic, [])
        self.assertEqual([group.name for group in groups], ["runtime_extensions"])

    def test_native_workspace_and_team_tools_are_not_left_in_basic(self):
        basic = SimpleNamespace(
            name="basic",
            tools=[
                SimpleNamespace(name="Bash"),
                SimpleNamespace(name="Read"),
                SimpleNamespace(name="TaskCreate"),
                SimpleNamespace(name="TeamCreate"),
            ],
            skills_or_loaders=["skill-loader"],
            mcps=["mcp-client"],
        )
        toolkit = SimpleNamespace(tool_groups=[basic])
        separate_native_tool_groups(toolkit, {"Bash", "Read"})
        groups = {group.name: group for group in toolkit.tool_groups}
        self.assertEqual([tool.name for tool in groups["basic"].tools], ["TaskCreate"])
        self.assertEqual([tool.name for tool in groups["workspace"].tools], ["Bash", "Read"])
        self.assertEqual([tool.name for tool in groups["team_tools"].tools], ["TeamCreate"])
        self.assertEqual(len(groups["basic"].skills_or_loaders), 1)
        self.assertEqual(groups["workspace"].skills_or_loaders, [])
        self.assertEqual(groups["workspace"].mcps, ["mcp-client"])
        self.assertIn("TeamCreate", TEAM_TOOL_NAMES)

    def test_real_agentscope_toolkit_hides_workspace_schema_until_reset(self):
        async def verify():
            workspace = LocalWorkspace(workdir="/tmp/hm-toolkit-group-test")
            workspace_tools = await workspace.list_tools()
            toolkit = Toolkit(tools=workspace_tools + [TaskCreate()])
            separate_native_tool_groups(
                toolkit,
                {tool.name for tool in workspace_tools},
            )
            basic = {
                schema["function"]["name"]
                for schema in await toolkit.get_tool_schemas()
            }
            active_workspace = {
                schema["function"]["name"]
                for schema in await toolkit.get_tool_schemas(["workspace"])
            }
            self.assertIn("TaskCreate", basic)
            self.assertNotIn("Bash", basic)
            self.assertIn("Bash", active_workspace)

        asyncio.run(verify())

    def test_runtime_does_not_pre_activate_a_group_before_reset_tools(self):
        app_source = (Path(__file__).resolve().parents[1] / "app.py").read_text()
        self.assertNotIn("custom_agent_cls=HiveWorkRunAgent", app_source)
        self.assertNotIn("activated_groups", app_source)

    def test_workrun_prompt_uses_the_native_task_dependency_schema(self):
        """AgentScope 2.0.8 creates tasks before their ids can be linked."""
        self.assertNotIn("blocked_by", TaskCreate.input_schema["properties"])
        self.assertIn("add_blocked_by", TaskUpdate.input_schema["properties"])
        app_source = (Path(__file__).resolve().parents[1] / "app.py").read_text()
        self.assertIn("TaskUpdate.add_blocked_by", app_source)
        self.assertNotIn("TaskCreate for each step (use blocked_by", app_source)

    def test_focused_company_collections_are_available_only_via_hivemind_group(self):
        async def verify():
            tools = await hivemind_tools(
                "11111111-1111-4111-8111-111111111111",
                "agent-1",
                "session-1",
            )
            groups = partition_hive_tools(tools)
            names = {tool.name for tool in groups["hivemind"]}
            self.assertTrue({
                "hivemind_people",
                "hivemind_projects",
                "hivemind_objectives",
                "hivemind_work",
                "hivemind_artifacts",
            }.issubset(names))
            self.assertFalse(names & {tool.name for tool in groups["basic"]})

        asyncio.run(verify())

    def test_every_injected_hivemind_tool_has_agent_scope_metadata(self):
        async def verify():
            tools = await hivemind_tools(
                "11111111-1111-4111-8111-111111111111",
                "agent-1",
                "session-1",
            )
            missing = [tool.name for tool in tools if not str(getattr(tool, "description", "")).strip()]
            self.assertEqual(missing, [])

        asyncio.run(verify())


if __name__ == "__main__":
    unittest.main()
