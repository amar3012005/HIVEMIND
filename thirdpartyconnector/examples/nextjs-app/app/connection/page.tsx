async function getStatus() {
  const base = process.env.NEXT_PUBLIC_APP_BASE_URL || 'http://localhost:3401';
  const resp = await fetch(`${base}/api/hivemind/status`, { cache: 'no-store' });
  if (!resp.ok) return null;
  return resp.json();
}

export default async function ConnectionPage() {
  const status = await getStatus();

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <h1>HiveMind Connection</h1>
      {!status?.connected ? <p>Not connected.</p> : null}
      {status?.connected ? (
        <div>
          <p><strong>Status:</strong> Connected</p>
          <p><strong>Workspace:</strong> {status.workspace_id || 'default'}</p>
          <p><strong>Scopes:</strong> {(status.scopes || []).join(', ')}</p>
          <p><strong>Resource:</strong> {status.resource}</p>
        </div>
      ) : null}
      <form action="/api/hivemind/disconnect" method="post" style={{ marginTop: 16 }}>
        <button
          type="submit"
          style={{ background: '#e2e8f0', border: '1px solid #cbd5e1', borderRadius: 10, padding: '8px 12px', cursor: 'pointer' }}
        >
          Disconnect
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        <a href="/">Back</a>
      </p>
    </main>
  );
}
