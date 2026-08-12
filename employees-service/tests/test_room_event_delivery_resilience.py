import asyncio
import inspect
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from hivemind_employees import api_hyper_rooms


class _Response:
    def raise_for_status(self):
        return None


class _FlakyCallback:
    def __init__(self):
        self.calls = []

    async def post(self, _url, *, headers, content):
        self.calls.append({"headers": headers, "body": json.loads(content)})
        if len(self.calls) < 3:
            raise RuntimeError("control temporarily unavailable")
        return _Response()


class RoomEventDeliveryResilienceTest(unittest.TestCase):
    def test_critical_room_event_retries_with_one_stable_delivery_id(self):
        client = _FlakyCallback()

        async def _no_wait(_seconds):
            return None

        event = {"t": "final_report", "content": "Grounded result"}
        with patch.object(api_hyper_rooms, "_CALLBACK_CLIENT", client), patch.object(
            api_hyper_rooms.asyncio, "sleep", _no_wait
        ), patch.object(api_hyper_rooms, "persist_hyper_turn_outbox_event", return_value=False):
            asyncio.run(api_hyper_rooms._emit_event("http://control/internal", "turn-1", event))

        self.assertEqual(len(client.calls), 3)
        ids = {call["body"]["event"]["event_id"] for call in client.calls}
        self.assertEqual(len(ids), 1)
        self.assertIn(event["event_id"], ids)

    def test_goalkeeper_seal_keeps_cumulative_token_accounting(self):
        merged = api_hyper_rooms._merge_goalkeeper_seal(
            {
                "cost_tokens": 120,
                "tokens_in": 80,
                "tokens_out": 40,
                "tokens_cached": 10,
                "tok_by": {"director": 60, "synth": 60},
            },
            {
                "cost_tokens": 90,
                "tokens_in": 50,
                "tokens_out": 40,
                "tokens_cached": 5,
                "tok_by": {"director": 30, "worker": 60},
                "status": "complete",
            },
        )

        self.assertEqual(merged["cost_tokens"], 210)
        self.assertEqual(merged["tokens_in"], 130)
        self.assertEqual(merged["tokens_out"], 80)
        self.assertEqual(merged["tokens_cached"], 15)
        self.assertEqual(merged["tok_by"], {"director": 90, "synth": 60, "worker": 60})
        self.assertEqual(merged["status"], "complete")

    def test_failed_local_report_repair_does_not_replay_the_whole_room(self):
        verdict = {
            "met": False,
            "artifact_ok": False,
            "grounded_ok": False,
            "repair_attempted": True,
        }
        self.assertFalse(api_hyper_rooms._goalkeeper_should_continue(verdict))

    def test_human_work_room_never_replays_the_whole_turn(self):
        with patch.object(api_hyper_rooms, "_goalkeeper_max_rounds", return_value=5):
            self.assertEqual(
                api_hyper_rooms._goalkeeper_rounds_for_turn("general", "work"), 1
            )
            self.assertEqual(
                api_hyper_rooms._goalkeeper_rounds_for_turn("general", "runtime"), 5
            )

    def test_unsourced_numeric_claims_are_rejected_deterministically(self):
        unsupported = api_hyper_rooms._unsupported_specific_claims(
            "Pilot for 4 weeks with 30 enterprises and a 38% target.",
            ["The company serves regulated enterprises."],
            "Compare outreach with awareness.",
        )
        self.assertEqual(len(unsupported), 1)
        allowed = api_hyper_rooms._unsupported_specific_claims(
            "The observed reply rate was 12%.",
            ["Provider receipt: observed reply rate was 12%."],
            "Summarize the observed result.",
        )
        self.assertEqual(allowed, [])

    def test_single_governance_pass_never_triggers_a_repair_rewrite(self):
        # The verify->repair->recheck cascade (up to 3 verify-shaped LLM calls per
        # turn) was removed in favor of one judge call whose verdict is trusted
        # as-is; a real gap is surfaced via completion_caveat, never rewritten.
        source = inspect.getsource(api_hyper_rooms._orchestrate_single_agent)
        self.assertNotIn("_repair_final_text", source)
        self.assertNotIn("quality_repair", source)


if __name__ == "__main__":
    unittest.main()
