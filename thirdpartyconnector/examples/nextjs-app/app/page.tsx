export default function HomePage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <h1>Connect HiveMind</h1>
      <p>Securely link your HiveMind workspace to this app. No API keys required.</p>
      <form action="/api/hivemind/start" method="post">
        <button
          type="submit"
          style={{
            background: '#0f172a',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '10px 16px',
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          Continue with HiveMind
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        <a href="/connection">View connection status</a>
      </p>
    </main>
  );
}
