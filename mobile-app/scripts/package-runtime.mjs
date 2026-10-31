// Bundles the Runtime (DSH web client) static code for the packaged app, so the native
// transport can answer /plugins/* and /assets/* from the app bundle instead of the network.
// The files are the public, release-pinned assets that the Cloudflare Worker already serves
// from runtime-runner.singulancelabs.com without credentials. Session data is never bundled.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNTIME_ORIGIN = 'https://runtime-runner.singulancelabs.com';
export const DEFAULT_ASSET_MANIFEST = '../frontend/Da-vinci/cloudflare/generated/runtime-native-assets.json';
const MAX_BYTES = 15 * 1024 * 1024; // the native bridge refuses responses above 20 MiB once encoded
const KEY = /^\/(?:plugins|assets)\/[^\s#]*$/;
const SHELL = '/assets/harness-shell.js';

/** Release entries of the newest generation, keyed by `pathname + search`. */
export function currentEntries(manifest) {
  if (!/^[0-9a-f]{40}$/.test(manifest?.release || '') || !/^[0-9a-f]{12}$/.test(manifest?.rev || '')) throw Error('Runtime asset manifest has no immutable release.');
  const entries = Object.entries(manifest.entries || {}).filter(([, entry]) => entry.path?.split('/')[2] === manifest.release);
  for (const [key] of entries) if (!KEY.test(key) || key.includes('..') || key === '/plugins/events') throw Error(`Unsafe Runtime asset path: ${key}`);
  if (!entries.some(([key]) => key.startsWith(`${SHELL}?rev=`)) || !entries.some(([key]) => key.startsWith('/plugins/'))) throw Error('Runtime asset manifest is missing the shell or plugin bundles.');
  return entries;
}

/** Download every current-release asset and write `<target>/runtime`. Returns the written manifest. */
export async function packageRuntime({ manifestPath, target = resolve('www'), fetchAsset = fetch, origin = RUNTIME_ORIGIN, concurrency = 8 } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entries = currentEntries(manifest);
  const root = resolve(target, 'runtime');
  await rm(root, { recursive: true, force: true });
  await mkdir(resolve(root, 'files'), { recursive: true });
  const written = {}; let next = 0;
  async function worker() {
    while (next < entries.length) {
      const [key] = entries[next++];
      const response = await fetchAsset(origin + key, { redirect: 'manual' });
      const type = response.headers.get('content-type') || '';
      if (response.status !== 200) throw Error(`Runtime asset unavailable (${response.status}): ${key}`);
      // The Worker stamps the release that served the file; a different release means the
      // Da-vinci manifest is older than the live runner and the bundle would be stale on arrival.
      if (response.headers.get('x-runtime-static-release') !== manifest.release) throw Error(`Live Runtime release differs from manifest ${manifest.release}. Rebuild from the current Da-vinci checkout.`);
      if (/html/i.test(type) || !/javascript|css|font|wasm|image|octet-stream/i.test(type)) throw Error(`Runtime asset is not static code: ${key}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES) throw Error(`Runtime asset size is not bundleable: ${key}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (key.startsWith(`${SHELL}?rev=`) && key.slice(-12) !== sha256.slice(0, 12)) throw Error('Runtime shell revision does not match its bytes.');
      await writeFile(resolve(root, 'files', sha256), bytes);
      written[key] = { file: sha256, type, bytes: bytes.length };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  // The app requests the shell with the boot graph revision (`manifest.rev`), not the file hash.
  const shell = Object.keys(written).find(key => key.startsWith(`${SHELL}?rev=`));
  written[`${SHELL}?rev=${manifest.rev}`] = written[shell];
  const out = { format: 1, release: manifest.release, graphRev: manifest.rev, builtAt: new Date().toISOString(), entries: Object.fromEntries(Object.entries(written).sort(([a], [b]) => a.localeCompare(b))) };
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify(out) + '\n');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = resolve(process.env.SINGULANCE_RUNTIME_ASSET_MANIFEST || DEFAULT_ASSET_MANIFEST);
  const out = await packageRuntime({ manifestPath });
  const total = Object.values(out.entries).reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`Bundled Runtime ${out.release.slice(0, 12)} (boot graph ${out.graphRev}): ${Object.keys(out.entries).length} paths, ${(total / 1048576).toFixed(1)} MiB.`);
}
