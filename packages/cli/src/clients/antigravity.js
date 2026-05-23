// Google Antigravity — VS Code-style mcp-servers.json under the User dir.
// macOS:   ~/Library/Application Support/Antigravity/User/mcp-servers.json
// Linux:   ~/.config/Antigravity/User/mcp-servers.json
// Windows: %APPDATA%/Antigravity/User/mcp-servers.json
//
// Schema:
// { "servers": { "hivemind": { "type": "http", "url": ..., "headers": {...} } } }
//
// NOTE: The legacy ~/.antigravity/mcp.json file is NOT read by Antigravity — it
// is an unrelated VS Code-fork settings dir. Writing there silently no-ops at
// the IDE level.
import path from 'node:path';
import { homeDir, readJSON, writeJSON, setDeep } from '../lib/config.js';

function configPath() {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'Antigravity', 'User', 'mcp-servers.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'User', 'mcp-servers.json');
  }
  // linux / *bsd
  const xdg = process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
  return path.join(xdg, 'Antigravity', 'User', 'mcp-servers.json');
}

export const antigravity = {
  id: 'antigravity',
  name: 'Antigravity',
  note: 'Application Support/Antigravity/User/mcp-servers.json — HTTP transport',
  configPath,
  async install({ endpoint, apiKey }) {
    const p = configPath();
    const root = readJSON(p);
    setDeep(root, 'servers.hivemind', {
      type: 'http',
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    writeJSON(p, root);
    return { path: p };
  },
  postInstall() {
    return 'Quit Antigravity fully (Cmd+Q) and reopen. The HIVEMIND server should appear under MCP Tools.';
  },
};
