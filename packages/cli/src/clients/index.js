// Registry of every supported MCP host. Each client exports:
//
//   id          stable slug used in CLI args + the FE Connectors page
//   name        human label printed in interactive picker
//   note        one-line subtitle shown in picker (what gets configured)
//   configPath  fn(): absolute path the install will touch
//   install(cfg) writes/merges the HIVEMIND MCP entry idempotently
//   postInstall optional fn returning hint string (e.g. "fully quit Claude")
//
// Adding a new client = one new file in src/clients/ + register here.
import { claudeDesktop } from './claude-desktop.js';
import { claudeCode } from './claude-code.js';
import { cursor } from './cursor.js';
import { vscode } from './vscode.js';
import { codex } from './codex.js';
import { antigravity } from './antigravity.js';

export const CLIENTS = [
  claudeCode,
  claudeDesktop,
  cursor,
  vscode,
  codex,
  antigravity,
];

export function findClient(id) {
  return CLIENTS.find((c) => c.id === id);
}
