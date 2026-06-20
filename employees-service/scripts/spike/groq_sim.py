#!/usr/bin/env python3
"""SPIKE 2 — can ONE director agent simulate the whole room by calling PERSONAS as
tools/functions? + skills loaded WITHIN the call by the model (not pre-inserted).

Two theories tested on the same context+query:
  A. DIRECTOR + persona-tools: one gpt-oss-120b session; tools = recall, load_skill,
     list_employees, consult_employee(slug, task). consult_employee sub-calls that
     employee's persona → returns its grounded POV. The director gathers POVs, lets
     them debate (consult to react), then synthesizes. "Single session", N sub-calls.
  B. PURE single HTTP call: personas described IN the prompt; the model role-plays
     all of them, debates, concludes. Literally one call.

Run inside hm-employees:
  docker exec hm-employees python /app/scripts/spike/groq_sim.py
"""
import asyncio
import json
import os
import time

import httpx

from hivemind_employees.hivemind_client import recall_emulated
from hivemind_employees.bootstrap_client import fetch_bootstrap

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_KEY = os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or ""
DIRECTOR_MODEL = os.environ.get("SIM_DIRECTOR_MODEL", "openai/gpt-oss-120b")
PERSONA_MODEL = os.environ.get("SIM_PERSONA_MODEL", "openai/gpt-oss-120b")
USER = "3b12845a-8cef-4174-ad89-16010810e90b"
ORG = "f5e2418b-61ef-4271-83a4-5623050b8402"

# ── skills: loaded WITHIN the call by the model via load_skill (not pre-inserted) ──
SKILLS = {
    "polished-doc": ("POLISHED DOC: open with '# Title' + a 2-sentence executive summary; "
                     "use '## Section'/'### Sub'; **bold** key terms/figures; for ANY numeric/"
                     "comparative data use a real markdown table (| h | h |, |---|, rows); end with "
                     "'Next steps'. Flag UNVERIFIED inline. No process narration."),
    "polished-email": ("POLISHED EMAIL: 'Subject: <specific>' line; warm one-line greeting by name; "
                       "2-4 tight sentences (context → value → ask); a single clear CTA; sign off. "
                       "Put the REAL artifact url inline. No fluff, no fabricated links."),
    "debate-facilitation": ("DEBATE: get each expert's distinct stance; surface the strongest "
                            "DISAGREEMENT explicitly; resolve by recency→authority of evidence, else "
                            "state the open question. Never average opinions into mush."),
}


async def _groq(messages, tools=None, model=DIRECTOR_MODEL, temp=0.4):
    body = {"model": model, "messages": messages, "temperature": temp}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    async with httpx.AsyncClient(timeout=90) as c:
        r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_KEY}"}, json=body)
    if r.status_code != 200:
        return None, {"err": f"{r.status_code}:{r.text[:200]}"}, 0
    j = r.json()
    u = j.get("usage") or {}
    return j["choices"][0]["message"], u, u.get("total_tokens", 0)


ROSTER = {}  # slug -> {name, lane, persona}


def _persona_str(emp):
    sysp = ((emp.get("active_prompt_version") or {}).get("system_prompt")
            or emp.get("persona") or "")
    name = emp.get("name") or emp.get("slug")
    lane = emp.get("_lane") or emp.get("role_archetype") or "Communicator"
    return name, lane, sysp[:1200]


async def consult_employee(slug, task, context):
    emp = ROSTER.get(slug)
    if not emp:
        return f"(no employee '{slug}')", 0
    name, lane, sysp = _persona_str(emp)
    sysmsg = (f"You are {name}, a {lane} on this team. {sysp}\n\nRespond IN CHARACTER and CONCISELY "
              f"(4-6 sentences) from YOUR expertise. Ground every claim in the CONTEXT provided; if "
              f"you DISAGREE with the premise or a teammate, challenge it with a specific reason. "
              f"Mark anything unverifiable as UNVERIFIED — never invent.")
    msg, u, tok = await _groq(
        [{"role": "system", "content": sysmsg},
         {"role": "user", "content": f"CONTEXT:\n{context}\n\nTASK: {task}"}],
        tools=None, model=PERSONA_MODEL)
    return (msg or {}).get("content", "(no reply)"), tok


# ── Theory A: director + persona tools ──
def _director_tools():
    return [
        {"type": "function", "function": {"name": "load_skill", "description":
            "Load a writing/reasoning skill before producing/deciding. Available: polished-doc, polished-email, debate-facilitation.",
            "parameters": {"type": "object", "properties": {"skill_name": {"type": "string"}}, "required": ["skill_name"]}}},
        {"type": "function", "function": {"name": "recall", "description":
            "Search the company brain (HIVEMIND) for more facts. Call per topic.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "max": {"type": "integer"}}, "required": ["query"]}}},
        {"type": "function", "function": {"name": "list_employees", "description":
            "List the room's employees (slug, name, lane) you can consult.",
            "parameters": {"type": "object", "properties": {}, "required": []}}},
        {"type": "function", "function": {"name": "consult_employee", "description":
            "Consult a teammate by slug for their grounded perspective on a task/question. Call several (and again, to make them react to each other) to run the debate.",
            "parameters": {"type": "object", "properties": {"slug": {"type": "string"}, "task": {"type": "string"}}, "required": ["slug", "task"]}}},
    ]


async def run_director(context, query, max_iters=20):
    print(f"\n{'='*72}\nTHEORY A — DIRECTOR + persona tools\nQUERY: {query}\n{'='*72}")
    sysmsg = ("You are the room's facilitator running a team of digital employees. SIMULATE a real "
              "working session: consult each relevant teammate (consult_employee) for their grounded "
              "perspective, then consult again to make them REACT to / challenge each other (a real "
              "debate, not an echo). Use recall for more facts; load_skill for output polish. Resolve "
              "disagreements explicitly (recency→authority of evidence). Then give ONE final, grounded "
              "recommendation that names who argued what. Never invent; flag UNVERIFIED.")
    messages = [{"role": "system", "content": sysmsg},
                {"role": "user", "content": f"CONTEXT (the load you were given):\n{context}\n\nQUERY: {query}"}]
    tools = _director_tools()
    calls, tok = 0, 0
    t0 = time.time()
    for it in range(max_iters):
        msg, u, t = await _groq(messages, tools=tools, model=DIRECTOR_MODEL)
        tok += t
        if msg is None:
            print("  ERR", u); return
        messages.append(msg)
        tcs = msg.get("tool_calls") or []
        if not tcs:
            print(f"\n--- FINAL ({calls} tool calls, {it} director rounds, {int((time.time()-t0)*1000)}ms) ---")
            print(f"--- TOKENS (director + personas): {tok} ---\n")
            print(msg.get("content"))
            return
        for tc in tcs:
            calls += 1
            fn = tc["function"]["name"]
            try:
                a = json.loads(tc["function"].get("arguments") or "{}")
            except Exception:
                a = {}
            if fn == "load_skill":
                res = SKILLS.get(a.get("skill_name", ""), "unknown skill")
            elif fn == "recall":
                r = await recall_emulated(str(a.get("query", "")), user_id=USER, org_id=ORG, max_memories=int(a.get("max", 5) or 5))
                mems = (r or {}).get("memories") or (r or {}).get("results") or []
                res = json.dumps([{"t": m.get("title"), "c": str(m.get("content") or "")[:200]} for m in mems[:5] if isinstance(m, dict)])
            elif fn == "list_employees":
                res = json.dumps([{"slug": s, "name": e["name"], "lane": e["lane"]} for s, e in ROSTER.items()])
            elif fn == "consult_employee":
                reply, ptok = await consult_employee(a.get("slug", ""), a.get("task", ""), context)
                tok += ptok
                res = reply
                print(f"  ⇄ consult {a.get('slug')}: {reply[:160].strip()}")
            else:
                res = f"unknown tool {fn}"
            if fn != "consult_employee":
                print(f"  → {fn}({json.dumps(a)[:80]})")
            messages.append({"role": "tool", "tool_call_id": tc["id"], "name": fn, "content": res})
    print(f"  max_iters hit | tokens={tok} | {int((time.time()-t0)*1000)}ms")


# ── Theory B: pure single HTTP call, personas in-prompt ──
async def run_single_call(context, query):
    print(f"\n{'='*72}\nTHEORY B — PURE single call (personas in-prompt, model role-plays all)\nQUERY: {query}\n{'='*72}")
    roster = "\n".join(f"- {e['name']} ({e['lane']}): {e['persona'][:300]}" for e in ROSTER.values())
    sysmsg = ("You simulate a full multi-expert room IN ONE PASS. Below are the team members + their "
              "stances. Internally role-play EACH one giving a distinct, grounded opinion on the query, "
              "have them CHALLENGE each other (a real debate, surface the strongest disagreement — do "
              "NOT make them all agree), then synthesize ONE final grounded recommendation that names "
              "who argued what. Ground in the CONTEXT; flag UNVERIFIED; never invent.\n\nTEAM:\n" + roster)
    t0 = time.time()
    msg, u, tok = await _groq(
        [{"role": "system", "content": sysmsg},
         {"role": "user", "content": f"CONTEXT:\n{context}\n\nQUERY: {query}"}],
        tools=None, model=DIRECTOR_MODEL)
    print(f"\n--- FINAL (1 call, {int((time.time()-t0)*1000)}ms) ---")
    print(f"--- TOKENS: {tok} ---\n")
    print((msg or {}).get("content"))


async def main():
    global ROSTER
    boot = await fetch_bootstrap()
    for e in boot[:6]:
        name, lane, sysp = _persona_str(e)
        ROSTER[e.get("slug") or e.get("id")] = {"name": name, "lane": lane, "persona": sysp, **e}
    print("ROSTER:", [f"{s}({v['lane']})" for s, v in ROSTER.items()])

    # a LOAD of context — pre-gather several Solvis topics
    ctx_parts = []
    for q in ["Solvis products and specs", "Solvis heat pump line", "Solvis solar storage strategy",
              "Solvis market and competitors", "Solvis CEO and company history"]:
        r = await recall_emulated(q, user_id=USER, org_id=ORG, max_memories=4)
        mems = (r or {}).get("memories") or (r or {}).get("results") or []
        for m in mems[:4]:
            if isinstance(m, dict):
                ctx_parts.append(f"- {m.get('title')}: {str(m.get('content') or '')[:200]}")
    context = "\n".join(dict.fromkeys(ctx_parts))[:6000]
    print(f"\ngathered context: {len(context)} chars")

    query = ("Should Solvis prioritise the heat-pump line or double down on solar + storage next "
             "year? Get each leader's view, debate it, and give a final recommendation with reasoning.")
    await run_director(context, query)
    await run_single_call(context, query)


if __name__ == "__main__":
    asyncio.run(main())
