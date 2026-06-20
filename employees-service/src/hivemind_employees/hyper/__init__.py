"""HyperAgents v2 engine — single Groq native-tool-calling director.

A drop-in EXECUTOR for a hyper-room turn. The director (gpt-oss-120b) runs the
room in ONE session: gathers grounded facts from the company brain + connectors
via native Groq tool-calling, convenes the room's personas for a real debate
(independent persona sub-calls — support + skepticism) when a decision is
warranted, and produces a grounded synthesis. The orchestrator wraps this with
the EXISTING centralized producer (`_produce_output`), verify, approval drain and
seal — so tenancy, schema, FE event contract and connector seams are unchanged.

Tenancy is NEVER owned here: the engine receives the resolved org/user/project
scope and passes it on every recall/connector call (via `hivemind_client`'s
emulation headers), exactly as the legacy swarm did.
"""

from .engine import run_director  # noqa: F401
