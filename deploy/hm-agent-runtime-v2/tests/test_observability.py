import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _OtlpReceiver(BaseHTTPRequestHandler):
    payloads = []

    def do_POST(self):  # noqa: N802 - HTTP handler API
        size = int(self.headers.get("content-length", "0"))
        type(self).payloads.append((self.path, self.headers.get("content-type"), self.rfile.read(size)))
        self.send_response(200)
        self.end_headers()

    def log_message(self, _format, *_args):
        return


class ObservabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _OtlpReceiver.payloads = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _OtlpReceiver)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=2)
        cls.server.server_close()

    def test_tracing_stays_off_without_an_explicit_exporter(self):
        code = "from observability import configure_tracing; assert configure_tracing() is False"
        environment = os.environ.copy()
        environment.pop("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", None)
        environment.pop("AGENTSCOPE_OTEL_EXPORTER_OTLP_ENDPOINT", None)
        completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=environment)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_configured_otlp_exporter_receives_a_native_runtime_span(self):
        endpoint = f"http://127.0.0.1:{self.server.server_port}/v1/traces"
        code = """
from observability import configure_tracing
from opentelemetry import trace
assert configure_tracing() is True
with trace.get_tracer('hm-agent-runtime-v2.golden').start_as_current_span('workrun.golden'):
    pass
provider = trace.get_tracer_provider()
assert provider.force_flush(timeout_millis=5000) is True
provider.shutdown()
"""
        environment = os.environ.copy()
        environment["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = endpoint
        environment["OTEL_SERVICE_NAME"] = "hm-agent-runtime-v2-golden"
        completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=environment)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(_OtlpReceiver.payloads)
        path, content_type, payload = _OtlpReceiver.payloads[-1]
        self.assertEqual(path, "/v1/traces")
        self.assertEqual(content_type, "application/x-protobuf")
        self.assertGreater(len(payload), 0)


if __name__ == "__main__":
    unittest.main()
