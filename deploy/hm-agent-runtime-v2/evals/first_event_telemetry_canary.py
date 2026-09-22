#!/usr/bin/env python3
"""Measure live AgentScope first-event milestones without collecting content."""

from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.request
import uuid


def post(base: str, path: str, body: dict, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={**headers, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode() or "{}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    headers = {"X-HM-User-Id": f"telemetry-canary-{uuid.uuid4().hex}"}
    credential = post(args.base, "/credential/", {"data": {"type": "cloudflare_gateway_credential", "name": "telemetry-canary", "api_key": "gateway-managed"}}, headers)
    agent = post(args.base, "/agent/", {"name": "Telemetry Canary"}, headers)
    session = post(args.base, "/sessions/", {"agent_id": agent["agent_id"], "chat_model_config": {"type": "cloudflare_gateway_credential", "credential_id": credential["credential_id"], "model": "deepseek/deepseek-v4-flash", "parameters": {"max_tokens": 64}}}, headers)
    submitted = time.monotonic()
    stream_ready = threading.Event()
    stream_error: list[BaseException] = []
    marks: dict[str, float] = {}
    def consume_stream() -> None:
        try:
            request = urllib.request.Request(
                f"{args.base}/sessions/{session['session_id']}/stream?agent_id={agent['agent_id']}",
                headers={**headers, "Accept": "text/event-stream"},
            )
            stream_ready.set()
            buffer = ""
            with urllib.request.urlopen(request, timeout=args.timeout) as response:
                while time.monotonic() - submitted < args.timeout:
                    chunk = response.read(1)
                    if not chunk:
                        break
                    buffer += chunk.decode("utf-8", errors="ignore")
                    while "\n\n" in buffer:
                        frame, buffer = buffer.split("\n\n", 1)
                        for line in frame.splitlines():
                            if not line.startswith("data:") or not line[5:].strip():
                                continue
                            event = json.loads(line[5:].strip())
                            kind = event.get("type")
                            if "acknowledgement" not in marks and kind == "REPLY_START": marks["acknowledgement"] = time.monotonic()
                            if "first_thinking" not in marks and kind == "THINKING_BLOCK_DELTA": marks["first_thinking"] = time.monotonic()
                            if "first_tool" not in marks and kind == "TOOL_CALL_START": marks["first_tool"] = time.monotonic()
                            if "first_answer" not in marks and kind == "TEXT_BLOCK_DELTA": marks["first_answer"] = time.monotonic()
                            if kind == "REPLY_END": marks["completion"] = time.monotonic()
                        if "completion" in marks:
                            return
        except BaseException as exc:  # report the stream failure in the caller
            stream_error.append(exc)

    stream = threading.Thread(target=consume_stream, daemon=True)
    stream.start()
    if not stream_ready.wait(timeout=5):
        raise AssertionError("SSE stream did not open before submission")
    post(
        args.base,
        "/chat/",
        {
            "agent_id": agent["agent_id"],
            "session_id": session["session_id"],
            "input": {
                "name": "telemetry-canary",
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "Use native TaskCreate to create exactly one task named Telemetry canary, then reply exactly TELEMETRY_OK. Do not use any other tools.",
                }],
            },
        },
        headers,
    )
    stream.join(timeout=args.timeout)
    if stream_error:
        raise stream_error[0]
    required = ("acknowledgement", "first_thinking", "first_tool", "first_answer", "completion")
    missing = [key for key in required if key not in marks]
    if missing:
        raise AssertionError(f"telemetry milestones missing: {missing}")
    elapsed = {key: round((value - submitted) * 1000) for key, value in marks.items()}
    print("first-event-telemetry-canary-ok", json.dumps(elapsed, sort_keys=True), "content=not-collected")


if __name__ == "__main__":
    main()
