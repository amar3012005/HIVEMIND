# Local-only. Does not replace production hivemind/harness-chat.
# Reuses the existing runner image, unlocks every shipped agent mode, and
# lays out an org sandbox with per-user workspace isolation.
ARG HARNESS_BASE=hivemind/harness-chat:c874825a6f57e38c073f53b5f9da88c93403ff2c
FROM ${HARNESS_BASE}
USER root
RUN node <<'NODE'
const fs = require('fs');
const { execSync } = require('child_process');
const p = '/opt/deepseek-harness/packages/bundle/hivemind-web-app/cordis.patch.yml';
let y = fs.readFileSync(p, 'utf8');
if (!y.includes('allowed: [hivemind-chat]')) throw new Error('unexpected hivemind-web-app patch');
y = y.replace('includeUserRoot: false', 'includeUserRoot: false');
y = y.replace(
  'allowed: [hivemind-chat]',
  'allowed: [hivemind-chat, hyperagents, hivemind, standard, ptc, cordis, minimal]',
);
y = y.replace(/\n- id: llm-pi-ai\n  config:\n    providers:[\s\S]*?(?=\n- id: )/, '\n');
y = y.replace(/\n- id: agent-default-model\n  config:\n    provider: cloudflare-openrouter\n    model: [^\n]+\n/, '\n');
y = y.replace(/\n- id: plugin-inventory\n  disabled: true\n/, '\n');
if (!y.includes('\n- id: client-hmr\n')) y += '\n- id: hmr\n  disabled: true\n- id: client-hmr\n  disabled: true\n';
if (y.includes('cloudflare-openrouter')) throw new Error('cloudflare-openrouter still in patch');
fs.writeFileSync(p, y);
const presetRoot = '/opt/deepseek-harness/packages/preset/agent-presets/presets';
for (const file of execSync(`find ${presetRoot} -name agent.cordis.yml`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
  let t = fs.readFileSync(file, 'utf8');
  t = t.replace(/(- id: (?:hivemind-)?tool-skill\n  name: '@deepseek-ai\/dsh-tool-skill')/g, '$1\n  disabled: true');
  fs.writeFileSync(file, t);
}
const files = execSync("grep -rl 'dsh web authentication required' /opt/deepseek-harness --include='*.js'", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
if (files.length === 0) throw new Error('browser-auth string missing');
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  let t = before.replace(/this\.writeUnauthorized\(req, res\);\s*return false/g, 'return true');
  if (t === before) t = before.replace(/authorizeIndex\s*\([^)]*\)\s*\{/, (m) => `${m}return true;`);
  t = t.replace(/isAuthenticated\s*\(\s*request\s*\)\s*\{/, 'isAuthenticated(request){return true;');
  if (t === before) throw new Error('could not open dsh web gate in ' + file);
  fs.writeFileSync(file, t);
}
const settingsHits = [
  ...execSync("grep -rl \"'host' : 'memory'\" /opt/deepseek-harness --include='*.js' || true", { encoding: 'utf8' }).trim().split('\n'),
  ...execSync('grep -rl \'"host":"memory"\' /opt/deepseek-harness --include=\'*.js\' || true', { encoding: 'utf8' }).trim().split('\n'),
].filter(Boolean);
if (settingsHits.length === 0) throw new Error('settings loopback persistence ternary missing');
for (const file of [...new Set(settingsHits)]) {
  const before = fs.readFileSync(file, 'utf8');
  const t = before
    .replaceAll("ctx.remote.$host.isLoopback ? 'host' : 'memory'", "'host'")
    .replaceAll('ctx.remote.$host.isLoopback?"host":"memory"', '"host"');
  if (t === before) throw new Error('could not force host settings persistence in ' + file);
  fs.writeFileSync(file, t);
}
const loopbackHits = execSync("grep -rl 'isLoopbackHostname(pageLocation.hostname)' /opt/deepseek-harness --include='*.js' || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (loopbackHits.length === 0) throw new Error('connection isLoopbackHostname ternary missing');
for (const file of loopbackHits) {
  const before = fs.readFileSync(file, 'utf8');
  const t = before.replaceAll('isLoopbackHostname(pageLocation.hostname)', 'true');
  if (t === before) throw new Error('could not force isLoopback on ' + file);
  fs.writeFileSync(file, t);
}
const rpc = execSync("grep -rl 'isAuthenticated(request)' /opt/deepseek-harness/packages/client/connection --include='*.js' || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const file of rpc) {
  const before = fs.readFileSync(file, 'utf8');
  const t = before.replace(
    /this\.browserAuth\.isAuthenticated\(request\) \? undefined : 401/g,
    'undefined',
  );
  if (t !== before) fs.writeFileSync(file, t);
}
const fallback = "{ const orgId=process.env.HIVEMIND_ORG_ID; const userId=process.env.HIVEMIND_USER_ID||orgId; if(!orgId||!userId) throw new Error('hivemind execution scope is unavailable'); return Object.freeze({orgId,userId,profile:'hivemind-chat',variation:'default'}); }";
const scopeFiles = execSync("grep -rl 'hivemind execution scope is unavailable' /opt/deepseek-harness --include='*.js'", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
if (scopeFiles.length === 0) throw new Error('execution-scope string missing');
for (const file of scopeFiles) {
  const before = fs.readFileSync(file, 'utf8');
  let t = before.replaceAll("throw new Error('hivemind execution scope is unavailable')", fallback);
  t = t.replaceAll('throw new Error("hivemind execution scope is unavailable")', fallback);
  if (t === before) throw new Error('could not patch execution scope in ' + file);
  fs.writeFileSync(file, t);
}
NODE
COPY ensure-org-fs.mjs /opt/byod/ensure-org-fs.mjs
COPY entrypoint-byod.sh /opt/byod/entrypoint-byod.sh
COPY brand-rewrite.mjs /opt/byod/brand-rewrite.mjs
COPY brand/singulance.css /opt/deepseek-harness/apps/web/dist/singulance.css
COPY virtual-workspace-box.js /opt/deepseek-harness/packages/hivemind/virtual-workspace/lib/index.js
RUN node /opt/byod/brand-rewrite.mjs \
  && chmod 755 /opt/byod/entrypoint-byod.sh /opt/byod/ensure-org-fs.mjs
USER node
ENTRYPOINT ["/opt/byod/entrypoint-byod.sh"]
