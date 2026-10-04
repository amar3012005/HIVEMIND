import unittest

from tara_grok.app import _provider_error_code, _InitialSilenceCheckIn, _browser_event, _capability_from_subprotocols, _opening_events, _session_update


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

    def test_opening_events_make_grok_speak_first(self):
        events = _opening_events({"opening_instruction": "Speak first about the goal."})
        self.assertEqual(events[0]["type"], "conversation.item.create")
        self.assertEqual(events[0]["item"]["role"], "user")
        self.assertIn("Speak first", events[0]["item"]["content"][0]["text"])
        self.assertEqual(events[1], {"type": "response.create"})

    def test_native_runtime_persona_replaces_tara_sales_doctrine(self):
        instructions = _session_update({"native_session_id": "session-native-room", "instructions": "You are Runtime, our AI Chief of Staff."})["session"]["instructions"]
        self.assertIn("You are Runtime", instructions)
        self.assertNotIn("You are TARA", instructions)
        self.assertNotIn("ACT ON THRESHOLDS", instructions)


class RuntimeInitialSilenceTests(unittest.TestCase):
    def test_native_first_checkin_uses_provider_timeout_and_preserves_limit(self):
        snapshot = {"native_session_id": "session-room", "initial_check_in": True, "max_duration_seconds": 180}
        session = _session_update(snapshot)["session"]
        self.assertEqual(session["turn_detection"]["idle_timeout_ms"], 20_000)
        self.assertIn("Do not restart the interview", session["instructions"])
        self.assertIn("infer consent or facts from silence", session["instructions"])
        self.assertEqual(snapshot["max_duration_seconds"], 180)

    def test_timeout_is_disabled_after_first_provider_event(self):
        snapshot = {"native_session_id": "session-room", "initial_check_in": True}
        state = _InitialSilenceCheckIn(snapshot)
        update = state.disable_for("input_audio_buffer.timeout_triggered", snapshot)
        self.assertIsNone(update["session"]["turn_detection"]["idle_timeout_ms"])
        self.assertEqual(update["session"]["turn_detection"]["type"], "server_vad")
        self.assertIsNone(state.disable_for("input_audio_buffer.timeout_triggered", snapshot))

    def test_human_speech_disables_initial_reprompt(self):
        snapshot = {"native_session_id": "session-room", "initial_check_in": True}
        state = _InitialSilenceCheckIn(snapshot)
        self.assertIsNotNone(state.disable_for("input_audio_buffer.speech_started", snapshot))
        self.assertIsNone(state.disable_for("input_audio_buffer.timeout_triggered", snapshot))

    def test_ordinary_tara_and_later_calls_keep_existing_behavior(self):
        for snapshot in [{}, {"native_session_id": "session-room", "initial_check_in": False}]:
            self.assertNotIn("idle_timeout_ms", _session_update(snapshot)["session"]["turn_detection"])
            self.assertIsNone(_InitialSilenceCheckIn(snapshot).disable_for("input_audio_buffer.timeout_triggered", snapshot))


class ProviderErrorDiagnosticTests(unittest.TestCase):
    def test_diagnostics_keep_only_safe_error_code(self):
        self.assertEqual(_provider_error_code({"error": {"code": "invalid_request_error", "message": "private prompt"}}), "invalid_request_error")
        self.assertEqual(_provider_error_code({"error": {"code": "token=secret\nprivate"}}), "xai_provider_error")
        self.assertEqual(_provider_error_code({"error": {"message": "private prompt"}}), "xai_provider_error")
