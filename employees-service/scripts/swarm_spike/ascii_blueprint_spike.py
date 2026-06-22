#!/usr/bin/env python3
"""ASCII-blueprint skill — PROVE-THE-QUALITY harness (test before building).

The risk (flagged): LLM ASCII art is often MIS-ALIGNED → looks amateur in a polished report. Before
adding it as a synth skill, prove the synth model (gpt-oss-120b) can produce CLEAN, well-aligned
monospace blueprints for blueprint-appropriate content (trees / box-flows / topology) — and judge
each for validity + alignment + usefulness. If quality is poor, gate hard or shelve.

Run:  PYTHONPATH=. python3 ascii_blueprint_spike.py
"""
import asyncio
import json
import os
import re

import httpx
import self_evolve_spike as L1  # reuse _load_key

MODEL = os.environ.get("EVO_SYNTH_MODEL", "openai/gpt-oss-120b")   # what writes the deliverable in prod
JUDGE = os.environ.get("EVO_JUDGE_MODEL", "openai/gpt-oss-120b")
BASE = "https://api.groq.com/openai/v1"

# Blueprint-appropriate prompts (where monospace beats mermaid).
CASES = [
    ("dir-tree", "Show the file/folder structure of a typical Python FastAPI service as an ASCII directory tree."),
    ("architecture", "Draw an ASCII box-and-arrow architecture: a React frontend → an API gateway → 3 microservices (auth, billing, data) → a Postgres DB and a Redis cache."),
    ("pipeline", "Draw an ASCII left-to-right CI/CD pipeline: commit → build → test → staging → approve → prod, with an arrow back from a failed test to build."),
    ("network", "Draw an ASCII network topology: internet → load balancer → 2 web servers → a database, with a firewall box between internet and the LB."),
]

ASCII_RULES = (
    "Render the answer as an ASCII diagram inside a single ``` code fence (monospace). RULES: use only "
    "monospace-safe characters (+ - | / \\ > < space, or box-drawing ┌ ┐ └ ┘ ─ │ ├ ┤ ▼ →). ALIGN everything "
    "on a fixed grid — boxes the same width, edges meeting cleanly, columns lined up. Keep it compact "
    "(≤ ~70 cols wide). Label nodes briefly. Output ONLY the fenced diagram, nothing else."
)


class Groq:
    def __init__(self, key):
        self.key = key

    async def chat(self, messages, *, model, temperature=0.3, json_object=False):
        body = {"model": model, "messages": messages, "temperature": temperature}
        if json_object:
            body["response_format"] = {"type": "json_object"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0)) as c:
            r = await c.post(f"{BASE}/chat/completions", headers={"Authorization": f"Bearer {self.key}"}, json=body)
            r.raise_for_status()
            return (r.json()["choices"][0]["message"].get("content") or "").strip()


def extract_fence(s):
    m = re.search(r"```[a-z]*\n?(.*?)```", s, re.S)
    return (m.group(1) if m else s).rstrip("\n")


async def gen(g, prompt):
    return await g.chat([{"role": "system", "content": ASCII_RULES}, {"role": "user", "content": prompt}],
                        model=MODEL, temperature=0.3)


async def judge(g, prompt, art):
    sysp = ("You are a strict reviewer of an ASCII diagram. Score 0.0-1.0 each: "
            "valid (coherent diagram, not garbage), aligned (boxes same width, edges/columns line up, no "
            "ragged drift), useful (clearly conveys the requested structure). Be harsh on misalignment — a "
            'wonky box loses alignment points. Return ONLY json: {"valid":0..1,"aligned":0..1,"useful":0..1,"note":"<8 words>"}')
    out = await g.chat([{"role": "system", "content": sysp},
                        {"role": "user", "content": f"REQUEST: {prompt}\n\nASCII:\n{art}"}],
                       model=JUDGE, temperature=0.0, json_object=True)
    try:
        j = json.loads(re.search(r"\{.*\}", out, re.S).group(0))
        dims = {k: float(j.get(k, 0) or 0) for k in ("valid", "aligned", "useful")}
        return dims, str(j.get("note", ""))
    except Exception:  # noqa: BLE001
        return {"valid": 0, "aligned": 0, "useful": 0}, "parse-fail"


def width_consistency(art):
    """Heuristic: how ragged are the lines? (max-min nonblank line length / max). Lower = tidier."""
    lines = [l for l in art.split("\n") if l.strip()]
    if len(lines) < 2:
        return 0.0
    lens = [len(l.rstrip()) for l in lines]
    return round((max(lens) - min(lens)) / max(max(lens), 1), 2)


async def main():
    g = Groq(L1._load_key())
    print(f"ASCII-blueprint spike | model={MODEL}\n")
    rows = []
    for name, prompt in CASES:
        art = extract_fence(await gen(g, prompt))
        dims, note = await judge(g, prompt, art)
        rows.append((name, dims, note, art))
        avg = sum(dims.values()) / 3
        print(f"── {name}  valid={dims['valid']:.2f} aligned={dims['aligned']:.2f} useful={dims['useful']:.2f} "
              f"avg={avg:.2f} ragged={width_consistency(art)} ({note})")
        print(art)
        print()
    aligned = [r[1]["aligned"] for r in rows]
    usefuls = [r[1]["useful"] for r in rows]
    a_avg = sum(aligned) / len(aligned)
    u_avg = sum(usefuls) / len(usefuls)
    print("=" * 60)
    print(f"  alignment avg: {a_avg:.2f}   usefulness avg: {u_avg:.2f}")
    if a_avg >= 0.8 and u_avg >= 0.8:
        print("  ✅ QUALITY GOOD — clean + useful → BUILD (gated synth directive).")
    elif u_avg >= 0.75 and a_avg >= 0.6:
        print("  🟡 useful but alignment shaky → BUILD but gate to TREES/simple only + monospace <pre>.")
    else:
        print("  ❌ alignment poor → SHELVE or restrict to dir-trees only; mermaid covers the rest.")


if __name__ == "__main__":
    asyncio.run(main())
