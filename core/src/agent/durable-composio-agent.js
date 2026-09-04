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

export const RETRY_CONNECT_VALUE = '__retry_connect__';

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
    if (t.includes('attachment') || t.includes('collaborator') || t.includes('assignee')) return false;
    if (t.includes('message') && t.includes('id')) return false;
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

export function pickRecipientEmail(emails = [], person = '') {
  const list = [...new Set((emails || []).map((email) => String(email).toLowerCase()))];
  const needle = String(person || '').toLowerCase();
  if (needle) {
    const hit = list.find((email) => email.includes(needle));
    if (hit) return hit;
  }
  return list[0] || null;
}

export function toolkitFromSlug(slug) {
  return String(slug || '').split('_')[0].toLowerCase() || null;
}

export function uniqueToolkitsFromSlugs(slugs = []) {
  return [...new Set((slugs || []).map(toolkitFromSlug).filter(Boolean))]
    .filter((toolkit) => toolkit !== 'hivemind' && toolkit !== 'local' && toolkit !== 'composio');
}

export function displayAppName(toolkit) {
  const key = String(toolkit || '').trim().toLowerCase();
  if (!key) return 'this app';
  return key.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export const TOOLKIT_ALIASES = Object.freeze({
  github: ['github', 'git', 'repo', 'repos', 'repository', 'repositories'],
  gmail: ['gmail', 'email', 'mail'],
  slack: ['slack'],
  notion: ['notion'],
  googledrive: ['googledrive', 'google drive', 'gdrive', 'drive'],
});

export function appsMatchingRequest(message, toolkits = []) {
  const text = ` ${String(message || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return (toolkits || []).filter((toolkit) => {
    const key = String(toolkit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = TOOLKIT_ALIASES[key] || [key, String(toolkit || '').toLowerCase().replace(/[-_]/g, ' ')];
    return aliases.some((alias) => text.includes(` ${String(alias).replace(/[-_]/g, ' ')} `));
  });
}

export function writeToolkitsIn(message, toolkits = []) {
  const text = String(message || '').toLowerCase();
  if (!/\b(send|email|mail|via|draft|share|forward)\b/.test(text)) return [];
  return (toolkits || []).filter((toolkit) => {
    const key = String(toolkit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key === 'gmail' || key === 'outlook') return /\b(gmail|email|mail|outlook)\b/.test(text);
    if (key === 'slack') return /\bslack\b/.test(text);
    return false;
  });
}

export function isReadThenWrite(message, toolkits = []) {
  const writes = writeToolkitsIn(message, toolkits);
  const reads = (toolkits || []).filter((toolkit) => !writes.includes(toolkit));
  return writes.length >= 1 && reads.length >= 1;
}

export function namedRepoQuery(text) {
  const match = String(text || '').match(/\b(hivemind|hive-mind|hive mind)\b/i);
  return match ? String(match[1]).replace(/\s+/g, '-') : '';
}

export function summarizeToolData(data, limit = 1800) {
  if (data == null) return '';
  const rows = data.items || data.repositories || data.repos || data.messages || [];
  if (Array.isArray(rows) && rows.length) {
    return rows.slice(0, 8).map((item) => {
      if (item == null || typeof item !== 'object') return String(item);
      return [
        item.full_name || item.name || item.title || item.subject,
        item.description || item.body || item.snippet,
        item.html_url || item.url,
      ].filter(Boolean).join(' — ');
    }).filter(Boolean).join('\n').slice(0, limit);
  }
  const blob = data.content || data.readme || data.body || data.text;
  if (typeof blob === 'string' && blob.trim()) return blob.trim().slice(0, limit);
  try {
    return JSON.stringify(data).slice(0, limit);
  } catch {
    return String(data).slice(0, limit);
  }
}

export function composeBriefing({ message, reads = [], recallText = '' } = {}) {
  const sections = [];
  for (const read of reads) {
    const summary = summarizeToolData(read?.data);
    if (!summary) continue;
    sections.push(`${read.slug}\n${summary}`);
  }
  if (recallText) sections.push(`HIVEMIND memory\n${String(recallText).slice(0, 1200)}`);
  const body = sections.join('\n\n').trim();
  if (body) return body.slice(0, 7000);
  return `Could not retrieve repository details yet.\n\nRequest: ${String(message || '').slice(0, 400)}`;
}

export function argumentsForReadSlug(slug, { person = '', repoHint = '' } = {}) {
  if (/FETCH_EMAIL|SEARCH_PEOPLE|GET_CONTACT|LIST_MESSAGES/i.test(slug) && person) {
    return { query: person, max_results: 5 };
  }
  if (/GITHUB_SEARCH|SEARCH_REPOS/i.test(slug)) {
    return { q: repoHint || 'HIVEMIND', query: repoHint || 'HIVEMIND' };
  }
  if (/LIST_REPOS|LIST_REPOSITORIES/i.test(slug)) {
    return { per_page: 15, affiliation: 'owner,collaborator,organization_member' };
  }
  return {};
}

function beginTool(emit, _run, name, args) {
  emit({ type: 'tool_started', name, tool: name, arguments: args || {} });
}

function finishTool(emit, run, name, { kind, status, summary, extra = {}, args } = {}) {
  recordStep(run, {
    kind,
    slug: name,
    tool: name,
    operation: name,
    status,
    summary,
    ...extra,
  });
  emit({
    type: 'tool_result',
    name,
    tool: name,
    status,
    result_summary: summary || status,
    arguments: args || {},
  });
}

export function connectAccountRequest(toolkit, redirectUrl = null) {
  const label = displayAppName(toolkit);
  return {
    kind: 'connect_account',
    field: 'connection',
    toolkit,
    provider: toolkit,
    app_label: label,
    logo_url: `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`,
    blocking: true,
    prompt: `Connect ${label} to continue. Approve access in the new tab, then come back and continue this request.`,
    options: [
      { id: 'connect', label: `Connect ${label}`, href: redirectUrl, open_url: Boolean(redirectUrl), value: redirectUrl || 'connect' },
      { id: 'connected', label: `I've connected ${label} — continue`, value: RETRY_CONNECT_VALUE },
    ],
  };
}

export function clarifyAppsRequest(toolkits = []) {
  const options = toolkits.slice(0, 6).map((toolkit) => ({
    id: toolkit,
    label: displayAppName(toolkit),
    value: toolkit,
    toolkit,
  }));
  return {
    kind: 'single_choice',
    field: 'toolkit',
    prompt: `Do you mean ${options.map((option) => option.label).join(', ').replace(/, ([^,]*)$/, ' or $1')}? Choose one and I will continue this request.`,
    options,
  };
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

function pause(run, inputRequest, summary) {
  return {
    status: 'needs_input',
    run,
    summary,
    steps: run.steps,
    draftIds: [],
    pendingActions: [],
    inputRequests: [inputRequest],
    resumeState: {
      kind: 'durable_agent',
      run_id: run.id,
      results: [{ inputRequest }],
    },
  };
}

export async function runDurableComposioAgent({
  message,
  ctx,
  onEvent,
  composio = null,
  prisma = null,
  choice = null,
} = {}) {
  const emit = onEvent || (() => {});
  const db = prisma || ctx?.prisma || null;
  const run = await getOrCreateAgentRun({ prisma: db, ctx, message });
  const picked = choice || ctx?.durableChoice || null;
  if (picked?.value === RETRY_CONNECT_VALUE || picked?.option_id === 'connected') {
    run.status = 'running';
  }
  if (picked?.values && typeof picked.values === 'object') {
    run.scratch.field_values = { ...(run.scratch.field_values || {}), ...picked.values };
    if (picked.values.app) {
      run.scratch.chosen_toolkit = String(picked.values.app).toLowerCase().replace(/[^a-z0-9]/g, '');
      run.status = 'running';
    }
  }
  if (picked?.value && picked.option_id && picked.option_id !== 'connect' && picked.option_id !== 'connected') {
    run.scratch.chosen_toolkit = String(picked.value || picked.toolkit || '').toLowerCase();
    run.status = 'running';
  }
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

  beginTool(emit, run, 'COMPOSIO_SEARCH_TOOLS', { query: message });
  const discovered = typeof composioSvc.searchToolsByIntent === 'function'
    ? await composioSvc.searchToolsByIntent(orgId, message)
    : { tools: [], connectedToolkits: connected };
  let searchedSlugs = (discovered.tools || []).map((tool) => tool?._composio?.slug).filter(Boolean);
  const discoveredToolkits = uniqueToolkitsFromSlugs(searchedSlugs);
  const mentioned = appsMatchingRequest(message, [...discoveredToolkits, ...connected, ...((discovered.apps || []).map((app) => app.slug))]);
  const fillGithubReads = mentioned.includes('github') || searchedSlugs.some((slug) => /^GITHUB_/i.test(slug));
  if (fillGithubReads && !selectReadSlugs(searchedSlugs, ['github']).length
      && typeof composioSvc.searchToolsByIntent === 'function') {
    const extra = await composioSvc.searchToolsByIntent(orgId, 'list repositories get readme', { toolkits: ['github'] }).catch(() => null);
    for (const tool of extra?.tools || []) {
      const slug = tool?._composio?.slug;
      if (slug && !searchedSlugs.includes(slug)) searchedSlugs.push(slug);
    }
  }
  const appHints = (discovered.apps || []).map((app) => app.slug).filter(Boolean);
  let candidates = mentioned.length
    ? [...new Set(mentioned)]
    : connected.filter((toolkit) => discoveredToolkits.includes(toolkit));
  if (!candidates.length) candidates = appHints.slice(0, 4);
  if (run.scratch.chosen_toolkit) {
    candidates = [run.scratch.chosen_toolkit];
    searchedSlugs = searchedSlugs.filter((slug) => slugMatchesConnected(slug, [run.scratch.chosen_toolkit]));
  }
  run.scratch.searched_slugs = searchedSlugs.slice(0, 24);
  run.scratch.candidate_apps = candidates;
  finishTool(emit, run, 'COMPOSIO_SEARCH_TOOLS', {
    kind: 'search',
    status: 'completed',
    summary: searchedSlugs.slice(0, 8).join(',') || 'no tools',
    extra: { slugs: searchedSlugs.slice(0, 12), executor: 'composio' },
  });

  const compoundSend = isReadThenWrite(message, candidates);
  const writeApps = compoundSend ? writeToolkitsIn(message, candidates) : [];
  const readApps = compoundSend ? candidates.filter((toolkit) => !writeApps.includes(toolkit)) : candidates;
  if (!run.scratch.chosen_toolkit && candidates.length > 1 && !compoundSend) {
    run.status = 'waiting_user';
    recordStep(run, { kind: 'clarify', toolkits: candidates, tool: 'clarify_apps', status: 'waiting_user' });
    await saveAgentRun({ prisma: db, run });
    return pause(run, clarifyAppsRequest(candidates), `Do you mean ${candidates.map(displayAppName).join(' or ')}?`);
  }

  const needed = candidates.filter((toolkit) => toolkit && !connected.includes(toolkit));
  if (needed.length === 1) {
    const toolkit = needed[0];
    let redirectUrl = null;
    if (typeof composioSvc.createConnectLink === 'function') {
      try {
        const link = await composioSvc.createConnectLink(toolkit, orgId, {
          callbackUrl: ctx.composioCallbackUrl || undefined,
          toolkitMeta: { composioManagedAuthSchemes: ['OAUTH2'], noAuth: false },
        });
        redirectUrl = link?.redirectUrl || link?.redirect_url || null;
      } catch (error) {
        emit({ type: 'tool_result', name: toolkit, status: 'connect_link_failed', summary: error.message });
      }
    }
    run.status = 'waiting_connection';
    run.scratch.needs_toolkit = toolkit;
    recordStep(run, { kind: 'connect', toolkit, status: 'waiting_connection' });
    await saveAgentRun({ prisma: db, run });
    return pause(run, connectAccountRequest(toolkit, redirectUrl), `Connect ${displayAppName(toolkit)} to continue.`);
  }
  if (!candidates.length && !connected.length) {
    run.status = 'waiting_user';
    await saveAgentRun({ prisma: db, run });
    return pause(run, {
      kind: 'field_input',
      prompt: 'Which app should I use for this? Name it (for example Gmail, Slack, GitHub, Notion) and I will connect or run it.',
      fields: [{ id: 'app', name: 'app', label: 'App', type: 'text', required: true }],
    }, 'Which app should I use?');
  }

  let recallText = '';
  try {
    beginTool(emit, run, 'hivemind_recall', { query: namedRepoQuery(message) || message });
    const dispatch = ctx?._tracedDispatch || ctx?._dispatchTool;
    let recall;
    const recallQuery = namedRepoQuery(message) || message;
    if (typeof dispatch === 'function') {
      const data = await dispatch('hivemind_recall', { query: recallQuery, query_original: message });
      recall = { successful: !data?.error, data, error: data?.error || null };
    } else {
      recall = await executeHivemindCustomTool('HIVEMIND_RECALL', {
        query: recallQuery,
        query_original: message,
        _structured_intent: true,
      }, ctx);
    }
    recallText = summarizeToolData(recall?.data);
    finishTool(emit, run, 'hivemind_recall', {
      kind: 'native',
      status: recall.successful ? 'completed' : 'error',
      summary: recall.successful ? (recallText.slice(0, 160) || 'recall ok') : String(recall.error || 'error'),
      extra: { executor: 'hivemind', slug: 'HIVEMIND_RECALL' },
    });
    if (recall.successful) run.scratch.recall = true;
  } catch (error) {
    finishTool(emit, run, 'hivemind_recall', {
      kind: 'native',
      status: 'error',
      summary: String(error.message || error).slice(0, 200),
      extra: { slug: 'HIVEMIND_RECALL', error: error.message },
    });
  }

  const scopedConnected = run.scratch.chosen_toolkit
    ? connected.filter((toolkit) => toolkit === run.scratch.chosen_toolkit)
    : connected;
  const readConnected = compoundSend
    ? connected.filter((toolkit) => readApps.includes(toolkit) || toolkit === 'gmail')
    : scopedConnected;
  const writeConnected = compoundSend
    ? connected.filter((toolkit) => writeApps.includes(toolkit))
    : scopedConnected;
  let writeSlug = selectWriteSlug(searchedSlugs, writeConnected.length ? writeConnected : connected);
  if (!writeSlug && writeApps.includes('gmail') && typeof composioSvc.searchToolsByIntent === 'function') {
    const extraMail = await composioSvc.searchToolsByIntent(orgId, 'gmail create email draft', { toolkits: ['gmail'] }).catch(() => null);
    for (const tool of extraMail?.tools || []) {
      const slug = tool?._composio?.slug;
      if (slug && !searchedSlugs.includes(slug)) searchedSlugs.push(slug);
    }
    writeSlug = selectWriteSlug(searchedSlugs, writeConnected.length ? writeConnected : ['gmail']);
  }
  const person = namedPersonQuery(message);
  const repoHint = namedRepoQuery(message);
  let readSlugs = [...new Set(selectReadSlugs(searchedSlugs, readConnected.length ? readConnected : connected))]
    .sort((left, right) => {
      const rank = (slug) => {
        if (/GITHUB_.*(LIST_REPO|SEARCH_REPO|GET_A_REPOSITORY|README)/i.test(slug)) return 0;
        if (/FETCH_EMAIL|GET_CONTACT|SEARCH_PEOPLE/i.test(slug)) return person ? 1 : 2;
        return 3;
      };
      return rank(left) - rank(right);
    });
  if (person) {
    const mail = searchedSlugs.find((slug) => /GMAIL_FETCH_EMAILS/i.test(slug) && slugMatchesConnected(slug, connected));
    if (mail && !readSlugs.includes(mail)) readSlugs.push(mail);
  }
  readSlugs = readSlugs.slice(0, 4);

  const readCalls = readSlugs.map((slug) => ({
    slug,
    arguments: argumentsForReadSlug(slug, { person, repoHint }),
  }));
  const readResults = [];

  const runOneRead = async (call) => {
    beginTool(emit, run, call.slug, call.arguments);
    let result = { successful: false, data: null, error: 'execute unavailable' };
    try {
      if (typeof composioSvc.executeTool === 'function') {
        result = await composioSvc.executeTool(orgId, call.slug, call.arguments);
      } else if (typeof composioSvc.executeToolsParallel === 'function') {
        const [row] = await composioSvc.executeToolsParallel(orgId, [call], { sessionId: run.composioSessionId });
        result = row || result;
      }
    } catch (error) {
      result = { successful: false, data: null, error: String(error.message || error) };
    }
    finishTool(emit, run, call.slug, {
      kind: 'read',
      status: result?.successful ? 'completed' : 'error',
      summary: result?.successful
        ? (summarizeToolData(result.data, 160) || 'ok')
        : String(result?.error || 'error').slice(0, 180),
      extra: { executor: 'composio' },
      args: call.arguments,
    });
    readResults.push({ slug: call.slug, ...result });
    const emails = emailsFromProviderData(result?.data);
    if (emails.length) run.scratch.emails = [...new Set([...(run.scratch.emails || []), ...emails])];
    return result;
  };

  for (const call of readCalls) {
    await runOneRead(call);
  }

  const listed = readResults.find((row) => row.successful && /GITHUB_.*(LIST|SEARCH).*REPO/i.test(row.slug));
  if (listed?.data && typeof composioSvc.executeTool === 'function') {
    const needle = (repoHint || 'hivemind').toLowerCase();
    const rows = listed.data.items || listed.data.repositories || listed.data.repos || [];
    const hit = (Array.isArray(rows) ? rows : []).find((item) => {
      const name = `${item.full_name || ''} ${item.name || ''}`.toLowerCase();
      return name.includes(needle);
    });
    const follow = searchedSlugs.find((slug) => /GITHUB_.*(GET_A_REPOSITORY_README|GET_README|GET_A_REPOSITORY$)/i.test(slug)
      && slugMatchesConnected(slug, connected));
    if (hit && follow && (hit.owner?.login || String(hit.full_name || '').includes('/'))) {
      const owner = hit.owner?.login || String(hit.full_name).split('/')[0];
      const repo = hit.name || String(hit.full_name).split('/')[1];
      await runOneRead({ slug: follow, arguments: { owner, repo } });
    }
  }

  const draftIds = [];
  const pendingActions = [];
  if (writeSlug) {
    const toolkit = toolkitFromSlug(writeSlug);
    if (toolkit && !connected.includes(toolkit)) {
      let redirectUrl = null;
      if (typeof composioSvc.createConnectLink === 'function') {
        try {
          const link = await composioSvc.createConnectLink(toolkit, orgId, {
            callbackUrl: ctx.composioCallbackUrl || undefined,
            toolkitMeta: { composioManagedAuthSchemes: ['OAUTH2'], noAuth: false },
          });
          redirectUrl = link?.redirectUrl || link?.redirect_url || null;
        } catch { /* Connect banner still renders */ }
      }
      run.status = 'waiting_connection';
      run.scratch.needs_toolkit = toolkit;
      recordStep(run, { kind: 'connect', toolkit, status: 'waiting_connection' });
      await saveAgentRun({ prisma: db, run });
      return pause(run, connectAccountRequest(toolkit, redirectUrl), `Connect ${displayAppName(toolkit)} to continue.`);
    }
    const to = pickRecipientEmail(run.scratch.emails || [], person)
      || run.scratch.field_values?.recipient_email
      || run.scratch.field_values?.to
      || null;
    const body = composeBriefing({ message, reads: readResults, recallText });
    const args = {
      recipient_email: to,
      to,
      subject: repoHint ? `${repoHint} repository briefing` : 'HIVEMIND repository briefing',
      body,
      _composio_slug: writeSlug,
    };
    if (!to) {
      run.status = 'waiting_user';
      recordStep(run, { kind: 'write', slug: writeSlug, status: 'waiting_user', error: 'recipient unresolved' });
      await saveAgentRun({ prisma: db, run });
      return pause(run, {
        kind: 'field_input',
        prompt: 'Who should receive this? Add the address and I will prepare a draft for your approval.',
        fields: [{ id: 'recipient_email', name: 'recipient_email', label: 'To', type: 'email', required: true }],
      }, 'Need a recipient to draft the message.');
    }
    beginTool(emit, run, writeSlug, { to, subject: args.subject });
    const drafted = await createDraft(ctx, writeSlug, args);
    if (drafted?.id) {
      draftIds.push(drafted.id);
      pendingActions.push({ id: drafted.id, tool: writeSlug, args });
      run.status = 'waiting_approval';
      run.scratch.draft_id = drafted.id;
      finishTool(emit, run, writeSlug, {
        kind: 'write',
        status: 'draft_created',
        summary: `draft to ${to} — not sent`,
        extra: { draft_id: drafted.id, executor: 'composio' },
        args,
      });
    } else {
      run.status = 'failed';
      finishTool(emit, run, writeSlug, {
        kind: 'write',
        status: 'error',
        summary: drafted?.error || 'draft failed',
      });
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
