import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('activation',Path(__file__).with_name('preserve-crm-activation.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class PreserveControlIntegrations(unittest.TestCase):
    def test_attention_rejects_the_brain_destination(self):
        for host in ('harness-runner', 'hivemind-harness-runner', 'hivemind-harness-runner-1'):
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, 'destination_invalid'):
                module.attention_destination({}, {'HIVEMIND_RUNTIME_ATTENTION_URL':f'http://{host}:3080/internal/hivemind/runtime-attention'})
    def test_attention_rejects_service_configuration_drift(self):
        with self.assertRaisesRegex(ValueError, 'destination_mismatch'):
            module.attention_destination({'HIVEMIND_RUNTIME_ATTENTION_URL':'http://runtime-runner:3080/internal/hivemind/runtime-attention'}, {'HIVEMIND_RUNTIME_ATTENTION_URL':'https://other.example/internal/hivemind/runtime-attention'})
    def test_attention_preserves_matching_routes_and_does_not_enable_absent_routes(self):
        route={'HIVEMIND_RUNTIME_ATTENTION_URL':'http://runtime-runner:3080/internal/hivemind/runtime-attention'}
        self.assertIsNone(module.attention_destination(route,route))
        self.assertIsNone(module.attention_destination({},{}))
        self.assertIsNone(module.attention_destination(route,{}))
    def test_attention_rejects_credentials_and_wrong_paths(self):
        for value in ('http://user:secret@runtime-runner:3080/internal/hivemind/runtime-attention', 'http://runtime-runner:3080/wrong'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'destination_invalid'):
                module.attention_destination({'HIVEMIND_RUNTIME_ATTENTION_URL':value},{})
    def test_only_existing_allowlisted_values_are_preserved(self):
        live={'ACCOUNT_ERASURE_NATIVE_URL':'https://native.example.test','ACCOUNT_ERASURE_NATIVE_TOKEN':'test-secret','HIVEMIND_RUNTIME_ATTENTION_URL':'https://attention.example.test','DATABASE_URL':'must-not-copy','HIVE_APP_RUNTIME_ENABLED':'false'}
        result=module.control_plane_integrations(live)
        self.assertEqual(set(result),{'ACCOUNT_ERASURE_NATIVE_URL','ACCOUNT_ERASURE_NATIVE_TOKEN','HIVEMIND_RUNTIME_ATTENTION_URL'})
        self.assertNotIn('DATABASE_URL',result)
    def test_retains_current_approved_overlay(self):
        self.assertEqual(module.control_plane_integrations({'ACCOUNT_ERASURE_NATIVE_TOKEN':'live-secret'}),{'ACCOUNT_ERASURE_NATIVE_TOKEN':'live-secret'})
    def test_missing_or_inactive_configuration_is_not_enabled(self):
        self.assertEqual(module.control_plane_integrations({'ACCOUNT_ERASURE_NATIVE_URL':''}),{})

if __name__=='__main__':unittest.main()
