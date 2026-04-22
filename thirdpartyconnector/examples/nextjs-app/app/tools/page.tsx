'use client';

import { FormEvent, useEffect, useState, useTransition } from 'react';

type ToolDefinition = {
  name: string;
  description?: string;
};

type ToolsResponse = {
  connected: boolean;
  workspaceId?: string | null;
  scopes?: string[];
  tools?: ToolDefinition[];
  error?: string;
};

const defaultArgsByTool: Record<string, string> = {
  hivemind_recall: JSON.stringify({ query: 'recent project context', limit: 3 }, null, 2),
  hivemind_list_memories: JSON.stringify({ limit: 5 }, null, 2),
  hivemind_query_with_ai: JSON.stringify({ question: 'What should I know from recent memory?', context_limit: 3 }, null, 2),
  hivemind_web_search: JSON.stringify({ query: 'HiveMind MCP authorization', limit: 3 }, null, 2),
  hivemind_save_memory: JSON.stringify({ title: 'Partner test note', content: 'Created from the partner tools page.' }, null, 2)
};

function getDefaultArgs(toolName: string): string {
  return defaultArgsByTool[toolName] || '{}';
}

export default function ToolsPage() {
  const [payload, setPayload] = useState<ToolsResponse | null>(null);
  const [selectedTool, setSelectedTool] = useState('');
  const [argsText, setArgsText] = useState('{}');
  const [resultText, setResultText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    async function loadTools() {
      const resp = await fetch('/api/hivemind/tools', { cache: 'no-store' });
      const data = await resp.json();
      if (cancelled) {
        return;
      }

      setPayload(data);
      const firstTool = data?.tools?.[0]?.name || '';
      setSelectedTool(firstTool);
      setArgsText(getDefaultArgs(firstTool));
      setErrorText(data?.error || '');
    }

    void loadTools();
    return () => {
      cancelled = true;
    };
  }, []);

  function onToolChange(name: string) {
    setSelectedTool(name);
    setArgsText(getDefaultArgs(name));
    setResultText('');
    setErrorText('');
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(async () => {
      setErrorText('');
      setResultText('');

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(argsText || '{}');
      } catch {
        setErrorText('Arguments must be valid JSON.');
        return;
      }

      const resp = await fetch('/api/hivemind/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedTool, arguments: parsedArgs })
      });

      const data = await resp.json();
      if (!resp.ok) {
        setErrorText(data?.error || 'Tool call failed.');
        return;
      }

      setResultText(JSON.stringify(data.result, null, 2));
    });
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <h1>Partner Tool Console</h1>
      <p>Connected partner apps can use all currently granted HiveMind tools by default.</p>

      {!payload?.connected ? <p>Not connected. Open <a href="/">the connect page</a> first.</p> : null}

      {payload?.connected ? (
        <>
          <p><strong>Workspace:</strong> {payload.workspaceId || 'default'}</p>
          <p><strong>Scopes:</strong> {(payload.scopes || []).join(', ')}</p>
          <p><strong>Available tools:</strong> {payload.tools?.length || 0}</p>

          <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, marginTop: 20 }}>
            <label>
              <div style={{ marginBottom: 6, fontWeight: 600 }}>Tool</div>
              <select
                value={selectedTool}
                onChange={(event) => onToolChange(event.target.value)}
                style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1' }}
              >
                {(payload.tools || []).map((tool) => (
                  <option key={tool.name} value={tool.name}>{tool.name}</option>
                ))}
              </select>
            </label>

            <label>
              <div style={{ marginBottom: 6, fontWeight: 600 }}>Arguments JSON</div>
              <textarea
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                rows={12}
                style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'monospace' }}
              />
            </label>

            <button
              type="submit"
              disabled={!selectedTool || isPending}
              style={{
                background: '#0f172a',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '10px 16px',
                cursor: 'pointer',
                fontWeight: 600,
                width: 'fit-content'
              }}
            >
              {isPending ? 'Running...' : 'Run Tool'}
            </button>
          </form>

          {errorText ? <p style={{ color: '#b91c1c', marginTop: 16 }}>{errorText}</p> : null}

          {resultText ? (
            <div style={{ marginTop: 20 }}>
              <h2 style={{ fontSize: 18 }}>Result</h2>
              <pre style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, overflowX: 'auto' }}>
                {resultText}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}