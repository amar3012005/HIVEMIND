#!/usr/bin/env python3
"""Loop 2 (eval-gated prompt-version promotion) — PROVE-THE-GATE harness.

Loop 1 accrues a per-employee PLAYBOOK (soft, injected each turn). Loop 2 periodically
DISTILS that playbook into the employee's PERSONA itself (a new prompt-version) — but only
PROMOTES the new version if it beats the live one on a held-out eval. This tests two claims:

  1. POSITIVE: baking a real learned playbook into the persona produces a candidate that
     BEATS the baseline persona on UNSEEN tasks → the gate PROMOTES it (durable compounding).
  2. NEGATIVE (the important one): an empty/irrelevant playbook produces a candidate that does
     NOT beat baseline → the gate REJECTS it. A gate that rubber-stamps is worthless; this
     proves it only promotes real improvement (no drift / reward-hacking).

Gate = the SAME one already live in core/scripts/prompt-tune.mjs:
     promote iff (candidate_avg - baseline_avg) > 0.03 AND candidate_avg > 0.65

Reuses the proven Loop 1 spike's domain (persona, held-out EVAL_TASKS, judge).
Run:  PYTHONPATH=. python3 loop2_promote_spike.py
"""
import asyncio
import json
import sys

import self_evolve_spike as L1  # reuse Groq, judge (review), EVAL_TASKS, PERSONA, ORG_CONTEXT, _load_key

PROMOTE_DELTA = 0.03   # identical to prompt-tune.mjs
PROMOTE_FLOOR = 0.65

# A representative ACCRUED playbook (the kind Loop 1 actually produces — see the live run:
# next-step+owner+deadline, runway-tie, flag assumptions, surface risk). This is the Loop 2 input.
LEARNED_PLAYBOOK = [
    "Specify one concrete next step with an owner and a deadline for every recommendation.",
    "Tie every decision to the stated cash/runway reality; quantify the runway impact.",
    "Label any figure you introduce as an assumption or UNVERIFIED unless it was given.",
    "Surface the single biggest risk or unknown before recommending a course of action.",
    "Be specific and falsifiable; cut generic filler.",
]
EMPTY_PLAYBOOK = []                      # negative control: nothing learned
NOISE_PLAYBOOK = [                       # negative control: irrelevant lessons (must NOT promote)
    "Use a friendly, upbeat tone in every message.",
    "Prefer bullet points over paragraphs when possible.",
]


async def propose_candidate(g, baseline_persona, playbook):
    """Teacher rewrite: fold the accrued playbook INTO the persona (a new prompt-version).
    Mirrors prompt-tune.mjs proposeImprovedPrompt, but conditioned on the playbook."""
    if not playbook:
        return baseline_persona  # nothing to distil → candidate == baseline (gate will reject)
    sysp = (
        "You improve an employee's system prompt by baking in operating lessons it has learned. "
        "Rewrite the prompt so it PERMANENTLY embodies every lesson, while keeping its role and "
        "staying concise. Return ONLY the rewritten system prompt, no preamble.")
    usr = (f"CURRENT SYSTEM PROMPT:\n{baseline_persona}\n\nLEARNED LESSONS TO BAKE IN:\n" +
           "\n".join(f"- {l}" for l in playbook))
    out = await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                       model=L1.JUDGE_MODEL, temperature=0.4)
    return out.strip() or baseline_persona


async def answer_with_persona(g, persona, task):
    msgs = [{"role": "system", "content": persona + f"\n\nCONTEXT (the only facts you may treat as given):\n{L1.ORG_CONTEXT}"},
            {"role": "user", "content": task}]
    return await g.chat(msgs, model=L1.AGENT_MODEL, temperature=0.7)


async def eval_persona(g, persona, tasks):
    scores = []
    for task in tasks:
        ans = await answer_with_persona(g, persona, task)
        rev = await L1.review(g, task, ans)
        scores.append(rev["total"])
    return round(sum(scores) / len(scores), 4) if scores else 0.0


def gate(base_avg, cand_avg):
    delta = round(cand_avg - base_avg, 4)
    promoted = delta > PROMOTE_DELTA and cand_avg > PROMOTE_FLOOR
    return delta, promoted


async def run_arm(g, name, baseline_persona, playbook, base_avg, tasks):
    cand = await propose_candidate(g, baseline_persona, playbook)
    cand_avg = await eval_persona(g, cand, tasks)
    delta, promoted = gate(base_avg, cand_avg)
    print(f"  {name:<22} candidate_avg={cand_avg:.3f}  delta={delta:+.3f}  "
          f"→ {'✅ PROMOTE' if promoted else '⛔ REJECT'}")
    return {"name": name, "cand_avg": cand_avg, "delta": delta, "promoted": promoted,
            "persona_chars": len(cand)}


async def main():
    L1._SEM = asyncio.Semaphore(5)
    g = L1.Groq(L1._load_key())
    tasks = L1.EVAL_TASKS  # held-out, never used to derive the playbook
    print(f"Loop 2 promote-gate spike | employee={L1.AGENT_MODEL} | judge={L1.JUDGE_MODEL} | "
          f"gate: delta>{PROMOTE_DELTA} & cand>{PROMOTE_FLOOR} | {len(tasks)} held-out tasks\n")
    base_avg = await eval_persona(g, L1.PERSONA, tasks)
    print(f"  baseline persona avg = {base_avg:.3f}\n")

    arms = [
        ("learned-playbook", LEARNED_PLAYBOOK),   # POSITIVE: should promote
        ("empty-playbook", EMPTY_PLAYBOOK),       # NEGATIVE: must reject (no change)
        ("noise-playbook", NOISE_PLAYBOOK),       # NEGATIVE: must reject (irrelevant)
    ]
    results = []
    for name, pb in arms:
        results.append(await run_arm(g, name, L1.PERSONA, pb, base_avg, tasks))

    print()
    learned = next(r for r in results if r["name"] == "learned-playbook")
    empty = next(r for r in results if r["name"] == "empty-playbook")
    noise = next(r for r in results if r["name"] == "noise-playbook")
    ok_pos = learned["promoted"]
    ok_neg = (not empty["promoted"]) and (not noise["promoted"])
    if ok_pos and ok_neg:
        print("  VERDICT: ✅ GATE PROVEN — real playbook promotes; empty/noise rejected (no drift).")
    elif ok_pos and not ok_neg:
        print("  VERDICT: 🟡 PROMOTES but gate too loose — a non-improving playbook also passed (drift risk).")
    elif not ok_pos:
        print("  VERDICT: ❌ real playbook did NOT clear the gate — distillation or gate too strict.")
    print(f"\n  elapsed-marker done")
    print(L1.METER.report())


if __name__ == "__main__":
    asyncio.run(main())
