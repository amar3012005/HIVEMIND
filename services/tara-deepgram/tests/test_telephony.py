import unittest
from unittest.mock import AsyncMock, patch

from tara_deepgram import telephony


class DialAllowlistTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_allowlist_blocks_dial(self):
        request = telephony.DialRequest(to="+4915112345678", session_id="test")
        with patch.object(telephony.config, "ALLOWED_NUMBERS", []):
            with self.assertRaisesRegex(ValueError, "not in the configured allowlist"):
                await telephony.dial(request)

    async def test_unlisted_number_blocks_dial(self):
        request = telephony.DialRequest(to="+4915112345678", session_id="test")
        with patch.object(telephony.config, "ALLOWED_NUMBERS", ["+4915999999999"]):
            with self.assertRaisesRegex(ValueError, "not in the configured allowlist"):
                await telephony.dial(request)

    async def test_allowed_number_reaches_provider(self):
        number = "+4915112345678"
        request = telephony.DialRequest(to=number, session_id="test")
        expected = {"call_leg_id": "leg-1", "session_id": "test", "status": "dialing"}
        with patch.object(telephony.config, "ALLOWED_NUMBERS", [number]), \
             patch.object(telephony.config, "TELEPHONY_PROVIDER", "twilio"), \
             patch.object(telephony, "_dial_twilio", AsyncMock(return_value=expected)) as provider:
            self.assertEqual(await telephony.dial(request), expected)
            provider.assert_awaited_once_with(request)


if __name__ == "__main__":
    unittest.main()
