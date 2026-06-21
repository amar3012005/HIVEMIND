#!/usr/bin/env python3
"""Self-evolving HyperAgents-employee spike — PROVE-THE-THEORY harness.

NOT social-sim. This tests ONE claim, in isolation, before any production wiring:

    A HyperAgents digital employee that, after each turn, REFLECTS on the
    outcome (a reviewer's verdict) into an outcome-tagged PLAYBOOK memory, and
    RECALLS that playbook before its next turn, makes measurably BETTER
    decisions over time — and the improvement GENERALISES to unseen tasks.

Three arms, same weak employee model, same fixed reviewer:

  control   — no playbook, fresh every round            (floor: does it just drift?)
  evolving  — recall playbook → answer → reviewer → reflect → playbook grows
              (the feature under test — Loop 1: episodic playbook memory + recall)
  told      — house-rules handed to it upfront           (ceiling: best case)

If  control < evolving  AND  evolving → told  AND held-out (never-reflected-on)
task also rises, the loop genuinely LEARNS the org's decision discipline from
outcomes and APPLIES it to future decisions — not memorisation, not luck.

The reviewer (strong model, temp 0, fixed rubric) is the OUTCOME SIGNAL — the
spike analog of the production signal (verifier verdict + HITL approve/reject +
user accept/rerun). The employee never grades itself.

Playbook store is a LOCAL json (isolated) — deliberately NOT real HIVEMIND
recall, so testing the theory neither costs nor pollutes a real org's brain.
Production port swaps this local store for scoped `recall(employee:<id>)`.

Run:
    python self_evolve_spike.py --rounds 8 --trials 1
    python self_evolve_spike.py --rounds 8 --trials 3 --arms control,evolving,told
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

# ── config (mirror social_sim so a port to engine.py is mechanical) ─────────
AGENT_MODEL = os.environ.get("EVO_AGENT_MODEL", "llama-3.1-8b-instant")    # weak employee UNDER TEST (room to improve)
JUDGE_MODEL = os.environ.get("EVO_JUDGE_MODEL", "openai/gpt-oss-120b")     # reviewer — outcome signal, NOT under test
REFLECT_MODEL = os.environ.get("EVO_REFLECT_MODEL", "openai/gpt-oss-120b") # distills lessons (prod: the slow-loop strong model)
FALLBACK_CHAIN = [m.strip() for m in os.environ.get(
    "EVO_FALLBACK_CHAIN", "openai/gpt-oss-20b,llama-3.3-70b-versatile").split(",") if m.strip()]
BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
HTTP_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
PLAYBOOK_CAP = 12   # bounded — prod equivalent: scoped recall top-k + dedup/supersede

_SEM: Optional[asyncio.Semaphore] = None
_RATE_429 = 0


def _load_key() -> str:
    key = os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or ""
    if key:
        return key
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents][:8]:
        envf = parent / ".env"
        if not envf.exists():
            continue
        for line in envf.read_text(errors="ignore").splitlines():
            line = line.strip()
            for var in ("GROQ_API_KEY", "LLM_API_KEY"):
                if line.startswith(var + "=") and "your_" not in line:
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    sys.exit("No GROQ_API_KEY / LLM_API_KEY in env or any parent .env")


class Meter:
    def __init__(self) -> None:
        self.by: Dict[str, Dict[str, int]] = {}
        self.calls = 0

    def add(self, model: str, usage: Dict[str, Any]) -> None:
        self.calls += 1
        b = self.by.setdefault(model, {"prompt": 0, "completion": 0})
        b["prompt"] += int(usage.get("prompt_tokens", 0) or 0)
        b["completion"] += int(usage.get("completion_tokens", 0) or 0)

    def report(self) -> str:
        out = [f"  calls={self.calls}  429s={_RATE_429}"]
        tot = 0
        for m, b in sorted(self.by.items()):
            t = b["prompt"] + b["completion"]
            tot += t
            out.append(f"    {m:<28} prompt={b['prompt']:>7} compl={b['completion']:>7} tot={t:>7}")
        out.append(f"    {'TOTAL':<28} {'':>7} {'':>7} tot={tot:>7}")
        return "\n".join(out)


METER = Meter()


class Groq:
    def __init__(self, key: str) -> None:
        self._key = key
        self.served_by = ""

    async def chat(self, messages: List[Dict[str, Any]], *, model: str,
                   temperature: float = 0.6, json_object: bool = False,
                   max_attempts: int = 4) -> str:
        """Returns assistant text. Model-fallback chain on 429 so a throttle
        escalates to a different family (separate bucket) instead of dropping work."""
        global _RATE_429
        chain = [model] + [f for f in FALLBACK_CHAIN if f != model]
        last = ""
        for m in chain:
            body: Dict[str, Any] = {"model": m, "messages": messages, "temperature": temperature}
            if json_object:
                body["response_format"] = {"type": "json_object"}
            for attempt in range(max_attempts):
                try:
                    if _SEM is not None:
                        await _SEM.acquire()
                    try:
                        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                            r = await c.post(f"{BASE_URL}/chat/completions",
                                             headers={"Authorization": f"Bearer {self._key}"}, json=body)
                    finally:
                        if _SEM is not None:
                            _SEM.release()
                    if r.status_code == 200:
                        j = r.json()
                        METER.add(m, j.get("usage", {}))
                        self.served_by = m
                        return (j["choices"][0]["message"].get("content") or "").strip()
                    if r.status_code == 429:
                        _RATE_429 += 1
                        await asyncio.sleep(min(2 ** attempt, 8))
                        if attempt >= 1:
                            break  # escalate to next model in chain
                        continue
                    if r.status_code >= 500:
                        await asyncio.sleep(min(2 ** attempt, 8))
                        continue
                    last = f"HTTP {r.status_code}: {r.text[:200]}"
                    break
                except Exception as exc:  # noqa: BLE001
                    last = str(exc)[:200]
                    await asyncio.sleep(min(2 ** attempt, 8))
        raise RuntimeError(f"groq chat failed after fallbacks: {last}")


def _parse_json(text: str) -> Any:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\n?", "", text).rstrip("`").strip()
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:  # noqa: BLE001
                pass
    return None


# ── lexical recall (mimics scoped HIVEMIND recall: employee:<id> + playbook) ─
_WORD = re.compile(r"[a-z0-9]{4,}")


def _keywords(s: str) -> set:
    return set(_WORD.findall(s.lower()))


def recall_playbook(playbook: List[str], task: str, k: int = 6) -> List[str]:
    """Top-k playbook lessons by lexical overlap with the task + always the most
    recent few (recency floor). Prod equivalent: vector recall scoped to the
    employee, tag=playbook. Returns the lessons to inject before the employee reasons."""
    if not playbook:
        return []
    tk = _keywords(task)
    scored = [(len(tk & _keywords(les)), -i, les) for i, les in enumerate(playbook)]
    scored.sort(reverse=True)
    picked = [les for _, _, les in scored[:k]]
    # recency floor: ensure the 2 newest are present (latest lessons matter even if off-topic lexically)
    for les in playbook[-2:]:
        if les not in picked:
            picked.append(les)
    return picked[:k + 2]


# ════════════════════════════════════════════════════════════════════════════
#  THE DOMAIN — a pre-seed startup "Head of Finance" employee.
#
#  HOUSE_RULES = the org's decision discipline. The reviewer enforces them.
#  The employee persona deliberately does NOT contain them → the evolving arm
#  must LEARN them from reviewer feedback and apply to NEW (incl held-out) tasks.
#  Tasks are VARIED so a learned rule must generalise, not memorise an answer.
# ════════════════════════════════════════════════════════════════════════════

ORG_CONTEXT = (
    "SINGULANCE — pre-seed B2B SaaS. ~€1.9M cash, ~€140k/mo burn (≈13 mo runway). "
    "No paying customers yet (3 design-partner pilots, unpaid). Team of 9. "
    "Raising a seed in ~6 months. Founder is non-financial."
)

PERSONA = (
    "You are the Head of Finance for an early-stage startup. You answer the founder's "
    "questions directly and decisively. Keep answers under 180 words."
)

# The reviewer's fixed rubric — the org's decision discipline (the learnable signal).
HOUSE_RULES = [
    "GROUNDED: never state a figure as fact unless it was given in the context; any number you "
    "introduce yourself must be explicitly flagged (e.g. 'assumption' / 'UNVERIFIED').",
    "RUNWAY-TIED: every recommendation must connect to the stated cash/runway/stage reality, not generic advice.",
    "DECISIVE-NEXT-STEP: end with exactly ONE concrete next action, naming an owner and a timeframe.",
    "RISK-SURFACED: explicitly name the single biggest risk or unknown in your recommendation.",
    "NO-FLUFF: be specific and falsifiable; no vague filler ('leverage synergies', 'explore options').",
]

# Training tasks (rotate). Tough, varied finance/CEO decisions.
TRAIN_TASKS = [
    "Should we hire two senior engineers now to hit our seed-demo milestone faster?",
    "A design partner offers €60k upfront for a 2-year exclusive in their vertical. Take it?",
    "Our AWS bill is climbing. Should I spend eng time optimising it this quarter?",
    "An investor wants to do a €500k bridge now at a flat valuation. Should we take it before the seed?",
    "Marketing wants €30k for a conference booth that 'everyone in our space attends'. Approve?",
    "Should we switch the team from contractors to full-time to look more credible to seed investors?",
    "A bigger competitor offered to acqui-hire us for an undisclosed amount. How should I think about it?",
    "Finance asks: should we extend runway by cutting two roles, or push harder to raise now?",
]

# Held-out EVAL SET — NEVER reflected on, DISJOINT from TRAIN. The clean, paired test:
# all arms answer the SAME unseen tasks → removes the task-difficulty confound that
# pollutes round-to-round training scores. Generalisation, not memorisation.
EVAL_TASKS = [
    "A vendor offers a 20% discount if we prepay 12 months of our data-infra contract today. Prepay to save money?",
    "Should we open a US entity now to make it easier to land American customers next year?",
    "Our top engineer asks for a 25% raise or they'll leave. Should I match it?",
    "A PR agency wants €8k/mo on a 6-month retainer to get us press before the raise. Worth it?",
    "Should we buy annual SaaS licences now (30% cheaper) instead of paying monthly?",
    "An angel offers €250k but wants a board seat and monthly reporting. Take the money?",
    "We have €40k unspent in this quarter's budget. Should we pull forward next quarter's hires?",
    "A customer will sign a €120k annual contract only if we build one custom feature first. Commit?",
]


# ── employee turn ───────────────────────────────────────────────────────────
async def employee_answer(g: Groq, task: str, *, lessons: List[str], told: bool) -> str:
    sys_parts = [PERSONA, f"\nCONTEXT (the only facts you may treat as given):\n{ORG_CONTEXT}"]
    if told:
        sys_parts.append("\nYou operate under these mandatory rules:\n" +
                         "\n".join(f"- {r}" for r in HOUSE_RULES))
    if lessons:
        sys_parts.append(
            "\nOPERATING PLAYBOOK — lessons you learned from past performance reviews. "
            "Apply every one of them:\n" + "\n".join(f"- {l}" for l in lessons))
    messages = [{"role": "system", "content": "".join(sys_parts)},
                {"role": "user", "content": task}]
    return await g.chat(messages, model=AGENT_MODEL, temperature=0.7)


# ── reviewer = outcome signal (fixed rubric, temp 0, independent) ────────────
async def review(g: Groq, task: str, answer: str) -> Dict[str, Any]:
    rubric = "\n".join(f"{i+1}. {r}" for i, r in enumerate(HOUSE_RULES))
    sys = (
        "You are a strict, consistent finance-decision reviewer. Score the answer 0.0-1.0 on EACH "
        "rule independently (1.0 = fully satisfied, 0.0 = violated/absent). Be harsh and literal. "
        f"\n\nORG CONTEXT (the only given facts):\n{ORG_CONTEXT}\n\nRULES:\n{rubric}\n\n"
        'Return ONLY json: {"grounded":0..1,"runway_tied":0..1,"decisive_next_step":0..1,'
        '"risk_surfaced":0..1,"no_fluff":0..1,"critique":"<2 sentences: the single most important '
        'thing to fix>"}')
    out = await g.chat(
        [{"role": "system", "content": sys},
         {"role": "user", "content": f"TASK:\n{task}\n\nANSWER:\n{answer}"}],
        model=JUDGE_MODEL, temperature=0.0, json_object=True)
    j = _parse_json(out) or {}
    dims = ["grounded", "runway_tied", "decisive_next_step", "risk_surfaced", "no_fluff"]
    scores = {d: float(j.get(d, 0.0) or 0.0) for d in dims}
    total = round(sum(scores.values()) / len(dims), 4)
    return {"scores": scores, "total": total, "critique": str(j.get("critique", ""))[:400]}


# ── reflection = Loop 1 write (distill outcome → general reusable lesson) ────
async def reflect(g: Groq, task: str, answer: str, rev: Dict[str, Any]) -> List[str]:
    weak = [d for d, s in rev["scores"].items() if s < 0.7]
    if not weak:
        return []  # nothing to learn — don't write noise
    sys = (
        "You are coaching a finance employee to do better NEXT time, on DIFFERENT questions. "
        "From this one performance review, write 1-2 SHORT, GENERAL, reusable operating rules "
        "(imperative, <=20 words each) that would raise the score on future, unrelated decisions. "
        "Rules must be transferable principles, NOT specific to this question's facts. "
        'Return ONLY json: {"lessons":["...","..."]}')
    usr = (f"TASK:\n{task}\n\nMY ANSWER:\n{answer}\n\nREVIEWER per-rule scores: "
           f"{json.dumps(rev['scores'])}\nReviewer critique: {rev['critique']}\n"
           f"Weakest areas: {', '.join(weak)}")
    out = await g.chat([{"role": "system", "content": sys}, {"role": "user", "content": usr}],
                       model=REFLECT_MODEL, temperature=0.3, json_object=True)
    j = _parse_json(out) or {}
    lessons = [str(x).strip() for x in (j.get("lessons") or []) if str(x).strip()]
    return lessons[:2]


def dedupe_into(playbook: List[str], new_lessons: List[str]) -> int:
    """Append only lessons not near-duplicate of an existing one (Jaccard on keywords).
    Bounded by PLAYBOOK_CAP (drop oldest). Returns count added. Prod analog: supersede."""
    added = 0
    for les in new_lessons:
        lk = _keywords(les)
        dup = any(len(lk & _keywords(ex)) / max(1, len(lk | _keywords(ex))) > 0.6 for ex in playbook)
        if dup:
            continue
        playbook.append(les)
        added += 1
    while len(playbook) > PLAYBOOK_CAP:
        playbook.pop(0)
    return added


# ── experiment ───────────────────────────────────────────────────────────────
@dataclass
class ArmState:
    name: str
    playbook: List[str] = field(default_factory=list)
    round_totals: List[float] = field(default_factory=list)
    round_dims: List[Dict[str, float]] = field(default_factory=list)


async def train_phase(g: Groq, evolving: ArmState, rounds: int, trial_idx: int) -> None:
    """Build the evolving employee's playbook over TRAIN tasks (reflect after each).
    Per-round scores are shown for the trace, but are NOT the verdict — rotating tasks
    confound difficulty with learning. The clean test is the held-out eval phase."""
    order = [TRAIN_TASKS[(trial_idx + i) % len(TRAIN_TASKS)] for i in range(rounds)]
    print(f"  train ({rounds} tasks): ", end="", flush=True)
    for task in order:
        lessons = recall_playbook(evolving.playbook, task)
        ans = await employee_answer(g, task, lessons=lessons, told=False)
        rev = await review(g, task, ans)
        evolving.round_totals.append(rev["total"])
        new = await reflect(g, task, ans, rev)
        added = dedupe_into(evolving.playbook, new)
        print(f"{rev['total']:.2f}{'·'+str(added) if added else ''} ", end="", flush=True)
    print(f"→ playbook={len(evolving.playbook)}")


async def eval_phase(g: Groq, arms: Dict[str, ArmState]) -> Dict[str, List[Dict[str, Any]]]:
    """All arms answer the SAME held-out EVAL_TASKS (never reflected on). Paired,
    apples-to-apples. This is the verdict signal."""
    results: Dict[str, List[Dict[str, Any]]] = {a: [] for a in arms}
    for task in EVAL_TASKS:
        for name, arm in arms.items():
            lessons = recall_playbook(arm.playbook, task) if name == "evolving" else []
            ans = await employee_answer(g, task, lessons=lessons, told=(name == "told"))
            rev = await review(g, task, ans)
            results[name].append({"total": rev["total"], "scores": rev["scores"]})
    return results


async def run_trial(g: Groq, rounds: int, arms_wanted: List[str], trial_idx: int) -> Dict[str, Any]:
    arms: Dict[str, ArmState] = {a: ArmState(a) for a in arms_wanted}
    print(f"\n{'─'*78}\nTRIAL {trial_idx+1}\n{'─'*78}")
    if "evolving" in arms:
        await train_phase(g, arms["evolving"], rounds, trial_idx)
    ev = await eval_phase(g, arms)
    # print eval-task breakdown
    print(f"  eval ({len(EVAL_TASKS)} held-out tasks):")
    for ti, task in enumerate(EVAL_TASKS):
        cells = "  ".join(f"{n[:4]}={ev[n][ti]['total']:.2f}" for n in arms_wanted)
        print(f"    E{ti+1} {task[:48]:<48} | {cells}")
    return {"arms": arms, "eval": ev}


def _avg(xs: List[float]) -> float:
    return round(sum(xs) / len(xs), 4) if xs else 0.0


def summarize(trials: List[Dict[str, Any]], arms_wanted: List[str], rounds: int) -> Dict[str, Any]:
    eval_mean: Dict[str, List[float]] = {a: [] for a in arms_wanted}          # per-trial eval mean
    eval_dims: Dict[str, Dict[str, List[float]]] = {a: {} for a in arms_wanted}
    train_first: Dict[str, List[float]] = {a: [] for a in arms_wanted}
    train_last: Dict[str, List[float]] = {a: [] for a in arms_wanted}
    last_playbook: List[str] = []
    for t in trials:
        for a in arms_wanted:
            totals = [r["total"] for r in t["eval"][a]]
            eval_mean[a].append(_avg(totals))
            # per-dimension eval means
            for r in t["eval"][a]:
                for d, v in r["scores"].items():
                    eval_dims[a].setdefault(d, []).append(v)
            arm = t["arms"][a]
            if arm.round_totals:
                train_first[a].append(_avg(arm.round_totals[:3]))
                train_last[a].append(_avg(arm.round_totals[-3:]))
            if a == "evolving":
                last_playbook = arm.playbook
    return {
        "eval": {a: _avg(eval_mean[a]) for a in arms_wanted},
        "eval_dims": {a: {d: _avg(vs) for d, vs in eval_dims[a].items()} for a in arms_wanted},
        "train_first3": {a: _avg(train_first[a]) for a in arms_wanted if train_first[a]},
        "train_last3": {a: _avg(train_last[a]) for a in arms_wanted if train_last[a]},
        "playbook": last_playbook,
    }


def verdict(s: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    ev = s["eval"].get("evolving", 0)
    ctrl = s["eval"].get("control", 0)
    told = s["eval"].get("told", 0)
    if "evolving" in s["train_first3"]:
        tf, tl = s["train_first3"]["evolving"], s["train_last3"]["evolving"]
        out.append(f"train trend (first3 → last3): {tf:.3f} → {tl:.3f}  (Δ {tl-tf:+.3f})  [noisy: rotating tasks]")
    out.append(f"HELD-OUT EVAL mean (the verdict signal, {len(EVAL_TASKS)} unseen tasks):")
    for a in s["eval"]:
        out.append(f"    {a:<10} {s['eval'][a]:.3f}")
    delta = round(ev - ctrl, 3)
    out.append(f"evolving − control (eval): {delta:+.3f}")
    if "told" in s["eval"]:
        denom = max(1e-6, told - ctrl)
        closed = (ev - ctrl) / denom * 100
        out.append(f"closed {closed:.0f}% of the control→told (learned vs told) gap "
                   f"({ctrl:.3f} → {ev:.3f} → {told:.3f})")
    # per-dim: which rules did the playbook actually teach?
    if "evolving" in s["eval_dims"] and "control" in s["eval_dims"]:
        out.append("per-rule lift (evolving − control) on eval:")
        for d in s["eval_dims"]["evolving"]:
            e, c = s["eval_dims"]["evolving"][d], s["eval_dims"]["control"].get(d, 0)
            out.append(f"    {d:<20} {c:.2f} → {e:.2f}  ({e-c:+.2f})")
    beats = delta >= 0.05
    strong = delta >= 0.10
    if strong:
        out.append("VERDICT: ✅ THEORY HOLDS (strong) — learned playbook clearly beats control on UNSEEN tasks.")
    elif beats:
        out.append("VERDICT: ✅ THEORY HOLDS — learned playbook beats control on unseen tasks (modest margin).")
    elif delta >= 0.0:
        out.append("VERDICT: 🟡 INCONCLUSIVE — eval gain too small to trust; add trials / harder rubric.")
    else:
        out.append("VERDICT: ❌ THEORY FAILS — playbook did not help on unseen tasks.")
    return out


async def main() -> None:
    global _SEM
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=8, help="train tasks (playbook-building rounds)")
    ap.add_argument("--trials", type=int, default=1)
    ap.add_argument("--arms", default="control,evolving,told")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    arms_wanted = [a.strip() for a in args.arms.split(",") if a.strip()]
    _SEM = asyncio.Semaphore(args.concurrency)

    g = Groq(_load_key())
    print(f"self-evolve spike | employee={AGENT_MODEL} | reviewer={JUDGE_MODEL} | "
          f"train={args.rounds} eval={len(EVAL_TASKS)} trials={args.trials} arms={arms_wanted}")
    t0 = time.time()
    trials = []
    for ti in range(args.trials):
        trials.append(await run_trial(g, args.rounds, arms_wanted, ti))

    s = summarize(trials, arms_wanted, args.rounds)
    print(f"\n{'═'*78}\nSUMMARY (avg over {args.trials} trial(s))\n{'═'*78}")
    for line in verdict(s):
        print("  " + line)
    print(f"\n  evolved playbook ({len(s['playbook'])} lessons):")
    for i, l in enumerate(s["playbook"]):
        print(f"    {i+1}. {l}")
    print(f"\n  elapsed {time.time()-t0:.1f}s")
    print(METER.report())

    if args.out:
        Path(args.out).write_text(json.dumps({"summary": s, "args": vars(args)}, indent=2))
        print(f"  wrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
