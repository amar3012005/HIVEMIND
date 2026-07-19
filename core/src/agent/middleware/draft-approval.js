/**
 * Draft-approval middleware.
 *
 * Intercepts tool calls whose tool entry has readOnly=false.
 * Flow:
 *   1. Agent invokes write tool (e.g. slack_send_message).
 *   2. Middleware persists args to pending_writes row (status='draft').
 *   3. Returns ToolResponse { status: 'draft_created', draft_id, preview }
 *      so the LLM acknowledges + FE renders DraftCard.
 *   4. User clicks Approve in UI → /v1/proxy/pending-writes/:id/approve
 *      → backend re-executes the tool, updates pending_writes row.
 *   5. Agent re-runs of the same tool in this turn with
 *      approval_token=<draft_id> bypass the middleware (skip flag).
 */
import { createHash } from 'node:crypto';

// Tool name conventions diverge per MCP provider:
//   slack  → snake_case  (slack_send_message)
//   notion → kebab-case  (notion-create-pages)
//   github → snake_case  (github_create_issue)
//   linear → snake_case  (linear_create_issue)
//   gmail  → snake_case  (gmail_send_message)
// Match BOTH separators so provider always resolves regardless of vendor.
const PROVIDER_PREFIXES = ['slack', 'notion', 'gmail', 'github', 'linear'];

function inferProvider(toolName) {
  for (const prov of PROVIDER_PREFIXES) {
    if (toolName.startsWith(prov + '_') || toolName.startsWith(prov + '-')) return prov;
  }
  return null;
}

function buildPreview(toolName, args) {
  const provider = inferProvider(toolName) || 'tool';
  if (toolName === 'slack_send_message' || toolName === 'slack_send_message_draft') {
    return `Send to Slack channel ${args.channel_id || '?'}: ${(args.message || '').slice(0, 160)}`;
  }
  if (toolName === 'slack_schedule_message') {
    const at = args.post_at ? new Date(args.post_at * 1000).toISOString() : '?';
    return `Schedule Slack msg to ${args.channel_id || '?'} at ${at}: ${(args.message || '').slice(0, 140)}`;
  }
  if (toolName === 'notion-create-pages') {
    const pages = Array.isArray(args.pages) ? args.pages : (args.page ? [args.page] : []);
    const titles = pages.map(p => p?.properties?.title || p?.title || '(untitled)').slice(0, 3);
    return `Create Notion page${pages.length > 1 ? 's' : ''}: ${titles.join(' / ')}`;
  }
  if (toolName === 'notion-update-page') {
    return `Update Notion page ${args.page_id || '?'}`;
  }
  if (toolName === 'notion-create-comment') {
    return `Comment on Notion ${args.page_id || args.discussion_id || '?'}: ${(args.rich_text?.[0]?.text?.content || '').slice(0, 140)}`;
  }
  return `${provider}/${toolName}: ${JSON.stringify(args || {}).slice(0, 200)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashArgs(args) {
  return createHash('sha256').update(stableJson(args || {})).digest('hex');
}

/**
 * @param {{ prisma: any, logger?: any }} deps
 * @returns middleware fn (kwargs, next)
 */
export function createDraftApprovalMiddleware({ prisma, logger = console }) {
  return async function draftApproval(kwargs, next) {
    const { tool_call, args, ctx } = kwargs;
    const { tool } = tool_call;

    // Read tools pass through unchanged.
    if (tool.readOnly || tool.external !== true) {
      return next(kwargs);
    }

    // Approval bypass: agent re-invokes the same tool after user clicked
    // Approve. The handler upstream substitutes the args from the row +
    // sets approval_token === draft_id.
    if (args?._approval_token && typeof args._approval_token === 'string') {
      const row = await prisma.pendingWrite.findUnique({
        where: { id: args._approval_token },
      }).catch(() => null);
      const cleanArgs = { ...args };
      delete cleanArgs._approval_token;
      const currentHash = hashArgs(cleanArgs);
      const unexpired = row?.expiresAt && new Date(row.expiresAt).getTime() > Date.now();
      if (row && row.status === 'approved' && row.toolName === tool.name
          && row.toolGroup === tool.groupName && row.userId === ctx.userId && row.orgId === ctx.orgId
          && (row.projectId || null) === (ctx.projectId || null)
          && row.argsHash === currentHash && unexpired) {
        const claimed = await prisma.pendingWrite.updateMany({
          where: {
            id: row.id,
            status: 'approved',
            toolName: tool.name,
            userId: ctx.userId,
            orgId: ctx.orgId,
            toolGroup: tool.groupName,
            argsHash: currentHash,
            projectId: ctx.projectId || null,
            expiresAt: { gt: new Date() },
          },
          data: { status: 'executing' },
        }).catch(() => ({ count: 0 }));
        if (claimed.count !== 1) {
          return {
            content: [{ type: 'text', text: 'draft was already claimed or its authorization changed' }],
            status: 'error',
            meta: { error: 'approval_replay_or_scope_mismatch' },
          };
        }
        // Strip the token before invoking the real handler.
        const innerResp = await next({ ...kwargs, args: cleanArgs });
        // Persist result.
        await prisma.pendingWrite.update({
          where: { id: row.id },
          data: {
            status: innerResp.status === 'error' ? 'failed' : 'sent',
            sentAt: new Date(),
            result: innerResp.meta?.raw || null,
            errorMsg: innerResp.status === 'error' ? (innerResp.meta?.error || null) : null,
          },
        }).catch(() => null);
        return innerResp;
      }
      return {
        content: [{ type: 'text', text: 'invalid or unapproved draft token' }],
        status: 'error',
        meta: { error: 'invalid_approval_token' },
      };
    }

    // Create draft.
    const provider = tool.groupName || inferProvider(tool.name) || 'unknown';
    const preview = buildPreview(tool.name, args);
    const argsHash = hashArgs(args);
    const expiresAt = new Date(Date.now() + Number(process.env.CHAT_DRAFT_TTL_MS || 15 * 60_000));
    const idempotencyKey = createHash('sha256')
      .update(`${ctx.orgId}:${ctx.userId}:${ctx.projectId || ''}:${tool.groupName}:${tool.name}:${argsHash}:${ctx._trace?.traceId || ''}`)
      .digest('hex');
    let draftId;
    try {
      const row = await prisma.pendingWrite.create({
        data: {
          userId: ctx.userId,
          orgId: ctx.orgId || null,
          provider,
          toolGroup: tool.groupName,
          toolName: tool.name,
          toolArgs: args || {},
          argsHash,
          projectId: ctx.projectId || null,
          connectionId: ctx.connectionId || null,
          traceId: ctx._trace?.traceId || null,
          idempotencyKey,
          expiresAt,
          preview,
          status: 'draft',
        },
      });
      draftId = row.id;
    } catch (err) {
      logger.warn(`[draft-approval] persist failed: ${err.message}`);
      return {
        content: [{ type: 'text', text: `draft creation failed: ${err.message}` }],
        status: 'error',
        meta: { error: err.message },
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Draft created — awaiting user approval. Tool: ${tool.name}, draft_id: ${draftId}. Preview: ${preview}`,
        },
      ],
      status: 'draft_created',
      meta: {
        draft_id: draftId,
        tool_name: tool.name,
        provider,
        preview,
      },
    };
  };
}
