#!/usr/bin/env python3
"""Crash/restart canary for a Redis-backed native AgentScope session.

The caller supplies an isolated runtime container.  The canary kills it after
the first native TaskCreate call starts, waits for the same session to come
back, and resumes with a continuation that must not recreate the task.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import threading
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
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode() or "{}")


def wait_livez(base: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(base + "/livez", timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise AssertionError("isolated runtime did not recover /livez after restart")


def stream_until(
    base: str,
    session_id: str,
    agent_id: str,
    headers: dict[str, str],
    events: list[dict],
    ready: threading.Event,
    stop_when: set[str],
    timeout: float,
) -> None:
    try:
        request = urllib.request.Request(
            f"{base}/sessions/{session_id}/stream?agent_id={agent_id}",
            headers={**headers, "Accept": "text/event-stream"},
        )
        ready.set()
        deadline = time.monotonic() + timeout
        buffer = ""
        with urllib.request.urlopen(request, timeout=timeout) as response:
            while time.monotonic() < deadline:
                chunk = response.read(1)
                if not chunk:
                    return
                buffer += chunk.decode("utf-8", errors="ignore")
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    for line in frame.splitlines():
                        if not line.startswith("data:") or not line[5:].strip():
                            continue
                        event = json.loads(line[5:].strip())
                        events.append(event)
                        if event.get("type") in stop_when:
                            return
    except Exception as exc:
        # A restart is expected to close one stream; the caller observes the
        # durable replay on the next connection instead of treating that close
        # as a canary failure.
        if not ready.is_set():
            raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18009")
    parser.add_argument("--container", required=True)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--recovery-wait", type=float, default=8)
    args = parser.parse_args()

    user_id = f"crash-recovery-canary-{uuid.uuid4().hex}"
    headers = {"X-HM-User-Id": user_id}
    credential = post(
        args.base,
        "/credential/",
        {"data": {"type": "cloudflare_gateway_credential", "name": "crash-recovery-canary", "api_key": "gateway-managed"}},
        headers,
    )
    agent = post(args.base, "/agent/", {"name": "Crash recovery canary"}, headers)
    session = post(
        args.base,
        "/sessions/",
        {
            "agent_id": agent["agent_id"],
            "chat_model_config": {
                "type": "cloudflare_gateway_credential",
                "credential_id": credential["credential_id"],
                "model": "deepseek/deepseek-v4-flash",
                "parameters": {"max_tokens": 128},
            },
        },
        headers,
    )
    session_id = session["session_id"]
    agent_id = agent["agent_id"]

    first: list[dict] = []
    ready = threading.Event()
    initial = threading.Thread(
        target=stream_until,
        args=(args.base, session_id, agent_id, headers, first, ready, {"TOOL_CALL_START"}, args.timeout),
        daemon=True,
    )
    initial.start()
    if not ready.wait(timeout=5):
        raise AssertionError("stream did not open before crash canary submission")
    # `ready` means the consumer thread was scheduled, not that urllib has
    # completed the HTTP handshake. Give the SSE request a turn before the
    # POST so the acknowledgement cannot be missed at the race boundary.
    time.sleep(0.5)
    post(
        args.base,
        "/chat/",
        {
            "agent_id": agent_id,
            "session_id": session_id,
            "input": {
                "name": "crash-recovery-canary",
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "First call reset_tools, then use native TaskCreate at most once to create a task named Crash recovery task. Finally reply exactly CRASH_OK. Do not use other tools.",
                }],
            },
        },
        headers,
    )
    initial.join(timeout=args.timeout)
    starts = [event for event in first if event.get("type") == "TOOL_CALL_START"]
    if not starts:
        raise AssertionError(f"runtime did not reach a native tool call before restart; events={first[-12:]}")

    subprocess.run(["docker", "restart", args.container], check=True, stdout=subprocess.DEVNULL)
    wait_livez(args.base, timeout=45)

    replay: list[dict] = []
    replay_thread = threading.Thread(
        target=stream_until,
        args=(args.base, session_id, agent_id, headers, replay, threading.Event(), {"REPLY_END"}, args.timeout),
        daemon=True,
    )
    replay_thread.start()
    replay_thread.join(timeout=args.timeout)
    if not any(event.get("type") == "REPLY_END" for event in replay):
        # Let the interrupted worker's native Redis lease expire naturally.
        # Never delete it on startup: another live worker may own it.
        time.sleep(args.recovery_wait)
        continuation = threading.Thread(
            target=stream_until,
            args=(args.base, session_id, agent_id, headers, replay, threading.Event(), {"REPLY_END"}, args.timeout),
            daemon=True,
        )
        continuation.start()
        time.sleep(0.25)
        post(
            args.base,
            "/chat/",
            {
                "agent_id": agent_id,
                "session_id": session_id,
                "input": {
                    "name": "crash-recovery-continuation",
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": "Continue the interrupted turn. Do not repeat any tool call that already completed; create Crash recovery task with native TaskCreate only if it does not already exist, then reply exactly CRASH_OK.",
                    }],
                },
            },
            headers,
        )
        continuation.join(timeout=args.timeout)

    all_events = first + replay
    tool_starts = [event for event in all_events if event.get("type") == "TOOL_CALL_START" and event.get("tool_call_name") == "TaskCreate"]
    identities = [event.get("id") or event.get("event_id") for event in tool_starts]
    unique_identities = {identity for identity in identities if identity}
    if len(tool_starts) > 2 or (unique_identities and len(unique_identities) > 1):
        raise AssertionError(f"TaskCreate was duplicated across crash recovery: {identities}")
    if not any(event.get("type") == "REPLY_END" for event in replay):
        raise AssertionError("session did not reach REPLY_END after runtime restart")
    print(
        "crash-recovery-canary-ok",
        f"first_events={len(first)}",
        f"replayed_events={len(replay)}",
        f"taskcreate_starts={len(tool_starts)}",
        "terminal=REPLY_END",
    )


if __name__ == "__main__":
    main()
