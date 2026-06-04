#!/usr/bin/env python3
"""Standalone verify: can the AaaS stream from HIVEMIND /api/tara/stream?

Run:  HIVEMIND_API_KEY=hmk_live_... python verify_stream_tara.py --user-id <uuid> --org-id <uuid>
Exit 0 = streamed tokens OK. Exit 1 = failed.
"""
import argparse
import asyncio
import sys
import time

from tara_aaas.tara_stream import stream_tara
from tara_aaas import config


async def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--query", default="Hello TARA, give me one short sentence.")
    p.add_argument("--user-id", default=None)
    p.add_argument("--org-id", default=None)
    p.add_argument("--session-id", default="aaas-verify-cli")
    args = p.parse_args()

    print(f"→ {config.HIVEMIND_TARA_STREAM_URL}")
    print(f"  api_key_set={bool(config.HIVEMIND_API_KEY)} user_id={args.user_id} org_id={args.org_id}\n")

    started = time.monotonic()
    first_ms = None
    full = ""
    err = None
    async for evt in stream_tara(
        query=args.query, session_id=args.session_id,
        user_id=args.user_id, org_id=args.org_id,
    ):
        t = evt["type"]
        if t == "token":
            if first_ms is None:
                first_ms = round((time.monotonic() - started) * 1000)
            full += evt["text"]
            print(evt["text"], end="", flush=True)
        elif t == "final":
            if evt.get("full_text") and not full:
                full = evt["full_text"]
        elif t == "error":
            err = evt["error"]

    total_ms = round((time.monotonic() - started) * 1000)
    print("\n" + "─" * 50)
    if err:
        print(f"❌ FAIL: {err}")
        return 1
    if not full.strip():
        print("❌ FAIL: no tokens produced")
        return 1
    print(f"✅ PASS | first_token={first_ms}ms total={total_ms}ms chars={len(full)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
