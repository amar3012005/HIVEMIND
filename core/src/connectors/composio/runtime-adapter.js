import crypto from 'node:crypto';
import { discoverSessionTools, executeSessionTool, executeTool, getToolkitTools } from './composio-service.js';
import { toComposioToolkit } from '../runtime-provider-policy.js';

const LEGACY_TOOL_SLUGS = Object.freeze({
  gmail_search: 'GMAIL_FETCH_EMAILS',
  gmail_get: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  gmail_get_thread: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  gmail_list_drafts: 'GMAIL_LIST_DRAFTS',
  gmail_list_labels: 'GMAIL_LIST_LABELS',
  gmail_create_draft: 'GMAIL_CREATE_EMAIL_DRAFT',
  gmail_send_draft: 'GMAIL_SEND_DRAFT',
  gmail_send: 'GMAIL_SEND_EMAIL',
  drive_search: 'GOOGLEDRIVE_FIND_FILE',
  docs_get: 'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
  docs_create: 'GOOGLEDOCS_CREATE_DOCUMENT',
  docs_append: 'GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT',
});

const WRITE_TOOL_MARKERS = /(?:^|_)(?:SEND|CREATE|UPDATE|DELETE|REMOVE|ARCHIVE|PUBLISH|POST|UPLOAD|INVITE|ADD|CANCEL|MOVE|COPY|REPLY|FORWARD|DRAFT)(?:_|$)/i;
const READ_TOOL_MARKERS = /(?:^|_)(?:GET|LIST|SEARCH|FETCH|FIND|RETRIEVE|LOOKUP|QUERY|READ|CHECK|DESCRIBE|EXTRACT|VIEW|DOWNLOAD)(?:_|$)/i;
const GOVERNED_READ_GRANT_TTL_MS = Math.max(30_000, Number(process.env.HYPER_COMPOSIO_READ_GRANT_TTL_MS || 300_000));

function governedGrantKey(secret) {
  const material = String(secret || process.env.HIVEMIND_MASTER_API_KEY || '').trim();
  if (!material) throw new Error('governed_session_grant_secret_missing');
  return crypto.createHash('sha256').update(`hyper-composio-read-grant.v1:${material}`).digest();
}

export function isGovernedReadTool(tool) {
  const slug = String(tool?._composio?.slug || tool?.slug || tool?.function?.name || '').trim();
  if (!slug || WRITE_TOOL_MARKERS.test(slug) || !READ_TOOL_MARKERS.test(slug)) return false;
  const description = String(tool?.function?.description || tool?.description || '');
  return !/\b(?:send|create|update|delete|remove|publish|post|upload|invite|modify|write)\b/i.test(description);
}

export function issueGovernedReadGrant(
  { orgId, userId, toolkit, sessionId, toolSlug },
  { now = Date.now(), secret } = {},
) {
  if (![orgId, userId, toolkit, sessionId, toolSlug].every((value) => String(value || '').trim())
      || !isGovernedReadTool({ slug: toolSlug })) {
    throw new Error('governed_session_grant_denied');
  }
  const grant = {
    orgId: String(orgId), userId: String(userId), toolkit: String(toolkit).toLowerCase(),
    sessionId: String(sessionId), toolSlug: String(toolSlug), expiresAt: now + GOVERNED_READ_GRANT_TTL_MS,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', governedGrantKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    grantId: `v1.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`,
    expiresAt: grant.expiresAt,
  };
}

export function resolveGovernedReadGrant(
  { grantId, orgId, userId, toolSlug },
  { now = Date.now(), secret } = {},
) {
  let grant;
  try {
    const [version, ivRaw, encryptedRaw, tagRaw] = String(grantId || '').split('.');
    if (version !== 'v1' || !ivRaw || !encryptedRaw || !tagRaw) throw new Error('invalid grant');
    const decipher = crypto.createDecipheriv('aes-256-gcm', governedGrantKey(secret), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final(),
    ]).toString('utf8');
    grant = JSON.parse(plaintext);
  } catch {
    throw new Error('governed_session_grant_invalid');
  }
  if (!grant || Number(grant.expiresAt) <= now) throw new Error('governed_session_grant_expired');
  if (grant.orgId !== String(orgId) || grant.userId !== String(userId)
      || grant.toolSlug !== String(toolSlug) || !isGovernedReadTool({ slug: grant.toolSlug })) {
    throw new Error('governed_session_grant_scope_denied');
  }
  return { ...grant };
}

/** Reuse the same tenant-scoped COMPOSIO_SEARCH_TOOLS + schema path as
 * use_tools:true chat, but return only conservative read capabilities. */
export async function discoverGovernedSessionReads(orgId, { toolkits, useCases } = {}, deps = {}) {
  const discover = deps.discoverSessionTools || discoverSessionTools;
  const result = await discover(orgId, { toolkits, useCases });
  const tools = (result.tools || []).filter(isGovernedReadTool).map((tool) => ({
    name: tool.function?.name,
    description: tool.function?.description || '',
    inputSchema: tool.function?.parameters || { type: 'object', properties: {} },
    sessionId: result.sessionId,
    toolSlug: tool._composio?.slug,
    toolkit: tool._composio?.toolkit,
    effect: 'read',
  })).filter((tool) => tool.name && tool.sessionId && tool.toolSlug);
  return { sessionId: result.sessionId, tools, searchedLogId: result.searchedLogId || null,
    schemaLogId: result.schemaLogId || null, sessionCacheHit: Boolean(result.sessionCacheHit),
    discoveryCacheHit: Boolean(result.discoveryCacheHit) };
}

export async function executeGovernedSessionRead({ sessionId, toolSlug, args = {} }, deps = {}) {
  if (!sessionId || !toolSlug || !isGovernedReadTool({ slug: toolSlug })) {
    throw new Error(`governed_session_read_denied:${toolSlug || 'missing'}`);
  }
  const execute = deps.executeSessionTool || executeSessionTool;
  const result = await execute(sessionId, toolSlug, args && typeof args === 'object' ? args : {});
  if (!result?.successful) throw new Error(result?.error || `Composio ${toolSlug} failed`);
  return { successful: true, data: result.data, receipt: {
    provider: 'composio', transport: 'tool_router_session', tool_slug: toolSlug,
    session_log_id: result.session_log_id || null, effect: 'read',
  } };
}

export const GOVERNED_RESEARCH_CAPABILITIES = Object.freeze({
  parallel_search: Object.freeze({ toolkit: 'parallel', tool: 'PARALLEL_SEARCH', effect: 'read' }),
  parallel_findall: Object.freeze({ toolkit: 'parallel', tool: 'PARALLEL_FIND_ALL', effect: 'research_compute' }),
  parallel_findall_status: Object.freeze({ toolkit: 'parallel', tool: 'PARALLEL_RETRIEVE_FIND_ALL_RUN_STATUS', effect: 'read' }),
  parallel_findall_result: Object.freeze({ toolkit: 'parallel', tool: 'PARALLEL_GET_FIND_ALL_RUN_RESULT', effect: 'read' }),
  parallel_task: Object.freeze({ toolkit: 'parallel', tool: 'PARALLEL_CREATE_TASK_RUN', effect: 'research_compute' }),
  parallel_enrichment: Object.freeze({ toolkit: 'parallel', tool: 'PARALLEL_ADD_ENRICHMENT_TO_FIND_ALL_RUN', effect: 'research_compute' }),
});

export function governedResearchCapability(name) {
  const capability = GOVERNED_RESEARCH_CAPABILITIES[String(name || '').trim()];
  if (!capability) throw new Error(`governed_research_capability_denied:${name || 'missing'}`);
  return capability;
}

/** Execute only the fixed Parallel research surface through Composio's
 * tenant-bound user_id. Shadow callers are contractually unable to spend or
 * mutate even the research provider's run state. */
export async function executeGovernedResearchTool(orgId, name, args = {}, { mode = 'shadow' } = {}) {
  const capability = governedResearchCapability(name);
  if (mode === 'shadow') {
    return { shadow: true, capability: name, toolkit: capability.toolkit, tool: capability.tool, effect: capability.effect };
  }
  if (!String(orgId || '').trim()) throw new Error('governed_research_org_required');
  return executeComposioConnector(orgId, capability.toolkit, {
    name: capability.tool,
    arguments: args && typeof args === 'object' ? args : {},
  });
}

function translateLegacyArguments(tool, args) {
  const translated = { ...(args || {}) };
  if (tool === 'gmail_search' && translated.max != null) {
    translated.max_results = translated.max;
    delete translated.max;
  }
  if (tool === 'gmail_list_drafts' && translated.max != null) {
    translated.max_results = translated.max;
    delete translated.max;
  }
  if (['gmail_get_draft', 'gmail_send_draft'].includes(tool)) {
    if (translated.draftId && !translated.draft_id) translated.draft_id = translated.draftId;
    delete translated.draftId;
  }
  if (['gmail_create_draft', 'gmail_send'].includes(tool)) {
    if (translated.to && !translated.recipient_email) translated.recipient_email = translated.to;
    delete translated.to;
    if (typeof translated.cc === 'string') translated.cc = translated.cc.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
    if (translated.threadId && !translated.thread_id) translated.thread_id = translated.threadId;
    delete translated.threadId;
  }
  if (tool === 'drive_search') {
    if (translated.query && !translated.q) translated.q = translated.query;
    if (translated.max != null && translated.pageSize == null) translated.pageSize = translated.max;
    delete translated.query;
    delete translated.max;
  }
  if (tool === 'docs_get') {
    if (translated.documentId && !translated.document_id) translated.document_id = translated.documentId;
    delete translated.documentId;
  }
  if (tool === 'docs_create') {
    if (translated.content && !translated.text) translated.text = translated.content;
    delete translated.content;
  }
  if (tool === 'docs_append') {
    const documentId = translated.documentId || translated.document_id;
    const text = translated.text;
    return {
      document_id: documentId,
      edit_docs: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }],
    };
  }
  return translated;
}

function normalizeManifest(toolkit, tool) {
  return {
    name: tool.function?.name,
    description: tool.function?.description || '',
    inputSchema: tool.function?.parameters || { type: 'object', properties: {} },
    _composio: tool._composio,
    toolkit,
  };
}

export async function inspectComposioToolkit(capability) {
  const toolkit = toComposioToolkit(capability);
  const tools = await getToolkitTools(toolkit);
  return { name: capability, provider: 'composio', toolkit, tools: tools.map((tool) => normalizeManifest(toolkit, tool)) };
}

export async function executeComposioConnector(orgId, capability, operation = {}) {
  const toolkit = toComposioToolkit(capability);
  const requested = String(operation.name || operation.arguments?.tool || '').trim();
  const args = operation.arguments?.arguments || operation.arguments || {};
  const tools = await getToolkitTools(toolkit);
  const match = tools.find((tool) => {
    const functionName = String(tool.function?.name || '').toLowerCase();
    const slug = String(tool._composio?.slug || '').toUpperCase();
    return functionName === requested.toLowerCase()
      || slug === requested.toUpperCase()
      || slug === String(LEGACY_TOOL_SLUGS[requested] || '').toUpperCase();
  });
  if (!match?._composio?.slug) throw new Error(`Composio tool is unavailable for ${capability}: ${requested}`);
  const cleanArgs = translateLegacyArguments(requested, args);
  delete cleanArgs.tool;
  delete cleanArgs.arguments;
  const result = await executeTool(orgId, match._composio.slug, cleanArgs);
  if (!result.successful) throw new Error(result.error || `Composio ${match._composio.slug} failed`);
  return result.data;
}

export async function executeComposioGoogleTool(orgId, legacyTool, args = {}) {
  if (legacyTool === 'gmail_get_draft') {
    const wanted = String(args?.draftId || args?.draft_id || '').trim();
    const listed = await executeComposioGoogleTool(orgId, 'gmail_list_drafts', { max: 100 });
    const draft = (listed.drafts || []).find((item) => String(item.draftId || '') === wanted);
    if (!draft?.message?.id) return null;
    const message = await executeComposioConnector(orgId, 'gmail', {
      name: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', arguments: { message_id: draft.message.id },
    });
    return { ...message, draftId: wanted, threadId: message?.threadId || draft.threadId || null,
      to: message?.to || null, subject: message?.subject || null, body: message?.messageText || null };
  }
  const toolkit = legacyTool.startsWith('gmail_') ? 'gmail'
    : legacyTool.startsWith('docs_') ? 'google-docs' : 'google-drive';
  const result = await executeComposioConnector(orgId, toolkit, { name: legacyTool, arguments: args });
  const payload = result?.data && typeof result.data === 'object' ? result.data : result;
  if (legacyTool === 'gmail_create_draft' || legacyTool === 'gmail_get_draft') {
    const draft = payload?.draft || payload?.response_data || payload?.responseData || payload?.result || payload;
    return { ...draft, draftId: draft?.draftId || draft?.draft_id || draft?.id || null,
      threadId: draft?.threadId || draft?.thread_id || draft?.message?.threadId || draft?.message?.thread_id || null };
  }
  if (legacyTool === 'gmail_send_draft' || legacyTool === 'gmail_send') {
    const message = payload?.message || payload;
    return { ...message, id: message?.id || message?.message_id || null,
      threadId: message?.threadId || message?.thread_id || null };
  }
  if (legacyTool === 'gmail_list_drafts') {
    const drafts = payload?.drafts || payload?.items || [];
    return { ...payload, drafts: drafts.map((draft) => ({ ...draft,
      draftId: draft?.draftId || draft?.draft_id || draft?.id || null,
      threadId: draft?.threadId || draft?.thread_id || draft?.message?.threadId || null })) };
  }
  if (legacyTool === 'gmail_search') {
    return { ...payload, messages: payload?.messages || payload?.items || [] };
  }
  return payload;
}
