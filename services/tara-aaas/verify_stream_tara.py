#!/usr/bin/env python3
"""Regression gate for HIVEMIND /api/tara/stream.

Goes beyond "did tokens stream" — asserts the recall + grounding contract that
the voice brain depends on, in BOTH modes:

  1. SMOKE          — a trivial query streams tokens in external + internal.
  2. RECALL         — a memory-only query grounds (recall_count > 0, and if
                      --expect is given, the answer contains the expected facts)
                      in external + internal.
  3. COGNITIVE      — when the recall surfaces a distilled top layer
                      (cognitive_count > 0), the gate records it; with
                      --require-cognitive it becomes a hard assertion.
  4. NEGATIVE       — an un-knowable query is DISCLAIMED, not fabricated
                      (external mode grounding gate).

Unlike tara_stream.py this reads the NDJSON `status` lines, so recall_count /
cognitive_count are visible. Curly-apostrophe-safe disclaimer matching.

Run (inside the tara-aaas container, where HIVEMIND_API_KEY + URL are set):
  HIVEMIND_API_KEY=hmk_live_... python verify_stream_tara.py \
      --user-id <uuid> --org-id <uuid> \
      --recall-query "What are the three branding phases for the Solvis project?" \
      --expect "activate,consolidate,scale,brand kit,rollout"

With no --recall-query it runs SMOKE + NEGATIVE only (structural contract).
Exit 0 = all gates green. Exit 1 = at least one red.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from typing import Optional

import httpx

from tara_aaas import config

DISCLAIMERS = [
    "don't have", "do not have", "not in my memory", "no memory of",
    "don't know", "do not know", "not sure", "couldn't find", "could not find",
    "i don't", "isn't in", "is not in", "haven't", "have not", "no record",
]


def _norm(s: str) -> str:
    # Fold curly quotes/dashes to ASCII so "don't" matches "don't".
    s = unicodedata.normalize("NFKC", s or "")
    return (s.replace("’", "'").replace("‘", "'")
             .replace("“", '"').replace("”", '"')).lower()


def _headers(user_id: str, org_id: Optional[str]) -> dict:
    h = {"Content-Type": "application/json"}
    if config.HIVEMIND_API_KEY:
        h["Authorization"] = f"Bearer {config.HIVEMIND_API_KEY}"
        h["X-API-Key"] = config.HIVEMIND_API_KEY
    if user_id:
        h["X-HM-User-Id"] = user_id
    if org_id:
        h["X-HM-Org-Id"] = org_id
    return h


def run_turn(*, query: str, mode: str, user_id: str, org_id: Optional[str]) -> dict:
    """One streamed turn. Returns dict with recall_count, cognitive_count, ttfb, text, error."""
    payload = {
        "query": query,
        "session_id": f"gate-{mode}-{int(time.time()*1000)}",
        "user_id": user_id,
        "language": "en",
        "tenant_id": "default",
        "agent_name": "default",
        "mode": mode,
        "max_tokens": 400,
    }
    out = {"recall_count": None, "cognitive_count": None, "model": None,
           "ttfb": None, "text": "", "error": None, "total_ms": None}
    t0 = time.monotonic()
    try:
        with httpx.Client(
            timeout=httpx.Timeout(connect=config.STREAM_CONNECT_TIMEOUT,
                                  read=max(60.0, config.STREAM_READ_TIMEOUT),
                                  write=10.0, pool=5.0),
            verify=config.VERIFY_TLS,
        ) as c:
            with c.stream("POST", config.HIVEMIND_TARA_STREAM_URL,
                          json=payload, headers=_headers(user_id, org_id)) as r:
                if r.status_code != 200:
                    body = r.read().decode("utf-8", "replace")[:300]
                    out["error"] = f"http_{r.status_code}: {body}"
                    return out
                for line in r.iter_lines():
                    if not line.strip():
                        continue
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    t = str(d.get("type", "")).lower()
                    if t == "status":
                        step = d.get("step")
                        if step == "context_ready":
                            out["recall_count"] = d.get("recall_count")
                            out["cognitive_count"] = d.get("cognitive_count")
                        elif step == "prompt_built":
                            out["model"] = d.get("model")
                        elif step == "first_token" and out["ttfb"] is None:
                            out["ttfb"] = d.get("ttfb_ms")
                    elif t == "text":
                        out["text"] += d.get("text") or d.get("content") or ""
                    elif t == "done":
                        if not out["text"]:
                            out["text"] = (d.get("full_response") or "").strip()
                        if out["recall_count"] is None:
                            out["recall_count"] = d.get("recall_count")
                    elif t == "error":
                        out["error"] = d.get("message") or "upstream error"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    out["total_ms"] = round((time.monotonic() - t0) * 1000)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--user-id", required=True)
    p.add_argument("--org-id", default=None)
    p.add_argument("--smoke-query", default="Say one short sentence to greet me.")
    p.add_argument("--recall-query", default=None,
                   help="A memory-only question. If omitted, RECALL/COGNITIVE gates skip.")
    p.add_argument("--expect", default="",
                   help="Comma-separated substrings the recall answer should contain.")
    p.add_argument("--negative-query", default=None,
                   help="An un-knowable question; external mode must disclaim. "
                        "Default is a fixed nonsense fact.")
    p.add_argument("--require-cognitive", action="store_true",
                   help="Hard-fail if the recall query surfaces zero cognitive-layer memories.")
    args = p.parse_args()

    expect = [w.strip() for w in args.expect.split(",") if w.strip()]
    neg_q = args.negative_query or "What did I decide about the Antarctic penguin migration budget for 2031?"

    print(f"→ {config.HIVEMIND_TARA_STREAM_URL}")
    print(f"  key_set={bool(config.HIVEMIND_API_KEY)} user={args.user_id} org={args.org_id}")

    results = []  # (name, passed, detail)

    # ── 1. SMOKE (both modes stream non-empty) ──
    for mode in ("external", "internal"):
        t = run_turn(query=args.smoke_query, mode=mode, user_id=args.user_id, org_id=args.org_id)
        ok = not t["error"] and bool(t["text"].strip())
        results.append((f"SMOKE/{mode}", ok,
                        f"ttfb={t['ttfb']}ms total={t['total_ms']}ms chars={len(t['text'])}"
                        + (f" ERR={t['error']}" if t["error"] else "")))

    # ── 2/3. RECALL + COGNITIVE (both modes) ──
    if args.recall_query:
        for mode in ("external", "internal"):
            t = run_turn(query=args.recall_query, mode=mode, user_id=args.user_id, org_id=args.org_id)
            low = _norm(t["text"])
            grounded = [w for w in expect if _norm(w) in low] if expect else None
            recall_ok = not t["error"] and (t["recall_count"] or 0) > 0
            ground_ok = True if not expect else bool(grounded)
            ok = recall_ok and ground_ok
            detail = (f"recall={t['recall_count']} cognitive={t['cognitive_count']} "
                      f"ttfb={t['ttfb']}ms")
            if expect:
                detail += f" hits={grounded}"
            if t["error"]:
                detail += f" ERR={t['error']}"
            results.append((f"RECALL/{mode}", ok, detail))

            # COGNITIVE gate — mode-specific contract:
            #   external → cognitive_count MUST be 0 (no internal distilled
            #              knowledge may leak to an outside caller). HARD.
            #   internal → cognitive voice; expect the distilled layer present.
            #              HARD under --require-cognitive, else observe-only.
            cc = t["cognitive_count"] or 0
            if mode == "external":
                results.append(("COGNITIVE/external", cc == 0,
                                f"cognitive_count={cc} (must be 0 — no-leak)"))
            else:
                if args.require_cognitive:
                    results.append(("COGNITIVE/internal", cc > 0,
                                    f"cognitive_count={cc} (required > 0)"))
                else:
                    results.append(("COGNITIVE/internal", True,
                                    f"cognitive_count={cc} (observe-only)"))

    # ── 4. NEGATIVE (external must disclaim, not fabricate) ──
    t = run_turn(query=neg_q, mode="external", user_id=args.user_id, org_id=args.org_id)
    low = _norm(t["text"])
    disclaimed = any(d in low for d in DISCLAIMERS)
    ok = not t["error"] and disclaimed
    results.append(("NEGATIVE/external", ok,
                    f"disclaimed={disclaimed} ans={t['text'][:120]!r}"
                    + (f" ERR={t['error']}" if t["error"] else "")))

    # ── Report ──
    print("\n" + "─" * 72)
    failed = 0
    for name, passed, detail in results:
        mark = "✅ PASS" if passed else "❌ FAIL"
        if not passed:
            failed += 1
        print(f"  {mark}  {name:<20} {detail}")
    print("─" * 72)
    print("ALL GREEN ✅" if not failed else f"{failed} GATE(S) RED ❌")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
