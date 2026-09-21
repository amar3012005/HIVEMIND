import unittest

from app import (
    _DEFAULT_WORKRUN_MODEL,
    _build_agent_system_prompt,
    _build_workrun_prompt,
    _workrun_credential_mode,
)


class WorkRunPromptTests(unittest.TestCase):
    def test_gateway_mode_never_uses_direct_provider_credential(self):
        self.assertEqual(
            _workrun_credential_mode(gateway_enabled=True, direct_key=None),
            "cloudflare_gateway_credential",
        )

    def test_direct_mode_ignores_persisted_gateway_placeholder(self):
        self.assertEqual(
            _workrun_credential_mode(gateway_enabled=False, direct_key="configured"),
            "openai_credential",
        )

    def test_direct_mode_without_key_requires_existing_direct_credential(self):
        self.assertEqual(
            _workrun_credential_mode(gateway_enabled=False, direct_key=None),
            "existing_direct_credential",
        )

    def test_default_workrun_model_has_a_shipped_gateway_card(self):
        self.assertEqual(_DEFAULT_WORKRUN_MODEL, "deepseek/deepseek-v4-flash")

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


if __name__ == "__main__":
    unittest.main()
