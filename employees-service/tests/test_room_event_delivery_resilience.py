import asyncio
import json
import unittest
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


if __name__ == "__main__":
    unittest.main()
