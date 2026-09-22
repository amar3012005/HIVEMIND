import importlib
import os
import unittest
from unittest.mock import patch


class AgentScopeTracingTests(unittest.TestCase):
    def test_tracing_is_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            module = importlib.import_module("agentscope_tracing")
            self.assertEqual(module.configure(), {"enabled": False, "reason": "disabled"})

    def test_enabled_requires_explicit_otlp_endpoint(self):
        with patch.dict(os.environ, {"AGENTSCOPE_OTEL_ENABLED": "1"}, clear=True):
            module = importlib.import_module("agentscope_tracing")
            self.assertEqual(module.configure(), {"enabled": False, "reason": "missing_endpoint"})

    def test_configured_provider_uses_explicit_endpoint(self):
        with patch.dict(
            os.environ,
            {
                "AGENTSCOPE_OTEL_ENABLED": "1",
                "AGENTSCOPE_OTEL_ENDPOINT": "http://otel.test/v1/traces",
            },
            clear=True,
        ):
            module = importlib.import_module("agentscope_tracing")
            result = module.configure()
            self.assertTrue(result["enabled"])
            self.assertIn(result["reason"], {"configured", "already_configured"})
            self.assertEqual(result["endpoint"], "http://otel.test/v1/traces")


if __name__ == "__main__":
    unittest.main()
