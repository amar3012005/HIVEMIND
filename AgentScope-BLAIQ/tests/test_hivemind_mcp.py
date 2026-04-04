from agentscope_blaiq.runtime.hivemind_mcp import HivemindMCPClient


def test_extract_tool_payload_parses_json_string_text():
    payload = {
        "content": [
            {
                "type": "text",
                "text": '{"results":[{"id":"mem-1","title":"Deck brief","content":"Enterprise deck context"}],"metadata":{"requestId":"abc"}}',
            }
        ]
    }

    extracted = HivemindMCPClient._extract_tool_payload(payload)

    assert extracted["results"][0]["id"] == "mem-1"
    assert extracted["metadata"]["requestId"] == "abc"
