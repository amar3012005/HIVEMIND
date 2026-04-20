import os
import json
import requests
import sys

# Simulation of path for local imports if needed
sys.path.append(os.path.join(os.path.dirname(__file__), '../MiroFish/backend'))

def test_groq_deep_research(query):
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        print("Error: GROQ_API_KEY not found in environment.")
        return

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "groq/compound",
        "messages": [{"role": "user", "content": query}],
        "temperature": 0.5,
        "max_tokens": 4096,
        "tool_choice": "auto"
    }

    print(f"--- Querying Groq Compound: {query} ---\n")
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=90)
        response.raise_for_status()
        data = response.json()

        message = data["choices"][0]["message"]
        
        if "reasoning" in message:
            print("[REASONING]:")
            print(message["reasoning"])
            print("-" * 40)

        print("\n[RESEARCH SUMMARY]:")
        print(message["content"])
        
        if "executed_tools" in message and message["executed_tools"]:
            print("\n" + "="*40)
            print("[ACTIONS PERFORMED]:")
            for i, tool in enumerate(message["executed_tools"]):
                t_type = tool.get("type", "unknown")
                print(f"Action {i+1}: {t_type.upper()}")
                if "search_results" in tool:
                    res = tool["search_results"].get("results", [])
                    print(f"  -> Searched web and found {len(res)} sources.")
                    for j, r in enumerate(res[:3]):
                        print(f"     [{j+1}] {r.get('title')} ({r.get('url')})")
                if "visit_results" in tool:
                    print(f"  -> Visited: {tool['visit_results'].get('url')}")
            print("="*40)

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "What is the status of the war between US and Iran as of April 2026?"
    test_groq_deep_research(q)
