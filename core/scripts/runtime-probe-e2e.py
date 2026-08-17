#!/usr/bin/env python3
"""
runtime-probe-e2e.py — autonomous end-to-end HQ Runtime driver.

Called by runtime-probe.sh --e2e. Polls /v1/hq/events (not the SSE stream —
polling is simpler and more robust for a control loop that also needs to
make decisions between reads), and for every event that requires a human
decision, auto-approves it ("choose y always", per explicit instruction) —
EXCEPT capability_required, which needs a real OAuth connector connection
this script has no credentials for and must never fake.

Every action is printed with an explicit ACTION=... line so nothing is
silent. Exits when the runtime returns to an idle state with nothing left
to approve, or after --minutes minutes, whichever comes first.
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("RUNTIME_PROBE_BASE", "https://api.singulancelabs.com")
SESSION = os.environ["RUNTIME_PROBE_SESSION"]
MAX_MINUTES = float(os.environ.get("RUNTIME_PROBE_E2E_MINUTES", "20"))

HEADERS = {"Authorization": f"Bearer {SESSION}"}


def _req(method, path, body=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = dict(HEADERS)
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode(errors="replace")}


def get_events(after):
    status, data = _req("GET", f"/v1/hq/events?after={after}&limit=100")
    if status != 200:
        print(f"[e2e] WARN events fetch failed status={status} body={data}")
        return after, []
    events = data.get("events", [])
    next_cursor = data.get("next", after)
    return next_cursor, events


def get_status():
    status, runtime = _req("GET", "/v1/hq/runtime")
    _, work = _req("GET", "/v1/hq/work")
    return runtime.get("runtime", {}), work


def approve_activation_sprint(sprint_id):
    print(f"ACTION=approve_activation_sprint sprint_id={sprint_id}")
    status, resp = _req("POST", f"/v1/hq/first-life/{sprint_id}/start", {"decision": "start"})
    print(f"  -> status={status} {json.dumps(resp)[:300]}")
    return status in (200, 202)


def approve_authority(run_id, gate):
    print(f"ACTION=approve_authority run_id={run_id} gate={gate}")
    status, resp = _req("POST", f"/v1/hq/playbooks/runs/{run_id}/authority", {"gate": gate, "approve": True})
    print(f"  -> status={status} {json.dumps(resp)[:300]}")
    return status == 200


def skip_admin_checkin():
    # "y always" here means "let Runtime proceed" — the admin check-in is an
    # OPTIONAL interactive browser conversation this script cannot actually
    # hold (it's not a chat agent), so the correct auto-decision is 'skip',
    # which is exactly what a human declining the offer would do. It is NOT
    # a rejection of anything — Runtime proceeds from retained evidence.
    print("ACTION=skip_admin_checkin")
    status, resp = _req("POST", "/v1/hq/first-life/admin-checkin", {"decision": "skip"})
    print(f"  -> status={status} {json.dumps(resp)[:300]}")
    return status in (200, 202)


def handle_event(e):
    event_type = e.get("eventType", "?")
    details = e.get("details") or {}
    seq = e.get("sequence", "?")
    title = e.get("title", "")
    popup = event_type in ("approval_required", "capability_required", "decision_required")
    print(f"[{e.get('createdAt','')}] seq={seq} type={event_type} POPUP={'true' if popup else 'false'} :: {title}")
    summary = (e.get("summary") or "")[:200]
    if summary:
        print(f"    {summary}")

    if event_type == "capability_required":
        provider = details.get("provider", "?")
        print(f"    SKIPPED: requires a real OAuth connection to {provider} — no credentials available, will not fake this.")
        return

    if event_type == "decision_required" and details.get("activation_sprint_id"):
        approve_activation_sprint(details["activation_sprint_id"])
        return

    if event_type == "decision_required" and title.lower().startswith("a brief internal check-in"):
        skip_admin_checkin()
        return

    if event_type == "approval_required" and details.get("run_id") and details.get("gate"):
        approve_authority(details["run_id"], details["gate"])
        return


def main():
    started = time.time()
    # Start from the cursor captured BEFORE the wake/resume was requested
    # (passed in by runtime-probe.sh), not 0 — fetching from 0 replays the
    # entire historical event log on every run, re-triggering approve
    # attempts against long-since-resolved decisions (harmless when the API
    # correctly 409s "not waiting", but noisy and wrong). Confirmed live,
    # 2026-08-17: an --e2e run against org Singulance replayed a real
    # approval_required from hours earlier and got exactly that 409.
    after = os.environ.get("RUNTIME_PROBE_E2E_START_SEQ", "0")
    idle_polls = 0
    print(f"[e2e] starting from sequence {after} — max {MAX_MINUTES} minutes")
    while True:
        elapsed_min = (time.time() - started) / 60
        if elapsed_min > MAX_MINUTES:
            print(f"[e2e] TIMEOUT after {elapsed_min:.1f} minutes")
            break

        after, events = get_events(after)
        for e in events:
            handle_event(e)

        runtime, work = get_status()
        state = runtime.get("state", "?")
        work_orders = work.get("work_orders", []) if isinstance(work, dict) else []
        active_work = [w for w in work_orders if w.get("status") in ("queued", "running", "processing")]

        if not events and state in ("WAITING", "OBSERVING") and not active_work:
            idle_polls += 1
        else:
            idle_polls = 0

        print(f"[e2e] poll: state={state} active_work_orders={len(active_work)} idle_polls={idle_polls} elapsed={elapsed_min:.1f}m")

        # 3 consecutive quiet polls (~15s) with nothing pending and nothing
        # active is treated as "reached a stable resting point" — not proof
        # every possible future todo has run, just that this pass has nothing
        # left to approve or react to right now.
        if idle_polls >= 3:
            print("[e2e] DONE: reached a stable idle state with no pending decisions and no active work orders.")
            break

        time.sleep(5)

    print("[e2e] final status:")
    runtime, work = get_status()
    print(json.dumps({"runtime": runtime, "work": work}, indent=2)[:4000])


if __name__ == "__main__":
    main()
