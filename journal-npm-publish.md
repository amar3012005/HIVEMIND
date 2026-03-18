---

## 2026-03-18 01:05 UTC - NPM Package PUBLISHED

### Success!

`@amar_528/mcp-bridge@2.0.0` is now live on NPM.

**URL**: https://www.npmjs.com/package/@amar_528/mcp-bridge

### Usage

```bash
npx @amar_528/mcp-bridge --version
# 2.0.0
```

### Antigravity Config

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@amar_528/mcp-bridge"],
      "env": {
        "HIVEMIND_API_URL": "https://hivemind.davinciai.eu",
        "HIVEMIND_API_KEY": "hm_master_key_99228811",
        "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

### Files Published

- `dist/cli.js` - CLI entrypoint
- `dist/server.ts` - Zod validation server
- `README.md` - Documentation
- `LICENSE` - MIT

### Next Steps

1. Test with `npx @amar_528/mcp-bridge --version`
2. Update antigravity config
3. Verify Claude Desktop connects
