# HIVEMIND feature inventory

One file per user-facing feature. Each records what the FE calls, what the
backend does, and the production guardrails — VERIFIED or MISSING, with evidence.

**Auditing rules learned the hard way (do not skip):**
- Scoped API key for core `:2026`; session Bearer for control-plane `:2027`.
  `X-Org-Id`/`X-User-Id` are CORS entries, NOT auth — probes using them run
  unscoped and return empty results that look exactly like a broken feature.
- Check dates before concluding a defect: most zero-counts in this DB are
  historical data, not current behaviour.
- Verify a claim against running code before reporting it.

| feature | group | route | endpoints | status |
|---|---|---|---|---|
| [Overview](overview.md) | Your Brain | `/hivemind/app/overview` | 5 | UNAUDITED |
| [Connectors](connectors.md) | Your Brain | `/hivemind/app/connectors` | 30 | UNAUDITED |
| [Memories](memories.md) | Your Brain | `/hivemind/app/memories` | 12 | UNAUDITED |
| [AI Meeting Notes](meeting-notes.md) | Your Brain | `/hivemind/app/meeting-notes` | 0 | UNAUDITED |
| [Memory Graph](memory-graph.md) | Your Brain | `/hivemind/app/graph` | 7 | UNAUDITED |
| [Knowledge Base](knowledge-base.md) | Your Brain | `/hivemind/app/knowledge` | 8 | **PARTIAL** — 3 fixed, 1 open |
| [Workspace Admin](workspace-admin.md) | Workspace Admin | `/hivemind/app/workspace` | 9 | UNAUDITED |
| [Team Members](team-members.md) | Workspace Admin | `/hivemind/app/team/members` | 3 | UNAUDITED |
| [Projects](projects.md) | Workspace Admin | `/hivemind/app/team/projects` | 7 | UNAUDITED |
| [Cognitive Layer](cognitive-layer.md) | Workspace Admin | `/hivemind/app/engine` | 5 | UNAUDITED |
| [Web Intel](web-intel.md) | AI Features | `/hivemind/app/web` | 13 | UNAUDITED |
| [MCP Server](mcp-server.md) | Advanced | `/hivemind/app/mcp` | 0 | UNAUDITED |
| [API Keys](api-keys.md) | Advanced | `/hivemind/app/keys` | 3 | UNAUDITED |
| [Evaluation](evaluation.md) | Advanced | `/hivemind/app/evaluation` | 7 | UNAUDITED |
| [Profile](profile.md) | Account | `/hivemind/app/profile` | 4 | UNAUDITED |
| [Usage](usage.md) | Account | `/hivemind/app/usage` | 2 | UNAUDITED |
| [Billing](billing.md) | Account | `/hivemind/app/billing` | 10 | UNAUDITED |
| [Settings](settings.md) | Account | `/hivemind/app/settings` | 0 | UNAUDITED |
| [HyperAgents Rooms + Runtime](hyperagents.md) | Operating System | `/hivemind/app/employees` | 45 | UNAUDITED |
| [Agent Swarm + Governance](swarm.md) | Operating System | `/hivemind/app/swarm` | 12 | UNAUDITED |
| [TARA Voice](tara.md) | Voice | `/hivemind/app/tara` | 9 | UNAUDITED |
| [Talk to HIVE (chat)](chat.md) | Your Brain | `/hivemind/app/overview` | 2 | UNAUDITED |
