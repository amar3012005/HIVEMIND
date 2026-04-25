import http from 'http';

const PORT = 5555;
const HIVEMIND_BASE = 'http://localhost:3000';
const CLIENT_ID = 'mirofish-partner-test';
const REDIRECT_URI = 'http://localhost:5555/callback';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f0f2f5;margin:0;"><div style="background:white;padding:2.5rem;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.05);text-align:center;max-width:400px;"><div style="font-size:3rem;margin-bottom:1rem;">🐠</div><h1 style="color:#0f172a;margin:0 0 0.5rem;">MiroFish Platform</h1><p style="color:#64748b;font-size:0.95rem;line-height:1.5;">Connect your HIVEMIND account to enable high-fidelity social evolution predictions.</p><a href="' + HIVEMIND_BASE + '/oauth/authorize?client_id=' + CLIENT_ID + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&response_type=code&scope=memory.read%20memory.write&state=xyz" style="display:block;background:#0ea5e9;color:white;padding:0.9rem;text-decoration:none;border-radius:10px;font-weight:600;margin-top:1.5rem;">Connect to HIVEMIND</a><div style="margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid #f1f5f9;font-size:0.8rem;color:#94a3b8;">Connected apps can configure user-specific credentials.</div></div></body></html>');
    return;
  }

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Connection Failed</h1><p>' + error + '</p><a href="/">Try Again</a>');
      return;
    }
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI
    });
    try {
      const tokenRes = await fetch(HIVEMIND_BASE + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams
      });
      const data = await tokenRes.json();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f0fdf4;margin:0;"><div style="background:white;padding:2.5rem;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.05);text-align:center;max-width:450px;border:1px solid #bbf7d0;"><div style="font-size:3rem;margin-bottom:1rem;">✅</div><h1 style="color:#166534;margin:0 0 0.5rem;">Successfully Linked</h1><p style="color:#15803d;font-size:0.95rem;">MiroFish has successfully configured your HIVEMIND credentials.</p><div style="background:#f8fafc;padding:1.2rem;border-radius:10px;text-align:left;margin:1.5rem 0;border:1px solid #e2e8f0;font-family:monospace;font-size:0.85rem;"><div style="color:#64748b;margin-bottom:0.5rem;font-weight:bold;text-transform:uppercase;font-size:0.7rem;">Configuration Details</div><div style="color:#0f172a;word-break:break-all;"><strong>Token:</strong> ' + data.access_token.substring(0, 32) + '...</div><div style="color:#0f172a;margin-top:0.4rem;"><strong>Scopes:</strong> ' + data.scope + '</div><div style="color:#0f172a;margin-top:0.4rem;"><strong>User:</strong> ' + (data.user_id || 'amar') + '</div></div><a href="/" style="display:block;background:#166534;color:white;padding:0.9rem;text-decoration:none;border-radius:10px;font-weight:600;margin-top:0.5rem;">Open MiroFish Predictions</a></div></body></html>');
    } catch (e) {
      res.end('Failed to exchange token: ' + e.message);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('[Simulator] MiroFish running at http://localhost:' + PORT);
});
