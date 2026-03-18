---

## 2026-03-18 13:00 UTC - NPM Bridge v2.0.5 PUBLISHED

### Summary
Successfully published `@amar_528/mcp-bridge@2.0.5` to NPM.

**Package URL**: https://www.npmjs.com/package/@amar_528/mcp-bridge

### What Was Fixed

1. **ESM Bin Symlink Issue**: npm doesn't reliably create bin symlinks for ESM modules
   - Workaround: Use direct node execution or global install + node

2. **Added Module Exports**: Exported functions for programmatic usage
   - `runHostedBridge()`
   - `runLocalBridge()`
   - `loadConfig()`
   - `BridgeConfig` interface

3. **Updated README**: Documented working configuration options

### Working Antigravity Configuration

**Option 1: Direct Node Execution (Most Reliable)**

Install the package globally first:
```bash
npm install -g @amar_528/mcp-bridge
```

Then add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/@amar_528/mcp-bridge/dist/cli.js"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu:8050",
        "HIVEMIND_API_KEY": "hm_master_key_99228811",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

**Note**: The HIVEMIND API URL includes port 8050 (`https://hivemind.davinciai.eu:8050`)

### Quick Setup for Antigravity

```bash
# 1. Install package
npm install -g @amar_528/mcp-bridge

# 2. Test installation
node /usr/local/lib/node_modules/@amar_528/mcp-bridge/dist/cli.js --version

# 3. Find the actual path
npm root -g
# Use this path in claude_desktop_config.json
```

### Files Published

- `dist/cli.js` - Main CLI with stdio MCP bridging
- `dist/server.js` - Zod validation server module
- `dist/wrapper.js` - npx wrapper helper
- `README.md` - Usage documentation
- `LICENSE` - MIT

### Versions Published

| Version | Status | Notes |
|---------|--------|-------|
| 2.0.0 | Published | Initial release |
| 2.0.1 | Published | Fixed bin naming |
| 2.0.2 | Published | Removed invalid bins |
| 2.0.3 | Published | Attempted bin fix |
| 2.0.4 | Published | Fixed main entry |
| 2.0.5 | Published | Added exports, updated README |

### Next Steps for Antigravity

1. Install package: `npm install -g @amar_528/mcp-bridge`
2. Test CLI: `node $(npm root -g)/@amar_528/mcp-bridge/dist/cli.js --version`
3. Update claude_desktop_config.json with working config
4. Verify MCP tools appear in Claude Desktop

### Infrastructure Notes

The bridge connects:
- **Claude Desktop/Cursor** (MCP clients)
- **HIVE-MIND API** (Hetzner Cloud, Falkenstein, Germany)
- **PostgreSQL + Qdrant** (Memory storage + vectors)

All data remains in EU, satisfying GDPR requirements.
