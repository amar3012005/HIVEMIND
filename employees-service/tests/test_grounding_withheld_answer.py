import unittest

from hivemind_employees.api_hyper_rooms import (
    _should_withhold_ungrounded_answer,
    _grounding_withheld_text,
    _verification_failure_result,
    _goalkeeper_should_continue,
)
from hivemind_employees.hyper.output_contract import resolve_output_contract


class ShouldWithholdUngroundedAnswerTests(unittest.TestCase):
    """The gate still fires for a plain (non-Work-Room) turn whose answer
    failed grounding, but the user-facing path now LABELS the draft instead
    of hiding it. Work Rooms remain excluded from this path.
    """

    def test_withholds_for_a_plain_room_with_an_ungrounded_or_unmet_verdict(self):
        self.assertTrue(_should_withhold_ungrounded_answer(None, "escalated", "The answer is 42."))
        self.assertTrue(_should_withhold_ungrounded_answer("runtime", "blocked", "The answer is 42."))

    def test_never_withholds_for_a_work_room_even_with_the_same_verdict(self):
        self.assertFalse(_should_withhold_ungrounded_answer("work", "escalated", "The answer is 42."))
        self.assertFalse(_should_withhold_ungrounded_answer("WORK", "blocked", "The answer is 42."))

    def test_never_withholds_a_genuinely_complete_answer(self):
        self.assertFalse(_should_withhold_ungrounded_answer(None, "complete", "The answer is 42."))

    def test_never_withholds_when_there_is_no_text_to_withhold(self):
        self.assertFalse(_should_withhold_ungrounded_answer(None, "escalated", ""))
        self.assertFalse(_should_withhold_ungrounded_answer(None, "escalated", "   "))


class GroundingWithheldTextTests(unittest.TestCase):
    def test_keeps_the_textual_draft_and_lists_gaps(self):
        text = _grounding_withheld_text(
            ["missing revenue figures", "no source for the claim", "unverified date", "a fourth gap"],
            "Our offering is the only sovereign memory layer.",
        )
        self.assertIn("missing revenue figures", text)
        self.assertIn("no source for the claim", text)
        self.assertIn("unverified date", text)
        self.assertIn("a fourth gap", text)
        self.assertIn("Our offering is the only sovereign memory layer.", text)
        self.assertTrue(text.startswith("Draft."))

    def test_falls_back_to_a_labeled_draft_when_no_gaps_are_given(self):
        text = _grounding_withheld_text(None, "A written recommendation.")
        self.assertIn("Draft.", text)
        self.assertIn("A written recommendation.", text)
        text_empty = _grounding_withheld_text([], "A written recommendation.")
        self.assertIn("A written recommendation.", text_empty)

    def test_never_hides_the_draft_or_asks_for_more_context(self):
        text = _grounding_withheld_text(["x"], "Positioning line.")
        self.assertNotIn("withholding the draft", text)
        self.assertNotIn("Ask again", text)
        self.assertIn("not withheld", text.lower())
        self.assertIn("Positioning line.", text)


class VerificationFailureResultTests(unittest.TestCase):
    """Real gap: a crashed/timed-out verifier previously left the turn's
    verification unset, which the status-derivation code (`_gv and not
    _gv.get('grounded_ok')`) treats as falsy — silently defaulting to
    status='complete' with an unverified answer, i.e. fail-OPEN. This is
    the fail-SAFE default recorded instead."""

    def test_a_verification_crash_is_recorded_as_ungrounded_not_silently_passed(self):
        result = _verification_failure_result(RuntimeError("model timeout"))
        self.assertFalse(result["grounded_ok"])
        self.assertFalse(result["met"])
        self.assertIn("model timeout", result["note"])

    def test_the_failure_result_is_truthy_so_status_derivation_does_not_skip_it(self):
        # The real bug: an EMPTY dict is falsy, so `_gv and not _gv.get(...)`
        # short-circuits to False and status stays "complete". This result
        # must never be empty/falsy.
        result = _verification_failure_result(Exception("boom"))
        self.assertTrue(result)
        self.assertTrue(bool(result))

    def test_a_recorded_verification_failure_correctly_triggers_the_withhold_path(self):
        # End-to-end of the real fix: verifier crashes -> failure result has
        # grounded_ok=False -> the real code's status derivation would set
        # status='escalated' -> the label path (tested above) must fire.
        failure = _verification_failure_result(Exception("timeout"))
        status = "escalated" if failure and not failure.get("grounded_ok") else "complete"
        self.assertEqual(status, "escalated")
        self.assertTrue(_should_withhold_ungrounded_answer(None, status, "A confident but unverified answer."))


class GoalkeeperTextContractTests(unittest.TestCase):
    def test_text_contract_does_not_replan_a_missing_visual(self):
        contract = resolve_output_contract(
            user_message="create a brand voice guide and test against competitor absence",
            room_kind="branding",
        )
        verdict = {
            "met": False,
            "artifact_ok": False,
            "grounded_ok": True,
            "gaps": ["The requested interactive artifact did not pass production rendering checks."],
        }
        self.assertFalse(_goalkeeper_should_continue(verdict, contract))

    def test_text_contract_replans_missing_evidence_only(self):
        contract = resolve_output_contract(
            user_message="create a brand voice guide and test against competitor absence",
            room_kind="branding",
        )
        verdict = {
            "met": False,
            "artifact_ok": True,
            "grounded_ok": False,
            "gaps": ["competitor set"],
        }
        self.assertTrue(_goalkeeper_should_continue(verdict, contract))


if __name__ == "__main__":
    unittest.main()


class RoundDeadlineConfigTests(unittest.TestCase):
    """Real incident (2026-08-20): a manual chat follow-up in an
    already-open room hung forever on "selecting lead and reactors" with
    zero user-visible error — root-caused to unbounded asyncpg pool.acquire()
    calls inside _orchestrate with no outer deadline anywhere in the call
    chain. HYPER_ROOM_ROUND_DEADLINE_SECONDS is the safety net; this guards
    its parsing doesn't silently regress to 0/unset."""

    def test_default_deadline_is_a_sane_positive_number_of_minutes(self):
        from hivemind_employees.api_hyper_rooms import HYPER_ROOM_ROUND_DEADLINE_SECONDS
        self.assertGreater(HYPER_ROOM_ROUND_DEADLINE_SECONDS, 60)
        self.assertLess(HYPER_ROOM_ROUND_DEADLINE_SECONDS, 1800)
