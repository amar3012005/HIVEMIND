import {
  stableJson,
  validateEntitlement,
  validateLifecycleEvent,
} from './contract.js';

function fromBase64(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) return false;
  let result = 0;
  for (let index = 0; index < actual.length; index += 1) result |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return result === 0;
}

async function verifySignature(document, signature, rawPublicKey) {
  const key = await crypto.subtle.importKey('raw', fromBase64(rawPublicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(signature), new TextEncoder().encode(stableJson(document)));
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 16_384) throw new Error('request body too large');
  return JSON.parse(text || '{}');
}

function requireToken(request, expected) {
  return expected && timingSafeEqual(request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '', expected);
}

export class OrganizationEntitlement {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      const stored = await this.state.storage.get('entitlement');
      return json(stored || { entitlement: null });
    }
    if (request.method !== 'PUT') return new Response('method not allowed', { status: 405 });
    const envelope = await readJson(request);
    await this.state.storage.put('entitlement', envelope);
    return json({ accepted: true, organization_id: envelope.document.organization_id, expires_at: envelope.document.expires_at });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const entitlementMatch = url.pathname.match(/^\/v1\/control\/organizations\/([0-9a-f-]{36})\/entitlement$/i);
    if (entitlementMatch) {
      const id = entitlementMatch[1].toLowerCase();
      if (!requireToken(request, env.CONTROL_PLANE_ADMIN_TOKEN)) return unauthorized();
      const object = env.ENTITLEMENTS.get(env.ENTITLEMENTS.idFromName(`organization:${id}`));
      if (request.method === 'GET') return object.fetch('https://internal/entitlement');
      if (request.method !== 'PUT') return new Response('method not allowed', { status: 405 });
      try {
        const envelope = await readJson(request);
        if (!envelope?.document || typeof envelope.signature !== 'string') throw new Error('signed entitlement required');
        const document = validateEntitlement(envelope.document);
        if (document.organization_id.toLowerCase() !== id) throw new Error('organization mismatch');
        if (!(await verifySignature(document, envelope.signature, env.ENTITLEMENT_PUBLIC_KEY))) throw new Error('invalid signature');
        return object.fetch('https://internal/entitlement', { method: 'PUT', body: JSON.stringify({ document, signature: envelope.signature }) });
      } catch (error) {
        return json({ error: error.message || 'invalid entitlement' }, 400);
      }
    }

    if (url.pathname === '/v1/control/lifecycle' && request.method === 'POST') {
      if (!requireToken(request, env.CONTROL_PLANE_INSTALLATION_TOKEN)) return unauthorized();
      try {
        const event = validateLifecycleEvent(await readJson(request));
        await env.CONTROL_EVENTS.send(event);
        return json({ accepted: true }, 202);
      } catch (error) {
        return json({ error: error.message || 'invalid lifecycle event' }, 400);
      }
    }

    if (url.pathname === '/health') return json({ ok: true, service: 'hivemind-edge-control-plane' });
    return json({ error: 'not found' }, 404);
  },
};
