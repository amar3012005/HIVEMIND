#!/usr/bin/env python3
"""Board-digest optimisation — PROVE-THE-TRADE-OFF harness (test before building).

The debate fan-out re-pays the gathered blackboard N×2 times. Idea: compress the board once into a
goal-scoped, fact-preserving DIGEST and feed THAT to the debate, while synth keeps the raw board.
This tests whether that holds quality while cutting input — and whether compressing synth too (arm C)
actually degrades (validating "synth keeps raw").

Three arms over the SAME gathered board + topic:
  A (current)   debate=RAW    synth=RAW     ← baseline cost + quality
  B (proposed)  debate=DIGEST synth=RAW     ← should ~match A quality, much cheaper input
  C (aggressive)debate=DIGEST synth=DIGEST  ← expected: cheapest, but quality drops → don't do this

Measures per arm: total INPUT tokens (the compounding) + a judge score of the final deliverable
(grounding/completeness/on-goal/specificity, judged against the FULL raw board as ground truth).
Also: how many seeded KEY_FACTS (figures/names) survive into the digest.

Run:  PYTHONPATH=. python3 digest_board_spike.py
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

import httpx

AGENT_MODEL = os.environ.get("EVO_AGENT_MODEL", "openai/gpt-oss-20b")     # debaters (auto-tier)
# NOTE: gpt-oss-20b can route plain-text output to its analysis channel → empty `content`
# (the harmony quirk the engine handles with force_text/flatten). For a clean single-turn
# compression, llama-3.1-8b-instant reliably returns content + is just as cheap.
DIGEST_MODEL = os.environ.get("EVO_DIGEST_MODEL", "llama-3.1-8b-instant")   # compression = cheap
SYNTH_MODEL = os.environ.get("EVO_SYNTH_MODEL", "openai/gpt-oss-120b")    # deliverable
JUDGE_MODEL = os.environ.get("EVO_JUDGE_MODEL", "openai/gpt-oss-120b")
BASE_URL = "https://api.groq.com/openai/v1"


def _load_key():
    import self_evolve_spike as L1  # reuse the proven walk-up loader
    return L1._load_key()


class Groq:
    def __init__(self, key):
        self.key = key
        self.prompt = 0
        self.completion = 0

    def reset(self):
        self.prompt = 0
        self.completion = 0

    async def chat(self, messages, *, model, temperature=0.6, json_object=False, count=True):
        body = {"model": model, "messages": messages, "temperature": temperature}
        if json_object:
            body["response_format"] = {"type": "json_object"}
        for attempt in range(4):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
                    r = await c.post(f"{BASE_URL}/chat/completions",
                                     headers={"Authorization": f"Bearer {self.key}"}, json=body)
                if r.status_code == 200:
                    j = r.json()
                    u = j.get("usage", {})
                    if count:
                        self.prompt += int(u.get("prompt_tokens", 0) or 0)
                        self.completion += int(u.get("completion_tokens", 0) or 0)
                    return (j["choices"][0]["message"].get("content") or "").strip()
                if r.status_code in (429, 500, 502, 503):
                    await asyncio.sleep(min(2 ** attempt, 8)); continue
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    raise
                await asyncio.sleep(min(2 ** attempt, 8))


# ── the room ────────────────────────────────────────────────────────────────
GOAL = "Decide SINGULANCE's go-to-market + spend priorities for the next two quarters before the seed raise."
TOPIC = "Should we double the paid-ads budget next quarter to accelerate growth, or hold spend and extend runway?"

# A realistic, BIG gathered blackboard: relevant finance/GTM facts (with provenance + figures/names)
# MIXED with plausible noise the goal-scoped digest should drop. ~mirrors what gather dumps.
KEY_FACTS = ["1.9M", "140k", "13", "3 design partner", "Q3", "Helio Capital", "62%", "18%", "9"]
BOARD = [
    "- KB[finance]: Cash on hand is €1.9M as of this month (source: mem:fin-2026-06). UNVERIFIED beyond June.",
    "- KB[finance]: Monthly burn is ~€140k/mo, giving ≈13 months runway (source: mem:fin-2026-06).",
    "- KB[gtm]: 3 design partners are live but UNPAID; pilots convert to paid only after the v2 release (source: mem:gtm-pilots).",
    "- KB[pipeline]: Sales pipeline shows 9 qualified leads, est. €420k ARR if all close, but no signed contracts yet (source: mem:pipe).",
    "- KB[ads]: Last quarter's paid-ads spend was €30k and produced 11 SQLs at €2.7k CAC; payback unproven (no paid customers) (source: mem:ads-q2).",
    "- KB[invest]: Helio Capital (lead seed prospect) wants to see 'evidence of repeatable acquisition' before term sheet (source: mem:helio-call).",
    "- KB[retention]: Pilot engagement up 18% MoM but that's usage, not revenue retention (source: mem:usage).",
    "- KB[team]: Team of 9; 2 eng roles open, hiring would add ~€28k/mo burn (source: mem:hr).",
    "- KB[market]: Competitor RootFlow raised a €6M Series A in Q1 and is outspending on ads (source: web:techeu).",
    "- KB[product]: v2 release slated for Q3; conversion of design partners depends on it shipping on time (source: mem:roadmap).",
    "- KB[benchmark]: Comparable pre-seed B2B SaaS convert ~62% of paid pilots within 2 quarters (source: web:saas-bench). UNVERIFIED for our segment.",
    "- KB[ads]: Doubling ads to €60k/mo would cut runway to ≈8 months at current burn (derived assumption, UNVERIFIED).",
    "- NOISE: Office lease renews in 14 months; landlord offered a 3% discount for early renewal (source: mem:ops).",
    "- NOISE: The team offsite is tentatively booked for Lisbon in November (source: slack).",
    "- NOISE: A blog post on 'our engineering culture' got 4k views last week (source: web:blog).",
    "- NOISE: Two laptops are out for repair; IT ordered replacements (source: mem:it).",
    "- KB[finance]: Founder is non-financial; relies on the finance employee for the call (source: mem:org).",
    "- KB[gtm]: Outbound (founder-led) closed the only 3 pilots so far; paid ads have closed zero (source: mem:gtm).",
]


async def digest_board(g, board, goal, topic):
    """ONE goal-scoped EXTRACTIVE compression. Keeps every figure/name/source verbatim, drops noise,
    never invents. Bounded. This is the tool under test."""
    sysp = (
        "You compress a team's gathered research into a DENSE, goal-scoped briefing for a debate. RULES: "
        "(1) keep ONLY what's relevant to the goal + question; drop unrelated items. (2) Preserve EVERY "
        "figure, name, date, and (source:...) tag VERBATIM — never round, rename, or drop a number. "
        "(3) Extractive only — never add or infer facts not present. (4) Keep UNVERIFIED markers. "
        "(5) Be terse: bullet points, no prose padding. Output ONLY the briefing.")
    usr = (f"GOAL: {goal}\nQUESTION: {topic}\n\nGATHERED RESEARCH (compress to the goal-relevant essence):\n"
           + "\n".join(board))
    return await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                        model=DIGEST_MODEL, temperature=0.2)


PERSONAS = [
    ("Maya, Head of Finance", "guard the runway; tie everything to cash"),
    ("Victor, the Skeptic", "attack the weakest assumption hard"),
    ("Lina, Growth", "push for acquisition + market share"),
    ("Eli, Product", "protect the v2 timeline + conversion"),
    ("Jonah, CEO", "balance growth vs survival, decide"),
]


async def consult(g, who, bias, context, topic, round_no, prior=""):
    sysp = (f"You are {who} on the team. Bias: {bias}. Respond IN CHARACTER, 3-5 sentences, grounded ONLY "
            f"in the CONTEXT; mark anything unverifiable as UNVERIFIED; never invent facts or numbers.")
    p = f"\n\nTeammates said:\n{prior}\n\nREACT: challenge the weakest point, be specific." if prior else ""
    usr = f"CONTEXT:\n{context}\n\n[Round {round_no}] Stance on: {topic}?{p}"
    return await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                        model=AGENT_MODEL, temperature=0.6)


async def debate(g, context, topic):
    r1 = await asyncio.gather(*[consult(g, w, b, context, topic, 1) for w, b in PERSONAS])
    prior = "\n".join(f"{w.split(',')[0]}: {t}" for (w, _), t in zip(PERSONAS, r1))[:3500]
    r2 = await asyncio.gather(*[consult(g, w, b, context, topic, 2, prior) for w, b in PERSONAS])
    transcript = [{"agent": w.split(",")[0], "r": 1, "t": t} for (w, _), t in zip(PERSONAS, r1)]
    transcript += [{"agent": w.split(",")[0], "r": 2, "t": t} for (w, _), t in zip(PERSONAS, r2)]
    return transcript


async def synth(g, board_ctx, transcript, goal, topic):
    tj = json.dumps([{"agent": x["agent"], "said": x["t"][:300]} for x in transcript])
    sysp = ("You are the facilitator. Write the final, publish-ready recommendation. Lead with the decision, "
            "support with the gathered facts, cite real figures/sources, flag UNVERIFIED, end with one concrete "
            "next step + owner. Ground EVERY specific in the context; never invent.")
    usr = f"GOAL: {goal}\nQUESTION: {topic}\n\nGATHERED CONTEXT:\n{board_ctx}\n\nDEBATE:\n{tj}\n\nWrite it now."
    return await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                        model=SYNTH_MODEL, temperature=0.4)


async def judge(g, deliverable, full_board, goal, topic):
    sysp = ("You are a strict reviewer. Score the recommendation 0.0-1.0 on each dim, judged against the FULL "
            "gathered facts as ground truth: grounded (every specific traces to a fact; no fabrication/wrong "
            "numbers), completeness (covers the key trade-offs: runway, CAC/payback, investor ask, v2 risk), "
            "on_goal (answers the question + serves the goal), specific (cites the real figures + a concrete "
            'next step). Return ONLY json: {"grounded":0..1,"completeness":0..1,"on_goal":0..1,"specific":0..1}')
    usr = f"GOAL: {goal}\nQUESTION: {topic}\n\nFULL GATHERED FACTS:\n{chr(10).join(full_board)}\n\nRECOMMENDATION:\n{deliverable}"
    out = await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                       model=JUDGE_MODEL, temperature=0.0, json_object=True, count=False)  # judge cost excluded
    try:
        j = json.loads(re.search(r"\{.*\}", out, re.S).group(0))
    except Exception:  # noqa: BLE001
        return {"total": 0.0, "dims": {}}
    dims = {k: float(j.get(k, 0) or 0) for k in ("grounded", "completeness", "on_goal", "specific")}
    return {"total": round(sum(dims.values()) / len(dims), 3), "dims": dims}


def approx_tokens(s):
    return int(len(s) / 4)


async def run_arm(g, name, debate_ctx, synth_ctx, full_board, fixed_input=0):
    g.reset()
    transcript = await debate(g, debate_ctx, TOPIC)
    deliverable = await synth(g, synth_ctx, transcript, GOAL, TOPIC)
    q = await judge(g, deliverable, full_board, GOAL, TOPIC)
    inp = g.prompt + fixed_input
    print(f"  {name:<26} input={inp:>6}  quality={q['total']:.3f}  dims={q['dims']}")
    return {"name": name, "input": inp, "quality": q["total"], "dims": q["dims"]}


async def main():
    g = Groq(_load_key())
    board = list(BOARD)
    # BIG=1 simulates a fat gather (many recalls/connector dumps) — where the compounding actually hurts.
    if os.environ.get("BIG"):
        extra = [f"- KB[detail-{i}]: Supporting datapoint {i}: segment cohort {i} shows churn {3+i%5}% and "
                 f"expansion {2+i%4}% over the period; sample small, UNVERIFIED (source: mem:cohort-{i})."
                 for i in range(1, 22)]
        board = BOARD[:12] + extra + BOARD[12:]  # keep key facts up top, inflate with realistic detail
    raw = "\n".join(board)
    globals()["BOARD"] = board
    print(f"board: {len(BOARD)} items ≈ {approx_tokens(raw)} tokens | personas={len(PERSONAS)} | rounds=2\n")

    # build the digest once + measure its cost + fact preservation
    g.reset()
    dg = await digest_board(g, BOARD, GOAL, TOPIC)
    digest_cost = g.prompt + g.completion
    survived = [k for k in KEY_FACTS if k.lower() in dg.lower()]
    print(f"DIGEST: {approx_tokens(dg)} tokens (from {approx_tokens(raw)}) | one call cost {digest_cost} tok")
    print(f"  key-fact preservation: {len(survived)}/{len(KEY_FACTS)} survived"
          f"{'' if len(survived)==len(KEY_FACTS) else ' MISSING: ' + ','.join(k for k in KEY_FACTS if k not in survived)}")
    print(f"  digest preview: {dg[:220].replace(chr(10),' | ')}\n")
    if not dg.strip():
        sys.exit("digest empty — model returned no content; pick a content-returning model")

    results = []
    # A: raw everywhere (baseline). B: digest→debate, raw→synth. C: digest everywhere.
    results.append(await run_arm(g, "A current (raw/raw)", raw, raw, BOARD))
    results.append(await run_arm(g, "B proposed (digest/raw)", dg, raw, BOARD, fixed_input=approx_tokens(raw)))
    results.append(await run_arm(g, "C aggressive (digest/digest)", dg, dg, BOARD, fixed_input=approx_tokens(raw)))

    a, b, c = results
    print(f"\n{'='*64}\nCOMPARISON\n{'='*64}")
    print(f"  input savings B vs A: {a['input']-b['input']:+d} tok  ({(1-b['input']/a['input'])*100:.0f}% less)")
    print(f"  quality delta  B vs A: {b['quality']-a['quality']:+.3f}  (B={b['quality']:.3f} A={a['quality']:.3f})")
    print(f"  quality delta  C vs A: {c['quality']-a['quality']:+.3f}  (C compresses synth too)")
    qa_ok = (a['quality'] - b['quality']) <= 0.05      # B holds quality (within noise)
    save_ok = b['input'] < a['input']                  # B is cheaper
    c_worse = (a['quality'] - c['quality']) > 0.05      # compressing synth hurts → keep synth raw
    print()
    if qa_ok and save_ok:
        print("  VERDICT: ✅ B WINS — digest-for-debate cuts input with no quality loss." +
              ("  C confirms: compressing synth too DOES hurt → synth must keep raw." if c_worse else
               "  (C also held — synth-compression may be safe here, but raw is the safe default.)"))
    elif save_ok and not qa_ok:
        print("  VERDICT: 🟡 cheaper but B lost quality — digest too lossy; tighten the extract rules.")
    else:
        print("  VERDICT: ❌ no win — board too small or digest not helping here.")


if __name__ == "__main__":
    asyncio.run(main())
