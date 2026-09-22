#!/usr/bin/env python3
"""Live proof of the progressive company-task AgentScope contract.

The principal is explicit because hm-core must resolve a real organization
membership; a random development user cannot resolve company playbooks.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
import uuid

from company_task_contract import validate_company_task


def post(base: str, path: str, body: dict, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={**headers, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode() or "{}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--user-id", default="d1fbfe05-b91a-4cac-9b23-7b96d23c983d")
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    headers = {"X-HM-User-Id": args.user_id}
    credential = post(args.base, "/credential/", {"data": {"type": "cloudflare_gateway_credential", "name": "company-canary", "api_key": "gateway-managed"}}, headers)
    agent = post(args.base, "/agent/", {"name": "Company Task Canary"}, headers)
    session = post(args.base, "/sessions/", {"agent_id": agent["agent_id"], "chat_model_config": {"type": "cloudflare_gateway_credential", "credential_id": credential["credential_id"], "model": "deepseek/deepseek-v4-flash", "parameters": {"max_tokens": 256}}}, headers)
    post(args.base, "/chat/", {"agent_id": agent["agent_id"], "session_id": session["session_id"], "input": {"name": "company-canary", "role": "user", "content": [{"type": "text", "text": ("This is a read-only company task. First call reset_tools to activate the hivemind group. Then call hivemind_company_context, PlaybookList, and PlaybookGet for global:general, create one native TaskCreate task, load source-verification with native Skill, and finally reply exactly COMPANY_OK. Do not call writes, web, or connected apps.")}]}}, headers)
    request = urllib.request.Request(f"{args.base}/sessions/{session['session_id']}/stream?agent_id={agent['agent_id']}", headers={**headers, "Accept": "text/event-stream"})
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
                    if line.startswith("data:") and line[5:].strip():
                        events.append(json.loads(line[5:].strip()))
                if events and events[-1].get("type") == "REPLY_END":
                    break
            if events and events[-1].get("type") == "REPLY_END":
                break
    verdict = validate_company_task(events)
    text = "".join(event.get("delta") or "" for event in events if event.get("type") == "TEXT_BLOCK_DELTA")
    if not verdict["ok"]:
        raise AssertionError(f"company task contract failed: {verdict['errors']}")
    if "COMPANY_OK" not in text:
        raise AssertionError(f"company task final answer missing: {text!r}")
    print("company-task-stream-canary-ok", f"events={len(events)}", "layers=company/playbook/tasks/skill", "terminal=REPLY_END")


if __name__ == "__main__":
    main()
