// Cursor IDE — ~/.cursor/mcp.json (project-level: <repo>/.cursor/mcp.json).
// We install user-scope so it works across all projects. Cursor accepts the
// Universal HTTP shape with transport:"http" at the top of the server entry.
import path from 'node:path';
import { homeDir, readJSON, writeJSON, setDeep } from '../lib/config.js';

function configPath() {
  return path.join(homeDir(), '.cursor', 'mcp.json');
}

export const cursor = {
  id: 'cursor',
  name: 'Cursor',
  note: '~/.cursor/mcp.json — HTTP transport',
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
    return 'Open Cursor → Settings → MCP. Toggle HIVEMIND on if not auto-enabled, then restart Cursor.';
  },
};
