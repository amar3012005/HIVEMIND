#!/usr/bin/env node
/**
 * Removes ~/.hivemind-claude/credentials.json so the MCP server stops
 * authenticating. Server-side memories are untouched.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CREDENTIALS_FILE = path.join(
  os.homedir(),
  '.hivemind-claude',
  'credentials.json'
);

try {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
    console.log('✓ HIVEMIND credentials removed:', CREDENTIALS_FILE);
  } else {
    console.log('No HIVEMIND credentials found (already signed out).');
  }
  console.log(
    'Server-side memories are untouched. Visit https://hivemind.davinciai.eu/hivemind/app/profile to delete them.'
  );
} catch (err) {
  console.error('logout failed:', err.message);
  process.exit(1);
}
