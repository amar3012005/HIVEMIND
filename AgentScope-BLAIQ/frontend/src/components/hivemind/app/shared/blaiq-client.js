/**
 * AgentScope-BLAIQ SSE streaming client.
 * Talks to the AgentScope backend at /api/v1/workflows/*.
 *
 * Note: The backend's encode_sse() wraps events as `data: {json}\n\n`
 * but sse-starlette adds its own `data: ` prefix, resulting in
 * `data: data: {json}` on the wire. The parser handles both cases.
 */

const TENANT_ID = import.meta.env.VITE_TENANT_ID || 'default';

function withTenant(body) {
  return {
    tenant_id: TENANT_ID,
    ...body,
  };
}

/** Extract JSON payload from an SSE data line, handling double-prefix. */
function extractJsonPayload(line) {
  let payload = line;

  // Strip leading `data: ` prefix(es) — the backend sometimes double-wraps
  while (payload.startsWith('data: ') || payload.startsWith('data:')) {
    payload = payload.replace(/^data:\s*/, '');
  }

  payload = payload.trim();
  if (!payload || payload === '[DONE]') return null;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function consumeSSE(response, onEvent) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(': ') || trimmed === ':') continue;

      // Check for [DONE] marker (with any number of data: prefixes)
      const stripped = trimmed.replace(/^(data:\s*)+/, '').trim();
      if (stripped === '[DONE]') return;

      if (!trimmed.startsWith('data:')) continue;

      const parsed = extractJsonPayload(trimmed);
      if (parsed) {
        onEvent(parsed);
      }
    }
  }
}

export async function streamWorkflow(path, body, onEvent) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(withTenant(body)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${path} failed: ${response.status} ${response.statusText} — ${text}`);
  }

  await consumeSSE(response, onEvent);
}

export function submitWorkflow(payload, onEvent) {
  return streamWorkflow('/api/v1/workflows/submit', payload, onEvent);
}

export function resumeWorkflow(payload, onEvent) {
  return streamWorkflow('/api/v1/workflows/resume', payload, onEvent);
}

export async function getWorkflowStatus(threadId) {
  const response = await fetch(
    `/api/v1/workflows/${threadId}/status?tenant_id=${encodeURIComponent(TENANT_ID)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok) {
    throw new Error(`Status request failed: ${response.status}`);
  }
  return response.json();
}

export async function getLiveAgents() {
  const response = await fetch('/api/v1/agents/live', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Agents request failed: ${response.status}`);
  }
  return response.json();
}

export async function getHivemindConfig() {
  const response = await fetch('/api/v1/hivemind/config', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HIVEMIND config request failed: ${response.status}`);
  }
  return response.json();
}

export async function testHivemindQuery(payload) {
  const response = await fetch('/api/v1/hivemind/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.detail || '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `HIVEMIND test failed: ${response.status}`);
  }
  return response.json();
}

export async function uploadFile(file, tenantId, threadId) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('tenant_id', tenantId || TENANT_ID);
  if (threadId) formData.append('thread_id', threadId);

  const response = await fetch('/api/v1/upload', {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
  return response.json();
}

export async function getArtifact(threadId) {
  const response = await fetch(`/api/v1/artifacts/${threadId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Artifact request failed: ${response.status}`);
  }
  return response.json();
}
