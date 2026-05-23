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

/**
 * Pull JSON / text body out of an MCP ToolResponse for parsing.
 */
function rawBodyText(raw) {
  try {
    const block = Array.isArray(raw?.content) ? raw.content[0] : null;
    return typeof block?.text === 'string' ? block.text : '';
  } catch {
    return '';
  }
}

function extractMarkerTags(toolName, args, raw) {
  const tags = new Set();
  const body = rawBodyText(raw);

  if (toolName.startsWith('slack_')) {
    // From args
    if (args?.channel_id) tags.add(`slack-channel-id:${args.channel_id}`);
    if (args?.thread_ts) tags.add(`slack-thread-ts:${args.thread_ts}`);
    // From response body. slack_read_channel returns lines like
    //   "Channel: #all-davinci-ai (C0AEN1R98BV)"
    //   "=== Message from Admin (U0AESBE05L6) at ... ==="
    //   "Message TS: 1778613040.934179"
    const chMatch = body.match(/Channel:\s*#([a-z0-9_-]+)\s*\(([A-Z0-9]+)\)/i);
    if (chMatch) {
      tags.add(`channel:${chMatch[1]}`);
      tags.add(`slack-channel-id:${chMatch[2]}`);
    }
    const userMatches = body.matchAll(/Message from\s+([^\s(]+(?:\s+[^\s(]+)?)\s+\(([A-Z0-9]+)\)/g);
    const senderNames = new Set();
    const senderIds = new Set();
    for (const m of userMatches) {
      senderNames.add(m[1].trim());
      senderIds.add(m[2]);
    }
    for (const n of Array.from(senderNames).slice(0, 5)) tags.add(`from:${n}`);
    for (const id of Array.from(senderIds).slice(0, 5)) tags.add(`slack-user-id:${id}`);
    const tsMatches = body.matchAll(/Message TS:\s*([\d.]+)/g);
    const tsList = [];
    for (const m of tsMatches) tsList.push(m[1]);
    if (tsList.length > 0) {
      tags.add(`slack-msg-count:${tsList.length}`);
      tags.add(`slack-latest-ts:${tsList[0]}`);
    }
  }

  if (toolName.startsWith('notion-') || toolName.startsWith('notion_')) {
    // notion-search returns JSON {"results":[{"id","title","type","url"}, ...]}
    try {
      const parsed = JSON.parse(body);
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      for (const r of results.slice(0, 5)) {
        if (r.id) tags.add(`notion-id:${r.id}`);
        if (r.title) tags.add(`notion-title:${r.title.slice(0, 60)}`);
        if (r.type) tags.add(`notion-type:${r.type}`);
      }
    } catch {}
  }

  if (toolName.startsWith('github_') || toolName.startsWith('github-')) {
    // GitHub MCP returns json with repo/issue/pr info
    try {
      const parsed = JSON.parse(body);
      if (parsed?.repository?.full_name) tags.add(`github-repo:${parsed.repository.full_name}`);
      if (parsed?.number) tags.add(`github-issue:${parsed.number}`);
    } catch {}
  }

  if (toolName.startsWith('linear_') || toolName.startsWith('linear-')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed?.identifier) tags.add(`linear-issue:${parsed.identifier}`);
      if (parsed?.team?.key) tags.add(`linear-team:${parsed.team.key}`);
    } catch {}
  }

  return Array.from(tags);
}

function buildIngestPayload(toolName, args, raw, ctx) {
  const provider = PROVIDER_FROM_TOOL[toolName];
  if (!provider) return null;

  const bodyText = rawBodyText(raw) || JSON.stringify(raw || {});
  if (!bodyText || bodyText.length < 20) return null;

  // Derive a more informative title when we can parse the body.
  let title = `${provider}/${toolName} live result`;
  if (toolName === 'slack_read_channel') {
    const m = bodyText.match(/Channel:\s*(#[a-z0-9_-]+)/i);
    if (m) title = `slack live: ${m[1]}`;
  } else if (toolName === 'slack_read_thread') {
    title = `slack live thread${args?.thread_ts ? ` ${String(args.thread_ts).slice(0, 12)}` : ''}`;
  }

  return {
    user_id: ctx.userId,
    org_id: ctx.orgId,
    title,
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
