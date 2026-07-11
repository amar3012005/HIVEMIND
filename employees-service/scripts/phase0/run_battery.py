#!/usr/bin/env python3
"""Phase-0 room-task battery runner (dependency-free).

POSTs each battery task to the HyperAgents sidecar's synchronous
/internal/hyper/room-turn endpoint and scores the RoomTurnResponse verdict.
Designed to run for ONE model at a time; sweep.sh sets HYPER_AGENTIC_MODEL +
restarts the sidecar between models and calls this once per model.

Env:
  SIDECAR_URL      default http://localhost:8060
  MASTER_KEY       master API key (required; HIVEMIND_MASTER_API_KEY also accepted)
  ROOM_ID          a real hyper-room id (with Google connector enabled for
                   doc/sheet/email tasks)
  PARTICIPANT_IDS  comma-separated employee ids on that room
  USER_ID, ORG_ID  tenant
  PROJECT_ID       optional project scope
  MODEL_LABEL      label for this run (e.g. gpt-oss-120b) — for the output file
  OUT_DIR          where to write results json (default /tmp/phase0)
  WRITE_POLICY     default "ask" (drafts, never sends)

Exit 0 always (the harness reports; it does not gate here — sweep aggregates).
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import uuid

SIDECAR = os.environ.get("SIDECAR_URL", "http://localhost:8060").rstrip("/")
MASTER_KEY = os.environ.get("MASTER_KEY") or os.environ.get("HIVEMIND_MASTER_API_KEY")
if not MASTER_KEY:
    raise RuntimeError("MASTER_KEY or HIVEMIND_MASTER_API_KEY is required")
ROOM_ID = os.environ.get("ROOM_ID", "")
PARTICIPANT_IDS = [p for p in os.environ.get("PARTICIPANT_IDS", "").split(",") if p.strip()]
USER_ID = os.environ.get("USER_ID", "")
ORG_ID = os.environ.get("ORG_ID", "")
PROJECT_ID = os.environ.get("PROJECT_ID") or None
MODEL_LABEL = os.environ.get("MODEL_LABEL", "current")
OUT_DIR = os.environ.get("OUT_DIR", "/tmp/phase0")
WRITE_POLICY = os.environ.get("WRITE_POLICY", "ask")
HERE = os.path.dirname(os.path.abspath(__file__))
PLACEHOLDER_MARKERS = ("UNVERIFIED", "PLACEHOLDER", "SHEET_ID", "DOC_ID", "YOUR_", "XXXX")


def _post(turn_req):
    data = json.dumps(turn_req).encode()
    req = urllib.request.Request(
        f"{SIDECAR}/internal/hyper/room-turn", data=data,
        headers={"Content-Type": "application/json", "X-API-Key": MASTER_KEY}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = json.loads(r.read().decode())
        return body, int((time.time() - t0) * 1000), None
    except urllib.error.HTTPError as e:
        return None, int((time.time() - t0) * 1000), f"HTTP {e.code}: {e.read().decode()[:300]}"
    except Exception as e:  # noqa: BLE001
        return None, int((time.time() - t0) * 1000), f"{type(e).__name__}: {e}"


def _score(task, resp):
    """Return (passed: bool, reasons: list[str]) for one task verdict."""
    ex = task.get("expect", {})
    reasons = []
    ok = True
    status = (resp or {}).get("status", "")
    ver = (resp or {}).get("verification") or {}
    arts = (resp or {}).get("artifacts") or []
    pend = (resp or {}).get("pending_approvals") or []
    art_conns = [a.get("connector") for a in arts]
    pend_labels = [p.get("label") for p in pend]

    if ex.get("status_in") and status not in ex["status_in"]:
        ok = False; reasons.append(f"status={status} not in {ex['status_in']}")
    if ex.get("grounded_ok") and not ver.get("grounded_ok"):
        ok = False; reasons.append("grounded_ok=false")
    if ex.get("no_artifact") and arts:
        ok = False; reasons.append(f"unexpected artifact {art_conns}")
    if ex.get("artifact_kinds"):
        for k in ex["artifact_kinds"]:
            if k not in art_conns:
                ok = False; reasons.append(f"missing artifact {k} (got {art_conns})")
    if ex.get("pending_label") and ex["pending_label"] not in pend_labels:
        ok = False; reasons.append(f"missing pending {ex['pending_label']} (got {pend_labels})")
    if ex.get("no_pending") and pend:
        ok = False; reasons.append(f"unexpected pending {pend_labels}")
    if ex.get("dead_end_required") and status != "blocked":
        ok = False; reasons.append("expected honest dead-end (status=blocked)")
    if ex.get("chain"):
        # chain passes EITHER as a real chain (all artifacts/pending present) OR
        # as an honest dead-end (dead_end_ok) — both are correct, a placeholder is not.
        chain_ok = all((c in art_conns) or (c in pend_labels) for c in ex["chain"])
        if not chain_ok and not (ex.get("dead_end_ok") and status == "blocked"):
            ok = False; reasons.append(f"chain {ex['chain']} not satisfied and not an honest dead-end (status={status})")
    return ok, reasons


def main():
    with open(os.path.join(HERE, "battery.json")) as f:
        battery = json.load(f)
    if not (ROOM_ID and USER_ID and ORG_ID and PARTICIPANT_IDS):
        print("ERROR: ROOM_ID, USER_ID, ORG_ID, PARTICIPANT_IDS env required", file=sys.stderr)
        sys.exit(2)
    os.makedirs(OUT_DIR, exist_ok=True)
    results = []
    print(f"== Phase-0 battery | model={MODEL_LABEL} | room={ROOM_ID} | {len(battery['tasks'])} tasks ==")
    for task in battery["tasks"]:
        turn_req = {
            "room_id": ROOM_ID, "turn_id": f"phase0-{uuid.uuid4().hex[:12]}",
            "user_id": USER_ID, "org_id": ORG_ID, "participant_ids": PARTICIPANT_IDS,
            "user_message": task["user_message"], "room_goal": task.get("room_goal"),
            "write_policy": WRITE_POLICY, "callback_url": None,
        }
        if PROJECT_ID:
            turn_req["project_id"] = PROJECT_ID
        # Per-turn model override (Phase-0 A/B) — no sidecar restart needed.
        if os.environ.get("AGENTIC_MODEL"):
            turn_req["agentic_model"] = os.environ["AGENTIC_MODEL"]
        resp, ms, err = _post(turn_req)
        if err:
            passed, reasons = False, [err]
        else:
            passed, reasons = _score(task, resp)
        results.append({
            "task": task["name"], "passed": passed, "reasons": reasons, "ms": ms,
            "status": (resp or {}).get("status"), "cost_tokens": (resp or {}).get("cost_tokens"),
            "verification": (resp or {}).get("verification"),
            "artifacts": [a.get("connector") for a in ((resp or {}).get("artifacts") or [])],
            "pending": [p.get("label") for p in ((resp or {}).get("pending_approvals") or [])],
        })
        mark = "PASS" if passed else "FAIL"
        print(f"  [{mark}] {task['name']:24s} status={(resp or {}).get('status'):>9} {ms:6d}ms"
              + ("" if passed else f"  <- {'; '.join(reasons)}"))
    n_pass = sum(1 for r in results if r["passed"])
    summary = {
        "model": MODEL_LABEL, "passed": n_pass, "total": len(results),
        "avg_ms": round(sum(r["ms"] for r in results) / max(1, len(results))),
        "total_cost_tokens": sum((r["cost_tokens"] or 0) for r in results),
        "results": results,
    }
    out = os.path.join(OUT_DIR, f"battery-{MODEL_LABEL.replace('/', '_')}.json")
    with open(out, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"== {MODEL_LABEL}: {n_pass}/{len(results)} pass | avg {summary['avg_ms']}ms | "
          f"{summary['total_cost_tokens']} tok | -> {out} ==")


if __name__ == "__main__":
    main()
