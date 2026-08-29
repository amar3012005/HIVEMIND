function equal(a, b) { if (!a || !b || a.length !== b.length) return false; let value = 0; for (let i = 0; i < a.length; i += 1) value |= a.charCodeAt(i) ^ b.charCodeAt(i); return value === 0; }
export default { async fetch(request, env) {
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (!equal(request.headers.get('Authorization') || '', `Bearer ${env.GATEWAY_TOKEN}`)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let message; try { message = await request.json(); } catch { return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
  const allowed = new Set((env.ALLOWED_RECIPIENTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  const to = String(message?.to || '').trim().toLowerCase();
  if (!allowed.has(to)) return Response.json({ ok: false, error: 'recipient_not_allowed' }, { status: 403 });
  if (!message?.subject || (!message?.text && !message?.html)) return Response.json({ ok: false, error: 'invalid_message' }, { status: 400 });
  try { const result = await env.EMAIL.send({ to, from: { email: env.FROM_EMAIL, name: 'Singulance Preview' }, subject: String(message.subject).slice(0, 250), html: String(message.html || ''), text: String(message.text || '') }); return Response.json({ ok: true, messageId: result.messageId || null }); } catch (error) { return Response.json({ ok: false, error: error?.code || 'email_send_failed' }, { status: 502 }); }
} };
