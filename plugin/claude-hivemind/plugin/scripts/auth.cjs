#!/usr/bin/env node
/**
 * HIVEMIND OAuth loopback — opens the browser, listens on localhost:19876 for
 * the redirect callback, persists the API key + user_id to
 * ~/.hivemind-claude/credentials.json (mode 600).
 *
 * Pattern adapted from supermemoryai/claude-supermemory.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const CONTROL_PLANE =
  process.env.HIVEMIND_CONTROL_PLANE ||
  'https://api.hivemind.davinciai.eu:8040';
const AUTH_PORT = parseInt(process.env.HIVEMIND_AUTH_PORT || '19876', 10);
const AUTH_TIMEOUT_MS = parseInt(
  process.env.HIVEMIND_AUTH_TIMEOUT_MS || '120000',
  10
); // 2 min

const SETTINGS_DIR = path.join(os.homedir(), '.hivemind-claude');
const CREDENTIALS_FILE = path.join(SETTINGS_DIR, 'credentials.json');

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>HIVEMIND connected</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f4;color:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#fff;border:1px solid #e3e0db;border-radius:16px;padding:32px 40px;box-shadow:0 1px 3px rgba(0,0,0,0.04);max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 8px;color:#16a34a}p{color:#525252;font-size:14px;margin:0}</style></head><body><div class="card"><h1>✓ HIVEMIND connected</h1><p>You can close this tab. Go back to your terminal — your Claude Code session is now authenticated.</p></div></body></html>`;
const ERROR_HTML = (msg) => `<!doctype html><html><head><meta charset="utf-8"><title>HIVEMIND error</title><style>body{font-family:-apple-system,sans-serif;background:#faf9f4;color:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#fff;border:1px solid #fecaca;border-radius:16px;padding:32px 40px;max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 8px;color:#dc2626}p{color:#525252;font-size:14px}</style></head><body><div class="card"><h1>HIVEMIND auth failed</h1><p>${msg}</p></div></body></html>`;

function ensureDir() {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function saveCredentials(apiKey, userId, orgId) {
  ensureDir();
  const data = {
    apiKey,
    userId,
    orgId: orgId || null,
    controlPlane: CONTROL_PLANE,
    coreApi:
      process.env.HIVEMIND_CORE_API ||
      'https://core.hivemind.davinciai.eu:8050',
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  // Tighten perms in case umask altered them.
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {}
  return data;
}

function openBrowser(url) {
  const onError = (err) => {
    if (err) console.warn('[hivemind-auth] could not open browser:', err.message);
  };
  if (process.platform === 'win32') {
    execFile('explorer.exe', [url], onError);
  } else if (process.platform === 'darwin') {
    execFile('open', [url], onError);
  } else {
    execFile('xdg-open', [url], onError);
  }
}

function startAuthFlow() {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${AUTH_PORT}`);

      if (u.pathname === '/callback') {
        const apiKey =
          u.searchParams.get('apikey') || u.searchParams.get('api_key');
        const userId =
          u.searchParams.get('user_id') || u.searchParams.get('userId');
        const orgId =
          u.searchParams.get('org_id') || u.searchParams.get('orgId');
        const error = u.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(ERROR_HTML(error));
          if (!resolved) {
            resolved = true;
            server.close();
            reject(new Error(`auth failed: ${error}`));
          }
          return;
        }

        if (!apiKey || !apiKey.startsWith('hm_')) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(ERROR_HTML('No HIVEMIND API key in callback'));
          return;
        }

        if (!userId) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(ERROR_HTML('No user_id in callback'));
          return;
        }

        const creds = saveCredentials(apiKey, userId, orgId);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML);
        if (!resolved) {
          resolved = true;
          server.close();
          resolve(creds);
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(AUTH_PORT, '127.0.0.1', () => {
      const callback = `http://localhost:${AUTH_PORT}/callback`;
      const authUrl = `${CONTROL_PLANE}/auth/cli?callback=${encodeURIComponent(
        callback
      )}&client=claude_code`;
      console.log('[hivemind-auth] opening browser to', authUrl);
      console.log('[hivemind-auth] waiting for callback on', callback);
      openBrowser(authUrl);
    });

    server.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`auth server failed: ${err.message}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          server.close();
        } catch {}
        reject(new Error('AUTH_TIMEOUT — no callback received'));
      }
    }, AUTH_TIMEOUT_MS);
  });
}

(async () => {
  try {
    const creds = await startAuthFlow();
    console.log('');
    console.log('✓ HIVEMIND connected');
    console.log('  user_id:', creds.userId);
    if (creds.orgId) console.log('  org_id: ', creds.orgId);
    console.log('  saved:  ', CREDENTIALS_FILE);
    console.log('');
    console.log(
      'Restart your Claude Code session (or run /mcp) to load the new credentials.'
    );
    process.exit(0);
  } catch (err) {
    console.error('[hivemind-auth] failed:', err.message);
    process.exit(1);
  }
})();
