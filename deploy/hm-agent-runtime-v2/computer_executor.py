"""AgentScope external computer-tool bridge.

The E2B computer pool is a separate local service.  This module is deliberately
only an authenticated HTTP client: it never receives E2B credentials, VNC
URLs, or arbitrary shell commands.  AgentScope parks the reply while this
executor waits for the durable pool receipt, then the caller resumes the same
reply with ``ExternalExecutionResultEvent``.
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

import httpx


POOL_URL = os.getenv("HIVEMIND_COMPUTER_POOL_URL", "").strip().rstrip("/")
POOL_TOKEN = os.getenv("HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN", "").strip()
POLL_SECS = max(0.1, float(os.getenv("HIVEMIND_COMPUTER_POOL_POLL_SECS", "1")))
MAX_WAIT_SECS = max(1.0, float(os.getenv("HIVEMIND_COMPUTER_POOL_MAX_WAIT_SECS", "900")))


class ComputerExecutorError(RuntimeError):
    """A fail-closed computer pool error."""


def _host(value: str) -> str:
    host = str(value or "").strip().lower()
    if not host or "://" in host or "/" in host or " " in host or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?", host):
        raise ComputerExecutorError("allowed_domains must contain host names only")
    return host


def _limits(value: Any) -> dict[str, int]:
    data = value if isinstance(value, dict) else {}
    return {
        "max_steps": min(max(int(data.get("max_steps", 30)), 1), 50),
        "timeout_ms": min(max(int(data.get("timeout_seconds", 180) * 1000), 1_000), 900_000),
    }


class ComputerPoolExecutor:
    """Submit and await one bounded computer run."""

    def __init__(self, *, base_url: str = POOL_URL, token: str = POOL_TOKEN) -> None:
        self.base_url = str(base_url or "").rstrip("/")
        self.token = str(token or "")

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.token)

    def _headers(self, org_id: str | None) -> dict[str, str]:
        if not self.enabled:
            raise ComputerExecutorError("computer pool is not configured")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        if org_id:
            headers["X-Hivemind-Organization-Id"] = org_id
        return headers

    async def run(
        self,
        *,
        user_id: str,
        org_id: str | None,
        agent_run_id: str,
        objective: str,
        allowed_domains: list[str],
        capabilities: list[str],
        max_steps: int = 30,
        timeout_seconds: int = 180,
    ) -> dict[str, Any]:
        if not objective.strip():
            raise ComputerExecutorError("objective is required")
        domains = [_host(item) for item in allowed_domains]
        if not domains:
            raise ComputerExecutorError("allowed_domains must be a non-empty array")
        payload = {
            "organization_id": org_id or "unknown",
            "user_id": user_id,
            "agent_run_id": agent_run_id,
            "objective": objective.strip(),
            "allowed_domains": domains,
            "permissions": [str(item).strip().lower() for item in capabilities if str(item).strip()],
            "limits": {"max_steps": min(max(int(max_steps), 1), 50), "timeout_ms": min(max(int(timeout_seconds) * 1000, 1_000), 900_000)},
        }
        headers = self._headers(org_id)
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{self.base_url}/v1/computer-runs", headers=headers, json=payload)
            if response.status_code >= 400:
                raise ComputerExecutorError(f"computer pool submit failed ({response.status_code})")
            run = response.json()
            run_id = str(run.get("computer_run_id") or "")
            if not run_id:
                raise ComputerExecutorError("computer pool did not return computer_run_id")
            deadline = asyncio.get_running_loop().time() + MAX_WAIT_SECS
            while True:
                status = str(run.get("status") or "").lower()
                if status in {"completed", "failed", "cancelled", "expired", "released"}:
                    return run
                if asyncio.get_running_loop().time() >= deadline:
                    raise ComputerExecutorError("computer pool execution timed out")
                await asyncio.sleep(POLL_SECS)
                current = await client.get(f"{self.base_url}/v1/computer-runs/{run_id}", headers=headers)
                if current.status_code >= 400:
                    raise ComputerExecutorError(f"computer pool status failed ({current.status_code})")
                run = current.json()
