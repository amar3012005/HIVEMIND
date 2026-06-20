#!/usr/bin/env python3
"""Real-world room simulation: ask CEO / CFO / PM questions in the Solvis room,
capture every agent event via the catcher, and write a clear /tmp/log.txt per run
(planner decision, each agent's contribution, recon-on-tasks, debate, final
conclusion, recon verdict). Run inside hm-employees AFTER catcher.py is up."""
import json
import os
import time
import urllib.request
import uuid

SID = "http://localhost:8060/internal/hyper/room-turn"
KEY = os.environ["HIVEMIND_MASTER_API_KEY"]
ROOM = "5a6e14c9-35e4-44c0-8582-c8b2a634b009"
ORG = "f5e2418b-61ef-4271-83a4-5623050b8402"
USER = "3b12845a-8cef-4174-ad89-16010810e90b"
PROJ = "0d8279b3-f7b0-46c6-9415-cebb52f7cc7c"
PARTS = ["be3a0e6b-8009-4461-89ad-b9cfce348997", "9181e34b-20a8-45e7-8ab6-9fc09477af28",
         "0470bf4c-deda-4d68-b2d5-7775b08344ad", "b27c577a-c4d8-4542-b17f-0a77d6e60180",
         "72f60dd6-7b56-42b0-8d3c-8ec0f3e1f0c5", "468d4e1b-54f7-4a6e-9cc5-b10206eba0a3"]
RUNS = [
    ("CEO", "As the CEO, should Solvis prioritise the heat-pump line or double down on solar + storage next year? Give a clear strategic recommendation with the reasoning."),
    ("CFO", "As the CFO, what are the biggest financial risks in our current product mix, and where should we cut cost or invest? Be specific."),
    ("PM", "As a product manager, what are the top feature gaps in our products versus what customers actually need, and what should we build next quarter?"),
]


def post(role, q):
    tid = f"sim-{role.lower()}-{uuid.uuid4().hex[:8]}"
    body = json.dumps({
        "room_id": ROOM, "turn_id": tid, "user_id": USER, "org_id": ORG, "project_id": PROJ,
        "participant_ids": PARTS, "user_message": q, "write_policy": "auto",
        "callback_url": "http://127.0.0.1:8077",
    }).encode()
    req = urllib.request.Request(SID, data=body,
                                 headers={"Content-Type": "application/json", "X-API-Key": KEY}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            resp = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        resp = {"error": str(e)}
    ms = int((time.time() - t0) * 1000)
    print(f"  {role} {tid} {ms}ms status={resp.get('status')}", flush=True)
    return {"role": role, "q": q, "turn_id": tid, "ms": ms, "resp": resp}


meta = [post(role, q) for role, q in RUNS]
json.dump(meta, open("/tmp/sim_meta.json", "w"))
print("sim done", flush=True)
