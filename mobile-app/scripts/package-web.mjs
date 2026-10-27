import { cp, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_ASSET_MANIFEST, packageRuntime } from './package-runtime.mjs';
const source = process.argv[2] && resolve(process.argv[2]);
const target = resolve('www');
if (!source || source === target || source.startsWith(target + '/') || target.startsWith(source + '/')) throw Error('Supply the compiled frontend build directory.');
await access(resolve(source, 'index.html'));
const html = await readFile(resolve(source, 'index.html'), 'utf8');
if (!/<script[^>]+src=/i.test(html)) throw Error('The frontend must contain its compiled application scripts.');
for (const entry of await readdir(target)) if (!['offline.html', '.gitkeep'].includes(entry)) await rm(resolve(target, entry), { recursive: true, force: true });
await cp(source, target, { recursive: true });
// Capacitor must load a real index file; initialize the SPA route before React loads.
await writeFile(resolve(target, 'index.html'), html.replace('<head>', '<head><script>if(location.pathname === "/" || location.pathname === "/index.html") history.replaceState(null, "", "/hivemind/m/chat");</script>'));
await writeFile(resolve(target, 'mobile-build.json'), JSON.stringify({ format: 1, frontendSha: process.env.SINGULANCE_FRONTEND_SHA || null, builtAt: new Date().toISOString() }) + '\n');
// Runtime's native UI code ships in the app; only session data is fetched at run time.
const runtime = await packageRuntime({ manifestPath: resolve(process.env.SINGULANCE_RUNTIME_ASSET_MANIFEST || DEFAULT_ASSET_MANIFEST), target });
console.log(`Bundled Runtime release ${runtime.release.slice(0, 12)} (${Object.keys(runtime.entries).length} paths).`);
console.log('Packaged frontend assets. Native authentication and device checks remain required.');
