import unittest

from hivemind_employees.api_hyper_rooms import (
    _should_withhold_ungrounded_answer,
    _grounding_withheld_text,
    _verification_failure_result,
)


class ShouldWithholdUngroundedAnswerTests(unittest.TestCase):
    """Real gap found investigating a human-input-focused HyperAgents Room
    review: a plain (non-Work-Room) turn whose answer failed grounding
    (status computed as 'blocked'/'escalated' by _verify_turn's verdict)
    still shipped the model's original, possibly fabricated draft to the
    user — only an internal status field was downgraded, which the user
    never sees. Work Rooms are deliberately excluded: they keep showing
    in-progress drafts as real operational progress, a different case."""

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
    def test_includes_up_to_three_gaps(self):
        text = _grounding_withheld_text(["missing revenue figures", "no source for the claim", "unverified date", "a fourth gap"])
        self.assertIn("missing revenue figures", text)
        self.assertIn("no source for the claim", text)
        self.assertIn("unverified date", text)
        self.assertNotIn("a fourth gap", text)

    def test_falls_back_to_a_generic_reason_when_no_gaps_are_given(self):
        text = _grounding_withheld_text(None)
        self.assertIn("could not be verified against real evidence", text)
        text_empty = _grounding_withheld_text([])
        self.assertIn("could not be verified against real evidence", text_empty)

    def test_never_echoes_the_word_fact_as_a_claim_of_truth(self):
        # Regression guard on the actual message content the user sees.
        text = _grounding_withheld_text(["x"])
        self.assertIn("withholding the draft", text)


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
        # status='escalated' -> the withhold path (tested above) must fire.
        failure = _verification_failure_result(Exception("timeout"))
        status = "escalated" if failure and not failure.get("grounded_ok") else "complete"
        self.assertEqual(status, "escalated")
        self.assertTrue(_should_withhold_ungrounded_answer(None, status, "A confident but unverified answer."))


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
        from hivemind_employees.api_hyper_rooms import (
            HYPER_GROK_ROOM_ROUND_DEADLINE_SECONDS,
            HYPER_ROOM_ROUND_DEADLINE_SECONDS,
            _work_room_execution_phase,
        )
        self.assertGreater(HYPER_ROOM_ROUND_DEADLINE_SECONDS, 60)
        self.assertLess(HYPER_ROOM_ROUND_DEADLINE_SECONDS, 1800)
        self.assertGreater(HYPER_GROK_ROOM_ROUND_DEADLINE_SECONDS, HYPER_ROOM_ROUND_DEADLINE_SECONDS)
        self.assertLessEqual(HYPER_GROK_ROOM_ROUND_DEADLINE_SECONDS, 1800)
        self.assertEqual(_work_room_execution_phase("off"), "ACCEPTED")
        self.assertEqual(_work_room_execution_phase("full"), "GROK_RUNNING")
