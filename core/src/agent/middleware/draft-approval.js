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

const WRITE_TOOL_PROVIDER_REGEX = {
  // Heuristic: derive provider from tool name prefix.
  slack_: 'slack',
  notion_: 'notion',
  gmail_: 'gmail',
  github_: 'github',
  linear_: 'linear',
};

function inferProvider(toolName) {
  for (const [prefix, prov] of Object.entries(WRITE_TOOL_PROVIDER_REGEX)) {
    if (toolName.startsWith(prefix)) return prov;
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
  return `${provider}/${toolName}: ${JSON.stringify(args || {}).slice(0, 200)}`;
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
    if (tool.readOnly) {
      return next(kwargs);
    }

    // Approval bypass: agent re-invokes the same tool after user clicked
    // Approve. The handler upstream substitutes the args from the row +
    // sets approval_token === draft_id.
    if (args?._approval_token && typeof args._approval_token === 'string') {
      const row = await prisma.pendingWrite.findUnique({
        where: { id: args._approval_token },
      }).catch(() => null);
      if (row && row.status === 'approved' && row.toolName === tool.name && row.userId === ctx.userId) {
        // Strip the token before invoking the real handler.
        const cleanArgs = { ...args };
        delete cleanArgs._approval_token;
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
    const provider = inferProvider(tool.name) || 'unknown';
    const preview = buildPreview(tool.name, args);
    let draftId;
    try {
      const row = await prisma.pendingWrite.create({
        data: {
          userId: ctx.userId,
          orgId: ctx.orgId || null,
          provider,
          toolName: tool.name,
          toolArgs: args || {},
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
