// Shared config + JSON / TOML helpers used by every client adapter.
// JSON merge here is conservative: read → parse → upsert → write atomically
// to a sibling tmp file then rename, so a crashed CLI never leaves a partial
// claude_desktop_config.json that would brick the host app on next launch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_ENDPOINT =
  process.env.HIVEMIND_ENDPOINT ||
  'https://core.hivemind.davinciai.eu:8050/api/mcp';

/**
 * Read JSON file. Missing or empty → {}. Throws on truly malformed JSON
 * because silently nuking the user's existing config is worse than an error.
 */
export function readJSON(p) {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf-8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Existing config at ${p} is not valid JSON (${err.message}). ` +
      `Refusing to overwrite — fix or move the file and retry.`
    );
  }
}

/**
 * Atomic JSON write. Pretty-printed with 2-space indent so humans can diff
 * the file after the install.
 */
export function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.hivemind-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * Walk a dotted-path key (e.g. "mcp.servers.hivemind") on `root`, setting
 * the leaf to `value`. Intermediate objects are created on demand. Existing
 * sibling keys are preserved.
 */
export function setDeep(root, dotted, value) {
  const parts = dotted.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

/**
 * Strip a TOML `[section]` block from a document so we can rewrite it
 * cleanly. Codex uses this — its config.toml grows over time and we only
 * want to touch our own `[mcp_servers.hivemind]` block.
 */
export function stripTomlSection(doc, section) {
  const header = `[${section}]`;
  const idx = doc.indexOf(header);
  if (idx < 0) return doc;
  let end = idx + header.length;
  while (end < doc.length) {
    if (doc[end] === '\n' && doc[end + 1] === '[') break;
    end++;
  }
  return doc.slice(0, idx) + doc.slice(end);
}

export function homeDir() {
  return os.homedir();
}

export function platform() {
  return process.platform;
}
