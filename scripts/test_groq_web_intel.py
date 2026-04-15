import os
import json
import requests
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

def test_groq_web_intel():
    """
    Benchmark Groq/Compound's native web search (vía Tavily) 
    vs. a standard LLM call + manual Tavily API.
    """
    client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
    
    prompt = "What are the latest developments in NVIDIA's Blackwell architecture as of April 2026?"
    
    print(f"--- Testing Groq/Compound with native Web Search ---")
    try:
        response = client.chat.completions.create(
            model="groq/compound",
            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        )
        
        # Analyze Response
        print("\n[REASONING]:")
        print(response.choices[0].message.reasoning)
        
        print("\n[FINAL CONTENT]:")
        print(response.choices[0].message.content)
        
        if hasattr(response.choices[0].message, 'executed_tools') and response.choices[0].message.executed_tools:
            print("\n[EXECUTED TOOLS]:")
            for tool in response.choices[0].message.executed_tools:
                print(f"- Tool Type: {tool.type}")
                if hasattr(tool, 'search_results') and tool.search_results:
                    print(f"  - Found {len(tool.search_results.get('results', []))} results.")

    except Exception as e:
        print(f"Error calling Groq/Compound: {e}")

if __name__ == "__main__":
    test_groq_web_intel()
