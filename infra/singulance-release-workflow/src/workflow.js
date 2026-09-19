import { WorkflowEntrypoint } from 'cloudflare:workers';

/** @typedef {'frontend' | 'core' | 'control-plane' | 'employees' | 'core-services' | 'harness-runner'} Artifact */

const ARTIFACTS = {
  frontend: {
    owner: 'amar3012005',
    repo: 'Da-vinci',
    ref: 'main',
    workflow: 'singulance-production-frontend.yml',
    canary: 'https://next.singulancelabs.com/',
  },
  core: {
    owner: 'amar3012005',
    repo: 'HIVEMIND',
    ref: 'singulance-main',
    workflow: 'singulance-production-hetzner.yml',
    service: 'core',
    canary: 'https://api.singulancelabs.com/health',
  },
  'control-plane': {
    owner: 'amar3012005',
    repo: 'HIVEMIND',
    ref: 'singulance-main',
    workflow: 'singulance-production-hetzner.yml',
    service: 'control-plane',
    canary: 'https://api.singulancelabs.com/health',
  },
  employees: {
    owner: 'amar3012005',
    repo: 'HIVEMIND',
    ref: 'singulance-main',
    workflow: 'singulance-production-hetzner.yml',
    service: 'employees',
    canary: 'https://api.singulancelabs.com/health',
  },
  'core-services': {
    owner: 'amar3012005',
    repo: 'HIVEMIND',
    ref: 'singulance-main',
    workflow: 'singulance-production-hetzner.yml',
    canary: 'https://api.singulancelabs.com/health',
  },
  'harness-runner': {
    owner: 'amar3012005',
    repo: 'HIVEMIND',
    ref: 'singulance-main',
    workflow: 'singulance-production-hetzner.yml',
    service: 'harness-runner',
    canary: 'https://api.singulancelabs.com/health',
  },
};

export class SingulanceProductionRelease extends WorkflowEntrypoint {
  /**
 * @param {{ payload: { artifact: Artifact, sha?: string, services?: string[], image?: string, requestedBy?: string } }} event
   * @param {import('cloudflare:workers').WorkflowStep} step
   */
  async run(event, step) {
    const artifact = event.payload?.artifact;
    const spec = ARTIFACTS[artifact];
    if (!spec) {
      throw new Error(`unknown artifact ${artifact}. allowed: ${Object.keys(ARTIFACTS).join(', ')}`);
    }

    const sha = await step.do('resolve-locked-ref', async () => {
      const res = await fetch(
        `https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${spec.ref}`,
        { headers: githubHeaders(this.env) },
      );
      if (!res.ok) throw new Error(`github ref ${spec.ref} → ${res.status}`);
      const body = await res.json();
      const requestedSha = String(event.payload?.sha || '').trim();
      if (requestedSha && requestedSha !== body.sha) {
        throw new Error(`requested SHA ${requestedSha} is not current ${spec.repo}@${spec.ref} (${body.sha})`);
      }
      return { sha: body.sha, ref: spec.ref, repo: `${spec.owner}/${spec.repo}` };
    });

    const dispatch = await step.do('dispatch-github-actions', async () => {
      const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/actions/workflows/${spec.workflow}/dispatches`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...githubHeaders(this.env), 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: spec.ref,
          inputs: {
            sha: sha.sha,
            ...(spec.service ? { services: spec.service } : {}),
            ...(event.payload?.services ? { services: event.payload.services.join(',') } : {}),
            ...(event.payload?.image ? { harness_image: event.payload.image } : {}),
            requested_by: event.payload.requestedBy || 'cloudflare-workflow',
          },
        }),
      });
      if (res.status !== 204) {
        throw new Error(`github dispatch ${res.status} ${await res.text()}`);
      }
      return { dispatchedAt: Date.now(), workflow: spec.workflow };
    });

    const run = await step.do(
      'wait-github-run',
      { retries: { limit: 36, delay: '10 seconds', backoff: 'constant' } },
      async () => {
        const qs = new URLSearchParams({
          event: 'workflow_dispatch',
          branch: spec.ref,
          per_page: '5',
        });
        const res = await fetch(
          `https://api.github.com/repos/${spec.owner}/${spec.repo}/actions/workflows/${spec.workflow}/runs?${qs}`,
          { headers: githubHeaders(this.env) },
        );
        if (!res.ok) throw new Error(`github runs ${res.status}`);
        const body = await res.json();
        const match = (body.workflow_runs || []).find((row) => row.created_at && Date.parse(row.created_at) >= dispatch.dispatchedAt - 15_000);
        if (!match) throw new Error('github run not visible yet');
        if (match.status !== 'completed') throw new Error(`github run ${match.status}`);
        if (match.conclusion !== 'success') throw new Error(`github run ${match.conclusion} ${match.html_url}`);
        return { id: match.id, html_url: match.html_url, head_sha: match.head_sha };
      },
    );

    const canary = await step.do(
      'canary-public-origin',
      { retries: { limit: 5, delay: '5 seconds', backoff: 'linear' } },
      async () => {
        const res = await fetch(spec.canary, { redirect: 'follow' });
        if (!res.ok) throw new Error(`canary ${spec.canary} → ${res.status}`);
        return { url: spec.canary, status: res.status };
      },
    );

    return {
      artifact,
      lockedRef: spec.ref,
      sha: sha.sha,
      github: run,
      canary,
    };
  }
}

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'singulance-release-workflow',
    'x-github-api-version': '2022-11-28',
  };
}
