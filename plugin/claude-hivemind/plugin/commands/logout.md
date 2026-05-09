---
description: Sign out from HIVEMIND and remove cached credentials.
allowed-tools: ["Bash"]
---

# /hivemind:logout — Sign out

Clear local credentials so the MCP server stops authenticating:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/logout.cjs"
```

This deletes `~/.hivemind-claude/credentials.json`. Your memories on the server are untouched. To delete server-side data, use the dashboard at https://hivemind.davinciai.eu/hivemind/app/profile.
