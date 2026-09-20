import unittest

from app import _build_agent_system_prompt, _build_workrun_prompt


class WorkRunPromptTests(unittest.TestCase):
    def test_system_prompt_keeps_direct_answers_tool_free(self):
        prompt = _build_agent_system_prompt(None)
        self.assertIn("answer directly", prompt)
        self.assertIn("select a playbook, or create tasks", prompt)
        self.assertIn("company work", prompt)

    def test_system_prompt_allows_grounded_answers_without_a_plan(self):
        prompt = _build_agent_system_prompt(None)
        self.assertIn("answer without a playbook or\n   task plan", prompt)

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
        self.assertIn("without a playbook or TaskCreate", prompt)
        company_work = prompt[prompt.index("For \"company work\""):] if "For \"company work\"" in prompt else prompt[prompt.index("For company work"):]
        self.assertLess(company_work.index("PlaybookList"), company_work.index("TaskCreate"))
        self.assertLess(company_work.index("TaskCreate"), company_work.index("activate another tool group"))


if __name__ == "__main__":
    unittest.main()
