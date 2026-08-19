import unittest

from hivemind_employees.api_hyper_rooms import (
    _should_withhold_ungrounded_answer,
    _grounding_withheld_text,
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


if __name__ == "__main__":
    unittest.main()
