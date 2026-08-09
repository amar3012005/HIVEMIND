import { executeTool, getToolkitTools } from './composio-service.js';
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
