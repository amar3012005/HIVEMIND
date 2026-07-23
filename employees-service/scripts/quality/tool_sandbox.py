#!/usr/bin/env python3
"""Tool-selection SANDBOX — see which tools different user queries trigger, WITHOUT running a
real room turn or any side effect (no dial, no Places call, no memory write).

For each query it does ONE LLM tool-calling round with the REAL tool schemas the room agents see
(build_hivemind_toolkit → get_json_schemas) + the REAL "LEADS & CALLS" tool-discipline guidance,
and prints the tools the model CHOSE to call. This is how we tune the guidance so:
  • lead questions → list_prospects (reuse), NOT places_search
  • "find new …" / user asks for new → places_search
  • "call <firm> at <phone>" → propose_call
  • pricing/strategy/recall questions → recall, no prospect/call tools

Run:  docker exec -i hm-employees python3 /app/scripts/quality/tool_sandbox.py   (or cp + run)
Env:  SANDBOX_MODEL (default openai/gpt-oss-120b)
"""
import json
import os
import httpx

from hivemind_employees.agents.agentscope_tools import build_hivemind_toolkit

MODEL = os.environ.get("SANDBOX_MODEL", "openai/gpt-oss-120b")
OR_KEY = os.environ["OPENROUTER_API_KEY"]

# The exact tool-discipline guidance the room agents get (mirror of agentscope_factory).
GUIDANCE = (
    "You are a digital employee working a task in a company room. Choose the RIGHT tool(s) for the "
    "user's request; if no tool is needed, answer directly (call none).\n\n"
    "LEADS & CALLS (tool discipline — follow exactly):\n"
    "- SEE / REUSE FIRST: any request about 'our leads/prospects', or to contact/reach-out/email/call "
    "an EXISTING lead, MUST start by calling list_prospects (optionally with a query) to read the "
    "company's lead book — each lead has a note + contact details. NEVER act on a lead from memory and "
    "never ask the user for details the lead book already holds.\n"
    "- DISCOVERY of brand-new prospects is a ROOM action, not yours: if the user asks for NEW/more "
    "prospects and the lead book has none that fit, list_prospects first, then say a discovery search is "
    "needed — never invent firms.\n"
    "- SAVE: when you find/qualify a lead worth keeping, call save_prospect(company, note, ...) with a "
    "note on why it matters now.\n"
    "- CALL: when a live phone call is the right next step for a specific prospect (warm/qualified lead, "
    "booked-meeting opening, time-sensitive follow-up — not routine info), call propose_call(company, "
    "phone, why). It only QUEUES the call for the user's approval. Use only when a call beats an email; "
    "never without a real phone number — if you don't have it, list_prospects first."
)

QUERIES = [
    "Who are our current leads and prospects?",
    "Find me new dental clinics in Berlin to reach out to.",
    "Call Müller Heizungsbau at +4915112345678 about the retrofit offer.",
    "What should our pricing strategy be next quarter?",
    "Reach out to our best existing lead.",
    "Add TechCorp (phone +491512223344) as a lead — they asked about our platform.",
    "Email our top prospect a follow-up.",
    "Remind me what we decided about the Q1 launch.",
    "We need more prospects — go find 10 new HVAC installers near Hannover.",
    "Give the Solvis lead a call to book a demo.",
]


def normalize_tools(schemas):
    out = []
    for s in schemas:
        if isinstance(s, dict) and s.get("type") == "function" and "function" in s:
            out.append(s)
        elif isinstance(s, dict) and "name" in s:
            out.append({"type": "function", "function": {
                "name": s["name"], "description": s.get("description", ""),
                "parameters": s.get("parameters") or s.get("input_schema") or {"type": "object", "properties": {}},
            }})
    return out


def called_tools(query, tools):
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": GUIDANCE}, {"role": "user", "content": query}],
        "tools": tools, "tool_choice": "auto", "temperature": 0.2, "max_tokens": 400,
        "provider": {"order": ["Cerebras", "Together"], "allow_fallbacks": True, "require_parameters": True},
    }
    try:
        r = httpx.post("https://openrouter.ai/api/v1/chat/completions",
                       headers={"Authorization": f"Bearer {OR_KEY}", "HTTP-Referer": "https://hivemind.davinciai.eu", "X-Title": "HIVEMIND"},
                       json=body, timeout=60)
        if r.status_code != 200:
            return [f"<HTTP {r.status_code}>"]
        msg = r.json()["choices"][0]["message"]
        tcs = msg.get("tool_calls") or []
        names = []
        for tc in tcs:
            fn = (tc.get("function") or {})
            args = fn.get("arguments")
            try:
                args = json.loads(args) if isinstance(args, str) else (args or {})
            except Exception:
                args = {}
            key = fn.get("name", "?")
            hint = args.get("company") or args.get("query") or args.get("phone") or ""
            names.append(f"{key}({str(hint)[:28]})" if hint else key)
        return names or ["<none — answered directly>"]
    except Exception as e:
        return [f"<err {type(e).__name__}>"]


def main():
    tk = build_hivemind_toolkit(api_key="", enabled_tool_names=[
        "hivemind_recall", "hivemind_list_memories", "hivemind_save_memory", "org_directory",
    ], user_id="sandbox", org_id="sandbox")
    tools = normalize_tools(tk.get_json_schemas())
    available = sorted(t["function"]["name"] for t in tools)
    print(f"TOOL SANDBOX · model={MODEL} · {len(tools)} tools available")
    print("available:", ", ".join(available))
    print("=" * 100)
    for q in QUERIES:
        names = called_tools(q, tools)
        print(f"▸ {q}\n    → {', '.join(names)}\n")


if __name__ == "__main__":
    main()
