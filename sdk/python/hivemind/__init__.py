"""HIVEMIND Python SDK.

EU-sovereign company brain — plug into any LLM stack.

Quick start:
    from hivemind import HiveMind
    hm = HiveMind(api_key="hmk_live_...")
    hm.save(title="Meeting notes", content="...")
    results = hm.search("docker deployment")
"""

from hivemind.client import AsyncHiveMind, HiveMind, HiveMindError
from hivemind.models import Memory, Relationship, SearchResult

__version__ = "0.1.0"
__all__ = [
    "HiveMind",
    "AsyncHiveMind",
    "HiveMindError",
    "Memory",
    "Relationship",
    "SearchResult",
]
