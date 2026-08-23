import unittest

from hivemind_employees.hyper.engine import _journal_verdict_slice


class JournalVerdictSliceTests(unittest.TestCase):
    """Real gap (2026-08-23): a Room's journal recorded WHAT it said last turn
    but never WHAT WAS WRONG with it (verifier crashed, claims unbacked) — so
    a follow-up turn on the same topic repeated the exact same fabricated
    numbers and hit the same dead verifier, with no learning signal at all.
    _journal_verdict_slice is the pure function deciding what (if anything)
    gets carried forward into the next turn's Director context."""

    def test_no_verdict_carries_nothing(self):
        self.assertIsNone(_journal_verdict_slice(None))
        self.assertIsNone(_journal_verdict_slice({}))

    def test_a_clean_verdict_with_nothing_wrong_carries_nothing(self):
        clean = {"grounded_ok": True, "verification_available": True, "gaps": [], "unsupported_claims": []}
        self.assertIsNone(_journal_verdict_slice(clean))

    def test_a_crashed_verifier_is_carried_forward(self):
        crashed = {"grounded_ok": False, "verification_available": False, "gaps": ["quality verification was unavailable; this report requires review before use"]}
        result = _journal_verdict_slice(crashed)
        self.assertIsNotNone(result)
        self.assertFalse(result["verification_available"])

    def test_ungrounded_claims_are_carried_forward(self):
        bad = {"grounded_ok": False, "gaps": ["invented conversion rate"], "unsupported_claims": ["55% baseline pilot"]}
        result = _journal_verdict_slice(bad)
        self.assertIsNotNone(result)
        self.assertFalse(result["grounded_ok"])
        self.assertIn("55% baseline pilot", result["unsupported_claims"])

    def test_lists_are_capped_and_truncated_defensively(self):
        bad = {"gaps": [f"gap {i}" for i in range(20)], "unsupported_claims": ["x" * 500]}
        result = _journal_verdict_slice(bad)
        self.assertLessEqual(len(result["gaps"]), 5)
        self.assertLessEqual(len(result["unsupported_claims"][0]), 200)


if __name__ == "__main__":
    unittest.main()
