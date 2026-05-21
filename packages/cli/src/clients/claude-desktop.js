// Claude Desktop — JSON config under per-OS Application Support path.
//
// Path resolution mirrors Anthropic's docs:
//   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Windows: %APPDATA%/Claude/claude_desktop_config.json
//   Linux:   ~/.config/Claude/claude_desktop_config.json   (unofficial, but
//            matches what the AppImage build uses)
//
// We write the "Universal HTTP" shape (type: http + headers.Authorization)
// — Claude Desktop 0.7+ speaks Streamable HTTP natively, no mcp-remote bridge
// needed. Older 0.6.x users should pick claude-code instead; we don't try to
// detect version because Claude Desktop has no `--version` flag.
import path from 'node:path';
import { homeDir, platform, readJSON, writeJSON, setDeep } from '../lib/config.js';

function configPath() {
  const home = homeDir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

export const claudeDesktop = {
  id: 'claude-desktop',
  name: 'Claude Desktop',
  note: 'claude_desktop_config.json — Universal HTTP transport',
  configPath,
  async install({ endpoint, apiKey }) {
    const p = configPath();
    const root = readJSON(p);
    setDeep(root, 'mcpServers.hivemind', {
      type: 'http',
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    writeJSON(p, root);
    return { path: p };
  },
  postInstall() {
    return 'Fully quit Claude Desktop (Cmd+Q on macOS) and reopen it. Then ask: "What MCP tools do you have?"';
  },
};
