/**
 * Durable Composio-session supervisor. Our model does not execute remote
 * tools. Reads go through Composio (search → MULTI_EXECUTE / executeTool)
 * with slugs from search. Native HIVEMIND tools dispatch in-process.
 * Writes become pendingWrite drafts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { executeHivemindCustomTool, nativeNameFromComposioSlug } from '../connectors/composio/hivemind-custom-toolkit.js';

const memoryRuns = new Map();

const READ_TOKENS = new Set(['fetch', 'find', 'get', 'list', 'read', 'search', 'retrieve']);
const WRITE_SEND_TOKENS = new Set(['send', 'reply', 'forward']);
const BLOCKED_WRITE_TOKENS = new Set(['delete', 'trash', 'remove', 'label', 'filter', 'settings']);

function tokens(slug) {
  return String(slug || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function conversationKey(ctx = {}) {
  return String(ctx.threadId || ctx.conversationId || ctx._conversationId || '').trim()
    || `user:${ctx.userId || 'anon'}`;
}

export function slugMatchesConnected(slug, connected = []) {
  if (!connected.length) return false;
  const head = String(slug || '').split('_')[0].toLowerCase();
  return connected.some((toolkit) => String(toolkit).toLowerCase().replace(/[^a-z0-9]/g, '') === head);
}

export function selectReadSlugs(slugs = [], connected = []) {
  return [...new Set((slugs || []).filter((slug) => {
    if (connected.length && !slugMatchesConnected(slug, connected)) return false;
    const t = tokens(slug);
    if (t.some((x) => BLOCKED_WRITE_TOKENS.has(x))) return false;
    if (t.some((x) => WRITE_SEND_TOKENS.has(x))) return false;
    return t.some((x) => READ_TOKENS.has(x));
  }))].slice(0, 6);
}

export function selectWriteSlug(slugs = [], connected = []) {
  const candidates = (slugs || []).filter((slug) => {
    if (connected.length && !slugMatchesConnected(slug, connected)) return false;
    const t = tokens(slug);
    if (t.some((x) => BLOCKED_WRITE_TOKENS.has(x))) return false;
    if (t.some((x) => WRITE_SEND_TOKENS.has(x))) return true;
    return t.includes('draft') && t.includes('create');
  });
  return candidates[0] || null;
}

export function emailsFromProviderData(data) {
  const found = new Set();
  const walk = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      for (const email of matches) {
        const lower = email.toLowerCase();
        const host = lower.split('@')[1] || '';
        if (/example\.(com|net|org)$/.test(host)) continue;
        if (host.endsWith('mail.gmail.com') || host.endsWith('google.com')) continue;
        if (host.split('.').length > 3) continue;
        found.add(lower);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) walk(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value).slice(0, 40)) walk(item, depth + 1);
    }
  };
  walk(data);
  return [...found];
}

export function namedPersonQuery(text) {
  const raw = String(text || '');
  const emails = emailsFromProviderData(raw);
  if (emails.length) return '';
  const via = raw.match(/\bto\s+([A-Za-z][A-Za-z0-9._-]{1,40})(?:\s+via|\s*$)/i);
  if (via?.[1] && !/^(me|him|her|them|us)$/i.test(via[1])) return via[1];
  return '';
}

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    conversationId: row.conversationId,
    goal: row.goal,
    composioSessionId: row.composioSessionId || null,
    status: row.status,
    steps: Array.isArray(row.steps) ? row.steps : [],
    scratch: row.scratch && typeof row.scratch === 'object' ? row.scratch : {},
  };
}

export async function loadAgentRun({ prisma, orgId, conversationId }) {
  if (prisma?.agentRun?.findUnique) {
    const row = await prisma.agentRun.findUnique({
      where: { orgId_conversationId: { orgId, conversationId } },
    });
    return runFromRow(row);
  }
  return memoryRuns.get(`${orgId}:${conversationId}`) || null;
}

export async function saveAgentRun({ prisma, run }) {
  const payload = {
    orgId: run.orgId,
    userId: run.userId,
    conversationId: run.conversationId,
    goal: run.goal,
    composioSessionId: run.composioSessionId || null,
    status: run.status,
    steps: run.steps || [],
    scratch: run.scratch || {},
  };
  if (prisma?.agentRun?.upsert) {
    const row = await prisma.agentRun.upsert({
      where: { orgId_conversationId: { orgId: run.orgId, conversationId: run.conversationId } },
      create: { id: run.id, ...payload },
      update: payload,
    });
    return runFromRow(row);
  }
  const stored = { ...run, ...payload, id: run.id };
  memoryRuns.set(`${run.orgId}:${run.conversationId}`, stored);
  return stored;
}

export async function getOrCreateAgentRun({ prisma, ctx, message }) {
  const conversationId = conversationKey(ctx);
  const existing = await loadAgentRun({ prisma, orgId: ctx.orgId, conversationId });
  if (existing) {
    if (message && existing.goal !== message) {
      existing.goal = `${existing.goal}\n${message}`.slice(0, 4000);
    }
    if (existing.status === 'waiting_connection') existing.status = 'running';
    return existing;
  }
  return {
    id: randomUUID(),
    orgId: ctx.orgId,
    userId: ctx.userId,
    conversationId,
    goal: String(message || '').slice(0, 4000),
    composioSessionId: null,
    status: 'running',
    steps: [],
    scratch: {},
  };
}

function recordStep(run, step) {
  run.steps.push({
    id: `s${run.steps.length + 1}`,
    at: new Date().toISOString(),
    ...step,
  });
}

export async function runDurableComposioAgent({
  message,
  ctx,
  onEvent,
  composio = null,
  prisma = null,
} = {}) {
  const emit = onEvent || (() => {});
  const db = prisma || ctx?.prisma || null;
  const run = await getOrCreateAgentRun({ prisma: db, ctx, message });
  if (run.status === 'waiting_approval' && run.scratch?.draft_id) {
    return {
      status: 'pending',
      run,
      summary: 'Draft ready for approval. Nothing has been sent.',
      steps: run.steps,
      draftIds: [run.scratch.draft_id],
      pendingActions: [],
    };
  }
  const composioSvc = composio || await import('../connectors/composio/composio-service.js');
  const orgId = ctx?.orgId;
  if (!orgId) {
    run.status = 'failed';
    await saveAgentRun({ prisma: db, run });
    return { status: 'error', run, summary: 'org_scope_required', steps: run.steps, draftIds: [], pendingActions: [] };
  }

  const accounts = typeof composioSvc.listConnectedAccounts === 'function'
    ? await composioSvc.listConnectedAccounts(orgId).catch(() => [])
    : [];
  const connected = [...new Set(accounts.filter((row) => row.status === 'ACTIVE').map((row) => row.toolkit).filter(Boolean))];
  run.scratch.connected_toolkits = connected;

  if (!run.composioSessionId && typeof composioSvc.getToolRouterSession === 'function' && connected.length) {
    try {
      const session = await composioSvc.getToolRouterSession(orgId, connected.slice(0, 8));
      run.composioSessionId = session.id || null;
    } catch (error) {
      run.scratch.session_error = String(error.message || error).slice(0, 240);
    }
  }

  const discovered = typeof composioSvc.searchToolsByIntent === 'function'
    ? await composioSvc.searchToolsByIntent(orgId, message)
    : { tools: [], connectedToolkits: connected };
  const searchedSlugs = (discovered.tools || []).map((tool) => tool?._composio?.slug).filter(Boolean);
  run.scratch.searched_slugs = searchedSlugs.slice(0, 24);
  recordStep(run, { kind: 'search', slugs: searchedSlugs.slice(0, 12), executor: 'composio' });
  emit({ type: 'tool_result', name: 'COMPOSIO_SEARCH_TOOLS', status: 'completed', summary: searchedSlugs.slice(0, 8).join(',') });

  try {
    const dispatch = ctx?._tracedDispatch || ctx?._dispatchTool;
    let recall;
    if (typeof dispatch === 'function') {
      const data = await dispatch('hivemind_recall', { query: message, query_original: message });
      recall = { successful: !data?.error, data, error: data?.error || null };
    } else {
      recall = await executeHivemindCustomTool('HIVEMIND_RECALL', {
        query: message,
        query_original: message,
        _structured_intent: true,
      }, ctx);
    }
    recordStep(run, {
      kind: 'native', slug: 'HIVEMIND_RECALL', executor: 'hivemind',
      status: recall.successful ? 'completed' : 'error',
    });
    emit({ type: 'tool_result', name: 'hivemind_recall', status: recall.successful ? 'completed' : 'error' });
    if (recall.successful) run.scratch.recall = true;
  } catch (error) {
    recordStep(run, { kind: 'native', slug: 'HIVEMIND_RECALL', status: 'error', error: error.message });
  }

  const writeSlug = selectWriteSlug(searchedSlugs, connected);
  const person = namedPersonQuery(message);
  const readSlugs = [...new Set(selectReadSlugs(searchedSlugs, connected))]
    .sort((left, right) => {
      const rank = (slug) => (/FETCH_EMAIL|GET_CONTACT|SEARCH_PEOPLE/i.test(slug) ? 0 : 1);
      return rank(left) - rank(right);
    })
    .slice(0, 3);

  const readCalls = readSlugs.map((slug) => {
    const args = /FETCH_EMAIL|SEARCH|CONTACT/i.test(slug) && person
      ? { query: person, max_results: 5 }
      : {};
    return { slug, arguments: args };
  });

  if (readCalls.length && typeof composioSvc.executeToolsParallel === 'function') {
    const results = await composioSvc.executeToolsParallel(orgId, readCalls, { sessionId: run.composioSessionId });
    results.forEach((result, index) => {
      const slug = readCalls[index].slug;
      recordStep(run, {
        kind: 'read', slug, executor: 'composio',
        status: result?.successful ? 'completed' : 'error',
      });
      emit({ type: 'tool_result', name: slug, status: result?.successful ? 'completed' : 'error' });
      const emails = emailsFromProviderData(result?.data);
      if (emails.length) run.scratch.emails = [...new Set([...(run.scratch.emails || []), ...emails])];
    });
  } else if (readCalls.length && typeof composioSvc.executeTool === 'function') {
    for (const call of readCalls) {
      const result = await composioSvc.executeTool(orgId, call.slug, call.arguments);
      recordStep(run, {
        kind: 'read', slug: call.slug, executor: 'composio',
        status: result?.successful ? 'completed' : 'error',
      });
      const emails = emailsFromProviderData(result?.data);
      if (emails.length) run.scratch.emails = [...new Set([...(run.scratch.emails || []), ...emails])];
    }
  }

  const draftIds = [];
  const pendingActions = [];
  if (writeSlug) {
    const toolkit = String(writeSlug.split('_')[0] || 'gmail').toLowerCase();
    if (connected.length && !connected.includes(toolkit) && !connected.includes(writeSlug.split('_')[0]?.toLowerCase())) {
      run.status = 'waiting_connection';
      run.scratch.needs_toolkit = toolkit;
      recordStep(run, { kind: 'connect', toolkit, status: 'waiting_connection' });
      await saveAgentRun({ prisma: db, run });
      return {
        status: 'needs_connection',
        run,
        summary: `Connect ${toolkit} to continue.`,
        steps: run.steps,
        draftIds,
        pendingActions,
      };
    }
    const to = (run.scratch.emails || [])[0] || null;
    const body = `Briefing from HIVEMIND for: ${String(message).slice(0, 400)}`;
    const args = {
      recipient_email: to,
      to,
      subject: 'HIVEMIND update',
      body,
      _composio_slug: writeSlug,
    };
    if (!to) {
      run.status = 'waiting_user';
      recordStep(run, { kind: 'write', slug: writeSlug, status: 'waiting_user', error: 'recipient unresolved' });
      await saveAgentRun({ prisma: db, run });
      return {
        status: 'needs_input',
        run,
        summary: 'Need a recipient email to draft the message.',
        steps: run.steps,
        draftIds,
        pendingActions,
        inputRequests: [{ kind: 'field_input', field: 'recipient_email', prompt: 'Recipient email' }],
      };
    }
    const drafted = await createDraft(ctx, writeSlug, args);
    if (drafted?.id) {
      draftIds.push(drafted.id);
      pendingActions.push({ id: drafted.id, tool: writeSlug, args });
      run.status = 'waiting_approval';
      run.scratch.draft_id = drafted.id;
      recordStep(run, { kind: 'write', slug: writeSlug, status: 'draft_created', draft_id: drafted.id, executor: 'composio' });
      emit({ type: 'tool_result', name: writeSlug, status: 'draft_created' });
    } else {
      run.status = 'failed';
      recordStep(run, { kind: 'write', slug: writeSlug, status: 'error', error: drafted?.error || 'draft failed' });
    }
    await saveAgentRun({ prisma: db, run });
    return {
      status: drafted?.id ? 'pending' : 'error',
      run,
      summary: drafted?.id
        ? 'Draft ready for approval. Nothing has been sent.'
        : (drafted?.error || 'draft failed'),
      steps: run.steps,
      draftIds,
      pendingActions,
    };
  }

  run.status = 'done';
  await saveAgentRun({ prisma: db, run });
  return {
    status: 'completed',
    run,
    summary: 'Completed durable agent steps.',
    steps: run.steps,
    draftIds,
    pendingActions,
  };
}

async function createDraft(ctx, composioSlug, args) {
  if (!ctx?.prisma?.pendingWrite?.create) {
    return { id: `mem-${randomUUID()}`, error: null };
  }
  const slug = String(composioSlug).slice(0, 120);
  const toolArgs = { ...(args || {}), _composio_slug: slug };
  const idempotencyKey = createHash('sha256')
    .update(`durable:${ctx.orgId}:${ctx.userId}:${slug}:${ctx._trace?.traceId || Date.now()}:${JSON.stringify(toolArgs)}`)
    .digest('hex');
  try {
    const row = await ctx.prisma.pendingWrite.create({
      data: {
        userId: ctx.userId,
        orgId: ctx.orgId || null,
        provider: 'composio',
        toolGroup: 'composio',
        toolName: slug,
        toolArgs,
        argsHash: createHash('sha256').update(JSON.stringify(toolArgs)).digest('hex'),
        traceId: ctx._trace?.traceId ? String(ctx._trace.traceId).slice(0, 160) : null,
        idempotencyKey,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        preview: `${slug} to ${args.recipient_email || args.to || ''}`.slice(0, 200),
        status: 'draft',
      },
    });
    return { id: row?.id || null, error: null };
  } catch (err) {
    return { id: null, error: String(err.message || err).slice(0, 240) };
  }
}

export function resetDurableAgentMemory() {
  memoryRuns.clear();
}

export { nativeNameFromComposioSlug };
