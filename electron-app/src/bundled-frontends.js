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

// Electron fetch cancels manual redirects instead of exposing their response.
// ClientRequest exposes the native redirect event, allowing Chromium's renderer
// to follow it with its own origin, cookies and navigation security checks.
function forwardReadRequest(request, ses, headers, credentials, net = require('electron').net) {
  return new Promise((resolve, reject) => {
    let origin = headers.get('origin');
    if (!origin) { try { origin = new URL(request.referrer || headers.get('referer')).origin; } catch {} }
    const outgoing = net.request({ url: request.url, method: request.method, session: ses,
      headers: Object.fromEntries(headers), credentials: credentials === 'same-origin' && !origin ? 'omit' : credentials, ...(origin ? { origin } : {}),
      bypassCustomProtocolHandlers: true, redirect: 'manual' });
    const responseHeaders = values => {
      const result = new Headers();
      for (const [name, value] of Object.entries(values)) {
        if (['content-encoding', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) continue;
        for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
      }
      return result;
    };
    const abort = () => outgoing.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    outgoing.once('close', () => request.signal?.removeEventListener('abort', abort));
    outgoing.once('error', reject);
    outgoing.once('redirect', (status, _method, location, values) => {
      const result = responseHeaders(values); result.set('location', location);
      resolve(new Response(null, { status, headers: result }));
      // Do not follow here: the renderer owns this redirect.
    });
    outgoing.once('response', incoming => {
      const result = responseHeaders(incoming.headers);
      if (request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)) {
        incoming.resume?.(); resolve(new Response(null, { status: incoming.statusCode, headers: result })); return;
      }
      let closed = false;
      const body = new ReadableStream({
        start(controller) {
          incoming.on('data', chunk => { if (closed) return; controller.enqueue(new Uint8Array(chunk)); if (controller.desiredSize <= 0) incoming.pause?.(); });
          incoming.once('end', () => { if (!closed) { closed = true; controller.close(); } });
          incoming.once('error', error => { if (!closed) { closed = true; controller.error(error); } });
          incoming.once('aborted', () => { if (!closed) { closed = true; controller.error(new Error('Network response interrupted')); } });
        },
        pull() { incoming.resume?.(); },
        cancel() { closed = true; outgoing.abort(); },
      });
      resolve(new Response(body, { status: incoming.statusCode, headers: result }));
    });
    outgoing.end();
  });
}

function installBundledFrontends(ses, root, log, observer = {}) {
  const bundle = createBundledFrontends(root);
  const served = new Set();
  ses.protocol.handle('https', async request => {
    const ticket = observer.begin?.(request);
    const result = bundle.resolve(request);
    if (!result) {
      const url = new URL(request.url);
      // Main-process fetch has no renderer origin to resolve `same-origin`
      // against. Keep the browser's existing first-party session credential.
      const firstParty = url.hostname === 'singulancelabs.com' || url.hostname.endsWith('.singulancelabs.com');
      const headers = new Headers(request.headers);
      if (!headers.has('origin') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        try {
          const referrer = new URL(request.referrer || headers.get('referer'));
          if (APP_HOSTS.has(referrer.hostname) && referrer.protocol === 'https:') headers.set('origin', referrer.origin);
        } catch { /* Missing initiator never receives a manufactured origin. */ }
      }
      const credentials = firstParty && request.credentials !== 'omit' ? 'include' : request.credentials;
      const response = await (['GET', 'HEAD'].includes(request.method)
        ? forwardReadRequest(request, ses, headers, credentials)
        : ses.fetch(request, { headers, bypassCustomProtocolHandlers: true, credentials })).catch(error => { log?.warn('Desktop network forwarding failed', { origin: url.origin, path: url.pathname, error: error.message }); throw error; });
      if (ticket) void observer.response?.(request, response.clone(), ticket).catch(() => {});
      if (response.status === 0) log?.warn('Network redirect cannot be forwarded', { origin: url.origin, path: url.pathname, type: response.type });
      if (firstParty && ['/api/hivemind/session/establish', '/api/hivemind/boot'].includes(url.pathname) && !response.ok) {
        log?.warn('Desktop session admission', { path: url.pathname, method: request.method, status: response.status, origin: headers.get('origin'), referrerOrigin: (() => { try { return new URL(request.referrer || headers.get('referer')).origin; } catch { return null; } })() });
      }
      if (url.origin === 'https://runtime-runner.singulancelabs.com' && url.pathname === '/api/hivemind/boot' && response.ok) {
        try { bundle.observeBootGraph(await response.clone().json()); } catch { /* The server remains the boot authority. */ }
      }
      return response;
    }
    const resource = new URL(request.url);
    const kind = resource.hostname === DOT_HOST ? 'opendot' : resource.pathname.startsWith('/plugins/') ? 'native-dsh'
      : resource.pathname === '/assets/harness-shell.js' ? 'native-shell' : result.type.startsWith('text/html') ? 'document' : 'outer';
    if (!served.has(kind)) { served.add(kind); log?.info('Bundled frontend in use', { kind }); }
    return new Response(result.body, { headers: { 'Content-Type': result.type, 'Cache-Control': result.type.startsWith('text/html') ? 'no-store' : 'public, max-age=31536000, immutable', ...result.headers, 'X-Singulance-Frontend': 'bundled' } });
  });
  log?.info('Packaged frontends enabled', { release: bundle.manifest.release, assets: Object.keys(bundle.manifest.assets).length, plugins: Object.keys(bundle.manifest.plugins).length });
  return bundle;
}
module.exports = { createBundledFrontends, installBundledFrontends, nativeCombo, forwardReadRequest };
