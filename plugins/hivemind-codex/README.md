# HIVE-MIND Codex Plugin

This plugin exposes the live HIVE-MIND MCP bridge to Codex.

## MCP configuration

- The server definition lives in [`.mcp.json`](./.mcp.json)
- The bridge uses the hosted descriptor URL and your `HIVEMIND_API_KEY`
- The API key is stored locally in the plugin MCP config for Codex use only

## What Codex gets

- `hivemind_web_search`
- `hivemind_web_crawl`
- `hivemind_web_job_status`
- `hivemind_web_usage`
- `hivemind_save_memory`
- `hivemind_recall`
- `hivemind_get_memory`
- `hivemind_list_memories`
- `hivemind_update_memory`
- `hivemind_delete_memory`
- `hivemind_save_conversation`
- `hivemind_traverse_graph`
- `hivemind_query_with_ai`

## Notes

- This is a Codex-only plugin wrapper.
- It does not modify HIVE-MIND core, control plane, or production connector code.
