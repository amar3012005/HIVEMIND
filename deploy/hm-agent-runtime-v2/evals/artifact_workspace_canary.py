"""AgentScope workspace artifact durability canary.

The bytes stay in the native workspace backend; HIVE-MIND stores only the
registered pointer.  This canary proves the first half of that contract: a
produced file is written through the workspace backend, flushed, and observed
as non-empty before a caller is allowed to register it.
"""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from agentscope.app.workspace_manager import IsolationPolicy, LocalWorkspaceManager


async def _run() -> None:
    with tempfile.TemporaryDirectory(prefix="agentscope-artifact-") as root:
        manager = LocalWorkspaceManager(
            root,
            isolation=IsolationPolicy.PER_SESSION,
            ttl=60,
        )
        async with manager:
            workspace = await manager.get_workspace(
                "canary-user",
                "canary-agent",
                "canary-session",
            )
            backend = workspace.get_backend()
            path = backend.join_path(workspace.workdir, "artifacts", "result.txt")
            payload = b"durable AgentScope artifact canary\n"
            await backend.write_file(path, payload)
            if not await backend.file_exists(path):
                raise AssertionError("workspace artifact was not written")
            observed = await backend.read_file(path)
            if observed != payload or not observed:
                raise AssertionError("workspace artifact was not flushed/non-empty")
            if not Path(workspace.workdir).exists():
                raise AssertionError("workspace root disappeared before registration")
            print(
                "artifact-workspace-canary-ok "
                f"workspace_id={workspace.workspace_id} bytes={len(observed)} "
                "backend=local pointer_ready=true",
            )


if __name__ == "__main__":
    asyncio.run(_run())
