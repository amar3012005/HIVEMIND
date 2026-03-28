function decodeSegment(segment) {
  return decodeURIComponent(segment || '');
}

function ok(body, statusCode = 200) {
  return { handled: true, statusCode, body };
}

export const RESIDENT_ROUTE_TEMPLATES = [
  '/api/swarm/resident/agents',
  '/api/swarm/resident/agents/:agent_id/run',
  '/api/swarm/resident/runs/:run_id',
  '/api/swarm/resident/runs/:run_id/observations',
  '/api/swarm/resident/runs/:run_id/cancel',
];

export function createResidentRoutes(manager) {
  return {
    async dispatch({ pathname, method, body = {}, userId, orgId }) {
      if (pathname === '/api/swarm/resident/agents' && method === 'GET') {
        const agents = await manager.listAgents();
        return ok({ agents, count: agents.length });
      }

      const runAgentMatch = pathname.match(/^\/api\/swarm\/resident\/agents\/([^/]+)\/run$/);
      if (runAgentMatch && method === 'POST') {
        const agentId = decodeSegment(runAgentMatch[1]);
        const run = await manager.startRun(agentId, body, { userId, orgId });
        return ok(run, 202);
      }

      const runMatch = pathname.match(/^\/api\/swarm\/resident\/runs\/([^/]+)$/);
      if (runMatch && method === 'GET') {
        const runId = decodeSegment(runMatch[1]);
        const run = await manager.getRun(runId);
        if (!run) return ok({ error: 'Run not found' }, 404);
        return ok(run);
      }

      const observationsMatch = pathname.match(/^\/api\/swarm\/resident\/runs\/([^/]+)\/observations$/);
      if (observationsMatch && method === 'GET') {
        const runId = decodeSegment(observationsMatch[1]);
        const result = await manager.getRunObservations(runId);
        if (!result) return ok({ error: 'Run not found' }, 404);
        return ok(result);
      }

      const cancelMatch = pathname.match(/^\/api\/swarm\/resident\/runs\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const runId = decodeSegment(cancelMatch[1]);
        const run = await manager.cancelRun(runId);
        if (!run) return ok({ error: 'Run not found' }, 404);
        return ok({
          run_id: run.run_id,
          status: run.status,
          cancelled_at: run.cancelled_at || null,
        });
      }

      return null;
    },
  };
}
