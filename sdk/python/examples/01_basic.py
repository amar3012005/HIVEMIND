"""Basic: save + search memories."""

import os

from hivemind import HiveMind

hm = HiveMind(api_key=os.environ["HIVEMIND_API_KEY"])

# Save
mem = hm.save(
    content="EU AI Act enters full force in August 2026. High-risk AI systems "
            "must complete conformity assessment by July 1, 2026.",
    title="EU AI Act deadline",
    tags=["eu-ai-act", "compliance", "deadline"],
    memory_type="fact",
    importance_score=0.9,
)
print(f"Saved: {mem.id}")

# Search
results = hm.search("when is the EU AI Act deadline", n_results=3)
for r in results:
    print(f"  [{r.score:.3f}] {r.memory.title}")
    print(f"           {r.memory.content[:120]}…")
