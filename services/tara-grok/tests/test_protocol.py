import unittest

from tara_grok.app import _browser_event, _capability_from_subprotocols, _session_update


class TaraGrokProtocolTests(unittest.TestCase):
    def test_capability_is_read_from_a_private_subprotocol(self):
        self.assertEqual(
            _capability_from_subprotocols(["hm.tara.v1", "hm.tara.cap.signed-token"]),
            "signed-token",
        )
        self.assertEqual(_capability_from_subprotocols(["hm.tara.v1"]), "")

    def test_browser_pcm_session_uses_xai_binary_transport_and_vad(self):
        session = _session_update({
            "language": "en-US",
            "keyterms": ["HIVEMIND"],
            "output_speed": 1.2,
            "pronunciation_replacements": {"HIVEMIND": "hive mind"},
        })["session"]
        self.assertEqual(session["audio"]["input"]["transport"], "binary")
        self.assertEqual(session["audio"]["output"]["transport"], "binary")
        self.assertEqual(session["audio"]["input"]["format"]["rate"], 16000)
        self.assertEqual(session["audio"]["input"]["transcription"]["model"], "grok-transcribe")
        self.assertEqual(session["turn_detection"]["type"], "server_vad")
        self.assertTrue(session["resumption"]["enabled"])

    def test_xai_events_are_normalized_for_the_provider_neutral_widget(self):
        self.assertEqual(_browser_event({"type": "session.updated"}), {"type": "ready"})
        self.assertEqual(
            _browser_event({"type": "conversation.item.input_audio_transcription.updated", "transcript": "hello"}),
            {"type": "transcript", "text": "hello"},
        )
        self.assertEqual(
            _browser_event({"type": "response.output_audio_transcript.delta", "delta": "Hi there"}),
            {"type": "agent_text", "text": "Hi there"},
        )
        self.assertEqual(_browser_event({"type": "response.done"}), {"type": "turn_done"})
