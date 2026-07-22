# Connectors — quick state (full doc: ../decision-docs/connector_tools.md)

Connector Runtime V1 is the ONE canonical authority for every provider: one plugin
per provider (`core/src/connectors/runtime/plugins/<id>/index.js`), one schema per
tool, one approval/audit/execution path, projected to Chat / MCP gateway / HyperAgents /
TARA / durable-sync. Canonical tool naming `<connector>__<operation>`; legacy names are
inbound aliases only. Never a monolith.

**Live (prod-20260722-rmye01367541):** 7 connectors / 35 tools —
gmail, google_docs, google_sheets (direct via `runGoogleTool`); slack, notion, github,
linear (MCP-backed via `McpBackedPlugin` + `mcpRead`/`mcpWrite`).

**Flags** (in `/root/hivemind/.env`): ENABLED on, MCP on (gateway verified — capability
200, 7 connectors offered), CHAT on (fall-through-safe), HYPER on (employees image has the
AgentScope MCP projection), TARA baked+env-gated (voice-safe read-only), SYNC mounted but off.

**Open (non-blocking):** refine notion/github/linear provider tool-names at first live MCP
`tools/list` inspect (wrong name → structured result, never a crash); approval convergence
(Hyper ContextVar → shared PendingWrite); audit on legacy exec routes; P11 legacy removal
only after scale-proven.

See the full decision-doc for the file map, per-tool table, approval mechanics, and verify commands:
[../decision-docs/connector_tools.md](../decision-docs/connector_tools.md)
