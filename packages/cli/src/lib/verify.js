// Post-install verification — hit /api/mcp with the API key the user just
// configured, so we can give a green-check or red-cross the moment install
// finishes. Beats the user discovering "Claude says no tools" tomorrow.
import https from 'node:https';
import http from 'node:http';

export async function verifyEndpoint(endpoint, apiKey, { timeoutMs = 8000 } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const url = new URL(endpoint);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          // Streamable HTTP can return either plain JSON or SSE (event: + data:).
          // Strip the SSE framing if present, then parse.
          const trimmed = buf.replace(/^event:[^\n]*\n/, '').replace(/^data:\s*/, '').trim();
          const parsed = JSON.parse(trimmed);
          const tools = parsed?.result?.tools;
          if (Array.isArray(tools)) {
            resolve({ ok: true, statusCode: res.statusCode, toolCount: tools.length });
          } else {
            resolve({ ok: false, statusCode: res.statusCode, error: parsed?.error?.message || 'unexpected response shape' });
          }
        } catch (err) {
          resolve({ ok: false, statusCode: res.statusCode, error: err.message });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `timeout after ${timeoutMs}ms` }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}
