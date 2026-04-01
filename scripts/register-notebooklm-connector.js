#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const registryPath = path.resolve(process.cwd(), 'data/mcp-connectors.json');
const notebooklmHome = process.env.NOTEBOOKLM_HOME || path.resolve(process.env.HOME || '.', '.notebooklm');
const notebooklmProfile = process.env.NOTEBOOKLM_PROFILE || 'default';
const userId = process.env.HIVEMIND_USER_ID || process.env.USER_ID || null;
const orgId = process.env.HIVEMIND_ORG_ID || process.env.ORG_ID || null;

function ensureFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]\n', 'utf8');
  }
}

function readRegistry(filePath) {
  ensureFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeRegistry(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const endpoint = {
  name: 'notebooklm',
  transport: 'stdio',
  command: 'node',
  args: ['mcp-server/notebooklm-mcp-server.js'],
  cwd: process.cwd(),
  env: {
    NOTEBOOKLM_BIN: process.env.NOTEBOOKLM_BIN || 'notebooklm',
    NOTEBOOKLM_HOME: notebooklmHome,
    NOTEBOOKLM_PROFILE: notebooklmProfile,
    NOTEBOOKLM_DEFAULT_NOTEBOOK_TITLE: process.env.NOTEBOOKLM_DEFAULT_NOTEBOOK_TITLE || 'Second Mind',
    NOTEBOOKLM_AUTO_CREATE_DEFAULT_NOTEBOOK: process.env.NOTEBOOKLM_AUTO_CREATE_DEFAULT_NOTEBOOK || '1',
    NOTEBOOKLM_TIMEOUT_MS: process.env.NOTEBOOKLM_TIMEOUT_MS || '120000',
    NOTEBOOKLM_RESEARCH_TIMEOUT_MS: process.env.NOTEBOOKLM_RESEARCH_TIMEOUT_MS || '600000',
  },
  headers: {},
  adapter_type: 'notebooklm',
  default_project: process.env.NOTEBOOKLM_DEFAULT_PROJECT || 'research',
  default_tags: ['notebooklm', 'research', 'second-mind'],
};

if (userId) {
  endpoint.user_id = userId;
}

if (orgId) {
  endpoint.org_id = orgId;
}

const registry = readRegistry(registryPath);
const next = registry.filter(item => item.name !== endpoint.name);
next.push({
  ...endpoint,
  updated_at: new Date().toISOString(),
});
writeRegistry(registryPath, next);

console.log(`Registered NotebookLM connector in ${registryPath}`);
