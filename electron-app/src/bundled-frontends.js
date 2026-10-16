const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_HOSTS = new Set(['runtime-runner.singulancelabs.com', 'singulancelabs.com', 'www.singulancelabs.com', 'next.singulancelabs.com']);
const DOT_HOST = 'dots.singulancelabs.com';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// This is the installed DSH client-modules public artifact format. The revision
// includes the indexed source map, so a different server build always falls back
// to the live native endpoint rather than running incompatible packaged code.
function nativeCombo(records, ids, revision) {
  let source = '', line = 0;
  const sections = [];
  for (const id of ids) {
    const record = records[id]; if (!record) return null;
    let text = Buffer.from(record.body, 'base64').toString('utf8');
    const sourceUrl = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/.exec(text)?.[1];
    text = text.replace(/(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/, '').replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '');
    if (!text.endsWith('\n')) text += '\n';
    let map;
    if (record.map) {
      map = JSON.parse(Buffer.from(record.map, 'base64').toString('utf8'));
      const base = new URL(`/plugins/${id}/client.js.map`, 'http://dsh.invalid');
      const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
      map.sources = map.sources.map(value => {
        const resolved = new URL(`${root}${root && !root.endsWith('/') && !value.startsWith('/') ? '/' : ''}${value}`, base);
        return resolved.origin === base.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href;
      });
      delete map.sourceRoot;
    } else {
      const fallback = sourceUrl === undefined ? `/plugins/${id}/client.js` : /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`;
      map = { version: 3, names: [], sources: [fallback], sourcesContent: [text], mappings: Array.from({ length: [...text].filter(c => c === '\n').length }, (_, i) => i === 0 ? 'AAAA' : 'AACA').join(';') };
    }
    sections.push({ offset: { line, column: 0 }, map });
    const bundle = `${text};\n`; source += bundle; line += [...bundle].filter(c => c === '\n').length;
  }
  const sourceMap = Buffer.from(`${JSON.stringify({ version: 3, file: 'client.js', sections })}\n`);
  const body = Buffer.from(source);
  const hash = crypto.createHash('sha1').update('combo').update('\0');
  for (const part of [body, sourceMap]) hash.update(`${part.byteLength}:`).update(part);
  const rev = revision ?? hash.digest('hex').slice(0, 12);
  return { rev, body: Buffer.from(`${source}//# sourceMappingURL=/plugins/??${ids.map(id => `${id}/client.js.map`).join(',')}&rev=${rev}\n`) };
}

function createBundledFrontends(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1) throw new Error('Unknown frontend bundle version');
  const combos = new Map();
  const shellRevisions = new Set();
  function artifactRevision(record) {
    const hash = crypto.createHash('sha1').update('plugin-artifact').update('\0');
    for (const part of [Buffer.from(record.body, 'base64'), ...(record.map ? [Buffer.from(record.map, 'base64')] : [])]) hash.update(`${part.byteLength}:`).update(part);
    return hash.digest('hex').slice(0, 12);
  }
  function observeBootGraph(boot) {
    const graph = boot?.injections?.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')?.value;
    if (!graph || !/^[a-f0-9]{12}$/.test(graph.rev) || !Array.isArray(graph.entries) || !graph.entries.length) return;
    if (!graph.entries.every(entry => manifest.plugins[entry.id] && artifactRevision(manifest.plugins[entry.id]) === entry.rev)) return;
    shellRevisions.add(graph.rev);
  }
  const read = entry => {
    const file = path.resolve(root, entry.file);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid bundled asset path');
    const body = fs.readFileSync(file);
    if (sha(body) !== entry.sha256) throw new Error('Bundled frontend integrity mismatch');
    return { body, type: entry.type, headers: entry.headers ?? {} };
  };
  function resolve(request) {
    if (request.method !== 'GET') return null;
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return null;
    const app = APP_HOSTS.has(url.hostname);
    if (!app && url.hostname !== DOT_HOST) return null;
    if (app && /^\/hivemind\/(?:app(?:\/|$)|login(?:\/|$))/.test(url.pathname)
      && (request.destination === 'document' || request.headers?.get('accept')?.includes('text/html'))) return read(manifest.index);
    const key = `${app ? 'app' : 'dot'}:${url.pathname}`;
    if (manifest.assets[key]) return read(manifest.assets[key]);
    if (url.hostname !== 'runtime-runner.singulancelabs.com') return null;
    if (url.pathname === '/assets/harness-shell.js') {
      const entry = manifest.nativeShell;
      if (entry && shellRevisions.has(url.searchParams.get('rev'))) return read(entry);
      return null;
    }
    if (url.pathname !== '/plugins/' || !/^\?\?@deepseek-ai\//.test(url.search)) return null;
    const match = /^\?\?(.+)&rev=([a-f0-9]{12})$/.exec(url.search);
    if (!match) return null;
    const resources = match[1].split(',');
    if (resources.length > 128 || !resources.every(value => /^@deepseek-ai\/[a-z0-9_-]+\/client\.js$/.test(value))) return null;
    let combo = combos.get(url.search);
    if (!combo) {
      combo = nativeCombo(manifest.plugins, resources.map(value => value.slice(0, -'/client.js'.length)));
      if (combo && combo.rev !== match[2] && resources.length === 1) {
        const id = resources[0].slice(0, -'/client.js'.length);
        if (artifactRevision(manifest.plugins[id]) === match[2]) combo = nativeCombo(manifest.plugins, [id], match[2]);
      }
      if (!combo || combo.rev !== match[2]) return null;
      combos.set(url.search, combo);
    }
    return { body: combo.body, type: 'text/javascript; charset=utf-8', headers: {} };
  }
  return { resolve, manifest, observeBootGraph };
}

function installBundledFrontends(ses, root, log) {
  const bundle = createBundledFrontends(root);
  ses.protocol.handle('https', async request => {
    const result = bundle.resolve(request);
    if (!result) {
      const response = await ses.fetch(request, { bypassCustomProtocolHandlers: true, redirect: 'manual' });
      const url = new URL(request.url);
      if (url.origin === 'https://runtime-runner.singulancelabs.com' && url.pathname === '/api/hivemind/boot' && response.ok) {
        try { bundle.observeBootGraph(await response.clone().json()); } catch { /* The server remains the boot authority. */ }
      }
      return response;
    }
    return new Response(result.body, { headers: { 'Content-Type': result.type, 'Cache-Control': result.type.startsWith('text/html') ? 'no-store' : 'public, max-age=31536000, immutable', ...result.headers, 'X-Singulance-Frontend': 'bundled' } });
  });
  log?.info('Packaged frontends enabled', { release: bundle.manifest.release, assets: Object.keys(bundle.manifest.assets).length, plugins: Object.keys(bundle.manifest.plugins).length });
  return bundle;
}
module.exports = { createBundledFrontends, installBundledFrontends, nativeCombo };
