#!/usr/bin/env python3
"""SPIKE: single-agent, NATIVE Groq local tool-calling (no AgentScope, no swarm).
One gpt-oss-120b agent loops — reasons, calls custom JSON tools (HIVEMIND recall,
then gmail), grounds, and gives a final answer in ONE agent session. Proves the
'one powerful reasoner + native tools' path before refactoring the orchestrator.

Run inside hm-employees (has GROQ_API_KEY + the tool impls):
  docker exec hm-employees python /app/scripts/spike/groq_agent.py
"""
import asyncio
import json
import os
import time

import httpx

from hivemind_employees.hivemind_client import recall_emulated, google_exec_emulated

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_KEY = os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or ""
MODEL = os.environ.get("SPIKE_MODEL", "openai/gpt-oss-120b")
USER = "3b12845a-8cef-4174-ad89-16010810e90b"
ORG = "f5e2418b-61ef-4271-83a4-5623050b8402"

RECALL_TOOL = {
    "type": "function",
    "function": {
        "name": "hivemind_recall",
        "description": "Search the company brain (HIVEMIND memory) for facts, people, history, products. Call it MULTIPLE times — once per distinct topic — to gather everything you need.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "what to look up (one topic)"},
                "max": {"type": "integer", "description": "max results (default 6)"},
            },
            "required": ["query"],
        },
    },
}
GMAIL_TOOL = {
    "type": "function",
    "function": {
        "name": "gmail_search",
        "description": "Search the company's Gmail for real messages. Returns subject/from/date/snippet. Use for live email context.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Gmail search query, e.g. 'from:customer newer_than:30d'"},
                "max": {"type": "integer", "description": "max messages (default 6)"},
            },
            "required": ["query"],
        },
    },
}

SYS = ("You are a HIVEMIND room agent. HIVEMIND is the COMPANY BRAIN — call hivemind_recall as "
       "many times as needed (one call per topic) to gather grounded facts; use gmail_search for "
       "live email context when relevant. Ground EVERY specific claim in a tool result; mark "
       "anything you genuinely can't find as UNVERIFIED — never invent. When you have enough, "
       "stop calling tools and give the final, grounded answer.")


async def _exec(name, args):
    try:
        if name == "hivemind_recall":
            r = await recall_emulated(str(args.get("query", "")), user_id=USER, org_id=ORG,
                                      max_memories=int(args.get("max", 6) or 6))
            mems = (r or {}).get("memories") or (r or {}).get("results") or (r or {}).get("context") or []
            out = []
            for m in (mems if isinstance(mems, list) else [])[:6]:
                if isinstance(m, dict):
                    out.append({"title": m.get("title") or m.get("name") or "",
                                "content": str(m.get("content") or m.get("summary") or m.get("text") or "")[:300]})
                elif isinstance(m, str):
                    out.append({"content": m[:300]})
            return json.dumps({"count": len(out), "memories": out})
        if name == "gmail_search":
            r = await google_exec_emulated("gmail_search", {"query": str(args.get("query", "")), "max": int(args.get("max", 6) or 6)},
                                           user_id=USER, org_id=ORG)
            res = (r or {}).get("result") if isinstance((r or {}).get("result"), dict) else (r or {})
            msgs = (res or {}).get("messages") or []
            return json.dumps({"count": len(msgs), "messages": [
                {"subject": x.get("subject"), "from": x.get("from"), "date": x.get("date"),
                 "snippet": str(x.get("snippet") or "")[:200]} for x in msgs[:6]]})
        return json.dumps({"error": f"unknown tool {name}"})
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": f"{type(e).__name__}: {e}"})


async def run(label, query, tools, max_iters=12):
    print(f"\n{'='*70}\n{label}: {query}\n{'='*70}")
    messages = [{"role": "system", "content": SYS}, {"role": "user", "content": query}]
    calls = 0
    t0 = time.time()
    async with httpx.AsyncClient(timeout=90) as c:
        for it in range(max_iters):
            resp = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_KEY}"},
                                json={"model": MODEL, "messages": messages, "tools": tools,
                                      "tool_choice": "auto", "temperature": 0.3})
            if resp.status_code != 200:
                print(f"  HTTP {resp.status_code}: {resp.text[:300]}")
                return
            msg = resp.json()["choices"][0]["message"]
            messages.append(msg)
            tcs = msg.get("tool_calls") or []
            if not tcs:
                ms = int((time.time() - t0) * 1000)
                print(f"\n--- FINAL ({calls} tool calls, {it} iters, {ms}ms) ---\n{msg.get('content')}\n")
                return
            for tc in tcs:
                calls += 1
                fn = tc["function"]["name"]
                try:
                    a = json.loads(tc["function"].get("arguments") or "{}")
                except Exception:  # noqa: BLE001
                    a = {}
                print(f"  → {fn}({json.dumps(a)[:120]})")
                result = await _exec(fn, a)
                print(f"      ↩ {result[:160]}")
                messages.append({"role": "tool", "tool_call_id": tc["id"], "name": fn, "content": result})
    print(f"  max_iters({max_iters}) hit — {calls} calls")


async def main():
    # P0 — multi-round recall in ONE agent session (forces several recall calls)
    await run("P0 recall-only",
              "Give me a grounded brief on Solvis: (1) their products, (2) who the CEO is, "
              "(3) the company's history/vision. Recall each separately and cite what you find.",
              [RECALL_TOOL])
    # P1 — add gmail; a query that needs live email context
    await run("P1 recall+gmail",
              "What are the most recent customer or partner emails we have, and what do they want? "
              "Use HIVEMIND for who they are and gmail for the actual messages.",
              [RECALL_TOOL, GMAIL_TOOL])


if __name__ == "__main__":
    asyncio.run(main())
