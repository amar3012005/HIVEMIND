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
  try {
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
  const rootId = crypto.randomUUID();
  const traceId = rootId;
  const metadata = safeTraceMetadata({ ctx, runId });
  const safely = promise => Promise.resolve(promise).catch(error => logger?.warn?.(`[governed-agent] LangSmith trace degraded: ${error.message}`));
  await safely(traceClient.createRun({
    id: rootId,
    trace_id: traceId,
    name: 'governed_run',
    run_type: 'chain',
    project_name: projectName,
    start_time: Date.now(),
    inputs: { redacted: true },
    extra: { metadata },
  }));

  return {
    async span(name, extra = {}) {
      const id = crypto.randomUUID();
      const spanMetadata = safeTraceMetadata({ ctx, runId, extra });
      await safely(traceClient.createRun({
        id,
        trace_id: traceId,
        parent_run_id: rootId,
        name: asText(name, 120),
        run_type: 'tool',
        project_name: projectName,
        start_time: Date.now(),
        inputs: { redacted: true },
        extra: { metadata: spanMetadata },
      }));
      return {
        end: async (result = {}) => safely(traceClient.updateRun(id, {
          end_time: Date.now(),
          outputs: { redacted: true },
          extra: { metadata: safeTraceMetadata({ ctx, runId, extra: { ...extra, ...result } }) },
        })),
        error: async (error) => safely(traceClient.updateRun(id, {
          end_time: Date.now(),
          error: asText(error?.message || error || 'unknown', 300),
          outputs: { redacted: true },
        })),
      };
    },
    async end(result = {}) {
      await safely(traceClient.updateRun(rootId, {
        end_time: Date.now(),
        outputs: { redacted: true },
        extra: { metadata: safeTraceMetadata({ ctx, runId, extra: result }) },
      }));
      await safely(traceClient.flush?.());
    },
    async error(error) {
      await safely(traceClient.updateRun(rootId, {
        end_time: Date.now(),
        error: asText(error?.message || error || 'unknown', 300),
        outputs: { redacted: true },
      }));
      await safely(traceClient.flush?.());
    },
  };
}
