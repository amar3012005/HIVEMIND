import importlib
import os
import unittest
from pathlib import Path
from unittest.mock import patch


class WorkspaceBackendTests(unittest.TestCase):
    def _load_backend(self, **environment):
        with patch.dict(os.environ, environment, clear=False):
            import workspace_backend
            backend = importlib.reload(workspace_backend)
        # The module reads environment at import time. Restore the ordinary
        # process configuration after each test so this probe cannot leak its
        # sandbox selection into another test module.
        self.addCleanup(importlib.reload, backend)
        return backend

    def test_docker_backend_is_a_per_session_sandbox_option(self):
        backend = self._load_backend(
            AGENTSCOPE_WORKSPACE_BACKEND="docker",
            AGENTSCOPE_WORKSPACE_ISOLATION="per_session",
        )
        manager = backend.build_workspace_manager("/tmp/hm-workspace-test")
        self.assertEqual(type(manager).__name__, "DockerWorkspaceManager")
        self.assertIn("backend=docker", backend.describe())
        self.assertIn("isolation=per_session", backend.describe())

    def test_runnable_compose_profiles_default_to_isolated_workruns(self):
        runtime_root = Path(__file__).resolve().parents[1]
        for filename in ("docker-compose.yml", "docker-compose.local.yml"):
            with self.subTest(filename=filename):
                compose = (runtime_root / filename).read_text()
                self.assertIn("AGENTSCOPE_WORKSPACE_BACKEND: ${AGENTSCOPE_WORKSPACE_BACKEND:-docker}", compose)
                self.assertIn("AGENTSCOPE_WORKSPACE_ISOLATION: ${AGENTSCOPE_WORKSPACE_ISOLATION:-per_session}", compose)


if __name__ == "__main__":
    unittest.main()
