# HIVEMIND Python SDK

Official Python SDK for [HIVEMIND](https://hivemind.davinciai.eu) — EU-sovereign company brain. Plug into any LLM stack.

```bash
pip install hivemind-sdk

# With framework adapters
pip install "hivemind-sdk[langchain]"
pip install "hivemind-sdk[llamaindex]"
pip install "hivemind-sdk[openai]"
pip install "hivemind-sdk[anthropic]"
pip install "hivemind-sdk[all]"
```

## 30-second quickstart

```python
from hivemind import HiveMind

hm = HiveMind(api_key="hmk_live_...")  # or env HIVEMIND_API_KEY

hm.save(
    content="EU AI Act deadline for high-risk systems: July 1, 2026.",
    title="EU AI Act deadline",
    tags=["eu-ai-act", "compliance"],
)

results = hm.search("when is the EU AI Act deadline")
for r in results:
    print(f"[{r.score:.3f}] {r.memory.title}")
```

## Framework adapters

### LangChain

```python
from hivemind import HiveMind
from hivemind.integrations.langchain import HiveMindRetriever

retriever = HiveMindRetriever(hm=HiveMind(), k=5, scope="team")
# Drop into any LCEL chain
```

### LlamaIndex

```python
from hivemind.integrations.llamaindex import HiveMindRetriever
from llama_index.core.query_engine import RetrieverQueryEngine

retriever = HiveMindRetriever(hm=HiveMind(), similarity_top_k=5)
engine = RetrieverQueryEngine.from_args(retriever=retriever)
```

### OpenAI Assistants — replace `file_search`

```python
from openai import OpenAI
from hivemind.integrations.openai_assistants import build_assistant_kwargs

client = OpenAI()
assistant = client.beta.assistants.create(**build_assistant_kwargs(
    name="Company Brain",
    model="gpt-4o",
))
# Run loop with handle_tool_call — see examples/04
```

### Anthropic Claude tool-use

```python
from anthropic import Anthropic
from hivemind.integrations.anthropic import HIVEMIND_TOOL_DEF, handle_tool_use

client = Anthropic()
resp = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    tools=[HIVEMIND_TOOL_DEF],
    messages=[{"role": "user", "content": "What did we decide about pricing?"}],
)
# Handle tool_use blocks — see examples/05
```

## What you get vs alternatives

| Feature | HIVEMIND | Mem0 | Supermemory | OpenAI file_search |
|---|---|---|---|---|
| EU sovereignty | ✅ | ❌ | ❌ | ❌ |
| 4-edge graph (Updates/Extends/Derives/Contradicts) | ✅ | ❌ | 3 edges | ❌ |
| Audit log + GDPR DSR | ✅ | partial | ❌ | ❌ |
| Bring-your-own LLM | ✅ | ✅ | ✅ | ❌ locked to OpenAI |
| Self-hosted | ✅ | ❌ | ❌ | ❌ |
| Citation/provenance on every result | ✅ | ✅ | ✅ | partial |
| Cluster-aware retrieval (hub boost) | ✅ | ❌ | ❌ | ❌ |
| Time-travel queries (bi-temporal) | ✅ | ❌ | ❌ | ❌ |

## Async

```python
from hivemind import AsyncHiveMind

async with AsyncHiveMind() as hm:
    results = await hm.search("docker deployment")
```

## Configuration

| Arg | Env | Default |
|---|---|---|
| `api_key` | `HIVEMIND_API_KEY` | _required_ |
| `base_url` | `HIVEMIND_URL` | `https://core.hivemind.davinciai.eu:8050` |
| `user_id` | — | optional, sets default ownership |
| `org_id` | — | optional, sets default tenant |
| `timeout` | — | 30.0s |

## Docs

- API reference: https://hivemind.davinciai.eu/docs
- OpenAPI spec: https://hivemind.davinciai.eu/openapi.yaml
- MCP server: https://core.hivemind.davinciai.eu:8050/api/mcp
- GitHub: https://github.com/amar3012005/HIVEMIND

## License

Apache-2.0
