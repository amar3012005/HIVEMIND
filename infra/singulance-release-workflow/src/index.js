export { SingulanceProductionRelease } from './workflow.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'singulance-release' }, { headers: CORS });
    }

    if (!authorize(request, env)) {
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/release/')) {
      const id = url.pathname.slice('/v1/release/'.length);
      const instance = await env.RELEASE.get(id);
      return Response.json(await instance.status(), { headers: CORS });
    }

    if (request.method === 'POST' && url.pathname === '/v1/release') {
      const body = await request.json().catch(() => ({}));
      const instance = await env.RELEASE.create({
        params: {
          artifact: body.artifact,
          sha: body.sha,
          services: body.services,
          image: body.image,
          note: body.note,
          requestedBy: body.requested_by || request.headers.get('x-requested-by') || 'unknown',
        },
      });
      return Response.json(
        {
          instanceId: instance.id,
          status: '/v1/release/' + instance.id,
          artifact: body.artifact,
          sha: body.sha,
        },
        { status: 202, headers: CORS },
      );
    }

    return Response.json(
      {
        error: 'not_found',
        usage: {
          start: 'POST /v1/release {"artifact":"frontend"|"core"|"control-plane"|"employees"}',
          status: 'GET /v1/release/:instanceId',
        },
      },
      { status: 404, headers: CORS },
    );
  },
};

function authorize(request, env) {
  const expected = env.RELEASE_TRIGGER_SECRET;
  if (!expected) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${expected}`;
}
