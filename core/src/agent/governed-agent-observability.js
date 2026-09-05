import crypto from 'node:crypto';

const asText = (value, limit = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 20);

export function isLangSmithTracingEnabled(env = process.env) {
  return String(env.LANGSMITH_TRACING || '').toLowerCase() === 'true' && Boolean(env.LANGSMITH_API_KEY);
}

export function safeTraceMetadata({ ctx = {}, runId, runtime = 'langgraph-governed-v2', extra = {} } = {}) {
  return {
    runtime,
    run_hash: hash(runId),
    org_hash: hash(ctx.orgId),
    user_hash: hash(ctx.userId),
    locale: asText(ctx.language || 'en', 20),
    feature_flag: asText(ctx.durableChatMode || 'off', 20),
    ...extra,
  };
}

/**
 * A deliberately narrow LangSmith bridge.  We create structural spans only:
 * no prompts, bodies, OAuth material, connector arguments, or provider data
 * are sent to LangSmith.  If tracing is unavailable it degrades silently; it
 * never changes execution or approval semantics.
 */
export async function createGovernedTrace({ ctx = {}, runId, env = process.env, client = null, logger = console } = {}) {
  if (!isLangSmithTracingEnabled(env) && !client) return null;
  const projectName = String(env.LANGSMITH_PROJECT || 'singulance-governed-agent-canary').slice(0, 120);
  let traceClient = client;
  let RunTree;
  try {
    ({ RunTree } = await import('langsmith/run_trees'));
    if (!traceClient) {
      const { Client } = await import('langsmith');
      traceClient = new Client({
        apiKey: env.LANGSMITH_API_KEY,
        apiUrl: env.LANGSMITH_ENDPOINT || undefined,
        hideInputs: true,
        hideOutputs: true,
        autoBatchTracing: true,
      });
    }
  } catch (error) {
    logger?.warn?.(`[governed-agent] LangSmith unavailable: ${error.message}`);
    return null;
  }
  const metadata = safeTraceMetadata({ ctx, runId });
  const safely = promise => Promise.resolve(promise).catch(error => logger?.warn?.(`[governed-agent] LangSmith trace degraded: ${error.message}`));
  const root = new RunTree({
    name: 'governed_run',
    run_type: 'chain',
    project_name: projectName,
    inputs: { redacted: true },
    extra: { metadata },
    client: traceClient,
  });
  await safely(root.postRun());

  return {
    async span(name, extra = {}) {
      const spanMetadata = safeTraceMetadata({ ctx, runId, extra });
      const child = root.createChild({
        name: asText(name, 120),
        run_type: 'tool',
        inputs: { redacted: true },
        extra: { metadata: spanMetadata },
      });
      await safely(child.postRun());
      return {
        end: async (result = {}) => {
          await child.end({ redacted: true }, undefined, Date.now(), safeTraceMetadata({ ctx, runId, extra: { ...extra, ...result } }));
          return safely(child.patchRun());
        },
        error: async (error) => {
          await child.end({ redacted: true }, asText(error?.message || error || 'unknown', 300));
          return safely(child.patchRun());
        },
      };
    },
    async end(result = {}) {
      await root.end({ redacted: true }, undefined, Date.now(), safeTraceMetadata({ ctx, runId, extra: result }));
      await safely(root.patchRun());
      await safely(traceClient.flush?.());
    },
    async error(error) {
      await root.end({ redacted: true }, asText(error?.message || error || 'unknown', 300));
      await safely(root.patchRun());
      await safely(traceClient.flush?.());
    },
  };
}
