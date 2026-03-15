import { GmailConnector } from '../../gmail.connector.js';

function extractJsonPayload(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  if (result.contents) return extractJsonPayload({ content: result.contents });

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        try {
          return JSON.parse(item.text);
        } catch {
          const match = item.text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
          if (match) {
            try {
              return JSON.parse(match[0]);
            } catch {
              continue;
            }
          }
        }
      }

      if (item?.type === 'resource' && item.resource?.text) {
        try {
          return JSON.parse(item.resource.text);
        } catch {
          continue;
        }
      }
    }
  }

  return result;
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function stringList(values) {
  return asArray(values).map(value => {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value).trim();
  }).filter(Boolean);
}

function dedupeTags(...groups) {
  return [...new Set(groups.flatMap(group => stringList(group)))];
}

function normalizeEmailMessage(raw = {}) {
  return {
    id: raw.id || raw.messageId || raw.message_id || raw.gmailMessageId,
    subject: raw.subject || raw.title || '',
    snippet: raw.snippet || raw.preview || '',
    body: raw.body || raw.text || raw.content || '',
    internalDate: raw.internalDate || raw.internal_date || raw.date || raw.timestamp || null,
    from: raw.from || raw.sender || null,
    to: raw.to || raw.recipients || [],
    cc: raw.cc || [],
    inReplyTo: raw.inReplyTo || raw.in_reply_to || null,
    permalink: raw.permalink || raw.url || raw.link || null,
  };
}

function normalizeGmailThreads(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.threads)) return payload.threads;
  if (payload.thread) return [payload.thread];
  if (Array.isArray(payload.messages)) {
    return [{
      id: payload.threadId || payload.thread_id || payload.id || `thread-${payload.messages[0]?.id || 'unknown'}`,
      labels: payload.labels || [],
      messages: payload.messages,
    }];
  }
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.id && (payload.body || payload.text || payload.content)) {
    return [{
      id: payload.threadId || payload.thread_id || payload.id,
      labels: payload.labels || [],
      messages: [payload],
    }];
  }
  return [];
}

function gmailAdapter(result, context) {
  const payload = extractJsonPayload(result);
  const threads = normalizeGmailThreads(payload).map(thread => ({
    id: thread.id || thread.threadId || thread.thread_id,
    labels: thread.labels || thread.tags || [],
    messages: (thread.messages || thread.items || [thread]).map(normalizeEmailMessage),
  }));

  const gmailConnector = new GmailConnector();
  const normalized = threads.flatMap(thread => gmailConnector.normalizeThread(thread, {
    user_id: context.user_id,
    org_id: context.org_id,
    project: context.project || context.endpoint.default_project || null,
  }));

  return normalized.map(memory => ({
    source_type: 'text',
    user_id: context.user_id,
    org_id: context.org_id,
    project: memory.project,
    title: memory.content.split('\n')[0]?.slice(0, 120) || 'Gmail memory',
    content: memory.content,
    tags: [...new Set([...(memory.tags || []), ...(context.tags || []), ...(context.endpoint.default_tags || [])])],
    document_date: memory.document_date,
    event_dates: memory.event_dates || [],
    source_platform: memory.source_metadata?.source_platform || 'gmail',
    source_id: memory.source_metadata?.source_id || null,
    source_url: memory.source_metadata?.source_url || null,
    metadata: {
      ...memory.metadata,
      source_type: memory.source_metadata?.source_type || 'gmail',
      thread_id: memory.source_metadata?.thread_id || null,
      parent_message_id: memory.source_metadata?.parent_message_id || null,
      endpoint_name: context.endpoint.name,
      mcp_operation: context.operation.name || context.operation.uri || null,
    },
  }));
}

function repositoryAdapter(result, context) {
  const payload = extractJsonPayload(result);
  const files = payload?.files || payload?.items || [];
  return files
    .filter(file => file?.content && (file.path || file.filepath))
    .map(file => ({
      source_type: 'code',
      user_id: context.user_id,
      org_id: context.org_id,
      project: context.project || context.endpoint.default_project || null,
      content: file.content,
      filepath: file.path || file.filepath,
      language: file.language || null,
      tags: [...new Set([...(context.tags || []), 'repository', ...(context.endpoint.default_tags || [])])],
      source_platform: 'repository',
      source_id: file.path || file.filepath,
      metadata: {
        repository: payload?.repository || null,
        branch: payload?.branch || null,
        commit_sha: payload?.commit_sha || null,
        endpoint_name: context.endpoint.name,
      },
    }));
}

function chatSessionAdapter(result, context) {
  const payload = extractJsonPayload(result);
  const messages = payload?.messages || payload?.turns || [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  return [{
    source_type: 'conversation',
    user_id: context.user_id,
    org_id: context.org_id,
    project: context.project || context.endpoint.default_project || null,
    title: payload?.title || 'Chat session',
    messages: messages.map(message => ({
      role: message.role || message.author || 'user',
      content: message.content || message.text || '',
      timestamp: message.timestamp || message.created_at || null,
    })),
    tags: [...new Set([...(context.tags || []), 'session', ...(context.endpoint.default_tags || [])])],
    source_platform: payload?.platform || context.endpoint.adapter_type || 'chat-session',
    source_id: payload?.id || payload?.session_id || null,
    metadata: {
      endpoint_name: context.endpoint.name,
      source_type: 'chat_session',
    },
  }];
}

function normalizeLinearIssues(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.issues)) return payload.issues;
  if (Array.isArray(payload.nodes)) return payload.nodes;
  if (payload.issue) return [payload.issue];
  if (payload.id && (payload.title || payload.identifier)) return [payload];
  return [];
}

function normalizeLinearProjects(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.projects)) return payload.projects;
  if (payload.project) return [payload.project];
  return [];
}

function normalizeLinearDocuments(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.documents)) return payload.documents;
  if (Array.isArray(payload.results)) return payload.results;
  if (payload.document) return [payload.document];
  return [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function linearIssueToMemory(issue, context) {
  const issueId = firstNonEmpty(issue.identifier, issue.key, issue.id) || 'Linear issue';
  const title = firstNonEmpty(issue.title, issue.name) || issueId;
  const state = firstNonEmpty(issue.state?.name, issue.status?.name, issue.status, issue.state);
  const team = firstNonEmpty(issue.team?.key, issue.team?.name, issue.teamId);
  const project = context.project
    || context.endpoint.default_project
    || firstNonEmpty(issue.project?.slugId, issue.project?.name, issue.team?.key)
    || 'linear';
  const labels = [
    ...stringList(issue.labels?.map(label => label.name || label)),
    ...stringList(issue.labelIds),
  ];
  const lines = [
    `${issueId}: ${title}`,
    state ? `Status: ${state}` : null,
    issue.priorityLabel || issue.priority ? `Priority: ${issue.priorityLabel || issue.priority}` : null,
    issue.assignee?.displayName || issue.assignee?.name ? `Assignee: ${issue.assignee?.displayName || issue.assignee?.name}` : null,
    team ? `Team: ${team}` : null,
    issue.project?.name ? `Project: ${issue.project.name}` : null,
    issue.description ? '' : null,
    issue.description || null,
  ].filter(Boolean);

  return {
    source_type: 'text',
    user_id: context.user_id,
    org_id: context.org_id,
    project,
    title: `${issueId}: ${title}`.slice(0, 120),
    content: lines.join('\n'),
    tags: dedupeTags(
      context.tags,
      context.endpoint.default_tags,
      ['linear', 'issue'],
      labels,
      team ? [team] : []
    ),
    document_date: issue.createdAt || issue.created_at || null,
    event_dates: [issue.updatedAt || issue.updated_at].filter(Boolean),
    source_platform: 'linear',
    source_id: issue.id || issue.identifier || null,
    source_url: issue.url || null,
    metadata: {
      source_type: 'linear_issue',
      endpoint_name: context.endpoint.name,
      mcp_operation: context.operation.name || context.operation.uri || null,
      linear_identifier: issue.identifier || null,
      linear_team: team,
      linear_state: state,
      linear_project_id: issue.project?.id || null,
      linear_cycle_id: issue.cycle?.id || null,
    },
  };
}

function linearProjectToMemory(project, context) {
  const name = firstNonEmpty(project.name, project.title) || 'Linear project';
  const slug = firstNonEmpty(project.slugId, project.slug, project.id);
  const status = firstNonEmpty(project.state, project.status?.name, project.progressState);
  const lines = [
    `Project: ${name}`,
    slug ? `Slug: ${slug}` : null,
    status ? `Status: ${status}` : null,
    project.lead?.displayName || project.lead?.name ? `Lead: ${project.lead?.displayName || project.lead?.name}` : null,
    project.description ? '' : null,
    project.description || null,
  ].filter(Boolean);

  return {
    source_type: 'text',
    user_id: context.user_id,
    org_id: context.org_id,
    project: context.project || context.endpoint.default_project || slug || name,
    title: `Linear project: ${name}`.slice(0, 120),
    content: lines.join('\n'),
    tags: dedupeTags(context.tags, context.endpoint.default_tags, ['linear', 'project']),
    document_date: project.createdAt || project.created_at || null,
    event_dates: [project.updatedAt || project.updated_at, project.targetDate || project.target_date].filter(Boolean),
    source_platform: 'linear',
    source_id: project.id || slug || null,
    source_url: project.url || null,
    metadata: {
      source_type: 'linear_project',
      endpoint_name: context.endpoint.name,
      mcp_operation: context.operation.name || context.operation.uri || null,
      linear_project_slug: slug,
      linear_status: status,
    },
  };
}

function linearDocumentToMemory(document, context) {
  const title = firstNonEmpty(document.title, document.name) || 'Linear document';
  const content = firstNonEmpty(document.content, document.body, document.text, document.summary) || '';
  return {
    source_type: 'text',
    user_id: context.user_id,
    org_id: context.org_id,
    project: context.project || context.endpoint.default_project || 'linear-docs',
    title: `Linear doc: ${title}`.slice(0, 120),
    content: [title, '', content].filter(Boolean).join('\n'),
    tags: dedupeTags(context.tags, context.endpoint.default_tags, ['linear', 'document']),
    document_date: document.createdAt || document.created_at || null,
    event_dates: [document.updatedAt || document.updated_at].filter(Boolean),
    source_platform: 'linear',
    source_id: document.id || title,
    source_url: document.url || null,
    metadata: {
      source_type: 'linear_document',
      endpoint_name: context.endpoint.name,
      mcp_operation: context.operation.name || context.operation.uri || null,
    },
  };
}

function linearAdapter(result, context) {
  const payload = extractJsonPayload(result);
  const issueMemories = normalizeLinearIssues(payload).map(issue => linearIssueToMemory(issue, context));
  const projectMemories = normalizeLinearProjects(payload).map(project => linearProjectToMemory(project, context));
  const documentMemories = normalizeLinearDocuments(payload).map(document => linearDocumentToMemory(document, context));
  const memories = [...issueMemories, ...projectMemories, ...documentMemories];

  if (memories.length > 0) {
    return memories;
  }

  if (payload && typeof payload === 'object') {
    return [{
      source_type: 'text',
      user_id: context.user_id,
      org_id: context.org_id,
      project: context.project || context.endpoint.default_project || 'linear',
      title: `Linear MCP: ${context.operation.name || 'result'}`.slice(0, 120),
      content: JSON.stringify(payload, null, 2),
      tags: dedupeTags(context.tags, context.endpoint.default_tags, ['linear', 'raw']),
      source_platform: 'linear',
      source_id: payload.id || null,
      metadata: {
        source_type: 'linear_raw',
        endpoint_name: context.endpoint.name,
        mcp_operation: context.operation.name || context.operation.uri || null,
      },
    }];
  }

  return [];
}

const ADAPTERS = {
  gmail: gmailAdapter,
  repository_code: repositoryAdapter,
  chat_session: chatSessionAdapter,
  linear: linearAdapter,
};

export function getMcpAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unsupported MCP adapter: ${name}`);
  }
  return adapter;
}
