import unittest

from lifecycle_contract import validate_lifecycle


class LifecycleContractTests(unittest.TestCase):
    def test_valid_turn_has_one_terminal_and_preserves_order(self):
        verdict = validate_lifecycle([
            {"id": "start", "type": "REPLY_START"},
            {"id": "thought", "type": "THINKING_BLOCK_DELTA"},
            {"id": "tool", "type": "TOOL_CALL_START"},
            {"id": "answer", "type": "TEXT_BLOCK_DELTA"},
            {"id": "end", "type": "REPLY_END"},
        ])
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["phases"], ["acknowledgement", "thinking", "tool", "answer", "terminal"])

    def test_replay_duplicate_and_missing_ack_are_rejected(self):
        verdict = validate_lifecycle([
            {"id": "thought", "type": "THINKING_BLOCK_DELTA"},
            {"id": "answer", "type": "TEXT_BLOCK_DELTA"},
            {"id": "answer", "type": "TEXT_BLOCK_DELTA"},
            {"id": "end", "type": "REPLY_END"},
        ])
        self.assertFalse(verdict["ok"])
        self.assertIn("stream must begin with acknowledgement", verdict["errors"])
        self.assertIn("duplicate event id: answer", verdict["errors"])

    def test_tool_only_turn_can_fail_without_fabricating_an_answer(self):
        verdict = validate_lifecycle([
            {"id": "start", "type": "REPLY_START"},
            {"id": "tool", "type": "TOOL_CALL_START"},
            {"id": "end", "type": "REPLY_END"},
        ])
        self.assertTrue(verdict["ok"], verdict)


if __name__ == "__main__":
    unittest.main()
