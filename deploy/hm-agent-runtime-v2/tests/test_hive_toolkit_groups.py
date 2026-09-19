import unittest
from types import SimpleNamespace
from pathlib import Path

from hive_toolkit_groups import extra_groups_for, partition_hive_tools


class HiveToolkitGroupsTests(unittest.TestCase):
    def test_only_playbook_tools_remain_in_basic_group(self):
        tools = [
            SimpleNamespace(name="PlaybookList"),
            SimpleNamespace(name="PlaybookGet"),
            SimpleNamespace(name="hivemind_company_context"),
            SimpleNamespace(name="hivemind_web_search"),
            SimpleNamespace(name="hivemind_composio_execute"),
        ]
        groups = partition_hive_tools(tools)
        self.assertEqual([tool.name for tool in groups["basic"]], ["PlaybookList", "PlaybookGet"])
        self.assertEqual([tool.name for tool in groups["hivemind"]], ["hivemind_company_context"])
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

    def test_runtime_does_not_pre_activate_a_group_before_reset_tools(self):
        app_source = (Path(__file__).resolve().parents[1] / "app.py").read_text()
        self.assertNotIn("custom_agent_cls=HiveWorkRunAgent", app_source)
        self.assertNotIn("activated_groups", app_source)


if __name__ == "__main__":
    unittest.main()
