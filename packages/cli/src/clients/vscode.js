// VS Code — user settings.json under mcp.servers.<name>.
//   macOS:   ~/Library/Application Support/Code/User/settings.json
//   Windows: %APPDATA%/Code/User/settings.json
//   Linux:   ~/.config/Code/User/settings.json
//
// settings.json is JSON-with-comments in practice but the file VS Code emits
// is plain JSON when never edited by hand. We use the same conservative read
// → parse path; if it throws (because of //-comments), we surface that and
// ask the user to manually paste the config block.
import path from 'node:path';
import { homeDir, platform, readJSON, writeJSON, setDeep } from '../lib/config.js';

function configPath() {
  const home = homeDir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
    default:
      return path.join(home, '.config', 'Code', 'User', 'settings.json');
  }
}

export const vscode = {
  id: 'vscode',
  name: 'VS Code',
  note: 'User settings.json → mcp.servers.hivemind',
  configPath,
  async install({ endpoint, apiKey }) {
    const p = configPath();
    const root = readJSON(p);
    setDeep(root, 'mcp.servers.hivemind', {
      type: 'http',
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    writeJSON(p, root);
    return { path: p };
  },
  postInstall() {
    return 'Restart VS Code. Open the Command Palette → "MCP: List Servers" to verify HIVEMIND appears.';
  },
};
