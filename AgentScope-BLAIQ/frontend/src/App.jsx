import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/hivemind/app/layout/AppShell';
import Chat from './components/hivemind/app/pages/Chat';
import KnowledgeBase from './components/hivemind/app/pages/KnowledgeBase';
import { BlaiqWorkspaceProvider } from './components/hivemind/app/shared/blaiq-workspace-context';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#fafaf8', color: '#111827', fontFamily: 'Inter, system-ui, sans-serif', padding: '2rem', textAlign: 'center',
        }}>
          <div style={{ color: '#dc2626', fontSize: '18px', fontWeight: 'bold', marginBottom: '12px' }}>
            Something went wrong
          </div>
          <pre style={{ color: '#6b7280', fontSize: '13px', maxWidth: '80vw', overflowX: 'auto', background: '#f3f4f6', padding: '16px', borderRadius: '12px', textAlign: 'left' }}>
            {this.state.error?.message}
            {'\n'}
            {this.state.error?.stack?.split('\n').slice(1, 6).join('\n')}
          </pre>
          <button
            style={{ marginTop: '20px', padding: '8px 20px', background: '#111827', border: 'none', borderRadius: '8px', color: 'white', cursor: 'pointer', fontSize: '13px' }}
            onClick={() => { window.localStorage.clear(); window.location.reload(); }}
          >
            Clear cache &amp; reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <BlaiqWorkspaceProvider>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<Navigate to="/app/chat" replace />} />
              <Route path="app">
                <Route index element={<Navigate to="/app/chat" replace />} />
                <Route path="chat" element={<Chat />} />
                <Route path="hivemind" element={<KnowledgeBase />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/app/chat" replace />} />
          </Routes>
        </BlaiqWorkspaceProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
