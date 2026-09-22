#!/usr/bin/env python3
"""Live proof that AgentScope's native Skill tool loads a skill on demand."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
import uuid


def post(base: str, path: str, body: dict, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode() or "{}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    user_id = f"skill-canary-{uuid.uuid4().hex}"
    headers = {"X-HM-User-Id": user_id}
    credential = post(
        args.base,
        "/credential/",
        {"data": {"type": "cloudflare_gateway_credential", "name": "skill-canary", "api_key": "gateway-managed"}},
        headers,
    )
    agent = post(args.base, "/agent/", {"name": "Skill Canary"}, headers)
    session = post(
        args.base,
        "/sessions/",
        {
            "agent_id": agent["agent_id"],
            "chat_model_config": {
                "type": "cloudflare_gateway_credential",
                "credential_id": credential["credential_id"],
                "model": "deepseek/deepseek-v4-flash",
                "parameters": {"max_tokens": 96},
            },
        },
        headers,
    )
    post(
        args.base,
        "/chat/",
        {
            "agent_id": agent["agent_id"],
            "session_id": session["session_id"],
            "input": {
                "name": "skill-canary",
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": (
                        "Use the native Skill tool (tool name exactly Skill) to load the "
                        "source-verification skill. After the tool returns, reply exactly "
                        "SKILL_OK. Do not use any other tools."
                    ),
                }],
            },
        },
        headers,
    )
    request = urllib.request.Request(
        f"{args.base}/sessions/{session['session_id']}/stream?agent_id={agent['agent_id']}",
        headers={**headers, "Accept": "text/event-stream"},
    )
    events: list[dict] = []
    deadline = time.monotonic() + args.timeout
    buffer = ""
    with urllib.request.urlopen(request, timeout=args.timeout) as response:
        while time.monotonic() < deadline:
            chunk = response.read(1)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="ignore")
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.splitlines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    event = json.loads(payload)
                    events.append(event)
                    if event.get("type") == "REPLY_END":
                        break
                if events and events[-1].get("type") == "REPLY_END":
                    break
            if events and events[-1].get("type") == "REPLY_END":
                break
    tool_events = [
        event for event in events
        if event.get("type") == "TOOL_CALL_START"
        and (event.get("tool_call_name") or event.get("tool_name") or event.get("name")) == "Skill"
    ]
    text = "".join(event.get("delta") or "" for event in events if event.get("type") == "TEXT_BLOCK_DELTA")
    if not tool_events:
        names = [event.get("tool_call_name") or event.get("tool_name") or event.get("name") for event in events if event.get("type") == "TOOL_CALL_START"]
        raise AssertionError(f"native Skill call missing; observed={names}")
    if "SKILL_OK" not in text:
        raise AssertionError(f"native Skill stream lost final answer: {text!r}")
    if not any(event.get("type") == "REPLY_END" for event in events):
        raise AssertionError("native Skill stream did not complete")
    print("skill-stream-canary-ok", f"events={len(events)}", "tool=Skill", "terminal=REPLY_END")


if __name__ == "__main__":
    main()
