import re
import json

def parse(raw):
    for pattern in [r'\[\s*\{.*\}\s*\]']:
        m = re.search(pattern, raw, re.DOTALL)
        if m:
            return json.loads(m.group(0))
    return []

print(parse('[ \n { "claim": "x", "direct_quote": "y" } \n]'))
