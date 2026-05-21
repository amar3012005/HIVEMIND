// Browser-based device auth — mirrors `gh auth login --web` UX.
//
// Flow:
//   1. Start a localhost HTTP server on a random port.
//   2. Open the user's default browser to
//      <controlPlane>/auth/cli/start?callback=http://127.0.0.1:<port>/cb&state=<rand>.
//   3. After Zitadel login the control plane mints (or reuses) the
//      user's auto-session API key and 302s to the callback with
//      ?state=...&token=...&user_email=...&org_id=...
//   4. We CSRF-check state, return a friendly HTML "you can close this
//      tab" page, kill the listener, and hand the token back.
//
// Security:
//   - Only 127.0.0.1 is bound (no 0.0.0.0) so other machines on the
//     same LAN can't sniff the callback.
//   - State is a 32-byte CSPRNG hex token; mismatch → reject.
//   - 5 minute hard timeout — listener closes itself even if the user
//     ctrl-c's the CLI mid-flow.
//   - No CORS: only same-origin localhost can read /cb anyway.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { c } from './ui.js';

const SUCCESS_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>HIVEMIND CLI — signed in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #fafaf9; color: #0a0a0a; }
  .card { max-width: 460px; margin: 80px auto; padding: 32px; border: 1px solid #e7e5e4; border-radius: 16px; background: #fff; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #57534e; line-height: 1.5; margin: 8px 0; }
  .check { font-size: 48px; color: #16a34a; margin-bottom: 8px; }
</style>
</head><body>
<div class="card">
  <div class="check">✓</div>
  <h1>HIVEMIND CLI signed in</h1>
  <p>You can close this tab and return to your terminal.</p>
</div>
</body></html>`;

function openBrowser(target) {
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
  // detached so the browser stays open if the CLI exits
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
}

/**
 * Run the browser handshake. Returns { token, userEmail, orgId, userId }.
 * Throws if the user cancels (Ctrl-C), times out, or the server returns
 * a state mismatch.
 *
 * @param {object} opts
 * @param {string} opts.controlPlane  base URL, e.g. https://hivemind.davinciai.eu
 * @param {number} [opts.timeoutMs=300000]
 */
export async function browserLogin({ controlPlane, timeoutMs = 300_000 }) {
  const state = crypto.randomBytes(32).toString('hex');

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/cb')) {
        res.writeHead(404); res.end(); return;
      }
      const u = new URL(req.url, 'http://127.0.0.1');
      const gotState = u.searchParams.get('state');
      const token = u.searchParams.get('token');
      const userEmail = u.searchParams.get('user_email') || null;
      const orgId = u.searchParams.get('org_id') || null;
      const userId = u.searchParams.get('user_id') || null;

      if (!gotState || gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('state mismatch — possible CSRF, ignoring');
        return; // do NOT resolve — wait for the legit callback
      }
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('missing token in callback');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SUCCESS_HTML);
      // Close after the response flushes so the browser actually renders
      // the success page before the socket dies.
      setImmediate(() => server.close(() => resolve({ token, userEmail, orgId, userId })));
    });

    server.on('error', (err) => reject(err));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const callback = `http://127.0.0.1:${port}/cb`;
      const startUrl = new URL('/auth/cli/start', controlPlane);
      startUrl.searchParams.set('callback', callback);
      startUrl.searchParams.set('state', state);

      console.log('');
      console.log(c.cyan('Opening browser to sign you in…'));
      console.log(c.dim('  if the browser does not open, paste this URL manually:'));
      console.log('  ' + c.underline(startUrl.toString()));
      console.log('');
      console.log(c.dim('Waiting for sign-in (press Ctrl-C to cancel)…'));

      openBrowser(startUrl.toString());
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`browser login timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    server.on('close', () => clearTimeout(timer));

    // Be polite on Ctrl-C — close the listener so the port is freed.
    const onSig = () => { server.close(); reject(new Error('cancelled')); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}
