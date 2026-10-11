import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


HELPER_PATH = Path(__file__).parents[1] / "install-open-dot-ingress.py"
SPEC = importlib.util.spec_from_file_location("open_dot_ingress", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def route(host, upstream):
    return {
        "match": [{"host": [host]}],
        "handle": [
            {
                "handler": "reverse_proxy",
                "upstreams": [{"dial": upstream}],
            }
        ],
        "terminal": True,
    }


class FakeCaddy:
    def __init__(self, post_loses_response=False, put_fails=False):
        self.original_route = route("api.example.test", "localhost:3000")
        self.baseline = {
            "admin": {"listen": "127.0.0.1:2019"},
            "apps": {
                "http": {
                    "servers": {
                        "srv0": {
                            "routes": [copy.deepcopy(self.original_route)],
                            "logs": {"logger_names": ["existing"]},
                        }
                    }
                },
                "tls": {"certificates": {"load_files": [{"certificate": "/private/cert.pem"}]}},
            },
        }
        self.baseline["apps"]["http"]["servers"]["srv0"]["routes"][0]["handle"].append(
            {"handler": "file_server", "hide": ["./Caddyfile"]}
        )
        self.baseline["apps"]["http"]["servers"]["srv0"]["routes"][0]["handle"].append(
            {"handler": "subroute", "routes": [{"group": "group20", "handle": [{"group": "group21"}]}]}
        )
        self.target = route(HELPER.SITE, HELPER.UPSTREAM)
        self.candidate = copy.deepcopy(self.baseline)
        self.candidate["apps"]["http"]["servers"]["srv0"]["routes"][0]["handle"][2]["routes"][0]["group"] = "group21"
        self.candidate["apps"]["http"]["servers"]["srv0"]["routes"][0]["handle"][2]["routes"][0]["handle"][0]["group"] = "group22"
        self.candidate["apps"]["http"]["servers"]["srv0"]["routes"].append(copy.deepcopy(self.target))
        self.live = copy.deepcopy(self.baseline)
        self.live["apps"]["http"]["servers"]["srv0"]["routes"][0]["handle"][1]["hide"] = [
            HELPER.CADDYFILE_DEST
        ]
        self.post_loses_response = post_loses_response
        self.put_fails = put_fails
        self.post_count = 0
        self.put_count = 0

    @property
    def routes_path(self):
        return HELPER._route_path("srv0")

    def request(self, path, body=None, headers=None, method=None):
        headers = headers or {}
        if path == "/config/":
            return copy.deepcopy(self.live), "root-etag"
        if path == self.routes_path:
            routes = self.live["apps"]["http"]["servers"]["srv0"]["routes"]
            if method == "POST":
                self.post_count += 1
                if headers.get("If-Match") != "routes-etag":
                    raise RuntimeError("stale route etag")
                routes.append(json.loads(body))
                if self.post_loses_response:
                    raise TimeoutError("simulated lost response")
                return None, "routes-etag-after-post"
            if method == "PUT":
                self.put_count += 1
                if self.put_fails:
                    raise TimeoutError("simulated route rollback failure")
                self.live["apps"]["http"]["servers"]["srv0"]["routes"] = json.loads(body)
                return None, "routes-etag-after-put"
            return copy.deepcopy(routes), "routes-etag"
        raise AssertionError(f"Unexpected Caddy API path: {path}")


class InstallOpenDotIngressTests(unittest.TestCase):
    def run_install(self, api, config_path, state_path, write_stream=None):
        def adapted(text):
            return copy.deepcopy(api.candidate if HELPER.BLOCK_START.encode() in text else api.baseline)

        stack = [
            patch.object(HELPER, "request", side_effect=api.request),
            patch.object(HELPER, "adapt", side_effect=adapted),
            patch.object(HELPER, "verify_caddyfile_mount"),
        ]
        if write_stream is not None:
            stack.append(patch.object(HELPER, "_write_stream", side_effect=write_stream))
        with contextlib.ExitStack() as exit_stack:
            for context in stack:
                exit_stack.enter_context(context)
            with contextlib.redirect_stdout(io.StringIO()):
                HELPER.install(config_path, state_path)

    def test_install_appends_only_owned_route_and_preserves_full_live_config(self):
        api = FakeCaddy()
        original = b"existing Caddyfile\n"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Caddyfile"
            state = root / "state"
            config.write_bytes(original)
            live_before = copy.deepcopy(api.live)

            self.run_install(api, config, state)

            expected = copy.deepcopy(live_before)
            expected["apps"]["http"]["servers"]["srv0"]["routes"].append(api.target)
            self.assertEqual(api.live, expected)
            self.assertEqual(config.read_bytes(), original + HELPER.BLOCK.encode())
            self.assertEqual((state / "Caddyfile.before-open-dot").read_bytes(), original)
            saved = json.loads((state / "Caddy-config.before-open-dot.json").read_text())
            self.assertEqual(saved["config"], live_before)
            self.assertEqual(saved["etag"], "root-etag")
            self.assertEqual(api.post_count, 1)

    def test_idempotent_retry_tolerates_adapter_group_renumbering(self):
        api = FakeCaddy()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Caddyfile"
            state = root / "state"
            config.write_bytes(b"existing Caddyfile\n")
            self.run_install(api, config, state)
            expected_routes = copy.deepcopy(api.live["apps"]["http"]["servers"]["srv0"]["routes"])

            self.run_install(api, config, state)

            self.assertEqual(api.live["apps"]["http"]["servers"]["srv0"]["routes"], expected_routes)
            self.assertEqual(api.post_count, 1)

    def test_lost_post_response_is_reconciled_from_exact_route_array(self):
        api = FakeCaddy(post_loses_response=True)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Caddyfile"
            state = root / "state"
            config.write_bytes(b"existing Caddyfile\n")

            self.run_install(api, config, state)

            routes = api.live["apps"]["http"]["servers"]["srv0"]["routes"]
            self.assertEqual(routes[-1], api.target)
            self.assertEqual(len(routes), 2)
            self.assertIn(HELPER.BLOCK_START.encode(), config.read_bytes())

    def test_file_failure_restores_exact_live_routes_and_original_file(self):
        api = FakeCaddy()
        original = b"existing Caddyfile\n"
        calls = 0
        original_write_stream = HELPER._write_stream

        def write_stream(stream, contents):
            nonlocal calls
            calls += 1
            if calls == 1:
                stream.seek(0)
                stream.write(contents[:10])
                stream.flush()
                raise OSError("simulated disk failure")
            return original_write_stream(stream, contents)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Caddyfile"
            state = root / "state"
            config.write_bytes(original)
            before = copy.deepcopy(api.live)
            with self.assertRaisesRegex(RuntimeError, "original file and live route array restored"):
                self.run_install(api, config, state, write_stream=write_stream)

            self.assertEqual(api.live, before)
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(api.put_count, 1)

    def test_file_restore_is_attempted_even_when_live_route_rollback_fails(self):
        api = FakeCaddy(put_fails=True)
        original = b"existing Caddyfile\n"
        calls = 0
        original_write_stream = HELPER._write_stream

        def fail_once_then_restore(stream, contents):
            nonlocal calls
            calls += 1
            if calls == 1:
                stream.seek(0)
                stream.write(contents[:10])
                stream.flush()
                raise OSError("simulated disk failure")
            return original_write_stream(stream, contents)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Caddyfile"
            state = root / "state"
            config.write_bytes(original)
            with self.assertRaisesRegex(RuntimeError, "file restored; live route rollback failed"):
                self.run_install(api, config, state, write_stream=fail_once_then_restore)

            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(api.put_count, 1)
            self.assertEqual(api.live["apps"]["http"]["servers"]["srv0"]["routes"][-1], api.target)

    def test_non_alias_drift_fails_before_route_or_file_mutation(self):
        api = FakeCaddy()
        api.live["apps"]["tls"]["unexpected"] = True
        original = b"existing Caddyfile\n"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Caddyfile"
            state = root / "state"
            config.write_bytes(original)
            with self.assertRaisesRegex(RuntimeError, "live/file drift"):
                self.run_install(api, config, state)
            self.assertEqual(api.post_count, 0)
            self.assertEqual(config.read_bytes(), original)

    def test_candidate_comparison_ignores_only_generated_group_numbers(self):
        baseline = {"routes": [{"group": "group20", "handle": [{"group": "group21"}]}]}
        adapted_with_inserted_route_removed = {
            "routes": [{"group": "group21", "handle": [{"group": "group22"}]}]
        }
        self.assertTrue(
            HELPER._same_adapted_config(baseline, adapted_with_inserted_route_removed)
        )
        adapted_with_route_change = {
            "routes": [{"group": "group21", "handle": [{"group": "group22"}], "terminal": False}]
        }
        self.assertFalse(HELPER._same_adapted_config(baseline, adapted_with_route_change))


if __name__ == "__main__":
    unittest.main()
