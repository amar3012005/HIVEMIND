import json
VALID_TOOL_NAMES = {
        "insight_forge", "panorama_search", "quick_search", "interview_agents",
        "query_claims", "query_trials", "query_consensus", "query_contradictions",
        "trace_provenance",
    }

def _is_valid_tool_call(data: dict) -> bool:
    if "arguments" in data and isinstance(data["arguments"], dict):
        args = data["arguments"]
        if data.get("name") == "tool_call" and "name" in args:
            data["name"] = args.get("name")
            data["parameters"] = args.get("parameters", {})
        elif str(data.get("name", "")).startswith("tool_"):
            data["name"] = data["name"].replace("tool_", "", 1)
            data["parameters"] = args
        elif data.get("name") in VALID_TOOL_NAMES and "name" in args and "parameters" in args:
            data["name"] = args["name"]
            data["parameters"] = args["parameters"]
        elif data.get("name") in VALID_TOOL_NAMES:
            data["parameters"] = args
    tool_name = data.get("name") or data.get("tool")
    if tool_name and tool_name in VALID_TOOL_NAMES:
        if "tool" in data:
            data["name"] = data.pop("tool")
        if "params" in data and "parameters" not in data:
            data["parameters"] = data.pop("params")
        return True
    return False

s1 = '{"name": "tool_call", "arguments": {"name":"query_claims","parameters":{"status":"proposed","min_confidence":0.7,"limit":5}}\n}'
s2 = '{"name": "tool_query_claims", "arguments": {"status":"synthesized","min_confidence":0.8,"limit":10}}'
s3 = '{"name": "trace_provenance", "arguments": {"name":"trace_provenance","parameters":{"claim_id":"csi_claim_138ffbb88b7fa59ac04b"}}\n}'

for s in [s1, s2, s3]:
    j = json.loads(s)
    print("before", j)
    valid = _is_valid_tool_call(j)
    print("after", valid, j)

