#!/usr/bin/env python3
"""Live AgentScope SSE reconnect/replay canary.

The canary deliberately disconnects after the first streamed event and then
reconnects to the same native session. AgentScope must replay the durable
prefix and continue the live stream to REPLY_END exactly once per event id.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.request
import uuid


def call(base: str, path: str, body: dict, headers: dict[str, str]) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode() or "{}")


def stream_events(
    base: str,
    session_id: str,
    agent_id: str,
    headers: dict[str, str],
    events: list[dict],
    ready: threading.Event,
    stop_after_first: bool = False,
) -> None:
    req = urllib.request.Request(
        f"{base}/sessions/{session_id}/stream?agent_id={agent_id}",
        headers={**headers, "Accept": "text/event-stream"},
    )
    ready.set()
    buffer = ""
    with urllib.request.urlopen(req, timeout=90) as response:
        while True:
            chunk = response.read(1)
            if not chunk:
                return
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
                    if stop_after_first:
                        return
                    if event.get("type") == "REPLY_END":
                        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()

    user_id = f"reconnect-canary-{uuid.uuid4().hex}"
    headers = {"X-HM-User-Id": user_id}
    credential = call(
        args.base,
        "/credential/",
        {"data": {"type": "cloudflare_gateway_credential", "name": "reconnect-canary", "api_key": "gateway-managed"}},
        headers,
    )
    agent = call(args.base, "/agent/", {"name": "Reconnect Canary"}, headers)
    session = call(
        args.base,
        "/sessions/",
        {
            "agent_id": agent["agent_id"],
            "chat_model_config": {
                "type": "cloudflare_gateway_credential",
                "credential_id": credential["credential_id"],
                "model": "deepseek/deepseek-v4-flash",
                "parameters": {"max_tokens": 64},
            },
        },
        headers,
    )
    session_id = session["session_id"]
    agent_id = agent["agent_id"]

    first_events: list[dict] = []
    ready = threading.Event()
    first = threading.Thread(
        target=stream_events,
        args=(args.base, session_id, agent_id, headers, first_events, ready, True),
        daemon=True,
    )
    first.start()
    ready.wait(timeout=5)
    time.sleep(0.25)
    call(
        args.base,
        "/chat/",
        {
            "agent_id": agent_id,
            "session_id": session_id,
            "input": {
                "name": "reconnect-canary",
                "role": "user",
                "content": [{"type": "text", "text": "Reply with exactly RECONNECT_OK. Do not use tools."}],
            },
        },
        headers,
    )
    first.join(timeout=args.timeout)
    if not first_events:
        raise AssertionError("first SSE connection received no event before disconnect")

    replayed: list[dict] = []
    second = threading.Thread(
        target=stream_events,
        args=(args.base, session_id, agent_id, headers, replayed, threading.Event(), False),
        daemon=True,
    )
    second.start()
    second.join(timeout=args.timeout)
    if not any(event.get("type") == "REPLY_END" for event in replayed):
        raise AssertionError(f"reconnect did not reach REPLY_END: {[e.get('type') for e in replayed]}")
    text = "".join(event.get("delta") or "" for event in replayed if event.get("type") == "TEXT_BLOCK_DELTA")
    if "RECONNECT_OK" not in text:
        raise AssertionError(f"reconnect replay lost final text: {text!r}")

    identities = [event.get("id") or event.get("event_id") for event in replayed]
    identities = [identity for identity in identities if identity]
    if len(identities) != len(set(identities)):
        raise AssertionError("reconnect stream duplicated a durable event identity")
    print(
        "reconnect-replay-canary-ok",
        f"first_events={len(first_events)}",
        f"replayed_events={len(replayed)}",
        "terminal=REPLY_END",
    )


if __name__ == "__main__":
    main()
