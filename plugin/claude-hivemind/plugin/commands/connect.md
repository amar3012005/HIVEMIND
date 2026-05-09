---
description: Sign in to HIVEMIND. Opens a browser, completes OAuth via Zitadel SSO or Google, and stores an API key locally so the MCP server can use it on every session.
allowed-tools: ["Bash"]
---

# /hivemind:connect — Sign in to HIVEMIND

Run the OAuth loopback flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/auth.cjs"
```

What this does:

1. Spawns a one-shot http server on `http://localhost:19876`.
2. Opens your default browser to `https://api.hivemind.davinciai.eu:8040/auth/cli?callback=http://localhost:19876/callback&client=claude_code`.
3. Backend authenticates via Zitadel SSO or Google (whichever is configured for your org).
4. On success, redirects back to `http://localhost:19876/callback?apikey=hm_...&user_id=...`.
5. Plugin saves credentials to `~/.hivemind-claude/credentials.json` (mode 600).
6. MCP server picks up `HIVEMIND_API_KEY` + `HIVEMIND_USER_ID` from env on the next session.

After this command completes, restart your Claude Code session (or run `/mcp` to refresh) so the HIVEMIND MCP picks up the new credentials.

Once connected, all 22 HIVEMIND tools become available:

**Memory (9):** save_memory, recall, get_memory, list_memories, update_memory, delete_memory, save_conversation, traverse_graph, query_with_ai

**Web Intelligence (4):** web_search, web_crawl, web_job_status, web_usage

**Coding Intelligence (6):** ingest_code, recall_bugs, log_decision, track_refactor, test_coverage, why_code

**Time Travel (3):** code_at, code_diff, code_timeline
