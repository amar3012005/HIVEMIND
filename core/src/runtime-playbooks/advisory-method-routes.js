import { readAdvisoryMethods, decideAdvisoryMethod } from './advisory-methods.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Existing dashboard session/admin authority, not a runner ticket or bearer key. */
export async function handleAdvisoryMethodApproval({ req, res, pathname, prisma, requireSession, requireOrgAdmin, parseBody, jsonResponse }) {
  const match = /^\/api\/advisory-methods\/([^/]+)$/.exec(pathname);
  if (!match) return false;
  if (!UUID.test(match[1])) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
  const current = await requireSession(req, res);
  if (!current) return true;
  const principal = { userId: current.session.userId, orgId: current.session.orgId, kind: 'human-session' };
  if (!await requireOrgAdmin(req, res, principal.userId, principal.orgId)) return true;
  try {
    const row = await readAdvisoryMethods(prisma, principal, match[1]);
    if (!row) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Review company method</title><style>body{max-width:760px;margin:48px auto;padding:24px;font:17px system-ui;line-height:1.5}pre{white-space:pre-wrap}button{padding:12px 20px;margin:8px}</style><h1>${escape(row.body.title)}</h1><p>Company-local advisory method. Version ${row.version}, replacing ${row.prior_version}. Status: ${escape(row.status)}.</p><h2>Why this change</h2><p>${escape(row.rationale)}</p><h2>Exact method</h2><pre>${escape(JSON.stringify(row.body, null, 2))}</pre><h2>Supporting evidence</h2><pre>${escape(JSON.stringify(row.evidence_refs, null, 2))}</pre>${row.status === 'pending' ? '<button data-decision="approve">Approve this version</button><button data-decision="reject">Decline</button>' : ''}<p id="result"></p><script>const hash=${JSON.stringify(row.content_hash)};document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{document.querySelectorAll('button').forEach(x=>x.disabled=true);try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content_hash:hash,decision:b.dataset.decision})});const v=await r.json();document.getElementById('result').textContent=r.ok?'Decision saved: '+v.status:v.error}catch{document.getElementById('result').textContent='Could not confirm the decision. Reload to check before retrying.'}})</script>`);
      return true;
    }
    if (req.method !== 'POST') { jsonResponse(res, { error: 'Method not allowed' }, 405); return true; }
    const origin = req.headers.origin;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    if (!origin || new URL(origin).host !== host) { jsonResponse(res, { error: 'Same-origin approval required' }, 403); return true; }
    const input = await parseBody(req);
    if (!['approve', 'reject'].includes(input.decision)) { jsonResponse(res, { error: 'Invalid decision' }, 400); return true; }
    const result = await decideAdvisoryMethod(prisma, principal, row.id, input.content_hash, input.decision === 'approve');
    jsonResponse(res, { id: result.id, status: result.status, version: result.version, content_hash: result.content_hash });
  } catch (error) { jsonResponse(res, { error: error.code || 'Advisory method unavailable' }, error.status || 500); }
  return true;
}
