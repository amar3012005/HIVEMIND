#!/usr/bin/env python3
"""HyperAgents QUALITY LOOP — enterprise-lens regression eval (run on the box, in hm-employees).

Runs realistic enterprise questions through a real room and judges each answer for whether it is
GROUNDED + USEFUL for THAT business vs a generic LLM response. Averages N samples per question (the
judging is noisy at n=1 — averaging is what makes the signal trustworthy). Writes a dated JSON report
so quality is tracked over time (a regression gate, not a one-off).

This is the standing quality-testing loop: test → score grounded-vs-generic → surface weak spots →
feed back into prompts/gather → re-run.

Run:  docker exec -i hm-employees python3 - < quality_eval.py        # or via the weekly cron
Env:  QE_SAMPLES (default 2), QE_PROFILE_JSON (override room+profile+questions)
"""
import asyncio, json, os, re, time
from hivemind_employees.hyper import engine as E
from hivemind_employees.hyper.engine import run_director

SAMPLES = max(1, int(os.environ.get("QE_SAMPLES", "2")))
MODELS = dict(director_model="openai/gpt-oss-20b", persona_model="openai/gpt-oss-20b", synth_model="openai/gpt-oss-120b")

# Default profile = Solvis. Override with QE_PROFILE_JSON to point at any room (institutionalize per tenant).
DEFAULT = {
    "room": dict(user_id="3b12845a-8cef-4174-ad89-16010810e90b", org_id="f5e2418b-61ef-4271-83a4-5623050b8402",
                 project_id="0d8279b3-f7b0-46c6-9415-cebb52f7cc7c", room_template="decision",
                 room_goal="Solvis strategy + growth", enabled_connectors=[],
                 participants=[{"slug": "maya", "name": "Maya", "_lane": "Strategy"},
                               {"slug": "victor", "name": "Victor", "_lane": "Skeptic"},
                               {"slug": "lina", "name": "Lina", "_lane": "Growth"},
                               {"slug": "eli", "name": "Eli", "_lane": "Product"}]),
    "profile": ("Solvis — Braunschweig, Germany. 30+ yr maker of efficient sustainable HEATING SYSTEMS "
                "(Wärmesysteme); thermal storage + energetic independence. Pivoting device-maker → PLATFORM "
                "('Solvis Ökosystem' = products+services+energy). Sells via regional Handwerk (craftsmen) "
                "partners; Made-in-Germany + on-site service. Brand: 'warmth that connects people'; Dachmarke + "
                "subbrand strategy. Market: German Wärmewende / renewable heat."),
    "questions": [
        ["strategy", "Should we accelerate the Ökosystem platform pivot next year, or focus capital on the core Wärmesystem product line? Decide with a rationale."],
        ["gtm", "How do we grow our Handwerk installer partner network across Germany — and what is the single highest-leverage move to start with?"],
        ["brand", "How should we communicate the Dachmarke + subbrand strategy to our Handwerk partners without confusing them?"],
        ["regulatory", "Given Germany's heating-law (GEG) and heat-pump subsidy shifts, how should we position our systems to homeowners this year?"],
        ["recall", "Remind me — what is our brand promise and our platform vision?"],
    ],
}
CFG = json.loads(os.environ["QE_PROFILE_JSON"]) if os.environ.get("QE_PROFILE_JSON") else DEFAULT
DIMS = ["grounded_solvis", "specific", "on_intent", "useful_for_exec"]


async def judge(profile, q, a):
    sysp = ("You are an executive of the described company reviewing an AI team's answer. Score 0-1: "
            "grounded_solvis (uses the company's REAL specifics — its products, brand, partners, market — NOT "
            "generic), specific (concrete + actionable), on_intent (answers what was asked), useful_for_exec "
            "(would you act on it). is_generic=true if it reads like generic LLM advice that could apply to ANY "
            "company. Be harsh — generic-but-fluent scores LOW. why=10 words.")
    usr = f"COMPANY:\n{profile}\n\nQUESTION:\n{q}\n\nANSWER:\n{a[:2400]}"
    schema = {"type": "object", "properties": {**{d: {"type": "number"} for d in DIMS},
              "is_generic": {"type": "boolean"}, "why": {"type": "string"}},
              "required": DIMS + ["is_generic", "why"], "additionalProperties": False}
    for _ in range(3):
        out = await E._evo_groq([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                                model="openai/gpt-oss-120b", schema=schema)
        if out:
            try:
                return json.loads(out)
            except Exception:
                m = re.search(r"\{.*\}", out, re.S)
                if m:
                    try: return json.loads(m.group(0))
                    except Exception: pass
        await asyncio.sleep(1)
    return None


async def ask(q):
    r = await run_director(user_message=q, emit=(lambda e: asyncio.sleep(0)), **CFG["room"], **MODELS)
    return r.get("final_text", "")


async def eval_q(kind, q):
    """Average SAMPLES judged runs for one question — robust to per-call noise."""
    accum = {d: [] for d in DIMS}; generic = 0; ok = 0
    for _ in range(SAMPLES):
        a = await ask(q)
        j = await judge(CFG["profile"], q, a)
        if not j:
            continue
        ok += 1
        for d in DIMS: accum[d].append(float(j.get(d, 0) or 0))
        generic += 1 if j.get("is_generic") else 0
    if not ok:
        return {"kind": kind, "judged": 0}
    means = {d: round(sum(v)/len(v), 3) for d, v in accum.items()}
    return {"kind": kind, "judged": ok, **means, "avg": round(sum(means.values())/len(means), 3),
            "generic_rate": round(generic/ok, 2)}


async def main():
    print(f"QUALITY LOOP · samples/q={SAMPLES} · digest_gate={E._DIGEST_MIN_CHARS}")
    rows = []
    for kind, q in CFG["questions"]:
        r = await eval_q(kind, q)
        rows.append(r)
        if r["judged"]:
            print(f"  [{kind:<11}] avg={r['avg']:.2f} grounded={r['grounded_solvis']:.2f} "
                  f"useful={r['useful_for_exec']:.2f} generic_rate={r['generic_rate']:.0%}")
        else:
            print(f"  [{kind:<11}] JUDGE-FAILED (excluded)")
    judged = [r for r in rows if r.get("judged")]
    mean_q = round(sum(r["avg"] for r in judged)/len(judged), 3) if judged else 0
    mean_g = round(sum(r["grounded_solvis"] for r in judged)/len(judged), 3) if judged else 0
    weak = [r["kind"] for r in judged if r["avg"] < 0.7]
    generic = [r["kind"] for r in judged if r["generic_rate"] >= 0.5]
    report = {"ts": int(os.environ.get("QE_TS", "0")), "samples": SAMPLES, "mean_quality": mean_q,
              "mean_grounded": mean_g, "weak": weak, "generic": generic, "rows": rows}
    print(f"\nSUMMARY mean_quality={mean_q} mean_grounded={mean_g} weak={weak or 'none'} generic={generic or 'none'}")
    try:
        path = "/tmp/quality_report.json"
        open(path, "w").write(json.dumps(report, indent=2))
        print(f"report -> {path}")
    except Exception:
        pass
    # regression signal for the loop/cron: nonzero exit if quality dropped below the floor
    floor = float(os.environ.get("QE_FLOOR", "0.7"))
    if judged and mean_q < floor:
        print(f"REGRESSION: mean_quality {mean_q} < floor {floor}")


asyncio.run(main())
