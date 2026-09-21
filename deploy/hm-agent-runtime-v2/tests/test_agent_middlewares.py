import asyncio
import tempfile
import unittest
from pathlib import Path

from agent_middlewares import hivemind_agent_middlewares, read_workspace_file


class _Workspace:
    def __init__(self, workdir):
        self.workdir = workdir


class _Backend:
    def join_path(self, *parts):
        return "/".join(part.strip("/") for part in parts)

    async def file_exists(self, path):
        return path == "workspace/deliverables/report.md"

    async def read_file(self, path):
        if path != "workspace/deliverables/report.md":
            raise FileNotFoundError(path)
        return b"durable report"


class _RemoteWorkspace:
    workdir = "/workspace"

    def get_backend(self):
        return _Backend()


class AgentMiddlewareTests(unittest.TestCase):
    def test_agent_scope_memory_and_tracing_middlewares_are_attached_to_workspace_agents(self):
        with tempfile.TemporaryDirectory() as workdir:
            middlewares = asyncio.run(hivemind_agent_middlewares(
                "user-1", "agent-1", "session-1", _Workspace(workdir),
            ))
            self.assertEqual(
                [middleware.__class__.__name__ for middleware in middlewares],
                ["AgenticMemoryMiddleware", "TracingMiddleware"],
            )
            skill = Path(workdir) / "skills" / "composio-connected-workflows" / "SKILL.md"
            self.assertTrue(skill.exists())
            self.assertIn("approval_required", skill.read_text(encoding="utf-8"))

    def test_no_workspace_does_not_attach_filesystem_backed_middlewares(self):
        middlewares = asyncio.run(hivemind_agent_middlewares("user-1", "agent-1", "session-1"))
        self.assertEqual(middlewares, [])

    def test_registered_agentscope_workspace_reads_artifact_bytes_through_its_backend(self):
        asyncio.run(hivemind_agent_middlewares(
            "user-1", "agent-1", "artifact-session", _RemoteWorkspace(),
        ))
        payload = asyncio.run(read_workspace_file(
            "artifact-session", "deliverables/report.md", max_bytes=1024,
        ))
        self.assertEqual(payload, b"durable report")
        with self.assertRaises(ValueError):
            asyncio.run(read_workspace_file(
                "artifact-session", "../outside.md", max_bytes=1024,
            ))


if __name__ == "__main__":
    unittest.main()
