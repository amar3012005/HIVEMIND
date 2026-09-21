import unittest

from agentscope.app._tool._agent_create import AgentCreate

from app import _SUBAGENT_TEMPLATES, _build_agent_system_prompt, _build_workrun_prompt


class WorkRunPromptTests(unittest.TestCase):
    def test_system_prompt_keeps_direct_answers_tool_free(self):
        prompt = _build_agent_system_prompt(None)
        self.assertIn("answer directly", prompt)
        self.assertIn("select a playbook, or create tasks", prompt)
        self.assertIn("company work", prompt)

    def test_system_prompt_allows_grounded_answers_without_a_plan(self):
        prompt = _build_agent_system_prompt(None)
        self.assertIn("answer without a playbook or\n   task plan", prompt)
        self.assertIn("SkillViewer", prompt)
        self.assertIn("never load every Skill speculatively", prompt)

    def test_company_work_order_is_playbook_then_tasks_then_group(self):
        prompt = _build_workrun_prompt(
            goal="Create a report",
            hyperagent_slug=None,
            playbook_id=None,
            playbook_version=None,
            scope={},
        )
        self.assertIn("For a self-contained direct answer", prompt)
        self.assertIn("company-grounded answer", prompt)
        self.assertIn("hivemind_complete_workrun", prompt)
        self.assertIn("without a playbook or TaskCreate", prompt)
        company_work = prompt[prompt.index("For \"company work\""):] if "For \"company work\"" in prompt else prompt[prompt.index("For company work"):]
        self.assertLess(company_work.index("PlaybookList"), company_work.index("TaskCreate"))
        self.assertLess(company_work.index("TaskCreate"), company_work.index("SkillViewer"))
        self.assertLess(company_work.index("SkillViewer"), company_work.index("activate another tool group"))

    def test_read_only_team_roles_cannot_inherit_full_leader_access(self):
        templates = {template.type: template for template in _SUBAGENT_TEMPLATES}
        for role in ("researcher", "analyst", "reviewer"):
            with self.subTest(role=role):
                self.assertTrue(templates[role].override_leader_mode)
                self.assertEqual(templates[role].permission_context.mode.value, "explore")
        prompt = _build_agent_system_prompt(None)
        self.assertIn("Teams are explicit, native delegation", prompt)
        self.assertIn("Persist required\n    artifacts before `TeamDelete`", prompt)

    def test_native_agent_create_exposes_the_registered_role_choices(self):
        templates = {template.type: template for template in _SUBAGENT_TEMPLATES}
        tool = AgentCreate(
            storage=None,
            message_bus=None,
            workspace_manager=None,
            user_id="user-1",
            agent_id="agent-1",
            session_id="session-1",
            sub_agent_templates=templates,
        )
        choices = tool.input_schema["properties"]["subagent_type"]["enum"]
        self.assertTrue({"default", "researcher", "writer", "analyst", "reviewer"}.issubset(choices))


if __name__ == "__main__":
    unittest.main()
