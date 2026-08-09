import asyncio
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
        ):
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

    def test_report_repair_uses_a_neutral_editor_not_an_employee_persona(self):
        captured = {}

        async def _bootstrap():
            return [{"id": "lead-1", "api_key": "test-key", "hyper": {"persona_contract": "critic"}}]

        async def _agent(_message):
            return SimpleNamespace(content=(
                "## Revised report\nGrounded and directly usable. This revision preserves the supported "
                "recommendation while removing the unsupported assertion."
            ))

        def _build(employee, *_args, **_kwargs):
            captured.update(employee)
            return _agent

        request = SimpleNamespace(user_id="user", org_id="org", project_id=None)
        lead = {"id": "lead-1", "slug": "skeptic", "persona": "Write a risk critique."}
        with patch.object(api_hyper_rooms, "fetch_bootstrap", _bootstrap), patch.object(
            api_hyper_rooms, "build_react_agent", _build
        ):
            repaired = asyncio.run(api_hyper_rooms._repair_final_text(
                request,
                lead,
                final_text="Unsupported report",
                verdict={"gaps": ["unsupported claim"], "unsupported_claims": ["guaranteed"]},
                blackboard={"facts": ["Verified fact"]},
                model="deepseek/deepseek-v4-flash",
            ))

        self.assertIn("Revised report", repaired)
        self.assertIsNone(captured["active_prompt_version"])
        self.assertIsNone(captured["hyper"])
        self.assertIn("neutral final-report editor", captured["persona"].lower())


if __name__ == "__main__":
    unittest.main()
