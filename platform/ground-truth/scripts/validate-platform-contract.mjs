import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = await readFile(path.join(root, 'platform.yaml'), 'utf8');
const delivery = await readFile(path.join(root, 'delivery-contract.md'), 'utf8');
const capabilities = await readFile(path.join(root, 'capability-contracts.md'), 'utf8');

for (const expected of [
  'version: 1',
  'hivemind_harness_chat_v1',
  'harness: Native Cordis/Harness conversation mode.',
  'legacy: Existing LangGraph/LangChain chat orchestrator.',
  'unknown_value_behavior: legacy',
  'singulance_local:',
  'enigma:',
  'singulance_production:',
]) assert.ok(platform.includes(expected), `platform.yaml missing ${expected}`);

for (const expected of [
  'Full scope',
  'Write scope is never “Full scope.”',
  'Composio owns provider discovery',
  'scoped plugin',
]) assert.ok(capabilities.includes(expected), `capability contract missing ${expected}`);

for (const expected of [
  'harness` → native Cordis/Harness',
  'legacy`, absent, or unrecognized → LangGraph/LangChain',
  'No client should load native Harness assets for a legacy admission.',
  'release lock',
]) assert.ok(delivery.includes(expected), `delivery contract missing ${expected}`);

console.log('platform ground-truth contract: valid');
