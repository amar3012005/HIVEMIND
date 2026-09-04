#!/usr/bin/env node
/**
 * Non-mutating production canary for the durable Composio chat release.
 *
 * Default mode only proves health and the fail-closed Flagship gate.  A live
 * read canary is opt-in and rejects any prompt that looks like a write.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const api = String(process.env.HIVEMIND_CANARY_API_URL || 'https://api.singulancelabs.com').replace(/\/$/, '');
const flagUrl = String(process.env.USE_TOOLS_DURABLE_AGENT_FLAG_URL
  || 'https://admin.hivemind.singulancelabs.com/__hivemind/feature-flags/use-tools-durable-agent');

if (args.has('--help')) {
  console.log(`Usage:
  node scripts/composio-durable-curl-canary.mjs
  HIVEMIND_CANARY_BEARER=... node scripts/composio-durable-curl-canary.mjs --live-read

Default: GET /health and the Flagship durable-agent gate only.
--live-read: submits a read-only Gmail prompt with use_tools:true. It never
creates, sends, posts, labels, deletes, or approves an external action.`);
  process.exit(0);
}

async function curlJson(url, { method = 'GET', headers = {}, body } = {}) {
  const argv = ['--fail-with-body', '--silent', '--show-error', '--max-time', '15', '-X', method, url];
  for (const [key, value] of Object.entries(headers)) argv.push('-H', `${key}: ${value}`);
  if (body) argv.push('--data', JSON.stringify(body), '-H', 'content-type: application/json');
  const { stdout } = await execFileAsync('curl', argv, { maxBuffer: 1_000_000 });
  return JSON.parse(stdout);
}

const health = await curlJson(`${api}/health`);
if (!health?.ok) throw new Error('health_not_ok');
console.log(`PASS health ${api}`);

const flag = await curlJson(flagUrl);
if (flag?.key !== 'use-tools-durable-agent' || flag?.source !== 'cloudflare-flagship') {
  throw new Error('invalid_durable_agent_flag_contract');
}
console.log(`PASS Flagship gate enabled=${Boolean(flag.enabled)}`);

if (!args.has('--live-read')) process.exit(0);
const bearer = String(process.env.HIVEMIND_CANARY_BEARER || '').trim();
if (!bearer) throw new Error('HIVEMIND_CANARY_BEARER is required with --live-read');
const intent = 'Show the most important unread Gmail emails from the last month.';
const prompt = `${intent} Do not send, draft, modify, label, archive, or delete anything.`;
if (/\b(send|draft|post|delete|label|archive|approve|create)\b/i.test(intent)) throw new Error('write_like_canary_prompt_rejected');
const result = await curlJson(`${api}/api/chat`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}` },
  body: { message: prompt, use_tools: true, thread_id: `durable-canary-${Date.now()}` },
});
if (result?.draft_ids?.length || result?.pending_actions?.length) throw new Error('unexpected_write_draft_in_read_canary');
console.log(`PASS live read status=${result?.compound_status || result?.execution?.status || 'unknown'}`);
