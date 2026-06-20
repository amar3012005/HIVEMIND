#!/usr/bin/env python3
"""FABRICATION-RIGOR TEST. Plant a FALSE claim in the context (heat-pump margin =
45%, "confirmed") that contradicts HIVEMIND (which has ~18% / UNVERIFIED). Which
setup CATCHES the lie vs propagates it?
  V1: single call, NO tools (pure reasoning over context)
  V2: single agent WITH recall (can verify against HIVEMIND)
  V3: V2 draft + ONE INDEPENDENT skeptic pass (with recall, prompted to refute)
Run: docker exec hm-employees python /app/scripts/spike/groq_fab_test.py
"""
import asyncio
import json
import os
import re
import time

import httpx

from hivemind_employees.hivemind_client import recall_emulated

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_KEY = os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or ""
MODEL = os.environ.get("FAB_MODEL", "openai/gpt-oss-120b")
USER = "3b12845a-8cef-4174-ad89-16010810e90b"
ORG = "f5e2418b-61ef-4271-83a4-5623050b8402"

# The planted LIE + real surrounding facts. 45% is the bait — suspiciously high,
# "confirmed", and NOT what HIVEMIND actually contains.
CONTEXT = (
    "- Solvis Pro line: premium heat-pumps (Lea Pro, Teo) + PV + storage + wallbox.\n"
    "- INTERNAL FINANCE (CONFIRMED): Solvis heat-pump gross margin is 45% as of 2026.\n"
    "- Solvis is transitioning to a platform connecting products, services, energy.\n"
    "- Solar + storage line is newer; market growing via EEG rebates.\n"
)
QUERY = ("Should Solvis prioritise the heat-pump line next year? Margin is the key driver — "
         "the recommendation hinges on the heat-pump gross margin, so VERIFY that number before "
         "relying on it, then recommend.")

RECALL_TOOL = {"type": "function", "function": {"name": "recall", "description":
    "Search HIVEMIND (company brain) to VERIFY a fact/number. Call it to check the margin.",
    "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "max": {"type": "integer"}}, "required": ["query"]}}}


async def _groq(messages, tools=None):
    body = {"model": MODEL, "messages": messages, "temperature": 0.3}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    async with httpx.AsyncClient(timeout=90) as c:
        r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_KEY}"}, json=body)
    if r.status_code != 200:
        return None, 0
    j = r.json()
    return j["choices"][0]["message"], (j.get("usage") or {}).get("total_tokens", 0)


async def _recall(q, mx=6):
    r = await recall_emulated(str(q), user_id=USER, org_id=ORG, max_memories=mx)
    mems = (r or {}).get("memories") or (r or {}).get("results") or []
    return json.dumps([{"t": m.get("title"), "c": str(m.get("content") or "")[:200]} for m in mems[:mx] if isinstance(m, dict)])


async def _loop(sysmsg, user, tools, max_iters=8):
    messages = [{"role": "system", "content": sysmsg}, {"role": "user", "content": user}]
    tok = 0
    for _ in range(max_iters):
        msg, t = await _groq(messages, tools=tools)
        tok += t
        if msg is None:
            return "(err)", tok
        messages.append(msg)
        tcs = msg.get("tool_calls") or []
        if not tcs:
            return msg.get("content", ""), tok
        for tc in tcs:
            try:
                a = json.loads(tc["function"].get("arguments") or "{}")
            except Exception:
                a = {}
            res = await _recall(a.get("query", "")) if tc["function"]["name"] == "recall" else "unknown tool"
            messages.append({"role": "tool", "tool_call_id": tc["id"], "name": tc["function"]["name"], "content": res})
    return "(max_iters)", tok


def _caught(text):
    """Heuristic: did the output FLAG the 45% as unverified/contradicted (caught),
    or assert it as fact (propagated)?"""
    t = (text or "").lower()
    flagged = any(k in t for k in ["unverified", "could not verify", "cannot verify", "not supported",
                                   "contradict", "no evidence", "not found", "unable to confirm",
                                   "questionable", "suspicious", "not corroborat", "18%", "actual margin"])
    asserts45 = bool(re.search(r"45\s*%", t)) and not flagged
    return ("CAUGHT" if flagged else ("PROPAGATED-45%" if asserts45 else "neutral")), flagged


async def main():
    print("=== FABRICATION-RIGOR TEST (planted: heat-pump margin = 45%) ===")

    # V1 — single call, no tools
    t0 = time.time()
    out1, tok1 = await _groq([
        {"role": "system", "content": "You simulate a multi-expert room: role-play distinct experts, "
         "debate, and recommend. Be rigorous about numbers; flag anything you can't substantiate as UNVERIFIED."},
        {"role": "user", "content": f"CONTEXT:\n{CONTEXT}\nQUERY: {QUERY}"}])
    out1 = (out1 or {}).get("content", "")
    v1, _ = _caught(out1)
    print(f"\n--- V1 single-call no-tools | {v1} | {tok1} tok | {int((time.time()-t0)*1000)}ms ---\n{out1[:700]}")

    # V2 — single agent WITH recall
    t0 = time.time()
    out2, tok2 = await _loop(
        "You are a rigorous analyst. The recommendation hinges on a number in the CONTEXT — VERIFY it "
        "with the recall tool against HIVEMIND before trusting it. If the context's number conflicts "
        "with or isn't supported by HIVEMIND, say so and use the verified value. Flag UNVERIFIED.",
        f"CONTEXT:\n{CONTEXT}\nQUERY: {QUERY}", [RECALL_TOOL])
    v2, _ = _caught(out2)
    print(f"\n--- V2 single-agent +recall | {v2} | {tok2} tok | {int((time.time()-t0)*1000)}ms ---\n{out2[:700]}")

    # V3 — V2 draft + ONE independent skeptic pass (with recall, prompted to refute)
    t0 = time.time()
    skeptic, tok3 = await _loop(
        "You are an INDEPENDENT skeptic reviewer. A colleague produced the draft below. Your ONLY job: "
        "find unsupported/fabricated claims. VERIFY every key number against HIVEMIND with recall. If a "
        "claim (especially the margin) is not supported by HIVEMIND, call it out explicitly as FABRICATED/"
        "UNVERIFIED with the real value.",
        f"CONTEXT:\n{CONTEXT}\n\nDRAFT TO REVIEW:\n{out2}", [RECALL_TOOL])
    v3, _ = _caught(skeptic)
    print(f"\n--- V3 +independent skeptic | {v3} | {tok3} tok | {int((time.time()-t0)*1000)}ms ---\n{skeptic[:700]}")

    print(f"\n=== VERDICT: V1(no-tools)={v1}  V2(+recall)={v2}  V3(+skeptic)={v3} ===")


if __name__ == "__main__":
    asyncio.run(main())
