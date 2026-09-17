#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Load test — N concurrent sessions on ONE Agent Service process.

This is the measurement that decides the worker count. The Phase 1 claim is
"one async process hosts many concurrent sessions"; this script tests it rather
than asserting it.

What it measures, per concurrency level:
  - wall time to complete N chat runs
  - per-run latency (p50 / p95 / max)
  - throughput (runs/sec)
  - failures and their causes
  - container memory before/after (via `docker stats`)

Why it is written this way:
  - Each run gets its OWN agent + session. Sharing one session would serialize
    (AgentScope enforces single-run-per-session and returns 409), which would
    measure the lock, not the concurrency.
  - The SSE stream is consumed with a raw socket read loop, not urllib's line
    iterator, because urllib buffers and would report a latency that is really
    the buffer flush time.
  - A run is "complete" when REPLY_END arrives, not when POST /chat returns —
    /chat is fire-and-forget and returns immediately.

Usage:
    python load_test.py --concurrency 1,5,10,25 --runs-per-level 10
    python load_test.py --concurrency 10 --runs-per-level 20 --model deepseek/deepseek-v4-flash
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

DEFAULT_BASE = "http://127.0.0.1:8000"
DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
CONTAINER = "hm-agent-runtime-v2"


@dataclass
class RunResult:
    ok: bool
    latency: float = 0.0
    error: str = ""
    events: int = 0
    reply: str = ""


@dataclass
class LevelResult:
    concurrency: int
    runs: list[RunResult] = field(default_factory=list)
    wall: float = 0.0
    mem_before_mb: float = 0.0
    mem_after_mb: float = 0.0

    @property
    def ok_runs(self) -> list[RunResult]:
        return [r for r in self.runs if r.ok]

    @property
    def failures(self) -> list[RunResult]:
        return [r for r in self.runs if not r.ok]


def _headers(user_id: str, api_key: str) -> dict[str, str]:
    h = {"Content-Type": "application/json", "X-HM-User-Id": user_id}
    if api_key:
        h["X-API-Key"] = api_key
    return h


def _call(base: str, path: str, body: dict | None, headers: dict, method: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path,
        data=data,
        method=method or ("POST" if data else "GET"),
    )
    for k, v in headers.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, json.loads(resp.read().decode() or "{}")


def _docker_mem_mb() -> float:
    """Container memory in MB, or 0 when docker is unavailable."""
    try:
        out = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", CONTAINER],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout.strip()
        if not out:
            return 0.0
        used = out.split("/")[0].strip()
        if used.endswith("MiB"):
            return float(used[:-3])
        if used.endswith("GiB"):
            return float(used[:-3]) * 1024
        if used.endswith("KiB"):
            return float(used[:-3]) / 1024
    except Exception:  # noqa: BLE001 - measurement must never break the test
        pass
    return 0.0


def _stream_until_reply_end(
    base: str,
    session_id: str,
    agent_id: str,
    headers: dict,
    result: RunResult,
    deadline: float,
) -> None:
    """Read the SSE stream until REPLY_END, counting events and capturing text.

    Uses a raw socket read loop: urllib's line iterator buffers, which would
    make the measured latency the buffer flush time rather than the model's.
    """
    url = f"{base}/sessions/{session_id}/stream?agent_id={agent_id}"
    req = urllib.request.Request(url)
    for k, v in headers.items():
        req.add_header(k, v)
    req.add_header("Accept", "text/event-stream")

    buf = ""
    text_parts: list[str] = []
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            while time.time() < deadline:
                chunk = resp.read(1)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", errors="ignore")
                while "\n\n" in buf:
                    frame, buf = buf.split("\n\n", 1)
                    for line in frame.split("\n"):
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload:
                            continue
                        try:
                            ev = json.loads(payload)
                        except ValueError:
                            continue
                        result.events += 1
                        etype = ev.get("type")
                        if etype == "TEXT_BLOCK_DELTA":
                            text_parts.append(ev.get("delta") or "")
                        elif etype == "REPLY_END":
                            result.reply = "".join(text_parts)
                            return
    except Exception as exc:  # noqa: BLE001
        result.error = f"stream: {exc}"


def _one_run(
    base: str,
    headers: dict,
    model: str,
    prompt: str,
    result: RunResult,
    deadline: float,
) -> None:
    """Create agent + session, subscribe, chat, wait for REPLY_END."""
    started = time.time()
    try:
        _, cred = _call(
            base,
            "/credential/",
            {
                "data": {
                    "type": "cloudflare_gateway_credential",
                    "name": "loadtest",
                    "api_key": "gateway-managed",
                },
            },
            headers,
        )
        cid = cred["credential_id"]

        _, agent = _call(base, "/agent/", {"name": "LoadTest Agent"}, headers)
        aid = agent["agent_id"]

        _, sess = _call(
            base,
            "/sessions/",
            {
                "agent_id": aid,
                "chat_model_config": {
                    "type": "cloudflare_gateway_credential",
                    "credential_id": cid,
                    "model": model,
                    "parameters": {"max_tokens": 64},
                },
            },
            headers,
        )
        sid = sess["session_id"]

        # Subscribe first so no event is missed, then trigger.
        stream_thread = threading.Thread(
            target=_stream_until_reply_end,
            args=(base, sid, aid, headers, result, deadline),
            daemon=True,
        )
        stream_thread.start()
        time.sleep(0.3)

        _call(
            base,
            "/chat/",
            {
                "agent_id": aid,
                "session_id": sid,
                "input": {
                    "name": "loadtest",
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}],
                },
            },
            headers,
        )
        stream_thread.join(timeout=max(1.0, deadline - time.time()))
        result.latency = time.time() - started
        result.ok = bool(result.reply) and not result.error
        if not result.ok and not result.error:
            result.error = "no REPLY_END before deadline"
    except urllib.error.HTTPError as exc:
        result.error = f"HTTP {exc.code}: {exc.read().decode()[:120]}"
        result.latency = time.time() - started
    except Exception as exc:  # noqa: BLE001
        result.error = str(exc)
        result.latency = time.time() - started


def run_level(
    base: str,
    headers: dict,
    model: str,
    concurrency: int,
    runs: int,
    prompt: str,
    timeout: float,
) -> LevelResult:
    level = LevelResult(concurrency=concurrency)
    level.mem_before_mb = _docker_mem_mb()

    results: list[RunResult] = [RunResult(ok=False) for _ in range(runs)]
    sem = threading.Semaphore(concurrency)
    threads: list[threading.Thread] = []

    def worker(idx: int) -> None:
        with sem:
            deadline = time.time() + timeout
            _one_run(base, headers, model, prompt, results[idx], deadline)

    wall_start = time.time()
    for i in range(runs):
        t = threading.Thread(target=worker, args=(i,), daemon=True)
        threads.append(t)
        t.start()
    for t in threads:
        t.join(timeout=timeout + 10)
    level.wall = time.time() - wall_start
    level.runs = results
    level.mem_after_mb = _docker_mem_mb()
    return level


def report(levels: list[LevelResult]) -> None:
    print("\n" + "=" * 78)
    print("LOAD TEST RESULTS — one Agent Service process")
    print("=" * 78)
    header = (
        f"{'conc':>5} {'runs':>5} {'ok':>4} {'fail':>5} "
        f"{'wall(s)':>8} {'rps':>7} {'p50(s)':>8} {'p95(s)':>8} {'max(s)':>8} {'mem(MB)':>9}"
    )
    print(header)
    print("-" * len(header))
    for lv in levels:
        lat = sorted(r.latency for r in lv.ok_runs)
        p50 = statistics.median(lat) if lat else 0.0
        p95 = lat[int(len(lat) * 0.95)] if lat else 0.0
        mx = max(lat) if lat else 0.0
        rps = len(lv.ok_runs) / lv.wall if lv.wall else 0.0
        mem = f"{lv.mem_before_mb:.0f}->{lv.mem_after_mb:.0f}"
        print(
            f"{lv.concurrency:>5} {len(lv.runs):>5} {len(lv.ok_runs):>4} "
            f"{len(lv.failures):>5} {lv.wall:>8.1f} {rps:>7.2f} "
            f"{p50:>8.2f} {p95:>8.2f} {mx:>8.2f} {mem:>9}",
        )
        for f in lv.failures[:3]:
            print(f"      FAIL: {f.error[:100]}")

    print("\nInterpretation:")
    print("  - If p95 stays flat as concurrency rises, the process is I/O-bound")
    print("    (waiting on the model) and one process is enough.")
    print("  - If p95 climbs sharply, the event loop is saturated — add workers.")
    print("  - Memory growth per level is the per-session cost; multiply by the")
    print("    target session count to size the container.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--user-id", default="loadtest")
    ap.add_argument("--api-key", default="hm_master_key_99228811")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--concurrency", default="1,5,10,25")
    ap.add_argument("--runs-per-level", type=int, default=10)
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument(
        "--prompt",
        default="Reply with exactly one word: ok",
    )
    args = ap.parse_args()

    headers = _headers(args.user_id, args.api_key)
    levels = [int(c) for c in args.concurrency.split(",") if c.strip()]

    print(f"target: {args.base}  model: {args.model}")
    print(f"levels: {levels}  runs/level: {args.runs_per_level}")

    results: list[LevelResult] = []
    for conc in levels:
        print(f"\n--- concurrency {conc} ---", flush=True)
        lv = run_level(
            args.base,
            headers,
            args.model,
            conc,
            args.runs_per_level,
            args.prompt,
            args.timeout,
        )
        print(
            f"    ok={len(lv.ok_runs)}/{len(lv.runs)} wall={lv.wall:.1f}s "
            f"mem={lv.mem_before_mb:.0f}->{lv.mem_after_mb:.0f}MB",
            flush=True,
        )
        results.append(lv)

    report(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
