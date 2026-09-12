import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/refresh-harness-chat-dev', import.meta.url));
const packages = ['hivemind/context', 'hivemind/memory', 'hivemind/runtime', 'hivemind/connected-apps', 'session/session-persistence-postgres', 'client/ui-hivemind-connect'];

function run(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hive-refresh-test-'));
  try {
    const source = join(root, 'harness');
    const bin = join(root, 'bin');
    const capture = join(root, 'calls');
    mkdirSync(bin);
    for (const pkg of packages) {
      const lib = join(source, 'packages', pkg, 'lib');
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(lib, 'index.js'), 'export {};');
      writeFileSync(join(lib, 'client.js'), 'export {};');
    }
    const bundleConfig = join(source, 'packages/bundle/hivemind-web-app/cordis.patch.yml');
    mkdirSync(join(bundleConfig, '..'), { recursive: true });
    writeFileSync(bundleConfig, 'plugins: []\n');
    const envFile = join(root, 'preview.env');
    writeFileSync(envFile, `HIVEMIND_HARNESS_SOURCE='${source}'\n`);
    writeFileSync(capture, '');
    const shim = `#!${process.execPath}
const fs=require('fs');
const tool=require('path').basename(process.argv[1]);
const args=process.argv.slice(2);
fs.appendFileSync(process.env.CAPTURE, JSON.stringify([tool,...args])+'\\n');
if(tool==='docker' && args[0]==='inspect') {
  const format=args[args.indexOf('-f')+1] || '';
  const all=args.join(' ');
  if(all.includes('.Mounts')) console.log(JSON.stringify([
    ...${JSON.stringify(packages)}.map(p=>({Destination:'/opt/deepseek-harness/packages/'+p+'/lib',Source:process.env.SOURCE+'/packages/'+p+'/lib'})),
    {Destination:'/opt/deepseek-harness/packages/bundle/hivemind-web-app/cordis.patch.yml',Source:process.env.SOURCE+'/packages/bundle/hivemind-web-app/cordis.patch.yml'}
  ]));
  else if(all.includes('compose.project')) console.log(process.env.BAD_PROJECT?'production':'hivemind-chat-local');
  else if(all.includes('compose.service')) console.log('harness-runner');
  else console.log('healthy');
}
if(tool==='pnpm' && args.includes('tsc') && process.env.FAIL_TSC) process.exit(9);
`;
    for (const tool of ['docker', 'pnpm', 'curl']) writeFileSync(join(bin, tool), shim, { mode: 0o755 });
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HIVEMIND_CHAT_ENV_FILE: envFile, HIVEMIND_SKIP_PACKAGE_BUILD: '0', SOURCE: source, CAPTURE: capture, ...overrides },
    });
    return { ...result, calls: readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('refresh bundles runtime artifacts and restarts without recreating environment', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const bundled = result.calls.findIndex(c => c[0] === 'pnpm' && c.includes('--filter'));
  const restarted = result.calls.findIndex(c => c[0] === 'docker' && c[1] === 'restart');
  assert.ok(bundled >= 0 && restarted > bundled);
  assert.ok(result.calls.some(c => c.includes('@deepseek-ai/dsh-hivemind-context')));
  assert.ok(result.calls.some(c => c.includes('@deepseek-ai/dsh-hivemind-connected-apps')));
  assert.equal(result.calls.some(c => c.includes('compose') || c.includes('--force-recreate')), false);
});

test('typecheck failure cannot restart the runner', () => {
  const result = run({ FAIL_TSC: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.some(c => c[1] === 'restart'), false);
});

test('refresh refuses a production-labelled container before any build', () => {
  const result = run({ BAD_PROJECT: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.some(c => c[0] === 'pnpm' || c[1] === 'restart'), false);
});
