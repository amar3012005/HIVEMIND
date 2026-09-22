import importlib
import asyncio
import os
import tempfile
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

    def test_unsandboxed_local_backend_requires_an_explicit_development_acknowledgement(self):
        blocked = self._load_backend(
            AGENTSCOPE_WORKSPACE_BACKEND="local",
            AGENTSCOPE_ALLOW_UNSAFE_LOCAL_WORKSPACE="0",
        )
        with self.assertRaisesRegex(RuntimeError, "unsandboxed and is refused"):
            blocked.build_workspace_manager("/tmp/hm-workspace-test")

        allowed = self._load_backend(
            AGENTSCOPE_WORKSPACE_BACKEND="local",
            AGENTSCOPE_ALLOW_UNSAFE_LOCAL_WORKSPACE="1",
        )
        manager = allowed.build_workspace_manager("/tmp/hm-workspace-test")
        self.assertEqual(type(manager).__name__, "LocalWorkspaceManager")
        self.assertIn("unsafe-local=explicit", allowed.describe())

    def test_runnable_compose_profiles_default_to_isolated_workruns(self):
        runtime_root = Path(__file__).resolve().parents[1]
        for filename in ("docker-compose.yml", "docker-compose.local.yml"):
            with self.subTest(filename=filename):
                compose = (runtime_root / filename).read_text()
                self.assertIn("AGENTSCOPE_WORKSPACE_BACKEND: ${AGENTSCOPE_WORKSPACE_BACKEND:-docker}", compose)
                self.assertIn("AGENTSCOPE_WORKSPACE_ISOLATION: ${AGENTSCOPE_WORKSPACE_ISOLATION:-per_session}", compose)
                self.assertIn("/var/run/docker.sock:/var/run/docker.sock", compose)

    def test_runtime_image_makes_the_explicit_docker_socket_mount_usable_on_desktop(self):
        """Docker Desktop presents its socket as root:root inside Linux VMs.

        The socket remains opt-in via Compose.  When mounted, appuser needs the
        matching group or a DockerWorkspaceManager default becomes a runtime
        failure instead of an isolated WorkRun sandbox.
        """
        runtime_root = Path(__file__).resolve().parents[1]
        dockerfile_path = runtime_root / "Dockerfile"
        if not dockerfile_path.exists():
            self.skipTest("Dockerfile structural assertions run against the source tree")
        dockerfile = dockerfile_path.read_text()
        self.assertIn("ARG DOCKER_GID=0", dockerfile)
        self.assertIn("usermod -aG root appuser", dockerfile)

    def test_runtime_installs_agentscope_docker_workspace_driver(self):
        runtime_root = Path(__file__).resolve().parents[1]
        requirements = (runtime_root / "requirements.txt").read_text()
        self.assertIn("workspace-docker", requirements)

    def test_per_session_ids_are_distinct_and_workspace_paths_cannot_escape_root(self):
        backend = self._load_backend(
            AGENTSCOPE_WORKSPACE_BACKEND="docker",
            AGENTSCOPE_WORKSPACE_ISOLATION="per_session",
        )

        async def check_ids(manager):
            first = await manager.assign_workspace_id(
                user_id="user-1", agent_id="agent-1", session_id="session-1",
            )
            second = await manager.assign_workspace_id(
                user_id="user-1", agent_id="agent-1", session_id="session-2",
            )
            return first, second

        manager = backend.build_workspace_manager(tempfile.mkdtemp(prefix="hm-workspace-") )
        first, second = asyncio.run(check_ids(manager))
        self.assertNotEqual(first, second)
        with self.assertRaisesRegex(ValueError, "escapes the workspace base directory"):
            manager._workdir_for("../outside")

    def test_workspace_ids_are_safe_for_docker_container_names(self):
        backend = self._load_backend(AGENTSCOPE_WORKSPACE_BACKEND="docker")
        self.assertEqual(
            backend.sanitize_workspace_id("workrun:1234/abcd"),
            "workrun-1234-abcd",
        )
        self.assertEqual(backend.sanitize_workspace_id("already-safe_1.2"), "already-safe_1.2")
        self.assertEqual(backend.sanitize_workspace_id("///"), "workspace")

    def test_skill_paths_include_leaf_skills_not_category_parents(self):
        backend = self._load_backend(AGENTSCOPE_WORKSPACE_BACKEND="docker")
        paths = backend._skill_paths()
        self.assertTrue(paths)
        self.assertTrue(all(Path(path, "SKILL.md").is_file() for path in paths))
        self.assertIn(str(Path(backend.SKILLS_DIR, "source-verification")), paths)
        self.assertNotIn(str(Path(backend.SKILLS_DIR, "business")), paths)


if __name__ == "__main__":
    unittest.main()
