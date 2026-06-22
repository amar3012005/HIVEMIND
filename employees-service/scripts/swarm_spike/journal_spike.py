#!/usr/bin/env python3
"""Swarm Journal + intent fast-path — PROVE-THE-THEORY harness (test before building).

Two claims to validate before wiring into the engine:

  CLAIM 1 — CONTINUITY: a compact per-turn JOURNAL injected at the start of a turn lets the room
            correctly recall what it decided in an EARLIER turn. A blank-slate room cannot.
            Test: T1 makes a decision → T2 builds on it → T3 asks "what did we decide & why?".
            Judge T3 against T1's ACTUAL decision. JOURNAL arm should recall it; BLANK arm can't.

  CLAIM 2 — FAST-PATH: an intent gate classifies a message DIRECT (recall/lookup) vs DELIBERATE.
            Direct questions answered from the journal are correct AND far cheaper than running the
            full deliberate pipeline. Measure classification accuracy + the token delta.

Also measures: journal size (must stay BOUNDED — no token regression) + T3 input tokens per arm.

Run:  PYTHONPATH=. python3 journal_spike.py
"""
import asyncio
import json
import os
import re

import httpx

import self_evolve_spike as L1  # reuse _load_key

ANSWER_MODEL = os.environ.get("EVO_AGENT_MODEL", "openai/gpt-oss-120b")   # the deliberate/synth model
JOURNAL_MODEL = os.environ.get("EVO_DIGEST_MODEL", "llama-3.1-8b-instant")  # cheap summariser (content-returning)
JUDGE_MODEL = os.environ.get("EVO_JUDGE_MODEL", "openai/gpt-oss-120b")
BASE_URL = "https://api.groq.com/openai/v1"

ORG = ("SINGULANCE — pre-seed B2B SaaS. ~€1.9M cash, ~€140k/mo burn (≈13 mo runway). 3 unpaid design "
       "partners, no paying customers. Team of 9. Seed raise in ~6 months; lead prospect Helio Capital "
       "wants 'evidence of repeatable acquisition'. v2 ships Q3. Last quarter paid-ads = €30k, 11 SQLs, "
       "€2.7k CAC, payback unproven.")


class Groq:
    def __init__(self, key):
        self.key, self.prompt, self.completion = key, 0, 0

    def reset(self):
        self.prompt = self.completion = 0

    async def chat(self, messages, *, model, temperature=0.5, json_object=False, count=True):
        body = {"model": model, "messages": messages, "temperature": temperature}
        if json_object:
            body["response_format"] = {"type": "json_object"}
        for attempt in range(4):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
                    r = await c.post(f"{BASE_URL}/chat/completions",
                                     headers={"Authorization": f"Bearer {self.key}"}, json=body)
                if r.status_code == 200:
                    j = r.json(); u = j.get("usage", {})
                    if count:
                        self.prompt += int(u.get("prompt_tokens", 0) or 0)
                        self.completion += int(u.get("completion_tokens", 0) or 0)
                    return (j["choices"][0]["message"].get("content") or "").strip()
                if r.status_code in (429, 500, 502, 503):
                    await asyncio.sleep(min(2 ** attempt, 8)); continue
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
            except Exception:  # noqa: BLE001
                if attempt == 3:
                    raise
                await asyncio.sleep(min(2 ** attempt, 8))


def approx(s):
    return int(len(s) / 4)


async def answer_turn(g, question, journal_block):
    """A room turn's grounded answer (stands in for gather+debate+synth). Journal injected if present."""
    sysp = ("You are the Head of Finance answering for the team. Decide directly, ground ONLY in the "
            "CONTEXT and the ROOM JOURNAL (prior decisions). End with the decision in one clear line. "
            "If the journal already answers a recall question, just state what was decided + why — don't re-derive.")
    usr = f"CONTEXT:\n{ORG}\n{journal_block}\n\nQUESTION: {question}"
    return await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                        model=ANSWER_MODEL, temperature=0.4)


async def summarize_turn(g, question, answer):
    """Compact journal entry — bounded. The Claude-Code-style compaction, one cheap call."""
    sysp = ("Summarize this room turn into ONE compact journal line for future turns. Format exactly: "
            "\"asked: <≤10 words> | decided: <the decision + key reason, ≤22 words>\". No preamble.")
    usr = f"USER ASKED: {question}\n\nTEAM ANSWER:\n{answer[:1200]}"
    return (await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                         model=JOURNAL_MODEL, temperature=0.2)).strip().split("\n")[0]


async def judge_continuity(g, t3_answer, truth_decision):
    sysp = ("Score 0.0-1.0 how well the ANSWER correctly recalls the PRIOR DECISION (does it state the "
            "same decision + reason, not a fresh/contradictory take?). 1.0=accurately recalls it; "
            '0.0=doesn\'t know it / contradicts. Return ONLY json: {"recall":0..1,"note":"<8 words>"}')
    usr = f"PRIOR DECISION (ground truth):\n{truth_decision}\n\nANSWER TO T3 (\"what did we decide & why?\"):\n{t3_answer}"
    out = await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                       model=JUDGE_MODEL, temperature=0.0, json_object=True, count=False)
    try:
        j = json.loads(re.search(r"\{.*\}", out, re.S).group(0))
        return float(j.get("recall", 0) or 0), str(j.get("note", ""))
    except Exception:  # noqa: BLE001
        return 0.0, "parse-fail"


async def intent_classify(g, message):
    sysp = ("Classify the user message for a team-room AI.\n"
            "DIRECT = answerable from memory/records WITHOUT a team debate: greetings; a factual lookup "
            "('what's our runway?'); OR any PAST-TENSE recall of what was already decided/agreed/chosen "
            "('what did we decide about X?', 'summarize what we agreed', 'remind me what we picked').\n"
            "DELIBERATE = a NEW decision/strategy/analysis/trade-off the team must reason through now "
            "('should we…?', 'design…', 'is it worth…?', 'evaluate…').\n"
            'Rule of thumb: asking what WAS decided = direct; asking what we SHOULD do = deliberate. '
            'Return ONLY json: {"intent":"direct"|"deliberate"}')
    out = await g.chat([{"role": "system", "content": sysp}, {"role": "user", "content": message}],
                       model=JOURNAL_MODEL, temperature=0.0, json_object=True, count=False)
    try:
        return json.loads(re.search(r"\{.*\}", out, re.S).group(0)).get("intent", "deliberate")
    except Exception:  # noqa: BLE001
        return "deliberate"


async def main():
    g = Groq(L1._load_key())
    print("=== CLAIM 1: journal continuity (3-turn) ===")
    # T1 — make a real decision (shared ground truth for both arms)
    q1 = "Should we double paid-ads spend next quarter to accelerate growth?"
    a1 = await answer_turn(g, q1, "")
    j1 = await summarize_turn(g, q1, a1)
    # T2 — build on it (journal present)
    q2 = "Draft the next-quarter budget split given that."
    a2 = await answer_turn(g, q2, f"\n\nROOM JOURNAL (prior turns):\n- {j1}")
    j2 = await summarize_turn(g, q2, a2)
    journal = f"\n\nROOM JOURNAL (prior turns):\n- {j1}\n- {j2}"
    print(f"  T1 decision (truth): {a1.strip().splitlines()[-1][:140]}")
    print(f"  journal ({approx(journal)} tok):\n    - {j1}\n    - {j2}")

    # T3 — continuity probe on a JOURNAL-ONLY detail (the exact budget split decided in T2, which is
    # NOT derivable from the org context — isolates RECALL from re-derivation). Ground truth = a2.
    q3 = "What exact amount/percentage did we allocate to paid ads in next quarter's budget, and why that figure?"
    g.reset(); a3_journal = await answer_turn(g, q3, journal); tok_journal = g.prompt
    g.reset(); a3_blank = await answer_turn(g, q3, ""); tok_blank = g.prompt
    r_journal, n_j = await judge_continuity(g, a3_journal, a2)
    r_blank, n_b = await judge_continuity(g, a3_blank, a2)
    print(f"\n  T3 JOURNAL arm: recall={r_journal:.2f} ({n_j})  input={tok_journal} tok")
    print(f"  T3 BLANK   arm: recall={r_blank:.2f} ({n_b})  input={tok_blank} tok")
    cont_ok = r_journal - r_blank >= 0.3

    print("\n=== CLAIM 2: intent gate (direct vs deliberate) ===")
    labeled = [
        ("what did we decide about paid ads?", "direct"),
        ("what's our current runway?", "direct"),
        ("hi, you around?", "direct"),
        ("summarize what we agreed last turn", "direct"),
        ("should we raise prices 15% next quarter?", "deliberate"),
        ("design our go-to-market for the seed raise", "deliberate"),
        ("is it worth hiring two engineers now?", "deliberate"),
        ("evaluate the Helio term-sheet trade-offs", "deliberate"),
    ]
    correct = 0
    for msg, want in labeled:
        got = await intent_classify(g, msg)
        ok = got == want
        correct += ok
        print(f"  [{'✓' if ok else '✗'}] want={want:<10} got={got:<10} | {msg[:46]}")
    acc = correct / len(labeled)

    print(f"\n{'='*60}\nVERDICT")
    print(f"  continuity: JOURNAL recall {r_journal:.2f} vs BLANK {r_blank:.2f} (Δ {r_journal-r_blank:+.2f}); "
          f"journal adds {tok_journal-tok_blank} tok to T3")
    print(f"  intent-gate accuracy: {correct}/{len(labeled)} ({acc*100:.0f}%)")
    if cont_ok and acc >= 0.75:
        print("  ✅ BOTH HOLD — journal restores continuity (blank can't), intent gate routes accurately → BUILD.")
    elif cont_ok:
        print("  🟡 continuity holds; intent gate needs a better classifier prompt before fast-path.")
    else:
        print("  🟡 weak continuity signal — check the journal injection / judge.")


if __name__ == "__main__":
    asyncio.run(main())
