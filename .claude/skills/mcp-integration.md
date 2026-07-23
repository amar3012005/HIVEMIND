# MCP Integration

MCP is a transport over canonical HIVEMIND capabilities, not a second memory or
connector engine. Reuse the existing authenticated Core tools for recall, chat
context, save/update, graph/time travel, and connectors.

Requirements:

- server-derived user/org/project authorization;
- schema validation and bounded inputs;
- same provenance, canonical ingestion, citations, usage, and audit behavior;
- write approval/idempotency for side effects;
- parity tests against the HTTP API and tenant-isolation denial tests.

Discover current MCP entrypoints with code-review-graph and source. Do not use
historical `davinciai.eu`, `/opt/HIVEMIND`, or hardcoded server paths.
