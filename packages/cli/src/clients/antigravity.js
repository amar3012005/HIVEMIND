// Google Antigravity — JSON config at ~/.antigravity/mcp.json.
// Same mcpServers.<name> shape as Cursor.
import path from 'node:path';
import { homeDir, readJSON, writeJSON, setDeep } from '../lib/config.js';

function configPath() {
  return path.join(homeDir(), '.antigravity', 'mcp.json');
}

export const antigravity = {
  id: 'antigravity',
  name: 'Antigravity',
  note: '~/.antigravity/mcp.json — HTTP transport',
  configPath,
  async install({ endpoint, apiKey }) {
    const p = configPath();
    const root = readJSON(p);
    setDeep(root, 'mcpServers.hivemind', {
      transport: 'http',
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    writeJSON(p, root);
    return { path: p };
  },
  postInstall() {
    return 'Restart Antigravity. The HIVEMIND server should appear under MCP Tools.';
  },
};
