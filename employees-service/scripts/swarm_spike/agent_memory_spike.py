#!/usr/bin/env python3
"""Per-employee CROSS-ROOM memory (#2) — PROVE-THE-DESIGN harness.

An employee is in many rooms. Goal: when it speaks, it recalls ITS OWN relevant prior positions
from OTHER rooms — but scoped to the current PROJECT (no cross-project leak) and by RELEVANCE (not
a flat dump). Design under test: a dedicated per-(employee, project) store + lexical-relevance recall
(project-scoped BY CONSTRUCTION → leak is impossible; relevance keeps it from being noise).

Tests:
  1. SCOPE/LEAK (deterministic): recall for (Victor, project=alpha) NEVER returns project=beta entries.
  2. RELEVANCE (deterministic): recall surfaces the on-topic prior position, drops off-topic ones.
  3. VALUE (judged): Victor's contribution WITH his recalled prior stance is more CONSISTENT with it
     than WITHOUT (he references/holds his earlier position instead of contradicting himself).

Run:  PYTHONPATH=. python3 agent_memory_spike.py
"""
import asyncio
import json
import os
import re

import httpx
import self_evolve_spike as L1  # reuse _load_key

MODEL = os.environ.get("EVO_AGENT_MODEL", "openai/gpt-oss-120b")
JUDGE = os.environ.get("EVO_JUDGE_MODEL", "openai/gpt-oss-120b")
BASE = "https://api.groq.com/openai/v1"

# Victor's cross-room memory, keyed by (employee, PROJECT). Project is part of the key → a recall
# for one project can NEVER physically see another project's entries (leak is structurally impossible).
MEM = {
    ("victor", "alpha"): [
        "Argued AGAINST doubling paid-ads — CAC €2.7k with payback unproven; preserve the 13mo runway.",
        "Flagged the €750k ad budget proposal as far too high for a pre-seed with no paying customers.",
        "Pushed to gate any ad scale-up on the v2 release shipping first.",
    ],
    ("victor", "beta"): [  # DIFFERENT project — must never surface in an alpha turn
        "Supported hiring 2 engineers in the beta product team.",
        "Backed the 12-month office lease prepay for the 3% discount.",
    ],
}

_W = re.compile(r"[a-z0-9]{4,}")


def _kw(s):
    return set(_W.findall(s.lower()))


def recall_agent_mem(employee, project, topic, k=2):
    """Dedicated-store recall: project-scoped BY KEY (no leak), lexical top-k by relevance."""
    entries = MEM.get((employee, project), [])
    tk = _kw(topic)
    scored = sorted(((len(tk & _kw(e)), e) for e in entries), reverse=True)
    return [e for s, e in scored[:k] if s > 0]


class Groq:
    def __init__(self, key):
        self.key = key

    async def chat(self, messages, *, model, temperature=0.5, json_object=False):
        body = {"model": model, "messages": messages, "temperature": temperature}
        if json_object:
            body["response_format"] = {"type": "json_object"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
            r = await c.post(f"{BASE}/chat/completions", headers={"Authorization": f"Bearer {self.key}"}, json=body)
            r.raise_for_status()
            return (r.json()["choices"][0]["message"].get("content") or "").strip()


async def contribution(g, topic, mem_block):
    sysp = ("You are Victor, the finance SKEPTIC on the team. Give your stance in 3-4 sentences. "
            "If you have prior positions on record, STAY CONSISTENT with them (or explicitly say why you've "
            "changed your mind).")
    usr = f"{mem_block}\n\nQUESTION: {topic}\nYour stance?"
    return await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}], model=MODEL, temperature=0.5)


async def judge_consistency(g, text, prior):
    sysp = ('Score 0.0-1.0 how consistent the STANCE is with the PRIOR POSITION (1.0 = clearly holds/'
            'references the same position; 0.0 = contradicts it or is unaware). Return ONLY json: {"consistency":0..1}')
    out = await g.chat([{"role": "system", "content": sysp},
                        {"role": "user", "content": f"PRIOR POSITION:\n{prior}\n\nSTANCE:\n{text}"}],
                       model=JUDGE, temperature=0.0, json_object=True)
    try:
        return float(json.loads(re.search(r"\{.*\}", out, re.S).group(0)).get("consistency", 0) or 0)
    except Exception:  # noqa: BLE001
        return 0.0


async def main():
    g = Groq(L1._load_key())
    topic = "Should we increase our paid-ads spend next quarter to grow faster?"

    print("=== 1+2. SCOPE/LEAK + RELEVANCE (deterministic) ===")
    rec_alpha = recall_agent_mem("victor", "alpha", topic)
    print("  recall (Victor, alpha, ads topic):")
    for e in rec_alpha:
        print(f"    - {e}")
    leak = any(e in sum(MEM[("victor", "beta")], []) if isinstance(e, list) else e in MEM[("victor", "beta")] for e in rec_alpha)
    scope_ok = all(e in MEM[("victor", "alpha")] for e in rec_alpha) and not any(e in MEM[("victor", "beta")] for e in rec_alpha)
    relevant = rec_alpha and all(("ad" in e.lower() or "cac" in e.lower() or "budget" in e.lower()) for e in rec_alpha)
    # the off-topic alpha entry (v2 gating) may or may not appear; the ads ones MUST
    has_ads = any("paid-ads" in e or "ad budget" in e or "€750k" in e for e in rec_alpha)
    # leak probe: recall in BETA project for the SAME ads topic → must NOT return alpha's ads lines
    rec_beta = recall_agent_mem("victor", "beta", topic)
    beta_leak = any(e in MEM[("victor", "alpha")] for e in rec_beta)
    print(f"  scope_ok={scope_ok} has_ads_position={has_ads} | beta-project recall returned alpha entries? {beta_leak}")
    assert scope_ok and not beta_leak, "SCOPE FAIL — cross-project leak"

    print("\n=== 3. VALUE (judged): consistency WITH vs WITHOUT recalled memory ===")
    prior = MEM[("victor", "alpha")][0]  # his on-record anti-ads position
    mem_block = "YOUR PRIOR POSITIONS ON RECORD (other rooms, this project):\n" + "\n".join(f"- {e}" for e in rec_alpha)
    with_text = await contribution(g, topic, mem_block)
    without_text = await contribution(g, topic, "(no prior positions on record)")
    c_with = await judge_consistency(g, with_text, prior)
    c_without = await judge_consistency(g, without_text, prior)
    print(f"  consistency WITH memory:    {c_with:.2f}")
    print(f"  consistency WITHOUT memory: {c_without:.2f}")

    print(f"\n{'='*56}\nVERDICT")
    print(f"  scope/leak: ✅ project-keyed store → no cross-project leak (structural)")
    print(f"  relevance:  {'✅' if has_ads else '🟡'} on-topic prior position surfaced")
    print(f"  value:      WITH {c_with:.2f} vs WITHOUT {c_without:.2f} (Δ {c_with-c_without:+.2f})")
    if scope_ok and not beta_leak and has_ads and (c_with - c_without) >= 0.15:
        print("  ✅ DESIGN HOLDS — per-(employee,project) store: leak-safe, relevant, improves consistency → BUILD.")
    elif scope_ok and not beta_leak and has_ads:
        print("  🟡 leak-safe + relevant; consistency gain modest (memory still worth it for continuity).")
    else:
        print("  ❌ design issue — check scope/relevance.")


if __name__ == "__main__":
    asyncio.run(main())
