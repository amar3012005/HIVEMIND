// OpenAI Codex CLI — TOML config at ~/.codex/config.toml.
// Codex reads `[mcp_servers.<name>]` blocks. We strip any existing
// hivemind block then append a fresh one so re-running this command is
// safe (no duplicates).
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, stripTomlSection } from '../lib/config.js';

function configPath() {
  return path.join(homeDir(), '.codex', 'config.toml');
}

export const codex = {
  id: 'codex',
  name: 'Codex',
  note: '~/.codex/config.toml → [mcp_servers.hivemind]',
  configPath,
  async install({ endpoint, apiKey }) {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    const stripped = stripTomlSection(existing, 'mcp_servers.hivemind');
    const block =
      '\n[mcp_servers.hivemind]\n' +
      'type = "http"\n' +
      `url = "${endpoint}"\n` +
      `headers = { Authorization = "Bearer ${apiKey}" }\n`;
    fs.writeFileSync(p, (stripped.trimEnd() + '\n' + block).trimStart(), { mode: 0o600 });
    return { path: p };
  },
  postInstall() {
    return 'Restart any open Codex sessions to pick up the new MCP server.';
  },
};
