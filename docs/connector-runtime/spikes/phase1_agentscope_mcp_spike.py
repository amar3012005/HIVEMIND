#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Connector Runtime V1 — Phase 1: AgentScope MCP compatibility spike (DISPOSABLE).

Goal (plan §8 Phase 1 acceptance):
  - One synthetic MCP connector can be invoked through an INACTIVE AgentScope group.
  - No provider-specific wrapper is required.

Also verifies the runtime-relevant behaviours the plan calls out:
  - tools/list + schema visibility gated by group activation
  - tools/call round-trip + ToolResponse conversion
  - inactive-group gate (a tool in an inactive group cannot be invoked)
  - async concurrency (N concurrent calls)
  - per-call execution_timeout (the runtime deadline maps onto this natively)
  - canonical `<connector>__<operation>` names fit tool-name limits (<=64)

This proves the eventual `mcp_projection.py` needs NO hand-written per-provider
Python functions: native `HttpStatelessClient` + `Toolkit.register_mcp_client`
(present in the running image, agentscope 1.0.21) do it all. The capability
token will ride in `headers={"Authorization": "Bearer <cap>"}`.

Run inside the employees image:
  docker exec hm-employees python3 /path/to/phase1_agentscope_mcp_spike.py
Exit code 0 = all assertions passed.
"""
import asyncio
import contextlib
import socket
import threading
import time

import uvicorn
from mcp.server.fastmcp import FastMCP

from agentscope.mcp import HttpStatelessClient
from agentscope.tool import Toolkit
from agentscope.message import ToolUseBlock

RESULTS = []


def _ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    mark = "PASS" if cond else "FAIL"
    print(f"[{mark}] {name}{(' — ' + detail) if detail else ''}", flush=True)


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---- Synthetic MCP server (stateless streamable-http) --------------------
def build_server(port):
    mcp = FastMCP("synthetic", stateless_http=True, host="127.0.0.1", port=port)

    @mcp.tool(name="synthetic__echo", description="Echo text back (read).")
    def synthetic__echo(text: str) -> str:
        return f"echo:{text}"

    @mcp.tool(name="synthetic__slow", description="Sleep then return (for timeout test).")
    def synthetic__slow(seconds: float) -> str:
        time.sleep(seconds)
        return f"slept:{seconds}"

    return mcp


def serve_in_thread(mcp, port):
    app = mcp.streamable_http_app()  # mounts at /mcp
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)

    def run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(server.serve())

    t = threading.Thread(target=run, daemon=True)
    t.start()
    # wait for readiness
    for _ in range(100):
        with contextlib.suppress(OSError):
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return server
        time.sleep(0.1)
    raise RuntimeError("synthetic MCP server did not come up")


async def _call(tk, name, inp):
    """Invoke a tool through the toolkit; return the accumulated ToolResponse."""
    block = ToolUseBlock(type="tool_use", id="t1", name=name, input=inp)
    last = None
    async for chunk in await tk.call_tool_function(block):
        last = chunk
    return last


def _text_of(resp):
    if resp is None:
        return ""
    parts = []
    for b in getattr(resp, "content", []) or []:
        t = b.get("text") if isinstance(b, dict) else getattr(b, "text", None)
        if t:
            parts.append(t)
    return " ".join(parts)


async def main():
    port = _free_port()
    url = f"http://127.0.0.1:{port}/mcp"
    serve_in_thread(build_server(port), port)

    client = HttpStatelessClient(name="synthetic", transport="streamable_http", url=url)

    # A) Native tools/list via the client — no wrapper code.
    tools = await client.list_tools()
    names = [getattr(t, "name", None) for t in tools]
    _ok("A. native tools/list", set(["synthetic__echo", "synthetic__slow"]).issubset(set(names)),
        f"names={names}")
    _ok("A2. canonical name length <=64", all(len(n) <= 64 for n in names if n),
        f"max={max((len(n) for n in names if n), default=0)}")

    # B) Register into an INACTIVE group via native register_mcp_client — no per-provider fn.
    tk = Toolkit()
    tk.create_tool_group("synthetic", description="Synthetic connector (spike)", active=False)
    await tk.register_mcp_client(
        client,
        group_name="synthetic",
        enable_funcs=["synthetic__echo", "synthetic__slow"],
        execution_timeout=1.0,  # runtime deadline maps onto this natively
    )
    schemas_inactive = [s["function"]["name"] for s in tk.get_json_schemas()]
    _ok("B. schemas hidden while group inactive",
        "synthetic__echo" not in schemas_inactive, f"visible={schemas_inactive}")

    # C) inactive-group gate: invoking while inactive must be refused.
    gated = await _call(tk, "synthetic__echo", {"text": "hi"})
    _ok("C. inactive-group invocation gated",
        "FunctionInactiveError" in _text_of(gated), _text_of(gated)[:80])

    # D) Activate group → schema visible → invoke through the group.
    tk.update_tool_groups(["synthetic"], active=True)
    schemas_active = [s["function"]["name"] for s in tk.get_json_schemas()]
    _ok("D. schema visible after activation", "synthetic__echo" in schemas_active,
        f"visible={schemas_active}")

    res = await _call(tk, "synthetic__echo", {"text": "phase1"})
    _ok("D2. tools/call through group → ToolResponse", "echo:phase1" in _text_of(res),
        _text_of(res)[:80])

    # E) async concurrency — N concurrent calls all succeed.
    outs = await asyncio.gather(*[_call(tk, "synthetic__echo", {"text": f"c{i}"}) for i in range(8)])
    _ok("E. 8 concurrent calls all returned",
        all(f"echo:c{i}" in _text_of(outs[i]) for i in range(8)),
        f"n={len(outs)}")

    # F) per-call execution_timeout enforced (deadline behaviour).
    slow = await _call(tk, "synthetic__slow", {"seconds": 3.0})
    txt = _text_of(slow).lower()
    _ok("F. execution_timeout produces structured result (not hang)",
        ("timeout" in txt or "timed out" in txt or "error" in txt) and "slept:3" not in txt,
        _text_of(slow)[:120])

    # summary
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n==== Phase 1 spike: {passed}/{total} assertions passed ====", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
