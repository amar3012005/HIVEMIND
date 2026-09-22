import unittest

from company_task_contract import validate_company_task


class CompanyTaskContractTests(unittest.TestCase):
    def test_direct_answer_can_skip_company_layers(self):
        verdict = validate_company_task([
            {"type": "REPLY_START"},
            {"type": "TEXT_BLOCK_DELTA", "delta": "Hello"},
            {"type": "REPLY_END", "finished_reason": "completed"},
        ])
        self.assertTrue(verdict["ok"], verdict)
        self.assertFalse(verdict["company_work"])

    def test_company_work_requires_progressive_layers_before_answer(self):
        verdict = validate_company_task([
            {"type": "REPLY_START"},
            {"type": "TOOL_CALL_START", "tool_call_name": "hivemind_company_context"},
            {"type": "TOOL_CALL_START", "tool_call_name": "PlaybookList"},
            {"type": "TOOL_CALL_START", "tool_call_name": "PlaybookGet"},
            {"type": "TOOL_CALL_START", "tool_call_name": "TaskCreate"},
            {"type": "TOOL_CALL_START", "tool_call_name": "SkillViewer"},
            {"type": "TEXT_BLOCK_DELTA", "delta": "Completed with evidence."},
            {"type": "REPLY_END", "finished_reason": "completed"},
        ])
        self.assertTrue(verdict["ok"], verdict)
        self.assertTrue(verdict["company_work"])

    def test_company_work_accepts_agentscope_native_skill_registration_name(self):
        verdict = validate_company_task([
            {"type": "REPLY_START"},
            {"type": "TOOL_CALL_START", "tool_call_name": "hivemind_company_context"},
            {"type": "TOOL_CALL_START", "tool_call_name": "PlaybookList"},
            {"type": "TOOL_CALL_START", "tool_call_name": "PlaybookGet"},
            {"type": "TOOL_CALL_START", "tool_call_name": "TaskCreate"},
            {"type": "TOOL_CALL_START", "tool_call_name": "Skill"},
            {"type": "TEXT_BLOCK_DELTA", "delta": "Completed with evidence."},
            {"type": "REPLY_END", "finished_reason": "completed"},
        ])
        self.assertTrue(verdict["ok"], verdict)

    def test_company_answer_before_playbook_is_rejected(self):
        verdict = validate_company_task([
            {"type": "REPLY_START"},
            {"type": "TOOL_CALL_START", "tool_call_name": "hivemind_company_context"},
            {"type": "TEXT_BLOCK_DELTA", "delta": "premature"},
            {"type": "TOOL_CALL_START", "tool_call_name": "PlaybookList"},
            {"type": "REPLY_END", "finished_reason": "completed"},
        ])
        self.assertFalse(verdict["ok"])
        self.assertIn("company-task layers must precede the answer", verdict["errors"])


if __name__ == "__main__":
    unittest.main()
