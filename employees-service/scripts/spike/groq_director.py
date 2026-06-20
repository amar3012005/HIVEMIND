#!/usr/bin/env python3
"""SPIKE 3 — the UNIFIED HyperAgent engine (test before production).

ONE director agent (gpt-oss-120b, native Groq tools) runs the room:
  gather (recall/drive/docs → a SHARED BLACKBOARD) → when discussion is warranted it
  calls the debate() tool (the room's personas as INDEPENDENT sub-LLM-calls: stance →
  react/challenge/support, real skepticism) → load_skill for polish → guarded produce
  (docs/email) → conclude. Genuinely multi-agent AT the debate; one cheap session
  everywhere else. The shared blackboard is free (one process).

Run: docker exec hm-employees python /app/scripts/spike/groq_director.py
"""
import asyncio
import json
import os
import re
import time

import httpx

from hivemind_employees.hivemind_client import recall_emulated, google_exec_emulated
from hivemind_employees.bootstrap_client import fetch_bootstrap

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_KEY = os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or ""
DIRECTOR_MODEL = os.environ.get("DIR_MODEL", "openai/gpt-oss-120b")
PERSONA_MODEL = os.environ.get("DIR_PERSONA_MODEL", "openai/gpt-oss-120b")
USER = "3b12845a-8cef-4174-ad89-16010810e90b"
ORG = "f5e2418b-61ef-4271-83a4-5623050b8402"

ROSTER = {}
BLACKBOARD = []   # shared, free in one process — everything gathered lands here
TRANSCRIPT = []   # the debate, for the README
TOK = {"n": 0}

SKILLS = {
    "polished-doc": ("POLISHED DOC: '# Title' + 2-sentence exec summary; '## Sections'; **bold** "
                     "figures; real markdown tables for any comparative/numeric data; 'Next steps'. "
                     "Flag UNVERIFIED inline. No process narration."),
    "polished-email": ("POLISHED EMAIL: 'Subject:' line; one-line greeting by name; 2-4 tight sentences "
                       "(context→value→ask); one CTA; sign off; REAL url inline; no fabricated links."),
}
_PH = re.compile(r"UNVERIFIED|PLACEHOLDER|SHEET_ID|DOC_ID|YOUR_LINK|XXXX|example\.com|<\s*(?:link|url|insert)", re.I)
_REAL_GURL = re.compile(r"https?://(?:docs|drive|sheets)\.google\.com/\S+", re.I)


async def _groq(messages, tools=None, model=DIRECTOR_MODEL, temp=0.4):
    body = {"model": model, "messages": messages, "temperature": temp}
    if tools:
        body["tools"], body["tool_choice"] = tools, "auto"
    async with httpx.AsyncClient(timeout=90) as c:
        r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_KEY}"}, json=body)
    if r.status_code != 200:
        return None, {"err": f"{r.status_code}:{r.text[:200]}"}
    j = r.json()
    TOK["n"] += (j.get("usage") or {}).get("total_tokens", 0)
    return j["choices"][0]["message"], (j.get("usage") or {})


def _persona(emp):
    name = emp.get("name") or emp.get("slug")
    lane = emp.get("_lane") or emp.get("role_archetype") or "Communicator"
    sysp = ((emp.get("active_prompt_version") or {}).get("system_prompt") or emp.get("persona") or "")[:1000]
    return name, lane, sysp


async def _consult(slug, prompt):
    emp = ROSTER.get(slug)
    if not emp:
        return slug, "(absent)"
    name, lane, sysp = _persona(emp)
    is_skeptic = "skeptic" in lane.lower()
    bias = " You are the SKEPTIC — your job is to find the weakest claim and challenge it hard." if is_skeptic else ""
    ctx = "\n".join(BLACKBOARD)[:4000]
    msg, _ = await _groq([
        {"role": "system", "content": f"You are {name}, a {lane}.{bias} {sysp}\nRespond IN CHARACTER, "
         f"CONCISELY (3-5 sentences), grounded ONLY in the CONTEXT. Challenge with specifics if you "
         f"disagree; mark anything unverifiable as UNVERIFIED; never invent."},
        {"role": "user", "content": f"CONTEXT:\n{ctx}\n\n{prompt}"}], model=PERSONA_MODEL)
    return name, (msg or {}).get("content", "(no reply)")


async def debate(topic, rounds=2):
    """The hyperagent simulation: personas argue the topic over `rounds`, on the shared
    blackboard. Round 1 = stances; round 2 = react/challenge each other. Returns a
    transcript + a convergence note (what the director then synthesizes)."""
    slugs = list(ROSTER.keys())[:5]
    lines = []
    r1 = await asyncio.gather(*[_consult(s, f"What is your stance on: {topic}? Give your view + your single biggest concern.") for s in slugs])
    for nm, txt in r1:
        lines.append({"round": 1, "agent": nm, "text": txt})
        TRANSCRIPT.append({"round": 1, "agent": nm, "text": txt})
    if rounds >= 2:
        prior = "\n".join(f"{nm}: {txt}" for nm, txt in r1)[:3500]
        r2 = await asyncio.gather(*[_consult(s, f"Your teammates said:\n{prior}\n\nREACT: whose point is weakest? "
                                              f"Challenge or build on it — be specific. Do you change your view on '{topic}'?") for s in slugs])
        for nm, txt in r2:
            lines.append({"round": 2, "agent": nm, "text": txt})
            TRANSCRIPT.append({"round": 2, "agent": nm, "text": txt})
    return json.dumps({"rounds": rounds, "transcript": [{"r": x["round"], "agent": x["agent"], "said": x["text"][:400]} for x in lines]})


def _t(name, desc, props, req):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": req}}}

TOOLS = [
    _t("recall", "Search HIVEMIND (company brain). Call per topic to gather grounded facts.", {"query": {"type": "string"}, "max": {"type": "integer"}}, ["query"]),
    _t("drive_search", "Find Google Drive files (docs/sheets) by name/content.", {"query": {"type": "string"}}, ["query"]),
    _t("docs_get", "Read an existing Google Doc's text by documentId.", {"documentId": {"type": "string"}}, ["documentId"]),
    _t("debate", "Run a DEBATE: the room's personas argue a topic (stance → challenge each other, real skepticism) over 1-2 rounds and return the transcript. Call this when the task needs a decision/discussion before you conclude.", {"topic": {"type": "string"}, "rounds": {"type": "integer"}}, ["topic"]),
    _t("load_skill", "Load a quality skill before producing. Available: polished-doc, polished-email.", {"skill_name": {"type": "string"}}, ["skill_name"]),
    _t("docs_create", "Create a real Google Doc. title + markdown content. Returns the real url.", {"title": {"type": "string"}, "content": {"type": "string"}}, ["title", "content"]),
    _t("gmail_create_draft", "Draft an email (saved, NOT sent). to + subject + body. Put the REAL url from a create call in the body.", {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, ["to", "subject", "body"]),
]


def _guard(name, a):
    if name == "docs_create" and (not str(a.get("title") or "").strip() or len(str(a.get("content") or "").strip()) < 30):
        return "Rejected: docs_create needs a real title + ≥30 chars of content."
    if name == "gmail_create_draft":
        if "@" not in str(a.get("to") or "") or _PH.search(str(a.get("to") or "")):
            return "Rejected: need a real recipient address."
        b = str(a.get("body") or "")
        if len(b.strip()) < 20 or _PH.search(b) or (re.search(r"\b(link|sheet|doc|attached)\b", b, re.I) and not _REAL_GURL.search(b)):
            return "Rejected: body too short, or references a link with no REAL Google url — use the real create-result url."
    return None


async def _exec(name, a):
    if name == "recall":
        r = await recall_emulated(str(a.get("query", "")), user_id=USER, org_id=ORG, max_memories=int(a.get("max", 5) or 5))
        mems = (r or {}).get("memories") or (r or {}).get("results") or []
        facts = [f"- {m.get('title')}: {str(m.get('content') or '')[:200]}" for m in mems[:5] if isinstance(m, dict)]
        BLACKBOARD.extend(facts)
        return json.dumps({"found": len(facts), "facts": facts})
    if name in ("drive_search", "docs_get"):
        ga = {"query": str(a.get("query", "")), "max": 6} if name == "drive_search" else {"documentId": str(a.get("documentId", ""))}
        r = await google_exec_emulated(name, ga, user_id=USER, org_id=ORG)
        res = (r or {}).get("result") if isinstance((r or {}).get("result"), dict) else (r or {})
        if name == "docs_get":
            BLACKBOARD.append(f"- DOC {res.get('title')}: {str(res.get('text') or '')[:300]}")
        return json.dumps(res)[:1500]
    if name == "debate":
        return await debate(str(a.get("topic", "")), int(a.get("rounds", 2) or 2))
    if name == "load_skill":
        return SKILLS.get(a.get("skill_name", ""), "unknown skill")
    if name in ("docs_create", "gmail_create_draft"):
        bad = _guard(name, a)
        if bad:
            return json.dumps({"error": bad})
        if name == "docs_create":
            r = await google_exec_emulated("docs_create", {"title": a["title"], "content": a.get("content", "")}, user_id=USER, org_id=ORG)
        else:
            r = await google_exec_emulated("gmail_create_draft", {"to": a["to"], "subject": a.get("subject", ""), "body": a.get("body", "")}, user_id=USER, org_id=ORG)
        res = (r or {}).get("result") if isinstance((r or {}).get("result"), dict) else (r or {})
        return json.dumps({"ok": bool(res.get("url") or res.get("draftId")), "url": res.get("url"),
                           "documentId": res.get("documentId"), "draftId": res.get("draftId"),
                           "note": "draft saved, NOT sent" if name == "gmail_create_draft" else "created"})
    return json.dumps({"error": f"unknown {name}"})


async def run(query, max_iters=20):
    print(f"\n{'='*72}\nDIRECTOR ENGINE — {query}\n{'='*72}")
    sysmsg = ("You are the facilitator of a HIVEMIND hyperagent room — sentinel agents living in the "
              "company brain. Gather grounded facts (recall/drive/docs → they accumulate on the shared "
              "board). When the task needs a decision or discussion, call debate(topic) — the room's "
              "personas will argue it (support + real skepticism). Use load_skill before producing. "
              "Produce real artifacts with the produce tools (use the REAL url they return). Ground "
              "everything; flag UNVERIFIED; never invent. End with a short synthesis citing who argued what.")
    messages = [{"role": "system", "content": sysmsg}, {"role": "user", "content": query}]
    calls = 0
    t0 = time.time()
    for it in range(max_iters):
        msg, u = await _groq(messages, tools=TOOLS)
        if msg is None:
            print("ERR", u); return
        messages.append(msg)
        tcs = msg.get("tool_calls") or []
        if not tcs:
            print(f"\n--- FINAL ({calls} tool calls, {it} director rounds, {int((time.time()-t0)*1000)}ms, {TOK['n']} tokens) ---\n{msg.get('content')}")
            return
        for tc in tcs:
            calls += 1
            fn = tc["function"]["name"]
            try:
                a = json.loads(tc["function"].get("arguments") or "{}")
            except Exception:
                a = {}
            print(f"  → {fn}({json.dumps(a)[:90]})")
            res = await _exec(fn, a)
            if fn == "debate":
                for x in TRANSCRIPT[-10:]:
                    print(f"      ⇄ R{x['round']} {x['agent']}: {x['text'][:140].strip()}")
            messages.append({"role": "tool", "tool_call_id": tc["id"], "name": fn, "content": res})
    print(f"  max_iters | {calls} calls | {TOK['n']} tokens | {int((time.time()-t0)*1000)}ms")


async def main():
    boot = await fetch_bootstrap()
    for e in boot[:6]:
        ROSTER[e.get("slug") or e.get("id")] = e
    print("ROSTER:", [f"{s}({(_persona(v)[1])})" for s, v in ROSTER.items()])
    await run("Decide: should Solvis prioritise the heat-pump line or double down on solar + storage "
              "next year? Debate it as the team, then write the decision as a polished Google Doc.")


if __name__ == "__main__":
    asyncio.run(main())
