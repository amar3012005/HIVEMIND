"""
Campaign engine — mass outbound with parallel or sequential dialing.

In-memory campaign state + JSONL persistence (per-call logs already land in
LOG_DIR via CallEventLog). Concurrency bounded by a semaphore well under the
Deepgram PAYG 15-session cap. Every dial passes through the same allowlist
gate in telephony.dial — a campaign can NEVER reach a non-allowlisted number.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional

from pydantic import BaseModel, Field

from . import config, telephony

log = logging.getLogger("tara_dg.campaigns")

_campaigns: dict[str, dict] = {}


class Contact(BaseModel):
    phone: str
    name: Optional[str] = None
    language: str = "en"


class CampaignRequest(BaseModel):
    name: str
    contacts: list[Contact]
    skill_id: Optional[str] = None
    goal: Optional[str] = None
    voice_id: Optional[str] = None
    language: str = "en"
    parallel: int = Field(default=1, ge=1)
    user_id: Optional[str] = None
    org_id: Optional[str] = None


def _persist(camp: dict) -> None:
    try:
        os.makedirs(config.LOG_DIR, exist_ok=True)
        with open(os.path.join(config.LOG_DIR, f"campaign-{camp['id']}.json"), "w") as f:
            json.dump(camp, f, ensure_ascii=False, default=str)
    except OSError as e:
        log.error("campaign persist failed: %s", e)


async def _run_contact(camp: dict, contact: dict, sem: asyncio.Semaphore) -> None:
    async with sem:
        if camp["status"] != "running":
            contact["state"] = "skipped"
            return
        session_id = f"camp-{camp['id']}-{uuid.uuid4().hex[:8]}"
        contact["session_id"] = session_id
        try:
            res = await telephony.dial(telephony.DialRequest(
                to=contact["phone"], session_id=session_id,
                user_id=camp.get("user_id"), org_id=camp.get("org_id"),
                language=contact.get("language") or camp["language"],
                voice_id=camp.get("voice_id"), skill_id=camp.get("skill_id"),
                goal=camp.get("goal"), campaign_id=camp["id"],
                contact_name=contact.get("name"),
            ))
            contact["call_leg_id"] = res["call_leg_id"]
            contact["state"] = "dialing"
        except ValueError as e:  # allowlist block etc. — skip, log, continue
            contact["state"] = "skipped"
            contact["skip_reason"] = str(e)
            return
        except Exception as e:  # noqa: BLE001
            contact["state"] = "error"
            contact["skip_reason"] = str(e)
            return
        # Hold the semaphore slot until the call ends (bounds true concurrency).
        deadline = time.time() + 600
        while time.time() < deadline:
            meta = telephony.pending_calls.get(contact["call_leg_id"])
            state = (meta or {}).get("status", "ended")
            contact["state"] = state
            if state == "ended":
                break
            await asyncio.sleep(2)
        contact["state"] = "done"
        _persist(camp)


async def _run_campaign(camp_id: str) -> None:
    camp = _campaigns[camp_id]
    sem = asyncio.Semaphore(min(camp["parallel"], config.CAMPAIGN_MAX_PARALLEL))
    await asyncio.gather(*(
        _run_contact(camp, c, sem) for c in camp["contacts"]
    ))
    camp["status"] = "completed" if camp["status"] == "running" else camp["status"]
    camp["finished_at"] = time.time()
    _persist(camp)
    log.info("campaign %s finished", camp_id)


def launch(req: CampaignRequest) -> dict:
    if len(req.contacts) > config.CAMPAIGN_DAILY_CAP:
        raise ValueError(f"Contact list exceeds daily cap ({config.CAMPAIGN_DAILY_CAP})")
    camp_id = uuid.uuid4().hex[:12]
    camp = {
        "id": camp_id, "name": req.name, "status": "running",
        "skill_id": req.skill_id, "goal": req.goal, "voice_id": req.voice_id,
        "language": req.language, "parallel": req.parallel,
        "user_id": req.user_id, "org_id": req.org_id,
        "started_at": time.time(), "finished_at": None,
        "contacts": [{"state": "queued", **c.model_dump()} for c in req.contacts],
    }
    _campaigns[camp_id] = camp
    _persist(camp)
    asyncio.get_event_loop().create_task(_run_campaign(camp_id))
    return {"campaign_id": camp_id, "status": "running", "contacts": len(camp["contacts"])}


def status(camp_id: str) -> Optional[dict]:
    return _campaigns.get(camp_id)


def stop(camp_id: str) -> bool:
    camp = _campaigns.get(camp_id)
    if not camp:
        return False
    camp["status"] = "stopped"
    _persist(camp)
    return True


def list_campaigns() -> list[dict]:
    return [
        {k: c[k] for k in ("id", "name", "status", "started_at", "finished_at")}
        | {"total": len(c["contacts"]),
           "done": sum(1 for x in c["contacts"] if x["state"] in ("done", "skipped", "error"))}
        for c in _campaigns.values()
    ]
