"""Live stop-current-turn canary for the native AgentScope WorkRun binding."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid


BASE = os.getenv("AGENT_RUNTIME_BASE", "http://127.0.0.1:8000").rstrip("/")
USER = f"stop-canary-{uuid.uuid4().hex}"
HEADERS = {"X-HM-User-Id": USER, "Content-Type": "application/json"}


def request(path: str, body: dict | None = None, method: str = "POST") -> tuple[int, dict]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=HEADERS,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode() or "{}")
        return error.code, payload


workrun_id = str(uuid.uuid4())
turn_id = str(uuid.uuid4())
room_id = str(uuid.uuid4())

status, credential = request(
    "/credential/",
    {"data": {"type": "cloudflare_gateway_credential", "name": "stop-canary", "api_key": "gateway-managed"}},
)
assert status in (200, 201), credential
status, agent = request("/agent/", {"name": "Stop-current-turn canary"})
assert status in (200, 201), agent
status, started = request(
    "/workrun/",
    {
        "workrun_id": workrun_id,
        "agent_id": agent["agent_id"],
        "turn_id": turn_id,
        "room_id": room_id,
        "org_id": str(uuid.uuid4()),
        "goal": "Run a deliberately stoppable AgentScope turn; do not use tools.",
        "chat_model_config": {
            "type": "cloudflare_gateway_credential",
            "credential_id": credential["credential_id"],
            "model": "deepseek/deepseek-v4-flash",
            "parameters": {"max_tokens": 256},
        },
    },
)
assert status == 200, started

status, cancelled = request(f"/workrun/{workrun_id}/cancel")
assert status == 200, cancelled
assert cancelled["cancelled"] is True, cancelled
assert cancelled["workrun_id"] == workrun_id, cancelled

status, deleted = request(f"/workrun/{workrun_id}", method="DELETE")
assert status == 200, deleted
assert deleted.get("deleted") is True, deleted
print("stop-workrun-canary-ok", "cancelled=true", "binding_deleted=true")
