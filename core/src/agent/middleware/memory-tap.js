/**
 * Memory-tap middleware.
 *
 * After every READ tool returns, schedule an async ingest of the result
 * into HIVEMIND memory so the next recall hits memory before going live
 * again. Fire-and-forget — never blocks the tool response.
 *
 * Triggers only when:
 *   - tool is readOnly (no point ingesting drafts)
 *   - response status === 'ok'
 *   - ctx.persistentMemoryEngine + ctx.buildRoutedIngestPayloads exist
 *
 * Tag scheme: `<provider>`, `<tool_name>`, plus any markers in the
 * response (channel:, page:, etc.) extracted by per-provider extractors.
 */

const PROVIDER_FROM_TOOL = {
  slack_read_channel: 'slack',
  slack_read_thread: 'slack',
  notion_read_page: 'notion',
  notion_search: 'notion',
  github_read_repo: 'github',
  linear_read_issue: 'linear',
};

function extractMarkerTags(toolName, args, raw) {
  const tags = [];
  if (toolName.startsWith('slack_')) {
    if (args?.channel_id) tags.push(`slack-channel-id:${args.channel_id}`);
  }
  return tags;
}

function buildIngestPayload(toolName, args, raw, ctx) {
  const provider = PROVIDER_FROM_TOOL[toolName];
  if (!provider) return null;

  // MCP tool results land in raw.content[0].text (often nested JSON).
  let bodyText = '';
  try {
    const block = Array.isArray(raw?.content) ? raw.content[0] : null;
    bodyText = typeof block?.text === 'string' ? block.text : JSON.stringify(raw || {});
  } catch {
    bodyText = JSON.stringify(raw || {});
  }
  if (!bodyText || bodyText.length < 20) return null;

  return {
    user_id: ctx.userId,
    org_id: ctx.orgId,
    title: `${provider}/${toolName} live result`,
    content: bodyText.slice(0, 4000),
    tags: [provider, `tool:${toolName}`, 'live-tap', ...extractMarkerTags(toolName, args, raw)],
    memory_type: 'event',
    source_metadata: {
      source_type: 'mcp-live-tap',
      source_platform: provider,
      source_id: `${provider}:${toolName}:${Date.now()}`,
    },
  };
}

export function createMemoryTapMiddleware({ logger = console } = {}) {
  return async function memoryTap(kwargs, next) {
    const { tool_call, args, ctx } = kwargs;
    const { tool } = tool_call;
    const resp = await next(kwargs);

    if (!tool.readOnly || resp.status !== 'ok') return resp;
    if (!ctx.persistentMemoryEngine?.ingestMemory) return resp;

    const payload = buildIngestPayload(tool.name, args, resp.meta?.raw, ctx);
    if (!payload) return resp;

    // Fire-and-forget — don't block the agent on memory write.
    setImmediate(async () => {
      try {
        await ctx.persistentMemoryEngine.ingestMemory(payload);
      } catch (err) {
        logger.warn(`[memory-tap] ingest failed for ${tool.name}: ${err.message}`);
      }
    });

    return resp;
  };
}
