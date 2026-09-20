import asyncio
import tempfile
import unittest
from pathlib import Path

from agent_middlewares import hivemind_agent_middlewares


class _Workspace:
    def __init__(self, workdir):
        self.workdir = workdir


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


if __name__ == "__main__":
    unittest.main()
