#!/usr/bin/env node
/**
 * SessionStart hook — loads credentials from
 * ~/.hivemind-claude/credentials.json and emits the env vars HIVEMIND_API_KEY
 * and HIVEMIND_USER_ID via Claude Code's hookSpecificOutput.additionalEnv
 * mechanism so the MCP bridge can read them.
 *
 * If no credentials exist, prints a notice telling the user to run
 * /hivemind:connect. Never fails the session — auth is opt-in.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CREDENTIALS_FILE = path.join(
  os.homedir(),
  '.hivemind-claude',
  'credentials.json'
);

function loadCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    if (!data.apiKey || !data.userId) return null;
    return data;
  } catch {
    return null;
  }
}

const creds = loadCredentials();

if (!creds) {
  // Tell the user how to authenticate. Don't block the session.
  const out = {
    systemMessage:
      'HIVEMIND not connected. Run /hivemind:connect to authenticate (opens browser, ~30s). MCP tools will be unavailable until then.',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'HIVEMIND MCP not authenticated. The user can run /hivemind:connect to sign in. Until then, do not call any hivemind_* tools — they will fail with 401.',
    },
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}

// Emit env vars for the MCP bridge.
const out = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalEnv: {
      HIVEMIND_API_KEY: creds.apiKey,
      HIVEMIND_USER_ID: creds.userId,
      HIVEMIND_ORG_ID: creds.orgId || '',
      HIVEMIND_CONTROL_PLANE:
        creds.controlPlane || 'https://api.hivemind.davinciai.eu:8040',
      HIVEMIND_CORE_API:
        creds.coreApi || 'https://core.hivemind.davinciai.eu:8050',
    },
    additionalContext:
      'HIVEMIND MCP authenticated. 22 tools live: memory (9), web (4), coding (6), time-travel (3). Use them aggressively per the memory-discipline skill.',
  },
};
console.log(JSON.stringify(out));
process.exit(0);
