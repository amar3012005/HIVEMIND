/**
 * SINGULANCE Ops Gateway MCP adapter.
 *
 * The deployment executor stays outside Core: the configured Cloudflare
 * Workflow owns GitHub Actions and the production host. This module only
 * exposes the typed, operator-only MCP boundary used by coding agents.
 */

const SHA_RE = /^[a-f0-9]{40}$/i;
const DIGEST_RE = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/i;

export const OPS_TOOL_NAMES = new Set([
  'deploy_cloudflare_frontend',
  'deploy_core_services',
  'deploy_harness_runner',
  'get_release_status',
]);

function config(env = process.env) {
  const baseUrl = String(env.SINGULANCE_OPS_GATEWAY_URL || '').replace(/\/$/, '');
  const token = String(env.SINGULANCE_OPS_GATEWAY_TOKEN || '');
  return { baseUrl, token, enabled: Boolean(baseUrl && token) };
}

export function isOpsTool(name) {
  return OPS_TOOL_NAMES.has(name);
}

export function getOpsToolsManifest({ isOperator = false, env = process.env } = {}) {
  if (!isOperator || !config(env).enabled) return [];

  return [
    {
      name: 'deploy_cloudflare_frontend',
      description: 'Deploy the exact pushed Da-vinci frontend SHA through the SINGULANCE Cloudflare release workflow. Returns a release instance for status and rollback evidence. Use only for a frontend/Worker change.',
      inputSchema: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: 'Exact 40-character pushed Da-vinci commit SHA.' },
          note: { type: 'string', description: 'Short release note.' },
        },
        required: ['sha'],
      },
    },
    {
      name: 'deploy_core_services',
      description: 'Deploy only the named HIVE-MIND production container services from the exact pushed singulance-main SHA. The release workflow builds immutable artifacts and recreates only these services.',
      inputSchema: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: 'Exact 40-character pushed HIVE-MIND singulance-main SHA.' },
          services: {
            type: 'array',
            items: { type: 'string', enum: ['core', 'control-plane', 'employees'] },
            minItems: 1,
            uniqueItems: true,
            description: 'Affected container services only.',
          },
          note: { type: 'string', description: 'Short release note.' },
        },
        required: ['sha', 'services'],
      },
    },
    {
      name: 'deploy_harness_runner',
      description: 'Promote one already-built immutable HIVE-MIND Harness runner image for the exact pushed HIVE-MIND SHA. Recreates only hivemind-harness-runner and its tunnel companion.',
      inputSchema: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: 'Exact 40-character pushed HIVE-MIND singulance-main SHA.' },
          image: { type: 'string', description: 'Immutable runner image reference ending in @sha256:<64 hex>.' },
          note: { type: 'string', description: 'Short release note.' },
        },
        required: ['sha', 'image'],
      },
    },
    {
      name: 'get_release_status',
      description: 'Read the status and immutable release evidence for a SINGULANCE Ops Gateway release instance.',
      inputSchema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string', description: 'Release instance id returned by a deployment tool.' },
        },
        required: ['instance_id'],
      },
    },
  ];
}

function validationError(message) {
  return { ok: false, error: message };
}

function requestFor(name, args = {}) {
  const sha = String(args.sha || '').trim();
  if (name !== 'get_release_status' && !SHA_RE.test(sha)) {
    return validationError('sha must be the exact 40-character pushed commit SHA');
  }

  switch (name) {
    case 'deploy_cloudflare_frontend':
      return { ok: true, method: 'POST', path: '/v1/release', body: { artifact: 'frontend', sha, note: args.note } };
    case 'deploy_core_services': {
      const services = Array.isArray(args.services) ? [...new Set(args.services)] : [];
      const allowed = new Set(['core', 'control-plane', 'employees']);
      if (!services.length || services.some((service) => !allowed.has(service))) {
        return validationError('services must contain one or more of: core, control-plane, employees');
      }
      return { ok: true, method: 'POST', path: '/v1/release', body: { artifact: 'core-services', sha, services, note: args.note } };
    }
    case 'deploy_harness_runner': {
      const image = String(args.image || '').trim();
      if (!DIGEST_RE.test(image)) {
        return validationError('image must be an immutable image reference ending in @sha256:<64 hex>');
      }
      return { ok: true, method: 'POST', path: '/v1/release', body: { artifact: 'harness-runner', sha, image, note: args.note } };
    }
    case 'get_release_status': {
      const instanceId = String(args.instance_id || '').trim();
      if (!instanceId || !/^[A-Za-z0-9_-]+$/.test(instanceId)) return validationError('instance_id is required');
      return { ok: true, method: 'GET', path: `/v1/release/${encodeURIComponent(instanceId)}` };
    }
    default:
      return validationError(`unknown Ops Gateway tool: ${name}`);
  }
}

export async function invokeOpsTool(name, args, { requestedBy, env = process.env, fetchImpl = fetch } = {}) {
  const gateway = config(env);
  if (!gateway.enabled) return validationError('SINGULANCE Ops Gateway is not configured on this MCP host');

  const request = requestFor(name, args);
  if (!request.ok) return request;

  const response = await fetchImpl(`${gateway.baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${gateway.token}`,
      ...(request.body ? { 'content-type': 'application/json' } : {}),
      'x-requested-by': String(requestedBy || 'mcp-operator').slice(0, 160),
    },
    ...(request.body ? { body: JSON.stringify({ ...request.body, requested_by: requestedBy || 'mcp-operator' }) } : {}),
  });
  const body = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
  if (!response.ok) return validationError(body?.error || `Ops Gateway request failed with ${response.status}`);
  return { ok: true, ...body };
}
