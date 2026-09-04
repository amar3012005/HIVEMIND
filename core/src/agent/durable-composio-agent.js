/**
 * Durable Composio-session supervisor. Our model does not execute remote
 * tools. Reads go through Composio (search → MULTI_EXECUTE / executeTool)
 * with slugs from search. Native HIVEMIND tools dispatch in-process.
 * Writes become pendingWrite drafts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { executeHivemindCustomTool, nativeNameFromComposioSlug } from '../connectors/composio/hivemind-custom-toolkit.js';
import { formatComposioSearch } from '../connectors/composio/composio-search-formatter.js';

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

export function shouldStartFreshRun(existing, message, choice) {
  if (!existing) return false;
  if (choice) return false;
  return ['waiting_approval', 'waiting_user', 'waiting_connection', 'done', 'failed', 'cancelled'].includes(existing.status);
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
    if (t.includes('attachment') || t.some((x) => x.startsWith('collaborator')) || t.includes('assignee')) return false;
    if (t.includes('secret') || t.includes('codespace')) return false;
    return t.some((x) => READ_TOKENS.has(x));
  }))].slice(0, 24);
}

export function slugRequiresOwnerRepo(slug) {
  const s = String(slug || '');
  if (/LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER/i.test(s)) return false;
  if (/SEARCH_REPOS/i.test(s)) return false;
  if (/^GITHUB_LIST_REPOSITORIES$/i.test(s)) return false;
  if (/GET_A_REPOSITORY|GET_README|README/i.test(s)) return true;
  return /LIST_REPO_|NOTIFICATION|WATCHER|CODESPACE|SECRET|INVITATION|PUBLIC_EVENT/i.test(s);
}

export function isRecipientLookupSlug(slug) {
  return /GET_CONTACT|SEARCH_PEOPLE|FETCH_EMAILS/i.test(String(slug || ''));
}

export function isMailboxInventorySlug(slug) {
  return /LIST_DRAFTS|GET_DRAFT|UPDATE_DRAFT|LIST_LABELS|LIST_SEND_AS/i.test(String(slug || ''));
}

export function isPersonResolveSlug(slug) {
  return /SEARCH_PEOPLE|GET_CONTACT|FETCH_EMAILS/i.test(String(slug || ''));
}

export function governReadSlugs(slugs = [], { readApps = [], person = '', writeApps = [] } = {}) {
  const scoped = selectReadSlugs(slugs, readApps.length ? readApps : undefined)
    .sort((left, right) => {
      const rank = (slug) => {
        if (/AUTHENTICATED|_MY_|_MINE_/i.test(slug)) return 0;
        if (/_BY_|MESSAGE_ID|_ID$/i.test(slug)) return 2;
        return 1;
      };
      return rank(left) - rank(right);
    });
  const skip = new Set((writeApps || []).map((toolkit) => String(toolkit).toLowerCase()));
  const byToolkit = new Map();
  for (const slug of scoped) {
    if (isRecipientLookupSlug(slug)) continue;
    const toolkit = toolkitFromSlug(slug);
    if (!toolkit || skip.has(toolkit) || byToolkit.has(toolkit)) continue;
    byToolkit.set(toolkit, slug);
  }
  const mail = person
    ? scoped.find((slug) => /FETCH_EMAILS/i.test(slug))
      || scoped.find((slug) => /SEARCH_PEOPLE/i.test(slug))
      || scoped.find((slug) => isRecipientLookupSlug(slug))
    : null;
  return [...byToolkit.values(), ...(mail && !byToolkit.has(toolkitFromSlug(mail)) ? [mail] : [])].slice(0, 5);
}

export function isNativeHivemindSlug(slug) {
  const value = String(slug || '');
  if (/^(LOCAL_)?HIVEMIND_/i.test(value)) return true;
  const native = nativeNameFromComposioSlug(value);
  return native.startsWith('hivemind_') || native === 'get_user_profile';
}

export function isWriteSlug(slug) {
  const t = tokens(slug);
  if (t.some((x) => BLOCKED_WRITE_TOKENS.has(x))) return false;
  if (t.includes('draft') && t.includes('create')) return true;
  if (t.includes('reply') || t.includes('comment')) return false;
  return t.some((x) => WRITE_SEND_TOKENS.has(x));
}

export function selectWriteSlug(slugs = [], connected = []) {
  const candidates = (slugs || []).filter((slug) => {
    if (connected.length && !slugMatchesConnected(slug, connected) && !isNativeHivemindSlug(slug)) return false;
    return isWriteSlug(slug);
  });
  const drafts = candidates.filter((slug) => {
    const t = tokens(slug);
    return t.includes('draft') && t.includes('create');
  });
  return drafts[0] || candidates[0] || null;
}

export function sessionToolkitsFor(connected = [], candidates = []) {
  const named = [...new Set((candidates || []).map((item) => String(item || '').toLowerCase()).filter(Boolean))];
  const source = named.length ? named : (connected || []);
  return [...new Set(source)]
    .filter((toolkit) => toolkit !== 'hivemind' && toolkit !== 'local' && toolkit !== 'composio')
    .slice(0, 8);
}

export function toolkitHasActiveConnection(toolkit, connected = [], statuses = {}) {
  const key = String(toolkit || '').toLowerCase();
  if (!key || key === 'local' || key === 'hivemind' || key === 'composio') return true;
  if ((connected || []).some((item) => String(item).toLowerCase() === key)) return true;
  const row = statuses[key];
  if (row == null) return false;
  if (typeof row === 'boolean') return row;
  return row.has_active_connection === true
    || row.connected === true
    || String(row.status || '').toUpperCase() === 'ACTIVE';
}

export function recallQueryFrom(message) {
  const text = String(message || '');
  if (/\b(company|hivemind|singulance)\b/i.test(text) && /\b(send|email|mail|share|draft|about)\b/i.test(text)) {
    return 'company information';
  }
  return text;
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
        if (host.endsWith('amazonses.com') || host.endsWith('sendgrid.net')) continue;
        if (/no-?reply|mailer-daemon|bounce@|notifications?@/i.test(lower)) continue;
        if (/^[0-9a-f-]{16,}@/i.test(lower)) continue;
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
    return hit || null;
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
  // Treat ordinary inbox language as Gmail when it is the connected mail
  // provider. Requiring the literal provider name made "important emails"
  // fail before Session discovery.
  gmail: ['gmail', 'email', 'emails', 'mail', 'inbox', 'mailbox'],
  slack: ['slack'],
  notion: ['notion'],
  googledrive: ['googledrive', 'google drive', 'gdrive', 'drive'],
  youtube: ['youtube', 'yt', 'youtubedata'],
  linkedin: ['linkedin', 'linked in'],
  instagram: ['instagram', 'insta', 'ig'],
});

export function appsMatchingRequest(message, toolkits = []) {
  const text = ` ${String(message || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const list = [...new Set([...(toolkits || []), ...Object.keys(TOOLKIT_ALIASES)])];
  return list.filter((toolkit) => {
    const key = String(toolkit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = TOOLKIT_ALIASES[key] || [key, String(toolkit || '').toLowerCase().replace(/[-_]/g, ' ')];
    return aliases.some((alias) => text.includes(` ${String(alias).replace(/[-_]/g, ' ')} `));
  });
}

const PERSON_STOP = new Set(['me', 'him', 'her', 'them', 'us', 'the', 'a', 'an', 'my', 'this', 'that', 'about', 'important', 'information', 'list', 'last', 'it', 'on', 'via', 'mail', 'email', 'gmail', 'slack', 'linkedin']);

export function writeToolkitsIn(message, toolkits = []) {
  const text = String(message || '').toLowerCase();
  if (!/\b(send|email|mail|via|draft|share|forward)\b/.test(text)) return [];
  const named = Boolean(namedPersonQuery(message));
  const list = [...new Set([...(toolkits || [])])];
  if (named && !list.some((toolkit) => /gmail|outlook/i.test(String(toolkit)))) list.push('gmail');
  return list.filter((toolkit) => {
    const key = String(toolkit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key === 'gmail' || key === 'outlook') {
      return named || /\b(gmail|email|mail|outlook)\b/.test(text);
    }
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

function localizedText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && value.localized && typeof value.localized === 'object') {
    const first = Object.values(value.localized).find((item) => typeof item === 'string' && item.trim());
    if (first) return String(first).trim();
  }
  return '';
}

export function summarizeToolData(data, limit = 1800) {
  if (data == null) return '';
  if (data.encoding === 'base64' && typeof data.content === 'string') {
    try {
      const decoded = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8').trim();
      if (decoded) return decoded.slice(0, limit);
    } catch { /* fall through */ }
  }
  const name = [
    data.localizedFirstName || localizedText(data.firstName),
    data.localizedLastName || localizedText(data.lastName),
  ].filter(Boolean).join(' ');
  const headline = data.localizedHeadline || localizedText(data.headline);
  const profileUrl = data.profileUrl
    || (data.vanityName ? `https://www.linkedin.com/in/${data.vanityName}` : '')
    || data.html_url || data.url || '';
  if (name || headline) {
    return [name, headline, profileUrl].filter(Boolean).join('\n').slice(0, limit);
  }
  const rows = data.items || data.repositories || data.repos || data.messages || data.videos || data.playlists || data.elements || [];
  if (Array.isArray(rows) && rows.length) {
    const lines = rows.slice(0, 10).map((item) => {
      if (item == null || typeof item !== 'object') return String(item);
      const nested = item.snippet && typeof item.snippet === 'object' ? item.snippet : {};
      const nestedText = typeof item.snippet === 'string' ? item.snippet : '';
      return [
        item.full_name || item.name || item.title || item.subject || nested.title || item.facetName,
        item.id || item.playlistId || nested.playlistId || '',
        item.description || item.body || nestedText || nested.description || nested.channelTitle,
        item.html_url || item.url || nested.url,
      ].filter(Boolean).join(' — ');
    }).filter(Boolean);
    if (lines.length && !lines.every((line) => /adTargetingFacet|urn:li:ad/i.test(line))) {
      return lines.join('\n').slice(0, limit);
    }
  }
  const blob = data.content || data.readme || data.body || data.text;
  if (typeof blob === 'string' && blob.trim()) return blob.trim().slice(0, limit);
  try {
    return JSON.stringify(data).slice(0, limit);
  } catch {
    return String(data).slice(0, limit);
  }
}

export function humanRecallText(data) {
  if (!data || data.error) return '';
  const memories = data.memories || data.data?.memories || [];
  if (!Array.isArray(memories) || !memories.length) return '';
  return memories.slice(0, 5).map((memory) => {
    const title = String(memory.title || '').trim();
    const content = String(memory.content || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!title && !content) return '';
    return title ? `${title}: ${content}` : content;
  }).filter(Boolean).join('\n\n');
}

function isNoiseText(text) {
  return /recall_plan|"mode":"fact"|persistentMemoryStore|_failure_mode|Missing required fields|status_code|adTargetingFacet|urn:li:adTargeting|downloadUrlExpiresAt/i.test(String(text || ''));
}

export function isFollowUpReadSlug(slug) {
  const value = String(slug || '');
  if (/ADS_|AUDIENCE|TARGETING|FACET|ADMIN|ORGANIZATION_ACL/i.test(value)) return false;
  return /_ITEMS|README|_BY_|MESSAGE_ID/i.test(value);
}

export function toolkitHasUsableFacts(reads, toolkit) {
  return (reads || []).some((read) => {
    if (!read?.successful || toolkitFromSlug(read.slug) !== toolkit) return false;
    if (isRecipientLookupSlug(read.slug)) return false;
    const text = summarizeToolData(read.data, 400);
    return Boolean(text) && !isNoiseText(text) && !/^\s*\{/.test(text);
  });
}

export function composeBriefing({ message, reads = [], recallText = '', person = '', recallData = null, factToolkits = null } = {}) {
  const relevant = (reads || []).filter((read) => {
    if (!read?.successful) return false;
    if (isRecipientLookupSlug(read.slug)) return false;
    if (isNativeHivemindSlug(read.slug)) return false;
    if (Array.isArray(factToolkits) && factToolkits.length) {
      return factToolkits.includes(toolkitFromSlug(read.slug));
    }
    return true;
  });
  const providerFacts = relevant.map((read) => summarizeToolData(read.data, 1200))
    .filter((text) => text && !isNoiseText(text) && !/^\s*\{/.test(text));
  const recallFacts = humanRecallText(recallData)
    || (recallText && !isNoiseText(recallText) && !/^\s*\{/.test(recallText) ? String(recallText).trim() : '');
  const facts = providerFacts.length ? providerFacts : (recallFacts ? [recallFacts] : []);
  const lines = [];
  const who = person ? person[0].toUpperCase() + person.slice(1) : 'there';
  lines.push(`Hi ${who},`);
  lines.push('');
  if (facts.length) {
    lines.push('Here is what I found:');
    lines.push('');
    lines.push(facts.join('\n\n'));
  } else {
    lines.push('I could not retrieve the requested records yet.');
  }
  lines.push('');
  lines.push('Nothing in this message was sent automatically; it is a draft for review.');
  return lines.join('\n').slice(0, 7000);
}

export async function polishBriefing({ message, body, person, polishImpl } = {}) {
  const source = String(body || '').trim();
  if (!source) return source;
  if (typeof polishImpl === 'function') {
    const polished = await polishImpl({ message, body: source, person });
    return String(polished || source).slice(0, 7000);
  }
  if (String(process.env.HIVEMIND_BRIEFING_POLISH || 'true').trim() === 'false') return source;
  try {
    const { chatCompletionFetch } = await import('../llm/chat-provider.js');
    const response = await chatCompletionFetch(process.env.HIVEMIND_BRIEFING_MODEL || 'openai/gpt-oss-20b:nitro', {
      body: JSON.stringify({
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content: 'Rewrite the facts into a concise professional email. Use only provided facts. Do not invent repositories, metrics, or quotes. Do not mention tool names, APIs, JSON, errors, or Gmail subjects. 120-220 words. Plain text.',
          },
          {
            role: 'user',
            content: `Recipient: ${person || 'colleague'}\nOriginal request: ${String(message || '').slice(0, 500)}\nFacts:\n${source.slice(0, 4000)}`,
          },
        ],
      }),
    }, { useCase: 'briefing_polish' });
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.trim().length > 40 && !/GITHUB_|GMAIL_|tool_result|adTargetingFacet|"localized"/i.test(text)) {
      return text.trim().slice(0, 7000);
    }
  } catch {
    // Template briefing is the fail-closed original.
  }
  return source;
}

export function argumentsForReadSlug(slug, { person = '' } = {}) {
  if (/FETCH_EMAIL|SEARCH_PEOPLE|GET_CONTACT|LIST_MESSAGES/i.test(slug) && person) {
    return { query: person, max_results: 5 };
  }
  return {};
}

export function draftSubject(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 90) || 'Draft';
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
  const toNamed = raw.match(/\bto\s+([A-Za-z][A-Za-z0-9._-]{1,40})\b/i);
  if (toNamed?.[1] && !PERSON_STOP.has(toNamed[1].toLowerCase())) return toNamed[1];
  const sendNamed = raw.match(/\bsend\s+([A-Za-z][A-Za-z0-9._-]{1,40})\b/i);
  if (sendNamed?.[1] && !PERSON_STOP.has(sendNamed[1].toLowerCase())) return sendNamed[1];
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

export async function getOrCreateAgentRun({ prisma, ctx, message, choice = null } = {}) {
  const baseKey = conversationKey(ctx);
  const existing = await loadAgentRun({ prisma, orgId: ctx.orgId, conversationId: baseKey });
  if (existing && !shouldStartFreshRun(existing, message, choice)) {
    if (message && existing.goal !== message) {
      existing.goal = `${existing.goal}\n${message}`.slice(0, 4000);
    }
    if (existing.status === 'waiting_connection') existing.status = 'running';
    return existing;
  }
  const conversationId = existing && shouldStartFreshRun(existing, message, choice)
    ? `${baseKey}:${randomUUID()}`
    : baseKey;
  return {
    id: randomUUID(),
    orgId: ctx.orgId,
    userId: ctx.userId,
    conversationId,
    goal: String(message || '').slice(0, 4000),
    composioSessionId: existing?.composioSessionId || null,
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

export function connectCallbackUrl(toolkit, origin) {
  const base = String(origin || '').trim();
  if (!base) return null;
  try {
    const url = new URL('/hivemind/app/connect/composio/callback', base);
    if (toolkit) url.searchParams.set('composio_toolkit', String(toolkit));
    return url.toString();
  } catch {
    return null;
  }
}

function pause(run, inputRequest, summary) {
  const stepIndex = Number.isFinite(Number(run.scratch?.step_index)) ? Number(run.scratch.step_index) : 0;
  const request = { ...inputRequest, step_index: stepIndex, step_id: `step-${stepIndex + 1}` };
  return {
    status: 'needs_input',
    run,
    summary,
    steps: run.steps,
    draftIds: [],
    pendingActions: [],
    inputRequests: [request],
    resumeState: {
      kind: 'durable_agent',
      run_id: run.id,
      results: [{ inputRequest: request }],
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
  const run = await getOrCreateAgentRun({ prisma: db, ctx, message, choice });
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

  let namedApps = appsMatchingRequest(message, [...connected, ...Object.keys(TOOLKIT_ALIASES)]);
  const impliedWrites = writeToolkitsIn(message, [...namedApps, ...connected]);
  namedApps = [...new Set([...namedApps, ...impliedWrites])];
  if (run.scratch.chosen_toolkit) namedApps = [run.scratch.chosen_toolkit];
  let candidates = namedApps.length ? namedApps : connected.slice();
  if (!candidates.length && !connected.length) {
    run.status = 'waiting_user';
    await saveAgentRun({ prisma: db, run });
    return pause(run, {
      kind: 'field_input',
      prompt: 'Which app should I use for this? Name it (for example Gmail, Slack, GitHub, Notion) and I will connect or run it.',
      fields: [{ id: 'app', name: 'app', label: 'App', type: 'text', required: true }],
    }, 'Which app should I use?');
  }

  const compoundSend = isReadThenWrite(message, candidates);
  const writeApps = compoundSend ? writeToolkitsIn(message, candidates) : [];
  const readApps = compoundSend ? candidates.filter((toolkit) => !writeApps.includes(toolkit)) : candidates;
  if (!run.scratch.chosen_toolkit && namedApps.length > 1 && !compoundSend) {
    run.status = 'waiting_user';
    recordStep(run, { kind: 'clarify', toolkits: namedApps, tool: 'clarify_apps', status: 'waiting_user' });
    await saveAgentRun({ prisma: db, run });
    return pause(run, clarifyAppsRequest(namedApps), `Do you mean ${namedApps.map(displayAppName).join(' or ')}?`);
  }

  const sessionToolkits = sessionToolkitsFor(connected, candidates);
  const resumingPlan = Boolean(picked) && Array.isArray(run.scratch.plan) && run.scratch.plan.length;
  const person = namedPersonQuery(message);

  const pauseForAppConnect = async (toolkit) => {
    let redirectUrl = null;
    let connectError = null;
    if (typeof composioSvc.createConnectLink === 'function') {
      try {
        const link = await composioSvc.createConnectLink(toolkit, orgId, {
          callbackUrl: ctx.composioCallbackUrl || connectCallbackUrl(toolkit, ctx.composioCallbackOrigin) || undefined,
          toolkitMeta: { composioManagedAuthSchemes: ['OAUTH2'], noAuth: false },
        });
        redirectUrl = link?.redirectUrl || link?.redirect_url || null;
      } catch (error) {
        connectError = String(error.message || error).slice(0, 180);
        emit({ type: 'tool_result', name: toolkit, status: 'connect_link_failed', summary: connectError });
      }
    }
    run.status = 'waiting_connection';
    run.scratch.needs_toolkit = toolkit;
    run.scratch.connection_error = connectError;
    recordStep(run, { kind: 'connect', toolkit, status: 'waiting_connection', ...(connectError ? { error: connectError } : {}) });
    await saveAgentRun({ prisma: db, run });
    return pause(run, connectAccountRequest(toolkit, redirectUrl), connectError
      ? `${displayAppName(toolkit)} cannot be connected for this workspace yet.`
      : `Connect ${displayAppName(toolkit)} to continue.`);
  };

  if (!resumingPlan) {
    if (!run.composioSessionId && typeof composioSvc.getToolRouterSession === 'function') {
      try {
        const session = await composioSvc.getToolRouterSession(orgId, sessionToolkits, { allowDisconnected: true });
        run.composioSessionId = session.id || null;
        run.scratch.custom_toolkit_attached = session.customToolkitAttached;
        if (session.customToolkitError) run.scratch.custom_toolkit_error = session.customToolkitError;
      } catch (error) {
        run.scratch.session_error = String(error.message || error).slice(0, 240);
      }
    }
    beginTool(emit, run, 'COMPOSIO_SEARCH_TOOLS', { query: message });
    let discovery;
    try {
      if (run.composioSessionId && typeof composioSvc.discoverSessionTools === 'function') {
        discovery = await composioSvc.discoverSessionTools(orgId, {
          toolkits: sessionToolkits,
          useCases: [message],
          allowDisconnected: true,
          searchPayload: formatComposioSearch({
            message,
            sessionId: run.scratch.workflow_session_id,
            destinationApps: sessionToolkits,
            generateId: !run.scratch.workflow_session_id,
          }),
        });
        discovery.fromSession = true;
      } else if (composio && typeof composioSvc.searchToolsByIntent === 'function') {
        const legacy = await composioSvc.searchToolsByIntent(orgId, message);
        discovery = {
          sessionId: run.composioSessionId,
          tools: legacy.tools || [],
          primaryToolSlugs: (legacy.tools || []).map((tool) => tool?._composio?.slug).filter(Boolean),
          relatedToolSlugs: [],
          toolkitConnectionStatuses: {},
          fromSession: false,
        };
      } else {
        throw new Error('session_discovery_unavailable');
      }
    } catch (error) {
      run.status = 'failed';
      run.scratch.search_error = String(error.message || error).slice(0, 240);
      finishTool(emit, run, 'COMPOSIO_SEARCH_TOOLS', { kind: 'search', status: 'error', summary: run.scratch.search_error, extra: { executor: 'composio' } });
      await saveAgentRun({ prisma: db, run });
      return { status: 'error', run, summary: 'Composio could not discover a safe capability for this request. Nothing was executed.', steps: run.steps, draftIds: [], pendingActions: [] };
    }
    let searchedSlugs = (discovery.tools || []).map((tool) => tool?._composio?.slug).filter(Boolean);
    const primary = (discovery.primaryToolSlugs?.length ? discovery.primaryToolSlugs : searchedSlugs).filter(Boolean);
    run.composioSessionId = discovery.sessionId || run.composioSessionId;
    if (discovery.workflowSessionId) run.scratch.workflow_session_id = discovery.workflowSessionId;
    run.scratch.searched_slugs = searchedSlugs.slice(0, 48);
    run.scratch.primary_tool_slugs = primary.slice(0, 48);
    run.scratch.related_tool_slugs = (discovery.relatedToolSlugs || []).slice(0, 24);
    run.scratch.candidate_apps = candidates;
    run.scratch.toolkit_connection_statuses = discovery.toolkitConnectionStatuses || {};
    run.scratch.recommended_plan_steps = discovery.recommendedPlanSteps || [];
    run.scratch.next_steps_guidance = discovery.nextStepsGuidance || null;
    run.scratch.from_session = Boolean(discovery.fromSession);
    const scoped = discovery.fromSession
      ? primary
      : primary.filter((slug) => isNativeHivemindSlug(slug) || candidates.includes(toolkitFromSlug(slug)));
    run.scratch.plan = (scoped.length ? scoped : primary).slice(0, 16);
    run.scratch.step_index = 0;
    finishTool(emit, run, 'COMPOSIO_SEARCH_TOOLS', {
      kind: 'search', status: 'completed',
      summary: uniqueToolkitsFromSlugs(run.scratch.plan).map(displayAppName).join(', ') || 'no tools',
      extra: { slugs: run.scratch.plan.slice(0, 12), executor: 'composio', session_id: run.composioSessionId },
      args: { query: message },
    });
  }

  const statuses = run.scratch.toolkit_connection_statuses || {};
  const plan = Array.isArray(run.scratch.plan) ? run.scratch.plan : [];
  const writeConnected = writeApps.length
    ? connected.filter((toolkit) => writeApps.includes(toolkit))
    : connected;
  let writeSlug = selectWriteSlug(
    [...plan, ...(run.scratch.related_tool_slugs || []), ...(run.scratch.searched_slugs || [])],
    writeConnected.length ? writeConnected : connected,
  );
  let recallText = run.scratch.recall_text || '';
  let recallData = run.scratch.recall_data || null;
  const readResults = Array.isArray(run.scratch.read_results) ? [...run.scratch.read_results] : [];
  const evidenceText = (slug) => {
    const toolkit = toolkitFromSlug(slug);
    const rows = readResults.filter((row) => row.successful && (!toolkit || toolkitFromSlug(row.slug) === toolkit || isNativeHivemindSlug(row.slug)));
    return [message, recallText, ...rows.map((row) => summarizeToolData(row.data, 800))].filter(Boolean).join('\n\n');
  };

  const persistProgress = async () => {
    run.scratch.recall_text = String(recallText || '').slice(0, 4000);
    if (recallData && typeof recallData === 'object') {
      run.scratch.recall_data = {
        memories: Array.isArray(recallData.memories) ? recallData.memories.slice(0, 5) : [],
      };
    }
    run.scratch.read_results = readResults.slice(-12).map((row) => ({
      slug: row.slug,
      successful: row.successful,
      data: row.data,
      error: row.error || null,
    }));
    await saveAgentRun({ prisma: db, run });
  };

  const runOneNative = async (slug) => {
    const native = nativeNameFromComposioSlug(slug);
    const args = native === 'hivemind_recall' || native === 'hivemind_list_memories'
      ? { query: recallQueryFrom(message), query_original: message }
      : {};
    beginTool(emit, run, slug, args);
    let result = { successful: false, data: null, error: 'native unavailable' };
    try {
      const dispatch = ctx?._tracedDispatch || ctx?._dispatchTool;
      if (native === 'hivemind_recall' && typeof dispatch === 'function') {
        const data = await dispatch('hivemind_recall', args, ctx);
        result = { successful: !data?.error, data, error: data?.error || null };
      } else {
        result = await executeHivemindCustomTool(slug, args, ctx);
      }
    } catch (error) {
      result = { successful: false, data: null, error: String(error.message || error) };
    }
    const text = humanRecallText(result.data) || (result.successful ? summarizeToolData(result.data, 400) : '');
    if (text && !isNoiseText(text)) {
      recallText = recallText || text;
      recallData = result.data || recallData;
      run.scratch.recall = true;
    }
    finishTool(emit, run, slug, {
      kind: 'native',
      status: result.successful ? 'completed' : 'error',
      summary: result.successful ? (text.slice(0, 160) || 'ok') : String(result.error || 'error').slice(0, 160),
      extra: { executor: 'hivemind', slug },
      args,
    });
    readResults.push({ slug, ...result });
    return result;
  };

  const runOneRead = async (call) => {
    let args = { ...(call.arguments || {}) };
    if (typeof composioSvc.generateToolInputs === 'function' && !isRecipientLookupSlug(call.slug)) {
      const generated = await composioSvc.generateToolInputs(call.slug, evidenceText(call.slug)).catch(() => null);
      if (generated && typeof generated === 'object' && !Array.isArray(generated)) {
        const clean = { ...generated };
        for (const key of Object.keys(clean)) {
          if (/^(user_id|userid|org_id|connected_account_id|entity_id|session_id|metadata)$/i.test(key)) delete clean[key];
        }
        if (Object.keys(clean).length) args = { ...args, ...clean };
      }
    }
    if (!Object.keys(args).length) args = argumentsForReadSlug(call.slug, { person });
    beginTool(emit, run, call.slug, args);
    let result = { successful: false, data: null, error: 'execute unavailable' };
    try {
      if (run.composioSessionId && typeof composioSvc.executeToolsParallel === 'function') {
        const [row] = await composioSvc.executeToolsParallel(orgId, [{ slug: call.slug, arguments: args }], {
          sessionId: run.composioSessionId,
          allowDirectFallback: false,
        });
        result = row || result;
      } else if (typeof composioSvc.executeTool === 'function') {
        result = await composioSvc.executeTool(orgId, call.slug, args);
      }
    } catch (error) {
      result = { successful: false, data: null, error: String(error.message || error) };
    }
    const missing = /missing required|invalid request data/i.test(String(result?.error || ''));
    finishTool(emit, run, call.slug, {
      kind: 'read',
      status: result?.successful ? 'completed' : (missing ? 'skipped' : 'error'),
      summary: result?.successful
        ? (summarizeToolData(result.data, 160) || 'ok')
        : (missing ? 'needs more context' : String(result?.error || 'error').slice(0, 180)),
      extra: { executor: 'composio' },
      args,
    });
    readResults.push({ slug: call.slug, ...result });
    const emails = emailsFromProviderData(result?.data);
    if (emails.length) run.scratch.emails = [...new Set([...(run.scratch.emails || []), ...emails])];
    return result;
  };

  const startAt = Number.isFinite(Number(run.scratch.step_index)) ? Number(run.scratch.step_index) : 0;
  for (let index = startAt; index < plan.length; index += 1) {
    const slug = plan[index];
    run.scratch.step_index = index;
    const already = (run.steps || []).some((step) => (step.slug === slug || step.tool === slug)
      && ['completed', 'draft_created', 'skipped'].includes(step.status));
    if (already) continue;
    if (tokens(slug).some((x) => BLOCKED_WRITE_TOKENS.has(x))) continue;
    if (isMailboxInventorySlug(slug)) continue;
    if (isNativeHivemindSlug(slug)) {
      if (recallText && !/GET_MEMORY/i.test(slug)) continue;
      await runOneNative(slug);
      await persistProgress();
      continue;
    }
    if (isWriteSlug(slug)) {
      writeSlug = selectWriteSlug([slug, writeSlug].filter(Boolean), writeConnected.length ? writeConnected : connected) || writeSlug || slug;
      continue;
    }
    const toolkit = toolkitFromSlug(slug);
    if (toolkit && !toolkitHasActiveConnection(toolkit, connected, statuses)) {
      await persistProgress();
      return pauseForAppConnect(toolkit);
    }
    if (isRecipientLookupSlug(slug) && (run.scratch.emails || []).length) continue;
    await runOneRead({ slug, arguments: argumentsForReadSlug(slug, { person }) });
    await persistProgress();
  }

  const followUps = (plan || [])
    .filter((slug) => isFollowUpReadSlug(slug))
    .filter((slug) => !readResults.some((row) => row.slug === slug))
    .filter((slug) => !isWriteSlug(slug));
  for (const slug of followUps.slice(0, 2)) {
    const toolkit = toolkitFromSlug(slug);
    if (toolkit && !toolkitHasActiveConnection(toolkit, connected, statuses)) continue;
    await runOneRead({ slug, arguments: {} });
  }

  if (writeSlug && !recallText) {
    const preview = composeBriefing({
      message,
      reads: readResults,
      recallText,
      person,
      recallData,
      factToolkits: readApps,
    });
    if (/could not retrieve/i.test(preview)) await runOneNative('HIVEMIND_RECALL');
  }

  if (writeSlug && person && !(run.scratch.emails || []).length) {
    const lookup = [...(run.scratch.related_tool_slugs || []), ...(run.scratch.searched_slugs || []), ...plan]
      .filter((slug) => isPersonResolveSlug(slug) && toolkitHasActiveConnection(toolkitFromSlug(slug), connected, statuses))
      .sort((left, right) => {
        const rank = (slug) => (/SEARCH_PEOPLE|GET_CONTACT/i.test(slug) ? 0 : 1);
        return rank(left) - rank(right);
      })[0];
    if (lookup && !readResults.some((row) => row.slug === lookup)) {
      await runOneRead({ slug: lookup, arguments: argumentsForReadSlug(lookup, { person }) });
    }
  }

  const draftIds = [];
  const pendingActions = [];
  if (writeSlug) {
    const toolkit = toolkitFromSlug(writeSlug);
    if (toolkit && !toolkitHasActiveConnection(toolkit, connected, statuses)) {
      await persistProgress();
      return pauseForAppConnect(toolkit);
    }
    const to = pickRecipientEmail(run.scratch.emails || [], person)
      || run.scratch.field_values?.recipient_email
      || run.scratch.field_values?.to
      || null;
    const draftedFacts = composeBriefing({
      message,
      reads: readResults,
      recallText,
      person,
      recallData,
      factToolkits: readApps,
    });
    const body = await polishBriefing({
      message,
      body: draftedFacts,
      person,
      polishImpl: ctx.polishBriefing,
    });
    const args = {
      recipient_email: to,
      to,
      subject: draftSubject(message),
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
