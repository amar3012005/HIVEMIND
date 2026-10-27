import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentEntries, packageRuntime } from './package-runtime.mjs';

const release = 'a'.repeat(40), old = 'b'.repeat(40), shellBytes = Buffer.from('export const shell=1;');
const shellRev = createHash('sha256').update(shellBytes).digest('hex').slice(0, 12);
const entry = (rel, name) => ({ path: `/runtime-native/${rel}/${name}`, type: 'text/javascript', immutable: true });
const manifest = { release, rev: 'c0ffee000001', entries: {
  '/plugins/??@x/dsh-a/client.js&rev=0123456789ab': entry(release, '1'),
  [`/assets/harness-shell.js?rev=${shellRev}`]: entry(release, '2'),
  '/assets/old-AAAA.js': entry(old, '3'),
} };
const serve = (overrides = {}) => async (url) => {
  const path = url.replace('https://runtime-runner.singulancelabs.com', '');
  const body = path.startsWith('/assets/harness-shell.js') ? shellBytes : Buffer.from('plugin code');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript', 'x-runtime-static-release': release, ...overrides } });
};
async function run(fetchAsset, data = manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-bundle-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(data));
  return { dir, out: await packageRuntime({ manifestPath: join(dir, 'manifest.json'), target: dir, fetchAsset }) };
}

test('bundles only the current release and aliases the shell to the boot graph revision', async () => {
  const { dir, out } = await run(serve());
  assert.deepEqual(Object.keys(out.entries).sort(), ['/assets/harness-shell.js?rev=c0ffee000001', `/assets/harness-shell.js?rev=${shellRev}`, '/plugins/??@x/dsh-a/client.js&rev=0123456789ab'].sort());
  const written = JSON.parse(await readFile(join(dir, 'runtime/manifest.json'), 'utf8'));
  assert.equal(written.release, release);
  const alias = written.entries['/assets/harness-shell.js?rev=c0ffee000001'];
  assert.equal(await readFile(join(dir, 'runtime/files', alias.file), 'utf8'), shellBytes.toString());
});
test('refuses a live runner release that differs from the manifest', async () => {
  await assert.rejects(run(serve({ 'x-runtime-static-release': old })), /Live Runtime release differs/);
});
test('refuses HTML responses and shells whose revision does not match their bytes', async () => {
  await assert.rejects(run(serve({ 'content-type': 'text/html' })), /not static code/);
  const bad = { ...manifest, entries: { ...manifest.entries, [`/assets/harness-shell.js?rev=${shellRev}`]: undefined } };
  delete bad.entries[`/assets/harness-shell.js?rev=${shellRev}`];
  bad.entries['/assets/harness-shell.js?rev=000000000000'] = entry(release, '2');
  await assert.rejects(run(serve(), bad), /does not match its bytes/);
});
test('rejects traversal and non-code paths in the manifest', () => {
  assert.throws(() => currentEntries({ ...manifest, entries: { ...manifest.entries, '/api/boot': entry(release, '9') } }), /Unsafe/);
  assert.throws(() => currentEntries({ ...manifest, release: 'bad' }), /immutable release/);
});
test('native plugin consults the bundle before the network, for static code only', async () => {
  const plugin = await readFile('ios/App/App/SingulanceNativePlugin.swift', 'utf8');
  assert.match(plugin, /localRuntimeResource\(request\)/);
  assert.match(plugin, /\["GET", "HEAD"\]\.contains/);
  const bundle = await readFile('ios/App/App/RuntimeBundle.swift', 'utf8');
  assert.match(bundle, /url\.host == "next\.singulancelabs\.com"/);
  assert.match(await readFile('ios/App/App.xcodeproj/project.pbxproj', 'utf8'), /RuntimeBundle\.swift in Sources/);
});
