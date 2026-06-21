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

def _tool(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}}

# P2 — connector READ tools
DRIVE_SEARCH = _tool("drive_search", "Find Google Drive files (docs/sheets/slides) by name/content. Returns id/name/type/url.",
                     {"query": {"type": "string"}, "max": {"type": "integer"}}, ["query"])
DOCS_GET = _tool("docs_get", "Read an existing Google Doc's full text by documentId (from drive_search).",
                 {"documentId": {"type": "string"}}, ["documentId"])
SHEETS_GET = _tool("sheets_get", "Read an existing Google Sheet's cell values by spreadsheetId. Optional range.",
                   {"spreadsheetId": {"type": "string"}, "range": {"type": "string"}}, ["spreadsheetId"])
# P3 — GUARDED produce/write tools (the agent takes ACTION)
DOCS_CREATE = _tool("docs_create", "Create a new Google Doc. title + content (markdown). Returns the real url. Produce ONLY after gathering real content.",
                    {"title": {"type": "string"}, "content": {"type": "string", "description": "full markdown body"}}, ["title", "content"])
SHEETS_CREATE = _tool("sheets_create", "Create a new Google Sheet. title + rows_json (a JSON 2-D array string, first row = headers). Returns the real url.",
                      {"title": {"type": "string"}, "rows_json": {"type": "string"}}, ["title", "rows_json"])
GMAIL_DRAFT = _tool("gmail_create_draft", "Draft an email (saved as a Gmail draft, NOT sent — needs the user's approval). to + subject + body. Put the REAL url from a prior sheets_create/docs_create result in the body, never a placeholder.",
                    {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, ["to", "subject", "body"])

import re as _re
_PH = _re.compile(r"UNVERIFIED|PLACEHOLDER|SHEET_ID|DOC_ID|YOUR_LINK|YOUR-LINK|XXXX|example\.com|1aBcDe|<\s*(?:link|url|sheet|insert)\b", _re.I)
_REAL_GURL = _re.compile(r"https?://(?:docs|drive|sheets)\.google\.com/\S+", _re.I)
_MENTIONS_LINK = _re.compile(r"\b(link|sheet|spreadsheet|doc|document|attached|here|below|access it)\b", _re.I)


def _guard_write(name, args):
    """Reject placeholder/empty write args BEFORE hitting Google (the gpt-oss
    placeholder-arg → 400 / fabricated-link failure mode). Returns an error string
    telling the agent to retry with real content, or None if the args are sound."""
    if name == "docs_create":
        if not str(args.get("title") or "").strip() or len(str(args.get("content") or "").strip()) < 30:
            return "Rejected: docs_create needs a real title AND ≥30 chars of real markdown content. Gather the content first, then call again."
    if name == "sheets_create":
        rj = str(args.get("rows_json") or "").strip()
        if not str(args.get("title") or "").strip() or not rj or rj in ("[]", "[[]]"):
            return "Rejected: sheets_create needs a title AND a non-empty rows_json (JSON 2-D array, first row = headers). Gather the rows first."
    if name == "gmail_create_draft":
        to = str(args.get("to") or "")
        if "@" not in to or _PH.search(to):
            return "Rejected: gmail_create_draft needs a REAL recipient email address."
        body = str(args.get("body") or "")
        if len(body.strip()) < 20:
            return "Rejected: the email body is too short — write the real message."
        if _PH.search(body):
            return "Rejected: the body contains a placeholder token. Use the REAL url returned by a prior sheets_create/docs_create call (or omit the link)."
        # If the body talks about a link/sheet/doc but has NO real Google URL, it's a
        # fabricated/missing link → reject (thread the real create-result url).
        if _MENTIONS_LINK.search(body) and not _REAL_GURL.search(body):
            return "Rejected: the body references a sheet/doc/link but contains NO real Google URL. Insert the exact url the prior sheets_create/docs_create call returned."
    return None


SYS = ("You are a HIVEMIND room agent. HIVEMIND is the COMPANY BRAIN — call hivemind_recall as "
       "many times as needed (one call per topic) to gather grounded facts; use gmail_search for "
       "live email context when relevant. Ground EVERY specific claim in a tool result; mark "
       "anything you genuinely can't find as UNVERIFIED — never invent. When the task asks you to "
       "CREATE a doc/sheet or DRAFT an email, gather the real content FIRST, then call the produce "
       "tool ONCE (docs_create / sheets_create / gmail_create_draft); put the REAL url a create call "
       "returns into any email body — never a placeholder. When done, stop calling tools and give a "
       "short final summary with the artifact link(s). Gather EFFICIENTLY: a few targeted recalls/"
       "searches (not a dozen) — once you have enough to act, PRODUCE; don't loop recall endlessly.")


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
        if name in ("drive_search", "docs_get", "sheets_get"):
            gargs = {"query": str(args.get("query", "")), "max": int(args.get("max", 8) or 8)} if name == "drive_search" \
                else {"documentId": str(args.get("documentId", ""))} if name == "docs_get" \
                else {"spreadsheetId": str(args.get("spreadsheetId", "")), "range": str(args.get("range", "") or "A1:Z200")}
            r = await google_exec_emulated(name, gargs, user_id=USER, org_id=ORG)
            res = (r or {}).get("result") if isinstance((r or {}).get("result"), dict) else (r or {})
            return json.dumps(res)[:1800]
        if name in ("docs_create", "sheets_create", "gmail_create_draft"):
            bad = _guard_write(name, args)
            if bad:
                return json.dumps({"error": bad})
            if name == "sheets_create":
                try:
                    rows = json.loads(args.get("rows_json") or "[]")
                except Exception:  # noqa: BLE001
                    return json.dumps({"error": "rows_json was not valid JSON — pass a JSON 2-D array string."})
                r = await google_exec_emulated("sheets_create", {"title": args["title"], "rows": rows}, user_id=USER, org_id=ORG)
            elif name == "docs_create":
                r = await google_exec_emulated("docs_create", {"title": args["title"], "content": args.get("content", "")}, user_id=USER, org_id=ORG)
            else:  # gmail_create_draft
                r = await google_exec_emulated("gmail_create_draft", {"to": args["to"], "subject": args.get("subject", ""), "body": args.get("body", "")}, user_id=USER, org_id=ORG)
            res = (r or {}).get("result") if isinstance((r or {}).get("result"), dict) else (r or {})
            url = res.get("url") or ""
            note = "saved as a DRAFT — NOT sent (needs the user's approval)" if name == "gmail_create_draft" else "created"
            return json.dumps({"ok": bool(url or res.get("draftId")), "url": url,
                               "spreadsheetId": res.get("spreadsheetId"), "documentId": res.get("documentId"),
                               "draftId": res.get("draftId"), "note": note})
        return json.dumps({"error": f"unknown tool {name}"})
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": f"{type(e).__name__}: {e}"})


async def run(label, query, tools, max_iters=12):
    print(f"\n{'='*70}\n{label}: {query}\n{'='*70}")
    messages = [{"role": "system", "content": SYS}, {"role": "user", "content": query}]
    calls = 0
    tok_in = tok_out = tok_total = 0
    t0 = time.time()
    async with httpx.AsyncClient(timeout=90) as c:
        for it in range(max_iters):
            resp = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_KEY}"},
                                json={"model": MODEL, "messages": messages, "tools": tools,
                                      "tool_choice": "auto", "temperature": 0.3})
            if resp.status_code != 200:
                print(f"  HTTP {resp.status_code}: {resp.text[:300]}")
                return
            j = resp.json()
            u = j.get("usage") or {}
            tok_in += u.get("prompt_tokens", 0); tok_out += u.get("completion_tokens", 0); tok_total += u.get("total_tokens", 0)
            msg = j["choices"][0]["message"]
            messages.append(msg)
            tcs = msg.get("tool_calls") or []
            if not tcs:
                ms = int((time.time() - t0) * 1000)
                print(f"\n--- FINAL ({calls} tool calls, {it} LLM rounds, {ms}ms) ---")
                print(f"--- TOKENS: total={tok_total}  in={tok_in}  out={tok_out} ---\n")
                print(msg.get("content"))
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
    print(f"  max_iters({max_iters}) hit — {calls} calls | TOKENS total={tok_total} in={tok_in} out={tok_out} | {int((time.time()-t0)*1000)}ms")


ALL_TOOLS = [RECALL_TOOL, GMAIL_TOOL, DRIVE_SEARCH, DOCS_GET, SHEETS_GET, DOCS_CREATE, SHEETS_CREATE, GMAIL_DRAFT]


async def main():
    # User's exact test query — detailed product-specs DOC + email it to the CEO.
    await run("USER QUERY: detailed product doc → email CEO",
              "Write a detailed doc about all the product specs of Solvis and send it to the CEO "
              "via email.",
              ALL_TOOLS, max_iters=24)


if __name__ == "__main__":
    asyncio.run(main())
