import { cp, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const source = process.argv[2] && resolve(process.argv[2]);
const target = resolve('www');
if (!source || source === target || source.startsWith(target + '/') || target.startsWith(source + '/')) throw Error('Supply the compiled frontend build directory.');
await access(resolve(source, 'index.html'));
const html = await readFile(resolve(source, 'index.html'), 'utf8');
if (!/<script[^>]+src=/i.test(html)) throw Error('The frontend must contain its compiled application scripts.');
for (const entry of await readdir(target)) if (!['offline.html', '.gitkeep'].includes(entry)) await rm(resolve(target, entry), { recursive: true, force: true });
await cp(source, target, { recursive: true });
// Capacitor must load a real index file; initialize the SPA route before React loads.
// Remote web fonts must not block the first paint of a packaged app (offline, or a slow route to the font host):
// the stylesheet loads in the background and the system fonts render until it arrives.
const packaged = html
  .replace('<head>', '<head><script>if(location.pathname === "/" || location.pathname === "/index.html") history.replaceState(null, "", "/hivemind/m/chat");</script>')
  .replace(/<link (href="https:\/\/fonts\.googleapis\.com\/[^"]+") rel="stylesheet">/g, '<link $1 rel="stylesheet" media="print" onload="this.media=\'all\'">');
await writeFile(resolve(target, 'index.html'), packaged);
await writeFile(resolve(target, 'mobile-build.json'), JSON.stringify({ format: 1, frontendSha: process.env.SINGULANCE_FRONTEND_SHA || null, builtAt: new Date().toISOString() }) + '\n');
console.log('Packaged frontend assets. Native authentication and device checks remain required.');
